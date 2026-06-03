import {iCloud} from '../icloud/icloud.js';
import {PhotosLibrary} from '../photos-library/photos-library.js';
import {Asset} from '../photos-library/model/asset.js';
import {Album, AlbumType} from '../photos-library/model/album.js';
import {PLibraryEntities, PLibraryProcessingQueues} from '../photos-library/model/photos-entity.js';
import {iCPSError} from '../../app/error/error.js';
import {SYNC_ERR} from '../../app/error/error-codes.js';
import {Resources} from '../resources/main.js';
import {SyncEngineHelper} from './helper.js';
import {iCPSEventRuntimeWarning, iCPSEventSyncEngine} from '../resources/events-types.js';
import {AxiosError} from 'axios';

const RETRY_BACKOFF_BASE_MS = 30 * 1000;
const RETRY_BACKOFF_MAX_MS = 5 * 60 * 1000;
const RETRY_BACKOFF_JITTER_MS = 5 * 1000;
const RETRYABLE_HTTP_STATUS_CODES = new Set([408, 409, 421, 425, 429, 500, 502, 503, 504]);
const ASSET_PROGRESS_LOG_INTERVAL = 25;

/**
 * This class handles the photos sync
 */
export class SyncEngine {
    /**
     * The iCloud connection
     */
    icloud: iCloud;

    /**
     * The local PhotosLibrary
     */
    photosLibrary: PhotosLibrary;

    /**
     * Creates a new sync engine from the previously created objects and CLI options
     * @param icloud - The iCloud object
     * @param photosLibrary - The photos library object
     */
    constructor(icloud: iCloud, photosLibrary: PhotosLibrary) {
        this.icloud = icloud;
        this.photosLibrary = photosLibrary;
    }

    /**
     * Performs the sync and handles all connections and retries
     * @returns A tuple consisting of assets and albums as fetched from the remote state. It can be assumed that this reflects the local state (given a warning free execution of the sync)
     * @throws An iCPSError, in case the sync could not be completed within the amount of allowed retries
     * @emits iCPSEventSyncEngine.START - When the sync starts
     * @emits iCPSEventSyncEngine.DONE - When the sync is done
     * @emits iCPSEventSyncEngine.RETRY - When the sync is retried - The first argument is the retry count, the second argument is the error that caused the retry
     *
     */
    async sync(): Promise<[Asset[], Album[]]> {
        Resources.logger(this).info(`Starting sync`);
        Resources.emit(iCPSEventSyncEngine.START);
        let retryCount = 1;

        // Keeping track of all previous errors in case we reach retry limit
        const retryError = new iCPSError(SYNC_ERR.MAX_RETRY);

        while (Resources.manager().maxRetries >= retryCount) {
            Resources.logger(this).info(`Performing sync, try #${retryCount}`);
            try {
                const [remoteAssets, remoteAlbums, localAssets, localAlbums] = await this.fetchAndLoadState();
                const [assetQueue, albumQueue] = await this.diffState(remoteAssets, remoteAlbums, localAssets, localAlbums);
                await this.writeState(assetQueue, albumQueue);
                Resources.logger(this).info(`Completed sync!`);
                Resources.emit(iCPSEventSyncEngine.DONE);
                return [remoteAssets, remoteAlbums];
            } catch (err) {
                const failedAttempt = retryCount;
                const syncError = this.buildSyncError(err);
                retryError.addContext(`error-try-${failedAttempt}`, this.getRetryErrorContext(err));
                retryCount++;

                if (!this.isRetryableSyncError(err)) {
                    Resources.logger(this).warn(`Not retrying non-retryable sync error: ${syncError.getDescription()}`);
                    throw syncError;
                }

                if (Resources.manager().maxRetries < retryCount) {
                    break;
                }

                const backoffMs = this.getRetryBackoffMs(retryCount, err);
                Resources.emit(iCPSEventSyncEngine.RETRY, retryCount, syncError, backoffMs);

                Resources.logger(this).info(`Settling outstanding network requests before sync retry #${retryCount}`);
                await Resources.network().settleRateLimiter();
                await Resources.network().settleCCYLimiter();
                Resources.logger(this).info(`Outstanding network requests settled before sync retry #${retryCount}`);
                await this.waitForRetryBackoff(retryCount, backoffMs);

                if (!await this.refreshICloudConnection(failedAttempt, retryError)) {
                    return [[], []];
                }
            }
        }

        // We'll only reach this, if we exceeded retryCount
        throw retryError.addMessage(`${retryCount}`);
    }

