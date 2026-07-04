import {AxiosError, AxiosRequestConfig, AxiosResponse} from 'axios';
import fs from 'fs/promises';
import {jsonc} from 'jsonc';
import pTimeout from 'p-timeout';
import {ICLOUD_PHOTOS_ERR} from '../../../app/error/error-codes.js';
import {iCPSError} from '../../../app/error/error.js';
import {AlbumAssets, AlbumType} from '../../photos-library/model/album.js';
import {Asset, AssetType} from '../../photos-library/model/asset.js';
import {iCPSEventCloud, iCPSEventPhotos, iCPSEventRuntimeWarning} from '../../resources/events-types.js';
import {Resources} from '../../resources/main.js';
import {ENDPOINTS, PhotosSetupResponseZone} from '../../resources/network-types.js';
import {SyncEngineHelper} from '../../sync-engine/helper.js';
import {SyncRetryPolicy} from '../../sync-engine/retry-policy.js';
import * as QueryBuilder from './query-builder.js';
import {AssetID, CPLAlbum, CPLAsset, CPLMaster} from './query-parser.js';
import {PhotosAccountZone, ZoneArea} from '../../resources/resource-types.js';

/**
 * To perform an operation, a record change tag is required. Hardcoding it for now
 */
const RECORD_CHANGE_TAG = `21h2`;

/**
 * The max record limit returned by iCloud.
 * Keeping this below the observed upper limit reduces pressure on the private Photos query indexes.
 */
const MAX_RECORDS_LIMIT = 200;
const PHOTO_METADATA_PAGE_CONCURRENCY = 4;
const PHOTOS_METADATA_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
const EXPIRED_DOWNLOAD_URL_STATUS = 410;

/**
 * Number of attempts made to look up a record while refreshing an expired download URL, including the initial attempt.
 */
const URL_REFRESH_LOOKUP_ATTEMPTS = 3;
const URL_REFRESH_LOOKUP_BACKOFF_BASE_MS = 1000;

/**
 * HTTP status returned by the CloudKit data endpoints once the Web-Auth session token has expired.
 * Unlike a transient failure, this does not recover on retry - the session has to be re-acquired.
 */
const SESSION_EXPIRED_STATUS = 421;

/**
 * Additional time granted, on top of the configured MFA timeout, to re-acquire an expired session before giving up.
 */
const SESSION_RECOVERY_GRACE_MS = 5 * 60 * 1000;

type PhotosQueryPage = {
    records: any[],
    continuationMarker?: string
}

type PhotosQueryResult = {
    records: any[],
    usedContinuation: boolean
}

/**
 * This class holds connection and state with the iCloud Photos Backend and provides functions to access the data stored there
 */
export class iCloudPhotos {
    /**
     * A promise that will resolve, once the object is ready or reject, in case there is an error
     */
    ready: Promise<void>;

    /**
     * Counter used to correlate verbose query start, completion and failure logs.
     */
    queryTraceCounter: number = 0;

    /**
     * Used to classify transient (e.g. session-expiry related) errors encountered while refreshing download URLs.
     */
    private readonly retryPolicy = new SyncRetryPolicy();

    /**
     * Tracks an in-flight session re-acquisition so concurrent download workers share a single re-authentication
     * instead of each triggering their own when the session expires mid-sync.
     */
    private sessionRecovery?: Promise<void>;

    /**
     * Creates a new iCloud Photos Class
     */
    constructor() {
        Resources.events(this).on(iCPSEventPhotos.SETUP_COMPLETED, async () => {
            await this.checkingIndexingStatus();
        });

        this.ready = this.getReady();
    }