    /**
     * Refreshes the iCloud account/session and Photos service state before a retry.
     * @param failedAttempt - The sync attempt that triggered this recovery
     * @param retryError - The aggregate retry error to annotate if recovery fails
     * @returns False if MFA timed out while recovering, true otherwise
     */
    private async refreshICloudConnection(failedAttempt: number, retryError: iCPSError): Promise<boolean> {
        Resources.logger(this).debug(`Refreshing iCloud connection...`);
        try {
            const iCloudReady = this.icloud.getReady();
            await this.icloud.setupAccount();
            if (!await iCloudReady) {
                return false;
            }

            await this.icloud.photos.setup();
        } catch (refreshErr) {
            retryError.addContext(`error-try-${failedAttempt}-refresh`, this.getRetryErrorContext(refreshErr));
            Resources.logger(this).warn(`Unable to refresh iCloud connection before retry: ${iCPSError.toiCPSError(refreshErr).getDescription()}`);
        }

        return true;
    }

    /**
     * Waits before the next retry attempt using a bounded exponential backoff.
     * @param retryCount - The retry attempt number that will run after the delay
     * @param backoffMs - The number of milliseconds to wait
     */
    private async waitForRetryBackoff(retryCount: number, backoffMs: number): Promise<void> {
        Resources.logger(this).info(`Waiting ${Math.ceil(backoffMs / 1000)}s before sync retry #${retryCount}`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
    }

    /**
     * Computes a bounded exponential backoff delay with small jitter.
     * @param retryCount - The retry attempt number that will run after the delay
     * @param err - The original error, inspected for retryAfter guidance
     * @returns Delay in milliseconds
     */
    private getRetryBackoffMs(retryCount: number, err?: unknown): number {
        const retryAfterMs = this.getRetryAfterMs(err);
        if (retryAfterMs !== undefined) {
            return retryAfterMs;
        }

        const exponentialDelay = RETRY_BACKOFF_BASE_MS * (2 ** Math.max(retryCount - 2, 0));
        const cappedDelay = Math.min(exponentialDelay, RETRY_BACKOFF_MAX_MS);
        return cappedDelay + Math.floor(Math.random() * RETRY_BACKOFF_JITTER_MS);
    }

    /**
     * Builds a sync-level error while preserving the original cause chain.
     * @param err - The original error
     * @returns The sync-level error
     */
    private buildSyncError(err: unknown): iCPSError {
        const cause = err instanceof Error ? err : iCPSError.toiCPSError(err);
        return new iCPSError(this.getAxiosError(err) ? SYNC_ERR.NETWORK : SYNC_ERR.UNKNOWN)
            .addCause(cause);
    }

    /**
     * Determines whether a failed sync request should be retried.
     * @param err - The original error
     * @returns True if retrying is expected to help
     */
    private isRetryableSyncError(err: unknown): boolean {
        const axiosError = this.getAxiosError(err);
        if (!axiosError?.response?.status) {
            return true;
        }

        return RETRYABLE_HTTP_STATUS_CODES.has(axiosError.response.status);
    }

    /**
     * Extracts the root Axios error from an app error cause chain.
     * @param err - The original error
     * @returns The nested Axios error, if present
     */
    private getAxiosError(err: unknown): AxiosError | undefined {
        const seen = new Set<unknown>();
        let current = err;

        while (current instanceof Error && !seen.has(current)) {
            seen.add(current);
            if ((current as AxiosError).isAxiosError || current.name === `AxiosError`) {
                return current as AxiosError;
            }

            current = (current as Error & {cause?: unknown}).cause;
        }

        return undefined;
    }

    /**
     * Creates safe retry context without request bodies, credentials or headers.
     * @param err - The original error
     * @returns A sanitized error context object
     */
    private getRetryErrorContext(err: unknown): Record<string, unknown> {
        const syncError = this.buildSyncError(err);
        const context: Record<string, unknown> = {
            description: syncError.getDescription(),
            errorCodeStack: syncError.getErrorCodeStack(),
        };

        const axiosError = this.getAxiosError(err);
        if (axiosError) {
            context.request = this.getAxiosRequestContext(axiosError);
        }

        return context;
    }

    /**
     * Returns safe request metadata for retry diagnostics.
     * @param axiosError - The Axios error to inspect
     * @returns Request metadata without headers or body
     */
    private getAxiosRequestContext(axiosError: AxiosError): Record<string, unknown> {
        const requestContext: Record<string, unknown> = {};

        if (axiosError.code) {
            requestContext.code = axiosError.code;
        }

        if (axiosError.config?.method) {
            requestContext.method = axiosError.config.method.toUpperCase();
        }

        if (axiosError.config?.url) {
            requestContext.endpoint = this.getSafeEndpoint(axiosError.config.url);
        }

        if (axiosError.response?.status) {
            requestContext.status = axiosError.response.status;
        }

        const retryAfterMs = this.getRetryAfterMs(axiosError);
        if (retryAfterMs !== undefined) {
            requestContext.retryAfterMs = retryAfterMs;
        }

        return requestContext;
    }

    /**
     * Extracts retryAfter guidance from CloudKit error payloads or HTTP headers.
     * @param err - The original error
     * @returns The delay in milliseconds, if provided
     */
    private getRetryAfterMs(err: unknown): number | undefined {
        const axiosError = this.getAxiosError(err);
        const responseData = axiosError?.response?.data as {retryAfter?: unknown} | undefined;
        const retryAfter = responseData?.retryAfter ?? axiosError?.response?.headers?.[`retry-after`];
        if (typeof retryAfter === `number` && Number.isFinite(retryAfter) && retryAfter > 0) {
            return retryAfter * 1000;
        }

        if (typeof retryAfter !== `string` || retryAfter.length === 0) {
            return undefined;
        }

        const retryAfterSeconds = Number.parseFloat(retryAfter);
        if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
            return retryAfterSeconds * 1000;
        }

        const retryAfterDateMs = Date.parse(retryAfter);
        if (Number.isFinite(retryAfterDateMs) && retryAfterDateMs > Date.now()) {
            return retryAfterDateMs - Date.now();
        }

        return undefined;
    }

    /**
     * Strips query parameters and host information from URLs for safe diagnostics.
     * @param url - The URL to sanitize
     * @returns A safe endpoint path
     */
    private getSafeEndpoint(url: string): string {
        try {
            return new URL(url).pathname;
        } catch (_err) {
            return url.split(`?`)[0];
        }
    }

    /**
     * This function fetches the remote state and loads the local state from disk
     * @returns A promise that resolve once the fetch was completed, containing the remote & local state - remote album state is in order
     * @emits iCPSEventSyncEngine.FETCH_N_LOAD - When the fetch & load starts
     * @emits iCPSEventSyncEngine.FETCH_N_LOAD_COMPLETED - When the fetch & load is done - The first argument is the amount of remote assets, the second argument is the amount of remote albums, the third argument is the amount of local assets, the fourth argument is the amount of local albums
     */
    async fetchAndLoadState(): Promise<[Asset[], Album[], PLibraryEntities<Asset>, PLibraryEntities<Album>]> {
        const startedAt = Date.now();
        Resources.emit(iCPSEventSyncEngine.FETCH_N_LOAD);
        Resources.logger(this).info(`Starting remote iCloud and local library state load`);
        const localState = Promise.all([
            this.photosLibrary.loadAssets(),
            this.photosLibrary.loadAlbums(),
        ]);

        const remoteAssetStartedAt = Date.now();
        Resources.logger(this).info(`Fetching remote iCloud asset metadata`);
        const [cplAssets, cplMasters] = await this.icloud.photos.fetchAllCPLAssetsMasters();
        Resources.logger(this).info(`Fetched remote iCloud asset metadata in ${Date.now() - remoteAssetStartedAt}ms; converting ${cplAssets.length} assets and ${cplMasters.length} masters`);
        const remoteAssets = SyncEngineHelper.convertCPLAssets(cplAssets, cplMasters);
        Resources.logger(this).info(`Converted ${remoteAssets.length} remote iCloud assets`);

        const remoteAlbumStartedAt = Date.now();
        Resources.logger(this).info(`Fetching remote iCloud album metadata`);
        const cplAlbums = await this.icloud.photos.fetchAllCPLAlbums();
        Resources.logger(this).info(`Fetched remote iCloud album metadata in ${Date.now() - remoteAlbumStartedAt}ms; converting ${cplAlbums.length} albums`);
        const remoteAlbums = SyncEngineHelper.convertCPLAlbums(cplAlbums);
        Resources.logger(this).info(`Converted ${remoteAlbums.length} remote iCloud albums`);

        Resources.logger(this).info(`Waiting for local Photos library state load`);
        const [localAssets, localAlbums] = await localState;
        Resources.logger(this).info(`Loaded local Photos library state with ${Object.keys(localAssets).length} assets and ${Object.keys(localAlbums).length} albums`);

        Resources.emit(iCPSEventSyncEngine.FETCH_N_LOAD_COMPLETED, remoteAssets.length, remoteAlbums.length, Object.keys(localAssets).length, Object.keys(localAlbums).length);
        Resources.logger(this).info(`Completed remote iCloud and local library state load in ${Date.now() - startedAt}ms`);
        return [remoteAssets, remoteAlbums, localAssets, localAlbums];
    }