    /**
     *
     * @returns - A promise, that will resolve once this objects emits 'READY' or reject if it emits 'ERROR'
     */
    getReady(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const events = Resources.events(this);
            const cleanup = () => {
                events.removeListener(iCPSEventPhotos.READY, onReady);
                events.removeListener(iCPSEventPhotos.ERROR, onError);
            };
            const onReady = () => {
                cleanup();
                resolve();
            };
            const onError = (err: unknown) => {
                cleanup();
                reject(err);
            };
            events
                .once(iCPSEventPhotos.READY, onReady)
                .once(iCPSEventPhotos.ERROR, onError);
        });
    }

    /**
     * Starting iCloud Photos service, acquiring all necessary account information required to interact with the backend. This includes information about a shared library
     * Will emit SETUP_COMPLETE or ERROR
     * @returns A promise, that will resolve once the service is available or reject in case of an error
     * @emits iCPSEventPhotos.SETUP_COMPLETED - Once the setup is completed
     * @emits iCPSEventPhotos.ERROR - In case of an error during setup - The iCPSError is provided as argument
     */
    async setup() {
        this.ready.catch(() => undefined);
        this.ready = this.getReady();

        try {
            Resources.logger(this).debug(`Getting iCloud Photos account information`);

            Resources.network().applyZones(
                await this.getZonesInArea(`PRIVATE`),
                await this.getZonesInArea(`SHARED`)
            )

            Resources.logger(this).debug(`Successfully gathered iCloud Photos account information`);
            Resources.emit(iCPSEventPhotos.SETUP_COMPLETED);
        } catch (err) {
            const setupError = new iCPSError(ICLOUD_PHOTOS_ERR.SETUP_ERROR).addCause(err);
            this.ready.catch(() => undefined);
            Resources.emit(iCPSEventPhotos.ERROR, setupError);
            throw setupError;
        } 
        return this.ready;
    }

    /**
     * Checks for everyone zone available in the respective area
     * @param area Either private or shared - depending on the ownership of the area
     * @returns An array of zone references
     */
    private async getZonesInArea(area: ZoneArea): Promise<PhotosSetupResponseZone[]> {
        Resources.logger(this).debug(`Getting zones in ${area} area`);
        const response = await Resources.network().post(ENDPOINTS.PHOTOS.AREAS[area] + ENDPOINTS.PHOTOS.PATH.ZONES, {});
        const validatedResponse = Resources.validator().validatePhotosSetupResponse(response);
        return validatedResponse.data.zones;
    }

    /**
     * Checking indexing state of all available zones of the photos service (sync should only safely be performed, after indexing is completed)
     * @emits iCPSEventPhotos.READY - If indexing is completed
     * @emits iCPSEventPhotos.ERROR - If indexing is not completed - The iCPSError is provided as argument
     * Will emit READY, or ERROR
     */
    async checkingIndexingStatus() {
        Resources.logger(this).debug(`Checking Indexing Status of iCloud Photos Account`);
        try {
            await this.checkIndexingStatusForZone(QueryBuilder.Zones.Primary);
            if (Resources.manager().sharedZoneAvailable) {
                await this.checkIndexingStatusForZone(QueryBuilder.Zones.Shared);
            }

            Resources.emit(iCPSEventPhotos.READY);
        } catch (err) {
            Resources.emit(iCPSEventPhotos.ERROR, new iCPSError(ICLOUD_PHOTOS_ERR.INDEXING_STATE_UNAVAILABLE).addCause(err));
        }
    }

    /**
     * Checks the indexing status of a given zone.
     * @param zone - The zone to check
     * @returns If indexing is successful
     * @throws If non-completed indexing state is found
     */
    async checkIndexingStatusForZone(zone: QueryBuilder.Zones) {
        const result = await this.performQuery(zone, `CheckIndexingState`);

        const indexingState = result[0]?.fields?.state?.value as string;

        if (!indexingState) {
            throw new iCPSError(ICLOUD_PHOTOS_ERR.INDEXING_STATE_UNAVAILABLE)
                .addMessage(`zone: ${zone}`)
                .addContext(`icloudResult`, result);
        }

        if (indexingState === `RUNNING`) {
            Resources.logger(this).debug(`Indexing for zone ${zone} in progress, sync needs to wait!`);
            const indexingInProgressError = new iCPSError(ICLOUD_PHOTOS_ERR.INDEXING_IN_PROGRESS)
                .addMessage(`zone: ${zone}`);

            const progress = result[0]?.fields?.progress?.value;
            if (progress) {
                indexingInProgressError.addMessage(`progress ${progress}`);
            }

            throw indexingInProgressError;
        }

        if (indexingState === `FINISHED`) {
            Resources.logger(this).info(`Indexing of ${zone} finished, sync can start!`);
            return;
        }

        throw new iCPSError(ICLOUD_PHOTOS_ERR.INDEXING_STATE_UNKNOWN)
            .addContext(`icloudResult`, result)
            .addMessage(`zone: ${zone}`)
            .addMessage(`indexing state: ${indexingState}`);
    }

    /**
     * Performs a query against the iCloud Photos Service
     * @param zone - Defines the zone to be used
     * @param recordType - The requested record type
     * @param filterBy - An array of filter instructions
     * @param resultsLimit - Results limit is maxed at 66 * 3 records (because every picture is returned three times)
     * @param desiredKeys - The fields requested from the backend
     * @returns An array of records as returned by the backend
     * @throws An iCPSError if the query fails
     */
    async performQuery(zone: QueryBuilder.Zones, recordType: string, filterBy?: any[], resultsLimit?: number, desiredKeys?: string[]): Promise<any[]> {
        return (await this.performQueryWithPagination(zone, recordType, filterBy, resultsLimit, desiredKeys)).records;
    }

    /**
     * Performs a query and tracks whether the backend used continuation marker pagination.
     * @param zone - Defines the zone to be used
     * @param recordType - The requested record type
     * @param filterBy - An array of filter instructions
     * @param resultsLimit - Results limit for each backend page
     * @param desiredKeys - The fields requested from the backend
     * @returns The returned records and whether a continuation marker was followed
     * @throws An iCPSError if the query fails
     */
    private async performQueryWithPagination(zone: QueryBuilder.Zones, recordType: string, filterBy?: any[], resultsLimit?: number, desiredKeys?: string[]): Promise<PhotosQueryResult> {
        const records: any[] = [];
        let continuationMarker: string | undefined;
        let usedContinuation = false;

        do {
            const page = await this.performQueryPage(zone, recordType, filterBy, resultsLimit, desiredKeys, continuationMarker);
            records.push(...page.records);
            usedContinuation = usedContinuation || Boolean(page.continuationMarker);
            continuationMarker = page.continuationMarker;
        } while (continuationMarker);

        return {
            records,
            usedContinuation,
        };
    }

    /**
     * Performs a single paged query against the iCloud Photos Service.
     * @param zone - Defines the zone to be used
     * @param recordType - The requested record type
     * @param filterBy - An array of filter instructions
     * @param resultsLimit - Results limit for this page
     * @param desiredKeys - The fields requested from the backend
     * @param continuationMarker - Marker from a previous page
     * @returns The page records and the next continuation marker, if present
     * @throws An iCPSError if the query fails
     */
    private async performQueryPage(zone: QueryBuilder.Zones, recordType: string, filterBy?: any[], resultsLimit?: number, desiredKeys?: string[], continuationMarker?: string): Promise<PhotosQueryPage> {
        const config: AxiosRequestConfig = {
            params: {
                remapEnums: `True`,
            },
            timeout: PHOTOS_METADATA_REQUEST_TIMEOUT_MS,
        };

        const zoneId = QueryBuilder.getZoneID(zone)

        const data: any = {
            query: {
                recordType: `${recordType}`,
            },
            zoneID: {
                zoneName: zoneId.zoneName,
                zoneType: zoneId.zoneType,
                ownerRecordName: zoneId.ownerRecordName,
            }
        };

        if (filterBy) {
            data.query.filterBy = filterBy;
        }

        if (desiredKeys) {
            data.desiredKeys = desiredKeys;
        }

        if (resultsLimit) {
            data.resultsLimit = resultsLimit;
        }

        if (continuationMarker) {
            data.continuationMarker = continuationMarker;
        }

        const traceId = ++this.queryTraceCounter;
        const startedAt = Date.now();
        const requestContext = this.getSafeQueryRequestContext(zoneId, recordType, filterBy, resultsLimit, desiredKeys, continuationMarker);
        Resources.logger(this).info(`Photos query #${traceId} started: ${jsonc.stringify(requestContext)}`);

        let queryResponse: AxiosResponse;
        try {
            queryResponse = await Resources.network().post(ENDPOINTS.PHOTOS.AREAS[zoneId.area] + ENDPOINTS.PHOTOS.PATH.QUERY, data, config);
        } catch (err) {
            this.logPhotosQueryFailure(traceId, startedAt, zoneId, recordType, filterBy, resultsLimit, desiredKeys, continuationMarker, err);
            throw err;
        }

        const fetchedRecords = queryResponse?.data?.records;
        if (!fetchedRecords || !Array.isArray(fetchedRecords)) {
            this.logPhotosQueryFailure(traceId, startedAt, zoneId, recordType, filterBy, resultsLimit, desiredKeys, continuationMarker, undefined, queryResponse);
            throw new iCPSError(ICLOUD_PHOTOS_ERR.UNEXPECTED_QUERY_RESPONSE)
                .addContext(`queryResponse`, queryResponse);
        }

        Resources.logger(this).info(`Photos query #${traceId} completed in ${Date.now() - startedAt}ms: ${jsonc.stringify({
            recordsReturned: fetchedRecords.length,
            continuationReturned: typeof queryResponse.data.continuationMarker === `string` && queryResponse.data.continuationMarker.length > 0,
        })}`);

        return {
            records: fetchedRecords,
            continuationMarker: typeof queryResponse.data.continuationMarker === `string` && queryResponse.data.continuationMarker.length > 0
                ? queryResponse.data.continuationMarker
                : undefined,
        };
    }

    /**
     * Logs safe query diagnostics for a failed Photos records/query request.
     * @param zoneId - The zone used for the query
     * @param recordType - The requested record type
     * @param filterBy - Query filters
     * @param resultsLimit - Results limit for this page
     * @param desiredKeys - Desired record fields
     * @param continuationMarker - Continuation marker from a previous page
     * @param err - Optional request error
     * @param response - Optional response for unexpected response shape
     */
    private logPhotosQueryFailure(traceId: number, startedAt: number, zoneId: PhotosAccountZone, recordType: string, filterBy?: any[], resultsLimit?: number, desiredKeys?: string[], continuationMarker?: string, err?: unknown, response?: AxiosResponse) {
        Resources.logger(this).warn(`Photos query #${traceId} failed after ${Date.now() - startedAt}ms: ${jsonc.stringify({
            request: this.getSafeQueryRequestContext(zoneId, recordType, filterBy, resultsLimit, desiredKeys, continuationMarker),
            response: this.getSafeQueryResponseContext(err, response),
        })}`);
    }

    /**
     * Extracts safe request diagnostics without headers, cookies or request bodies.
     * @param zoneId - The zone used for the query
     * @param recordType - The requested record type
     * @param filterBy - Query filters
     * @param resultsLimit - Results limit for this page
     * @param desiredKeys - Desired record fields
     * @param continuationMarker - Continuation marker from a previous page
     * @returns Safe request context
     */
    private getSafeQueryRequestContext(zoneId: PhotosAccountZone, recordType: string, filterBy?: any[], resultsLimit?: number, desiredKeys?: string[], continuationMarker?: string): Record<string, unknown> {
        return {
            area: zoneId.area,
            zone: {
                zoneName: zoneId.zoneName,
                zoneType: zoneId.zoneType,
            },
            endpoint: `${ENDPOINTS.PHOTOS.AREAS[zoneId.area]}${ENDPOINTS.PHOTOS.PATH.QUERY}`,
            recordType,
            filters: filterBy?.map(filter => this.getSafeQueryFilterContext(filter)) ?? [],
            resultsLimit,
            desiredKeys,
            timeoutMs: PHOTOS_METADATA_REQUEST_TIMEOUT_MS,
            continuation: Boolean(continuationMarker),
        };
    }

    /**
     * Extracts safe filter diagnostics without headers, cookies or request bodies.
     * @param filter - The filter to summarize
     * @returns Safe filter details
     */
    private getSafeQueryFilterContext(filter: any): Record<string, unknown> {
        return {
            fieldName: filter?.fieldName,
            systemFieldName: filter?.systemFieldName,
            comparator: filter?.comparator,
            value: this.getSafeQueryValue(filter?.fieldValue?.value),
            type: filter?.fieldValue?.type,
        };
    }

    /**
     * Keeps only primitive request diagnostic values.
     * @param value - The value to sanitize
     * @returns Safe diagnostic value
     */
    private getSafeQueryValue(value: unknown): unknown {
        if (typeof value === `string` || typeof value === `number` || typeof value === `boolean`) {
            return value;
        }

        if (Array.isArray(value)) {
            return value.map(item => this.getSafeQueryValue(item));
        }

        if (value && typeof value === `object` && `recordName` in value) {
            return {
                recordName: (value as {recordName?: unknown}).recordName,
            };
        }

        if (value === undefined || value === null) {
            return value;
        }

        return `<object>`;
    }

    /**
     * Extracts safe response diagnostics from a query failure.
     * @param err - Optional request error
     * @param response - Optional response
     * @returns Safe response context
     */
    private getSafeQueryResponseContext(err?: unknown, response?: AxiosResponse): Record<string, unknown> {
        const axiosResponse = response ?? (err as AxiosError | undefined)?.response;
        const data = axiosResponse?.data;

        return {
            status: axiosResponse?.status,
            code: (err as AxiosError | undefined)?.code,
            serverErrorCode: typeof data?.serverErrorCode === `string` ? data.serverErrorCode : undefined,
            reason: typeof data?.reason === `string` ? data.reason : undefined,
            retryAfter: typeof data?.retryAfter === `number` || typeof data?.retryAfter === `string`
                ? data.retryAfter
                : axiosResponse?.headers?.[`retry-after`],
            recordsReturned: Array.isArray(data?.records) ? data.records.length : undefined,
            continuationReturned: typeof data?.continuationMarker === `string` && data.continuationMarker.length > 0,
        };
    }

    /**
     * Looks up records by record name in the iCloud Photos backend.
     * @param zone - Defines the zone to be used
     * @param recordNames - Record names to look up
     * @param desiredKeys - Optional desired fields to reduce the lookup response
     * @returns The records returned by the backend
     */
    async performLookup(zone: QueryBuilder.Zones, recordNames: string[], desiredKeys?: string[]): Promise<any[]> {
        const config: AxiosRequestConfig = {
            params: {
                remapEnums: `True`,
            },
        };

        const zoneId = QueryBuilder.getZoneID(zone);
        const data: any = {
            records: recordNames.map(recordName => ({recordName})),
            zoneID: {
                zoneName: zoneId.zoneName,
                zoneType: zoneId.zoneType,
                ownerRecordName: zoneId.ownerRecordName,
            },
        };

        if (desiredKeys) {
            data.desiredKeys = desiredKeys;
        }

        const startedAt = Date.now();
        Resources.logger(this).debug(`Looking up ${recordNames.length} iCloud Photos record(s) in ${zone} library`);
        const lookupResponse = await Resources.network().post(ENDPOINTS.PHOTOS.AREAS[zoneId.area] + ENDPOINTS.PHOTOS.PATH.LOOKUP, data, config);
        const fetchedRecords = lookupResponse?.data?.records;
        if (!fetchedRecords || !Array.isArray(fetchedRecords)) {
            throw new iCPSError(ICLOUD_PHOTOS_ERR.UNEXPECTED_LOOKUP_RESPONSE)
                .addContext(`lookupResponse`, lookupResponse);
        }

        Resources.logger(this).debug(`Looked up ${fetchedRecords.length} iCloud Photos record(s) in ${Date.now() - startedAt}ms`);
        return fetchedRecords;
    }

    /**
     * Performs a lookup, recovering from session expiry and retrying transient errors.
     * Used while refreshing download URLs during long syncs: a single failed lookup would otherwise drop the asset for the whole run.
     * A HTTP 421 indicates the Web-Auth session token has expired - retrying the same dead session is futile, so the session is
     * re-acquired before retrying. Other transient errors (timeouts, 429, 5xx) are retried with exponential backoff.
     * @param zone - Defines the zone to be used
     * @param recordNames - Record names to look up
     * @param desiredKeys - Optional desired fields to reduce the lookup response
     * @returns The records returned by the backend
     */
    private async performLookupWithRetry(zone: QueryBuilder.Zones, recordNames: string[], desiredKeys?: string[]): Promise<any[]> {
        let sessionRecovered = false;
        for (let attempt = 1; attempt <= URL_REFRESH_LOOKUP_ATTEMPTS; attempt++) {
            try {
                return await this.performLookup(zone, recordNames, desiredKeys);
            } catch (err) {
                const status = this.retryPolicy.getAxiosError(err)?.response?.status;

                // A 421 means the session token expired - the session needs to be re-acquired, not merely retried.
                // Only attempt this once per lookup to avoid looping if re-authentication does not resolve the failure.
                if (status === SESSION_EXPIRED_STATUS && !sessionRecovered) {
                    sessionRecovered = true;
                    Resources.logger(this).info(`Session token expired while refreshing download URL, re-acquiring session`);
                    await this.recoverExpiredSession();
                    continue;
                }

                if (attempt === URL_REFRESH_LOOKUP_ATTEMPTS || !this.retryPolicy.isRetryableSyncError(err)) {
                    throw err;
                }

                const backoffMs = URL_REFRESH_LOOKUP_BACKOFF_BASE_MS * (2 ** (attempt - 1));
                Resources.logger(this).debug(`Lookup failed (attempt ${attempt}/${URL_REFRESH_LOOKUP_ATTEMPTS}), retrying in ${backoffMs}ms`);
                await new Promise(resolve => setTimeout(resolve, backoffMs));
            }
        }

        throw new iCPSError(ICLOUD_PHOTOS_ERR.UNEXPECTED_LOOKUP_RESPONSE)
            .addMessage(`exhausted retries for ${recordNames.join(`, `)}`);
    }

    /**
     * Re-acquires an expired iCloud session by triggering the existing re-authentication flow and waiting for the Photos
     * service to become ready again. Concurrent callers share a single re-authentication so a wave of simultaneously expiring
     * download workers does not start multiple competing logins.
     * @returns A promise that resolves once the session is ready again, or rejects if re-authentication fails or times out
     */
    private async recoverExpiredSession(): Promise<void> {
        if (!this.sessionRecovery) {
            this.sessionRecovery = this.acquireFreshSession()
                .finally(() => {
                    this.sessionRecovery = undefined;
                });
        }

        await this.sessionRecovery;
    }

    /**
     * Drives a single session re-acquisition: arms listeners for the next readiness/error signal, then emits SESSION_EXPIRED
     * to kick off the re-authentication flow owned by the iCloud class.
     * @returns A promise that resolves on the next READY event, or rejects on ERROR or timeout
     */
    private acquireFreshSession(): Promise<void> {
        const events = Resources.events(this);
        let cleanup = () => undefined;
        const sessionReady = new Promise<void>((resolve, reject) => {
            const onReady = () => {
                cleanup();
                resolve();
            };
            const onError = (err: unknown) => {
                cleanup();
                reject(err);
            };
            cleanup = () => {
                events.removeListener(iCPSEventPhotos.READY, onReady);
                events.removeListener(iCPSEventPhotos.ERROR, onError);
            };
            events
                .once(iCPSEventPhotos.READY, onReady)
                .once(iCPSEventPhotos.ERROR, onError);
        });

        Resources.emit(iCPSEventCloud.SESSION_EXPIRED);

        return pTimeout(sessionReady, {
            milliseconds: Resources.manager().mfaTimeout * 1000 + SESSION_RECOVERY_GRACE_MS,
            message: new iCPSError(ICLOUD_PHOTOS_ERR.DOWNLOAD_URL_REFRESH)
                .addMessage(`timed out re-acquiring expired session`),
        }).finally(cleanup);
    }

    /**
     * Performs a single operation with the iCloud Backend
     * @param zone - Defines the zone to be used
     * @param operationType - The type of operation, that should be performed
     * @param recordNames - The list of recordNames of the asset the operation should be performed on
     * @param fields - The fields to be altered
     * @returns An array of records that have been altered
     */
    async performOperation(zone: QueryBuilder.Zones, operationType: string, fields: any, recordNames: string[]): Promise<any[]> {
        const config: AxiosRequestConfig = {
            params: {
                remapEnums: `True`,
            },
        };

        const zoneId = QueryBuilder.getZoneID(zone)

        const data: any = {
            operations: [],
            zoneID: {
                zoneName: zoneId.zoneName,
                zoneType: zoneId.zoneType,
                ownerRecordName: zoneId.ownerRecordName,
            },
            atomic: true,
        };

        data.operations = recordNames.map(recordName => ({
            operationType: `${operationType}`,
            record: {
                recordName: `${recordName}`,
                recordType: `CPLAsset`,
                recordChangeTag: RECORD_CHANGE_TAG,
                fields,
            },
        }));

        const operationResponse = await Resources.network().post(ENDPOINTS.PHOTOS.AREAS[zoneId.area] + ENDPOINTS.PHOTOS.PATH.MODIFY, data, config);
        const fetchedRecords = operationResponse?.data?.records;
        if (!fetchedRecords || !Array.isArray(fetchedRecords)) {
            throw new iCPSError(ICLOUD_PHOTOS_ERR.UNEXPECTED_OPERATIONS_RESPONSE)
                .addContext(`operationResponse`, operationResponse);
        }

        return fetchedRecords;
    }

    /**
     * Fetches all album records, traversing the directory tree
     * @remarks Since the shared library currently does not support it's own directory tree / WebUI does not show pictures in folders we only do this for the primary zone
     *          Since we are requesting them based on parent folder and are starting from the root folder the results array should yield: If folder A is closer to the root than folder B, the index of A is smaller than the index of B
     * @returns An array of all album records in the account
     * @throws An iCPSError if fetching fails
     */
    async fetchAllCPLAlbums(): Promise<CPLAlbum[]> {
        try {
            const startedAt = Date.now();
            Resources.logger(this).info(`Fetching iCloud album metadata tree`);

            // Processing queue
            const queue: Promise<CPLAlbum[]>[] = [];

            // Final list of all albums
            const albumRecords: CPLAlbum[] = [];

            // Getting root folders as an initial set for the processing queue
            queue.push(this.fetchCPLAlbums());

            while (queue.length > 0) {
                // Getting next item in the queue
                for (const nextAlbum of await queue.shift()) {
                    // If album is a folder, there is stuff in there, adding it to the queue
                    if (nextAlbum.albumType === AlbumType.FOLDER) {
                        Resources.logger(this).debug(`Adding child elements of ${nextAlbum.albumNameEnc} to the processing queue`);
                        queue.push(this.fetchCPLAlbums(nextAlbum.recordName));
                    }

                    // Adding completed album
                    albumRecords.push(nextAlbum);
                }
            }

            Resources.logger(this).info(`Fetched ${albumRecords.length} iCloud album metadata records in ${Date.now() - startedAt}ms`);
            return albumRecords;
        } catch (err) {
            throw new iCPSError(ICLOUD_PHOTOS_ERR.FOLDER_STRUCTURE).addCause(err);
        }
    }

    /**
     * Builds the request to receive all albums and folders for the given folder from the iCloud backend
     * @remarks Since the shared library currently does not support it's own directory tree / WebUI does not show pictures in folders we only do this for the primary zone
     * @param folderId- The record name of the folder. If parent is undefined, all albums without parent will be returned.
     * @returns A promise, that once resolved, contains all subfolders for the provided folder
     */
    buildAlbumRecordsRequest(folderId?: string): Promise<any[]> {
        return folderId === undefined
            ? this.performQuery(QueryBuilder.Zones.Primary, QueryBuilder.RECORD_TYPES.ALBUM_RECORDS)
            : this.performQuery(
                QueryBuilder.Zones.Primary,
                QueryBuilder.RECORD_TYPES.ALBUM_RECORDS,
                [QueryBuilder.getParentFilterForParentId(folderId)],
            );
    }

    /**
     * Filters unwanted picture records before post-processing
     * @param record - The record to be filtered
     * @throws An iCPSError, in case the provided record should be ignored
     */
    filterAlbumRecord(record: any) {
        if (record.deleted === true) {
            throw new iCPSError(ICLOUD_PHOTOS_ERR.DELETED_RECORD)
                .addMessage(record.recordName)
                .addContext(`record`, record);
        }

        if (record.recordName === `----Project-Root-Folder----` || record.recordName === `----Root-Folder----`) {
            throw new iCPSError(ICLOUD_PHOTOS_ERR.UNWANTED_ALBUM)
                .addMessage(record.recordName)
                .addContext(`record`, record);
        }

        if (record.fields.albumType.value !== AlbumType.FOLDER
            && record.fields.albumType.value !== AlbumType.ALBUM) {
            throw new iCPSError(ICLOUD_PHOTOS_ERR.UNKNOWN_ALBUM)
                .addMessage(record.fields.albumType.value)
                .addContext(`record.fields`, record.fields);
        }
    }

    /**
     * Fetching a list of albums identified by their parent.
     * @remarks Since the shared library currently does not support it's own directory tree / WebUI does not show pictures in folders we only do this for the primary zone
     * @param parentId - The record name of the parent folder. If parent is undefined, all albums without parent will be returned.
     * @returns An array of folder and album records. Unwanted folders and folder types are filtered out. Albums have their items included (as a promise)
     */
    async fetchCPLAlbums(parentId?: string): Promise<CPLAlbum[]> {
        const startedAt = Date.now();
        Resources.logger(this).info(`Fetching iCloud album records for ${parentId === undefined ? `root folder` : `parent ${parentId}`}`);
        const cplAlbums: CPLAlbum[] = [];

        for (const album of await this.buildAlbumRecordsRequest(parentId)) {
            try {
                this.filterAlbumRecord(album);

                if (album.fields.albumType.value === AlbumType.ALBUM) {
                    const [albumCPLAssets, albumCPLMasters] = await this.fetchAllCPLAssetsMasters(album.recordName);

                    const albumAssets: AlbumAssets = {};

                    SyncEngineHelper.convertCPLAssets(albumCPLAssets, albumCPLMasters).forEach(asset => {
                        /**
                         * @remarks this probably needs to be more complex to support shared library folders once available from the API
                         */
                        albumAssets[asset.getAssetFilename()] = asset.getPrettyFilename();
                    });

                    cplAlbums.push(CPLAlbum.parseFromQuery(album, albumAssets));
                }

                if (album.fields.albumType.value === AlbumType.FOLDER) {
                    cplAlbums.push(CPLAlbum.parseFromQuery(album));
                }
            } catch (err) {
                const albumError = iCPSError.toiCPSError(err);
                if ([
                    ICLOUD_PHOTOS_ERR.DELETED_RECORD.code,
                    ICLOUD_PHOTOS_ERR.UNWANTED_ALBUM.code,
                    ICLOUD_PHOTOS_ERR.UNKNOWN_ALBUM.code,
                ].includes(albumError.code)) {
                    Resources.logger(this).info(`Ignoring CPLAlbum: ${jsonc.stringify(album)}: ${albumError.getDescription()}`);
                    continue;
                }

                throw new iCPSError(ICLOUD_PHOTOS_ERR.FOLDER_STRUCTURE)
                    .addMessage(album?.recordName ?? `unknown album`)
                    .addCause(err);
            }
        }

        Resources.logger(this).info(`Fetched ${cplAlbums.length} iCloud album records for ${parentId === undefined ? `root folder` : `parent ${parentId}`} in ${Date.now() - startedAt}ms`);
        return cplAlbums;
    }

    /**
     * Returns the number of records currently present in a given album.
     * This is necessary to properly handling splitting up the record requests (keeping iCloud API limitations in mind)
     * @param zone - Defines the zone to be used
     * @param albumId - The record name of the album, if undefined all pictures will be returned
     * @returns The number of assets within the given album
     * @throws An iCPSError in case the count cannot be obtained
     */
    async getPictureRecordsCountForZone(zone: QueryBuilder.Zones, albumId?: string): Promise<number> {
        try {
            const startedAt = Date.now();
            Resources.logger(this).info(`Counting iCloud photo metadata records for album ${albumId === undefined ? `All photos` : albumId} in ${zone} library`);
            const indexCountFilter = QueryBuilder.getIndexCountFilter(albumId);
            const countData = await this.performQuery(
                zone,
                QueryBuilder.RECORD_TYPES.INDEX_COUNT,
                [indexCountFilter],
            );
            const recordCount = Number.parseInt(countData[0].fields.itemCount.value, 10);
            Resources.logger(this).info(`Counted ${recordCount} iCloud photo metadata records for album ${albumId === undefined ? `All photos` : albumId} in ${zone} library in ${Date.now() - startedAt}ms`);
            return recordCount;
        } catch (err) {
            throw new iCPSError(ICLOUD_PHOTOS_ERR.COUNT_DATA)
                .addMessage(`zone ${zone}`)
                .addCause(err);
        }
    }

    /**
     * The iCloud API is limiting the amount of records that can be obtained with a single request.
     * This function determines how many requests are necessary, based on the expected size of the album.
     * @param zone - Defines the zone to be used
     * @param expectedNumberOfRecords - The amount of records expected within the given album
     * @param albumId - The record name of the album, if undefined all pictures will be returned
     * @returns The number of necessary requests.
     */
    getPictureRecordsRequestCountForZone(zone: QueryBuilder.Zones, expectedNumberOfRecords: number, albumId?: string): number {
        const numberOfRequests = albumId === undefined
            ? Math.ceil((expectedNumberOfRecords * 2) / MAX_RECORDS_LIMIT) // On all pictures two records per photo are returned (CPLMaster & CPLAsset) which are counted against max
            : Math.ceil((expectedNumberOfRecords * 3) / MAX_RECORDS_LIMIT); // On folders three records per photo are returned (CPLMaster, CPLAsset & CPLContainerRelation) which are counted against max

        Resources.logger(this).debug(`Expecting ${expectedNumberOfRecords} records for album ${albumId === undefined ? `All photos` : albumId} in ${zone} library, executing ${numberOfRequests} queries`);
        return numberOfRequests;
    }

    /**
     * Fetches one page of picture records.
     * @param zone - Defines the zone to be used
     * @param index - The page index to fetch
     * @param albumId - The record name of the album, if undefined all pictures will be returned
     * @returns Picture records for the requested page
     */
    async fetchPictureRecordsPageForZone(zone: QueryBuilder.Zones, index: number, albumId?: string): Promise<any[]> {
        const startRank = albumId === undefined // The start rank always refers to the tuple/triple of records, therefore we need to adjust the start rank based on the amount of records returned
            ? index * Math.floor(MAX_RECORDS_LIMIT / 2)
            : index * Math.floor(MAX_RECORDS_LIMIT / 3);
        Resources.logger(this).debug(`Fetching query for records of album ${albumId === undefined ? `All photos` : albumId} in ${zone} library at index ${startRank}`);
        const startRankFilter = QueryBuilder.getStartRankFilterForStartRank(startRank);
        const directionFilter = QueryBuilder.getDirectionFilterForDirection();
        const recordType = albumId === undefined
            ? QueryBuilder.RECORD_TYPES.ALL_PHOTOS
            : QueryBuilder.RECORD_TYPES.PHOTO_RECORDS;
        const filterBy = albumId === undefined
            ? [startRankFilter, directionFilter]
            : [startRankFilter, directionFilter, QueryBuilder.getParentFilterForParentId(albumId)];
        const records: any[] = [];
        let continuationMarker: string | undefined;

        do {
            const page = await this.performQueryPage(
                zone,
                recordType,
                filterBy,
                MAX_RECORDS_LIMIT,
                QueryBuilder.QUERY_KEYS,
                continuationMarker,
            );
            records.push(...page.records);
            continuationMarker = page.continuationMarker;
            if (continuationMarker) {
                Resources.logger(this).debug(`Following continuation marker for startRank-paged photo metadata query at index ${startRank}`);
            }
        } while (continuationMarker);

        return records;
    }

    /**
     * Filters unwanted picture records before post-processing
     * @param record - The record to be filtered
     * @param seen - An array of previously seen recordNames
     * @throws An iCPSError, in case the provided record should be ignored
     */
    filterPictureRecord(record: any, seen: Set<string>) {
        if (record?.deleted === true) {
            throw new iCPSError(ICLOUD_PHOTOS_ERR.DELETED_RECORD)
                .addContext(`record`, record);
        }

        if (record.fields?.isHidden?.value === 1) {
            throw new iCPSError(ICLOUD_PHOTOS_ERR.HIDDEN_RECORD)
                .addContext(`record`, record);
        }

        // If (Object.prototype.hasOwnProperty.call(seen, record.recordName)) {
        if (seen.has(record.recordName)) {
            throw new iCPSError(ICLOUD_PHOTOS_ERR.DUPLICATE_RECORD)
                .addContext(`record`, record);
        }

        if (record.recordType === QueryBuilder.RECORD_TYPES.CONTAINER_RELATION) {
            throw new iCPSError(ICLOUD_PHOTOS_ERR.UNWANTED_RECORD_TYPE)
                .addMessage(record.recordType)
                .addContext(`recordType`, record.recordType);
        }

        if (record.recordType !== QueryBuilder.RECORD_TYPES.PHOTO_MASTER_RECORD
            && record.recordType !== QueryBuilder.RECORD_TYPES.PHOTO_ASSET_RECORD) {
            throw new iCPSError(ICLOUD_PHOTOS_ERR.UNKNOWN_RECORD_TYPE)
                .addMessage(record.recordType)
                .addContext(`recordType`, record.recordType);
        }
    }

    /**
     * Fetching all pictures associated to an album within the given zone, identified by parentId
     * @param zone - Defines the zone to be used
     * @param parentId - The record name of the album, if undefined all pictures will be returned
     * @returns A tuple containing the plain records as returned by the backend and the expected number of assets within the album
     */
    async fetchAllPictureRecordsForZone(zone: QueryBuilder.Zones, parentId?: string): Promise<[any[], number]> {
        const startedAt = Date.now();
        const albumName = parentId === undefined ? `All photos` : parentId;
        Resources.emit(iCPSEventPhotos.FETCH_PROGRESS, `Counting remote asset metadata (${zone} library, ${albumName})...`);
        // Getting number of items in folder
        const expectedNumberOfRecords = await this.getPictureRecordsCountForZone(zone, parentId);

        const numberOfRequests = this.getPictureRecordsRequestCountForZone(zone, expectedNumberOfRecords, parentId);
        const allRecords: any[] = [];
        const concurrency = Math.min(PHOTO_METADATA_PAGE_CONCURRENCY, Math.max(numberOfRequests, 1));
        Resources.emit(iCPSEventPhotos.FETCH_PROGRESS, `Fetching remote asset metadata (${zone} library, ${albumName}): 0/${numberOfRequests} page batches`);

        for (let startIndex = 0; startIndex < numberOfRequests; startIndex += concurrency) {
            const pageIndexes = Array.from(
                {length: Math.min(concurrency, numberOfRequests - startIndex)},
                (_unused, offset) => startIndex + offset,
            );
            Resources.logger(this).info(`Fetching iCloud photo metadata pages ${pageIndexes[0] + 1}-${pageIndexes[pageIndexes.length - 1] + 1}/${numberOfRequests} for album ${parentId === undefined ? `All photos` : parentId} in ${zone} library`);
            const pages = await Promise.all(pageIndexes.map(index => this.fetchPictureRecordsPageForZone(zone, index, parentId)));
            pages.forEach(page => allRecords.push(...page));
            Resources.emit(iCPSEventPhotos.FETCH_PROGRESS, `Fetching remote asset metadata (${zone} library, ${albumName}): pages ${pageIndexes[0] + 1}-${pageIndexes[pageIndexes.length - 1] + 1}/${numberOfRequests}, ${allRecords.length} raw records`);
            Resources.logger(this).info(`Fetched iCloud photo metadata pages ${pageIndexes[0] + 1}-${pageIndexes[pageIndexes.length - 1] + 1}/${numberOfRequests} for album ${parentId === undefined ? `All photos` : parentId} in ${zone} library (${allRecords.length} raw records accumulated)`);
        }

        Resources.logger(this).info(`Fetched ${allRecords.length} raw iCloud photo metadata records for album ${parentId === undefined ? `All photos` : parentId} in ${zone} library in ${Date.now() - startedAt}ms`);
        return [allRecords, expectedNumberOfRecords];
    }

    /**
     * Fetching all pictures associated to an album, identified by parentId
     * @param parentId - The record name of the album, if undefined all pictures will be returned
     * @returns An array of CPLMaster and CPLAsset records
     * @throws An iCPSError, in case the records could not be fetched
     * @emits iCPSEventRuntimeWarning.COUNT_MISMATCH - In case the number of fetched records does not match the expected number of records -  provides the album id, number of expected assets, actual CPL Assets and actual CPL Masters
     */
    async fetchAllCPLAssetsMasters(parentId?: string): Promise<[CPLAsset[], CPLMaster[]]> {
        const startedAt = Date.now();
        Resources.logger(this).info(`Fetching all picture records for album ${parentId === undefined ? `All photos` : parentId}`);

        let expectedNumberOfRecords = -1;
        let allRecords: any[] = [];
        const cplMasters: CPLMaster[] = [];
        const cplAssets: CPLAsset[] = [];
        try {
            [allRecords, expectedNumberOfRecords] = await this.fetchAllPictureRecordsForZone(QueryBuilder.Zones.Primary, parentId);

            // Merging assets of shared library, if available
            if (Resources.manager().sharedZoneAvailable && typeof parentId === `undefined`) { // Only fetch shared album records if no parentId is specified, since icloud api does not yet support shared records in albums
                Resources.logger(this).info(`Fetching all picture records for album ${parentId === undefined ? `All photos` : parentId} for shared zone`);
                const [sharedRecords, sharedExpectedCount] = await this.fetchAllPictureRecordsForZone(QueryBuilder.Zones.Shared);
                allRecords = [...allRecords, ...sharedRecords];
                expectedNumberOfRecords += sharedExpectedCount;
            }
        } catch (err) {
            throw new iCPSError(ICLOUD_PHOTOS_ERR.FETCH_RECORDS)
                .addMessage(`album ${parentId === undefined ? `'All photos'` : parentId}`)
                .addCause(err);
        }

        // Post-processing response
        const seen = new Set<string>();
        const ignoredAssets: iCPSError[] = [];
        for (const record of allRecords) {
            try {
                this.filterPictureRecord(record, seen);

                if (record.recordType === QueryBuilder.RECORD_TYPES.PHOTO_MASTER_RECORD) {
                    cplMasters.push(CPLMaster.parseFromQuery(record));
                    seen.add(record.recordName);
                }

                if (record.recordType === QueryBuilder.RECORD_TYPES.PHOTO_ASSET_RECORD) {
                    cplAssets.push(CPLAsset.parseFromQuery(record));
                    seen.add(record.recordName);
                }
            } catch (err) {
                // Summarizing errors/warnings
                ignoredAssets.push((err as iCPSError));
            }
        }

        await this.fetchMissingCPLMasters(cplAssets, cplMasters, parentId);

        // Pretty printing ignored assets
        if (ignoredAssets.length > 0) {
            Resources.logger(this).info(`Ignoring ${ignoredAssets.length} assets for ${parentId === undefined ? `All photos` : parentId}:`);
            const erroredAssets = ignoredAssets.filter(err => err.code !== ICLOUD_PHOTOS_ERR.UNWANTED_RECORD_TYPE.code); // Filtering 'expected' errors
            if (erroredAssets.length > 0) {
                Resources.logger(this).warn(`${erroredAssets.length} unexpected errors for ${parentId === undefined ? `All photos` : parentId}: ${erroredAssets.map(err => err.code).join(`, `)}`);
            }
        }

        // There should be one CPLMaster and one CPLAsset per record, however the iCloud response is sometimes not adhering to this.
        if (cplMasters.length !== expectedNumberOfRecords || cplAssets.length !== expectedNumberOfRecords) {
            Resources.emit(iCPSEventRuntimeWarning.COUNT_MISMATCH,
                parentId === undefined ? `All photos` : parentId,
                expectedNumberOfRecords,
                cplAssets.length,
                cplMasters.length,
            );
        } else {
            Resources.logger(this).debug(`Received expected amount (${expectedNumberOfRecords}) of records for album ${parentId === undefined ? `'All photos'` : parentId}`);
        }

        Resources.logger(this).info(`Parsed ${cplAssets.length} CPLAsset and ${cplMasters.length} CPLMaster records for album ${parentId === undefined ? `All photos` : parentId} in ${Date.now() - startedAt}ms`);
        return [cplAssets, cplMasters];
    }

    /**
     * Looks up CPLMaster records missing from the paged metadata response.
     * @param cplAssets - Parsed CPLAsset records
     * @param cplMasters - Parsed CPLMaster records to append to
     * @param parentId - Current album id, if any
     */
    private async fetchMissingCPLMasters(cplAssets: CPLAsset[], cplMasters: CPLMaster[], parentId?: string): Promise<void> {
        const knownMasterNames = new Set(cplMasters.map(master => master.recordName));
        const missingMasterNamesByZone = new Map<QueryBuilder.Zones, Set<string>>();
        for (const asset of cplAssets) {
            if (knownMasterNames.has(asset.masterRef)) {
                continue;
            }

            const zone = asset.zoneName === `PrimarySync` ? QueryBuilder.Zones.Primary : QueryBuilder.Zones.Shared;
            const missingMasterNames = missingMasterNamesByZone.get(zone) ?? new Set<string>();
            missingMasterNames.add(asset.masterRef);
            missingMasterNamesByZone.set(zone, missingMasterNames);
        }

        for (const [zone, missingMasterNames] of missingMasterNamesByZone) {
            Resources.logger(this).warn(`Looking up ${missingMasterNames.size} missing CPLMaster record(s) for album ${parentId === undefined ? `All photos` : parentId} in ${zone} library`);
            const missingMasterRecords = await this.performLookupWithRetry(zone, [...missingMasterNames], QueryBuilder.QUERY_KEYS);
            for (const record of missingMasterRecords) {
                this.filterPictureRecord(record, knownMasterNames);
                if (record.recordType !== QueryBuilder.RECORD_TYPES.PHOTO_MASTER_RECORD) {
                    throw new iCPSError(ICLOUD_PHOTOS_ERR.UNEXPECTED_LOOKUP_RESPONSE)
                        .addMessage(`expected CPLMaster for missing master lookup, got ${record.recordType}`);
                }

                const master = CPLMaster.parseFromQuery(record);
                if (!knownMasterNames.has(master.recordName)) {
                    cplMasters.push(master);
                    knownMasterNames.add(master.recordName);
                }
            }
        }
    }

    /**
     * Downloads an asset to the correct file location and applies relevant metadata to the file
     * @param asset - The asset to be downloaded
     * @returns A promise, that resolves, once the asset has been written to disk
     * @throws An error, in case the asset could not be downloaded
     */
    async downloadAsset(asset: Asset): Promise<void> {
        const location = asset.getAssetFilePath();
        const displayName = this.getAssetDownloadDisplayName(asset);
        try {
            await Resources.network().downloadData(asset.downloadURL, location, displayName);
        } catch (err) {
            if (!this.isExpiredDownloadURLError(err)) {
                throw err;
            }

            Resources.logger(this).debug(`iCloud download URL expired for ${displayName}, refreshing URL and retrying`);
            await this.refreshAssetDownloadURL(asset);
            await Resources.network().downloadData(asset.downloadURL, location, displayName);
        }

        await fs.utimes(location, new Date(asset.modified), new Date(asset.modified)); // Setting modified date on file
    }

    /**
     * Gets a human-facing asset name for download diagnostics.
     * @param asset - The asset being downloaded
     * @returns A filename suitable for logs
     */
    private getAssetDownloadDisplayName(asset: Asset): string {
        if (asset.origFilename) {
            return asset.getPrettyFilename();
        }

        return asset.getAssetFilename();
    }

    /**
     * Detects iCloud's response for an expired signed asset download URL.
     * @param err - Error thrown by the download request
     * @returns True if the request failed because the download URL expired
     */
    private isExpiredDownloadURLError(err: unknown): boolean {
        const axiosError = err as AxiosError | undefined;
        return Boolean((axiosError?.isAxiosError || axiosError?.name === `AxiosError`)
            && axiosError?.response?.status === EXPIRED_DOWNLOAD_URL_STATUS);
    }

    /**
     * Refreshes the signed download URL on an asset by looking up its current CloudKit record.
     * @param asset - The asset whose URL should be refreshed
     */
    private async refreshAssetDownloadURL(asset: Asset): Promise<void> {
        try {
            const downloadRecordName = asset.downloadRecordName ?? asset.recordName;
            if (!downloadRecordName) {
                throw new iCPSError(ICLOUD_PHOTOS_ERR.DOWNLOAD_URL_REFRESH)
                    .addMessage(`missing download record name`);
            }

            const [record] = await this.performLookupWithRetry(asset.zone, [downloadRecordName], QueryBuilder.QUERY_KEYS);
            if (!record) {
                throw new iCPSError(ICLOUD_PHOTOS_ERR.UNEXPECTED_LOOKUP_RESPONSE)
                    .addMessage(`no record returned for ${downloadRecordName}`);
            }

            await this.applyDownloadURLFromRecord(asset, record);
        } catch (err) {
            throw new iCPSError(ICLOUD_PHOTOS_ERR.DOWNLOAD_URL_REFRESH)
                .addMessage(asset.getDisplayName())
                .addCause(err);
        }
    }

    /**
     * Applies a refreshed download URL from a looked-up CPLMaster or CPLAsset record.
     * @param asset - The asset being refreshed
     * @param record - The CloudKit record returned by lookup
     */
    private async applyDownloadURLFromRecord(asset: Asset, record: any): Promise<void> {
        if (record.recordType === QueryBuilder.RECORD_TYPES.PHOTO_MASTER_RECORD) {
            asset.downloadURL = AssetID.parseFromQuery(record.fields?.resOriginalRes).downloadURL;
            return;
        }

        if (record.recordType === QueryBuilder.RECORD_TYPES.PHOTO_ASSET_RECORD && asset.assetType === AssetType.ORIG) {
            const masterRecordName = record.fields?.masterRef?.value?.recordName;
            if (!masterRecordName) {
                throw new iCPSError(ICLOUD_PHOTOS_ERR.UNEXPECTED_LOOKUP_RESPONSE)
                    .addMessage(`CPLAsset lookup did not include masterRef`);
            }

            asset.downloadRecordName = masterRecordName;
            const [masterRecord] = await this.performLookupWithRetry(asset.zone, [masterRecordName], QueryBuilder.QUERY_KEYS);
            if (!masterRecord) {
                throw new iCPSError(ICLOUD_PHOTOS_ERR.UNEXPECTED_LOOKUP_RESPONSE)
                    .addMessage(`no master record returned for ${masterRecordName}`);
            }

            await this.applyDownloadURLFromRecord(asset, masterRecord);
            return;
        }

        if (record.recordType === QueryBuilder.RECORD_TYPES.PHOTO_ASSET_RECORD) {
            const assetIdRecord = record.fields?.resJPEGFullRes ?? record.fields?.resVidFullRes;
            if (!assetIdRecord) {
                throw new iCPSError(ICLOUD_PHOTOS_ERR.UNEXPECTED_LOOKUP_RESPONSE)
                    .addMessage(`CPLAsset lookup did not include a downloadable resource`);
            }

            asset.downloadURL = AssetID.parseFromQuery(assetIdRecord).downloadURL;
            return;
        }

        throw new iCPSError(ICLOUD_PHOTOS_ERR.UNEXPECTED_LOOKUP_RESPONSE)
            .addMessage(`unexpected record type ${record.recordType}`);
    }

    /**
     * Deletes the records in the remote library
     * @remarks Since the shared library currently does not support it's own directory tree / WebUI does not show pictures in folders we only do this for the primary zone, because archiving is only possible of folders
     * @param recordNames - A list of record names that need to be deleted
     * @returns A Promise, that fulfils once the operation has been performed
     * @throws An iCPSError, in case the records could not be deleted
     */
    async deleteAssets(recordNames: string[]) {
        Resources.logger(this).debug(`Deleting ${recordNames.length} assets: ${jsonc.stringify(recordNames)}`);
        await this.performOperation(QueryBuilder.Zones.Primary, `update`, QueryBuilder.getIsDeletedField(), recordNames);
    }
}