    /**
     * This function diffs the provided local state with the given remote state
     * @param remoteAssets - An array of all remote assets
     * @param remoteAlbums - An array of all remote albums
     * @param localAssets - A list of local assets
     * @param localAlbums - A list of local albums
     * @returns A promise that, once resolved, will contain processing queues that can be used in order to sync the remote state.
     * @emits iCPSEventSyncEngine.DIFF - When the diff starts
     * @emits iCPSEventSyncEngine.DIFF_COMPLETED - When the diff is done
     */
    async diffState(remoteAssets: Asset[], remoteAlbums: Album[], localAssets: PLibraryEntities<Asset>, localAlbums: PLibraryEntities<Album>): Promise<[PLibraryProcessingQueues<Asset>, PLibraryProcessingQueues<Album>]> {
        Resources.emit(iCPSEventSyncEngine.DIFF);
        Resources.logger(this).info(`Diffing state`);
        const [assetQueue, albumQueue] = await Promise.all([
            SyncEngineHelper.getProcessingQueues(remoteAssets, localAssets),
            SyncEngineHelper.getProcessingQueues(remoteAlbums, localAlbums),
        ]);
        const resolvedAlbumQueue = SyncEngineHelper.resolveHierarchicalDependencies(albumQueue, localAlbums);
        Resources.emit(iCPSEventSyncEngine.DIFF_COMPLETED);
        return [assetQueue, resolvedAlbumQueue];
    }

    /**
     * Takes the processing queues and performs the necessary actions to write them to disk
     * @param assetQueue - The queue containing assets that need to be written to, or deleted from disk
     * @param albumQueue - The queue containing albums that need to be written to, or deleted from disk
     * @returns A promise that will settle, once the state has been written to disk
     * @emits iCPSEventSyncEngine.WRITE - When the write starts
     * @emits iCPSEventSyncEngine.WRITE_ASSETS - When the write of assets starts - The first argument is the amount of assets that need to be delete, the second argument is the amount of assets that need to be added, the third argument is the amount of assets that will be kept
     * @emits iCPSEventSyncEngine.WRITE_ASSETS_COMPLETED - When the write of assets is done
     * @emits iCPSEventSyncEngine.WRITE_ALBUMS - When the write of albums starts - The first argument is the amount of albums that need to be delete, the second argument is the amount of albums that need to be added, the third argument is the amount of albums that will be kept
     * @emits iCPSEventSyncEngine.WRITE_ALBUMS_COMPLETED - When the write of albums is done
     * @emits iCPSEventSyncEngine.WRITE_COMPLETED - When the write is done
     */
    async writeState(assetQueue: PLibraryProcessingQueues<Asset>, albumQueue: PLibraryProcessingQueues<Album>) {
        Resources.emit(iCPSEventSyncEngine.WRITE);
        Resources.logger(this).info(`Writing state`);

        Resources.emit(iCPSEventSyncEngine.WRITE_ASSETS, assetQueue[0].length, assetQueue[1].length, assetQueue[2].length);
        await this.writeAssets(assetQueue);
        Resources.emit(iCPSEventSyncEngine.WRITE_ASSETS_COMPLETED);

        Resources.emit(iCPSEventSyncEngine.WRITE_ALBUMS, albumQueue[0].length, albumQueue[1].length, albumQueue[2].length);
        await this.writeAlbums(albumQueue);
        Resources.emit(iCPSEventSyncEngine.WRITE_ALBUMS_COMPLETED);

        Resources.emit(iCPSEventSyncEngine.WRITE_COMPLETED);
    }

    /**
     * Writes the asset changes defined in the processing queue to to disk (by downloading the asset or deleting it)
     * @param processingQueue - The asset processing queue
     * @returns A promise that settles, once all asset changes have been written to disk
     */
    async writeAssets(processingQueue: PLibraryProcessingQueues<Asset>) {
        const toBeDeleted = processingQueue[0];
        const toBeAdded = processingQueue[1];
        // Initializing sync queue

        Resources.logger(this).info(`Writing assets by deleting ${toBeDeleted.length} local asset(s) and adding ${toBeAdded.length} remote asset(s)`);

        // Deleting before downloading, in order to ensure no conflicts
        await Promise.all(toBeDeleted.map(asset => this.photosLibrary.deleteAsset(asset)));

        let completedAssets = 0;
        await Promise.all(toBeAdded.map(async asset => {
            await this.addAsset(asset);
            completedAssets++;
            if (completedAssets % ASSET_PROGRESS_LOG_INTERVAL === 0 || completedAssets === toBeAdded.length) {
                Resources.logger(this).info(`Asset sync progress: ${completedAssets}/${toBeAdded.length}`);
            }
        }));
    }

    /**
     * Downloads and stores a given asset, unless file is already present on disk
     * @param asset - The asset that needs to be downloaded
     * @returns A promise that resolves, once the file has been successfully written to disk
     * @emits iCPSEventSyncEngine.WRITE_ASSET_COMPLETED - When the asset has been written to disk - The first argument is the name of the asset
     * @emits iCPSEventRuntimeWarning.WRITE_ASSET_ERROR - When an error occurs while writing the asset to disk - The first argument is the error, the second argument is the asset
     */
    async addAsset(asset: Asset) {
        try {
            await this.icloud.photos.downloadAsset(asset);
            await asset.verify();
        } catch (err) {
            await this.deleteFailedAsset(asset);
            Resources.emit(iCPSEventRuntimeWarning.WRITE_ASSET_ERROR, err, asset);
            return;
        }

        Resources.emit(iCPSEventSyncEngine.WRITE_ASSET_COMPLETED, this.getAssetProgressDisplayName(asset));
    }

    /**
     * Removes a failed local asset so the next sync attempt starts with a clean download.
     * @param asset - The asset that failed while being written
     */
    private async deleteFailedAsset(asset: Asset): Promise<void> {
        try {
            await this.photosLibrary.deleteAsset(asset);
        } catch (err) {
            Resources.logger(this).warn(`Unable to delete failed asset ${this.getAssetProgressDisplayName(asset)}: ${iCPSError.toiCPSError(err).getDescription()}`);
        }
    }

    /**
     * Gets a human-facing asset name for progress messages.
     * @param asset - The asset being processed
     * @returns A filename suitable for logs and the Web UI
     */
    private getAssetProgressDisplayName(asset: Asset): string {
        if (asset.origFilename) {
            return asset.getPrettyFilename();
        }

        return asset.getAssetFilename();
    }

    /**
     * Writes the album changes defined in the processing queue to to disk
     * @param processingQueue - The album processing queue, expected to have resolved all hierarchical dependencies
     * @returns A promise that settles, once all album changes have been written to disk
     */
    async writeAlbums(processingQueue: PLibraryProcessingQueues<Album>) {
        Resources.logger(this).info(`Writing lib structure!`);

        // Making sure our queues are sorted
        const toBeDeleted: Album[] = SyncEngineHelper.sortQueue(processingQueue[0]);
        const toBeAdded: Album[] = SyncEngineHelper.sortQueue(processingQueue[1]);

        // Deletion before addition, in order to avoid duplicate folders
        // Reversing processing order, since we need to remove nested folders first
        toBeDeleted.reverse().forEach(album => {
            this.removeAlbum(album);
        });

        toBeAdded.forEach(album => {
            this.addAlbum(album);
        });

        await this.photosLibrary.cleanArchivedOrphans();
    }

    /**
     * Writes the data structure of an album to disk. This includes:
     *   * Create a hidden folder containing the UUID
     *   * Create a link to the hidden folder, containing the real name of the album
     *   * (If possible) link correct pictures from the assetFolder to the newly created album
     * @param album - The album, that should be written to disk
     * @throws An iCPSError, if an archived album could not be retrieved from the stash
     * @emits iCPSEventRuntimeWarning.WRITE_ALBUM_ERROR - When an error occurs while writing the album to disk - The first argument is the iCPSError, the second argument is the album
     */
    addAlbum(album: Album) {
        // If albumType == Archive -> Check in 'archivedFolder' and move
        Resources.logger(this).debug(`Creating album ${album.getDisplayName()} with parent ${album.parentAlbumUUID}`);

        if (album.albumType === AlbumType.ARCHIVED) {
            try {
                this.photosLibrary.retrieveStashedAlbum(album);
            } catch (err) {
                throw new iCPSError(SYNC_ERR.STASH_RETRIEVE)
                    .addMessage(album.getDisplayName())
                    .addCause(err);
            }

            return;
        }

        try {
            this.photosLibrary.writeAlbum(album);
        } catch (err) {
            Resources.emit(iCPSEventRuntimeWarning.WRITE_ALBUM_ERROR, new iCPSError(SYNC_ERR.ADD_ALBUM).addCause(err), album);
        }
    }

    /**
     * This will delete an album from disk and remove all associated symlinks
     * Deletion will only happen if the album is 'empty'. This means it only contains symlinks or 'safe' files. Any other folder or file will result in the folder not being deleted.
     * @param album - The album that needs to be deleted
     * @throws An iCPSError, if an archived album could not be stashed
     * @emits iCPSEventRuntimeWarning.WRITE_ALBUM_ERROR - When an error occurs while writing the album to disk - The first argument is the iCPSError, the second argument is the album
     */
    removeAlbum(album: Album) {
        Resources.logger(this).debug(`Removing album ${album.getDisplayName()}`);

        if (album.albumType === AlbumType.ARCHIVED) {
            try {
                this.photosLibrary.stashArchivedAlbum(album);
            } catch (err) {
                throw new iCPSError(SYNC_ERR.STASH)
                    .addMessage(album.getDisplayName())
                    .addCause(err);
            }

            return;
        }

        try {
            this.photosLibrary.deleteAlbum(album);
        } catch (err) {
            Resources.emit(iCPSEventRuntimeWarning.WRITE_ALBUM_ERROR, new iCPSError(SYNC_ERR.DELETE_ALBUM).addCause(err), album);
        }
    }
}
