import {iCloud} from '../icloud/icloud.js';
import {PhotosLibrary} from '../photos-library/photos-library.js';
import {Asset} from '../photos-library/model/asset.js';
import {Album, AlbumType} from '../photos-library/model/album.js';
import {PLibraryEntities, PLibraryProcessingQueues} from '../photos-library/model/photos-entity.js';
import {iCPSError} from '../../app/error/error.js';
import {AUTH_ERR, SYNC_ERR} from '../../app/error/error-codes.js';
import {Resources} from '../resources/main.js';
import {SyncEngineHelper} from './helper.js';
import {iCPSEventRuntimeWarning, iCPSEventSyncEngine} from '../resources/events-types.js';
import {AssetWriter} from './asset-writer.js';
import {SyncRetryPolicy} from './retry-policy.js';

export type SyncOptions = {
    verifyKeptAssetChecksums: boolean
}

const DEFAULT_SYNC_OPTIONS: SyncOptions = {
    verifyKeptAssetChecksums: true,
};

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

    private readonly retryPolicy = new SyncRetryPolicy();
    private readonly options: SyncOptions;

    /**
     * Creates a new sync engine from the previously created objects and CLI options
     * @param icloud - The iCloud object
     * @param photosLibrary - The photos library object
     */
    constructor(icloud: iCloud, photosLibrary: PhotosLibrary, options: Partial<SyncOptions> = {}) {
        this.icloud = icloud;
        this.photosLibrary = photosLibrary;
        this.options = {
            ...DEFAULT_SYNC_OPTIONS,
            ...options,
        };
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
     * @returns False if non-interactive session refresh cannot start, true otherwise
     */
    private async refreshICloudConnection(failedAttempt: number, retryError: iCPSError): Promise<boolean> {
        Resources.logger(this).debug(`Refreshing iCloud connection...`);
        try {
            if (!await this.icloud.setupAccount({emitSessionExpired: false})) {
                Resources.logger(this).info(`Existing iCloud web session was not accepted during sync retry; refreshing using stored trust token`);
                if (!await this.icloud.refreshSessionWithStoredTrustToken()) {
                    throw new iCPSError(AUTH_ERR.ACCOUNT_SETUP)
                        .addMessage(`Existing iCloud web session was not accepted during sync retry and no stored trust token is available; not requesting MFA during sync`);
                }

                await this.icloud.photos.setup();
                return true;
            }

            if (!await this.icloud.getReady()) {
                throw new iCPSError(AUTH_ERR.SETUP_TIMEOUT)
                    .addMessage(`iCloud did not become ready during sync retry; not requesting MFA during sync`);
            }

            await this.icloud.photos.setup();
        } catch (refreshErr) {
            retryError.addContext(`error-try-${failedAttempt}-refresh`, this.getRetryErrorContext(refreshErr));
            if (this.requiresInteractiveAuthentication(refreshErr)) {
                throw new iCPSError(AUTH_ERR.FAILED)
                    .addCause(iCPSError.toiCPSError(refreshErr));
            }

            Resources.logger(this).warn(`Unable to refresh iCloud connection before retry: ${iCPSError.toiCPSError(refreshErr).getDescription()}`);
        }

        return true;
    }

    /**
     * Determines whether retry recovery reached a point that requires user MFA.
     * @param err - The refresh error
     * @returns True if continuing non-interactively cannot succeed
     */
    private requiresInteractiveAuthentication(err: unknown): boolean {
        return iCPSError.toiCPSError(err).getRootErrorCode(true) === AUTH_ERR.MFA_REQUIRED.code;
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
        return this.retryPolicy.getRetryBackoffMs(retryCount, err);
    }

    /**
     * Builds a sync-level error while preserving the original cause chain.
     * @param err - The original error
     * @returns The sync-level error
     */
    private buildSyncError(err: unknown): iCPSError {
        return this.retryPolicy.buildSyncError(err);
    }

    /**
     * Determines whether a failed sync request should be retried.
     * @param err - The original error
     * @returns True if retrying is expected to help
     */
    private isRetryableSyncError(err: unknown): boolean {
        return this.retryPolicy.isRetryableSyncError(err);
    }

    /**
     * Creates safe retry context without request bodies, credentials or headers.
     * @param err - The original error
     * @returns A sanitized error context object
     */
    private getRetryErrorContext(err: unknown): Record<string, unknown> {
        return this.retryPolicy.getRetryErrorContext(err);
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
        Resources.emit(iCPSEventSyncEngine.FETCH_N_LOAD_PROGRESS, `Loading local assets and albums from disk; fetching remote asset metadata...`, 16);

        const remoteAssetStartedAt = Date.now();
        Resources.logger(this).info(`Fetching remote iCloud asset metadata`);
        const [cplAssets, cplMasters] = await this.icloud.photos.fetchAllCPLAssetsMasters();
        Resources.emit(iCPSEventSyncEngine.FETCH_N_LOAD_PROGRESS, `Fetched remote asset metadata (${cplAssets.length} assets, ${cplMasters.length} masters); converting...`, 20);
        Resources.logger(this).info(`Fetched remote iCloud asset metadata in ${Date.now() - remoteAssetStartedAt}ms; converting ${cplAssets.length} assets and ${cplMasters.length} masters`);
        const remoteAssets = SyncEngineHelper.convertCPLAssets(cplAssets, cplMasters);
        Resources.emit(iCPSEventSyncEngine.FETCH_N_LOAD_PROGRESS, `Converted ${remoteAssets.length} remote assets; fetching remote album metadata...`, 21);
        Resources.logger(this).info(`Converted ${remoteAssets.length} remote iCloud assets`);

        const remoteAlbumStartedAt = Date.now();
        Resources.logger(this).info(`Fetching remote iCloud album metadata`);
        const cplAlbums = await this.icloud.photos.fetchAllCPLAlbums();
        Resources.emit(iCPSEventSyncEngine.FETCH_N_LOAD_PROGRESS, `Fetched remote album metadata (${cplAlbums.length} records); converting...`, 22);
        Resources.logger(this).info(`Fetched remote iCloud album metadata in ${Date.now() - remoteAlbumStartedAt}ms; converting ${cplAlbums.length} albums`);
        const remoteAlbums = SyncEngineHelper.convertCPLAlbums(cplAlbums);
        Resources.logger(this).info(`Converted ${remoteAlbums.length} remote iCloud albums`);

        Resources.logger(this).info(`Waiting for local Photos library state load`);
        Resources.emit(iCPSEventSyncEngine.FETCH_N_LOAD_PROGRESS, `Waiting for local library state from disk...`, 22);
        const [localAssets, localAlbums] = await localState;
        Resources.emit(iCPSEventSyncEngine.FETCH_N_LOAD_PROGRESS, `Loaded local library state (${Object.keys(localAssets).length} assets, ${Object.keys(localAlbums).length} albums)`, 23);
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
        const startedAt = Date.now();
        const localAssetCount = Object.keys(localAssets).length;
        const localAlbumCount = Object.keys(localAlbums).length;
        Resources.emit(iCPSEventSyncEngine.DIFF);
        Resources.logger(this).info(
            `Diffing remote state (${remoteAssets.length} asset(s), ${remoteAlbums.length} album(s)) `
            + `against local state (${localAssetCount} asset(s), ${localAlbumCount} album(s))`,
        );
        const [assetQueue, albumQueue] = await Promise.all([
            SyncEngineHelper.getProcessingQueues(remoteAssets, localAssets),
            SyncEngineHelper.getProcessingQueues(remoteAlbums, localAlbums),
        ]);
        const resolvedAlbumQueue = SyncEngineHelper.resolveHierarchicalDependencies(albumQueue, localAlbums);
        Resources.logger(this).info(
            `Completed state diff in ${Date.now() - startedAt}ms; `
            + `assets: ${this.formatQueueSummary(assetQueue)}; albums: ${this.formatQueueSummary(resolvedAlbumQueue)}`,
        );
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
        const startedAt = Date.now();
        const queuedChangeCount = assetQueue[0].length + assetQueue[1].length + albumQueue[0].length + albumQueue[1].length;
        const unchangedCount = assetQueue[2].length + albumQueue[2].length;
        Resources.emit(iCPSEventSyncEngine.WRITE);
        Resources.logger(this).info(
            `Writing state changes (${queuedChangeCount} queued add/delete action(s), ${unchangedCount} unchanged item(s)); `
            + `assets: ${this.formatQueueSummary(assetQueue)}; albums: ${this.formatQueueSummary(albumQueue)}`,
        );

        await this.writeAssets(assetQueue);
        Resources.emit(iCPSEventSyncEngine.WRITE_ASSETS_COMPLETED);

        if (Resources.manager().allPhotosByName) {
            // Rebuild the human-readable symlink folders from the assets that should now be on disk (kept + added)
            await this.photosLibrary.writeAssetsByName([...assetQueue[1], ...assetQueue[2]]);
        }

        Resources.emit(iCPSEventSyncEngine.WRITE_ALBUMS, albumQueue[0].length, albumQueue[1].length, albumQueue[2].length);
        await this.writeAlbums(albumQueue);
        Resources.emit(iCPSEventSyncEngine.WRITE_ALBUMS_COMPLETED);

        Resources.emit(iCPSEventSyncEngine.WRITE_COMPLETED);
        Resources.logger(this).info(`Completed writing state changes in ${Date.now() - startedAt}ms`);
    }

    /**
     * Formats sync processing queue counts for concise progress logging.
     * @param queue - The queue whose delete/add/keep counts should be summarized
     * @returns A human-readable queue summary
     */
    private formatQueueSummary<T>(queue: PLibraryProcessingQueues<T>): string {
        return `delete ${queue[0].length}, add ${queue[1].length}, keep ${queue[2].length}`;
    }

    /**
     * Writes the asset changes defined in the processing queue to to disk (by downloading the asset or deleting it)
     * @param processingQueue - The asset processing queue
     * @returns A promise that settles, once all asset changes have been written to disk
     */
    async writeAssets(processingQueue: PLibraryProcessingQueues<Asset>) {
        await this.assetWriter.writeAssets(processingQueue);
    }

    /**
     * Downloads and stores a given asset, unless file is already present on disk
     * @param asset - The asset that needs to be downloaded
     * @returns A promise that resolves, once the file has been successfully written to disk
     * @emits iCPSEventSyncEngine.WRITE_ASSET_STARTED - When the asset download starts - The first argument is the name of the asset
     * @emits iCPSEventSyncEngine.WRITE_ASSET_COMPLETED - When the asset has been written to disk - The first argument is the name of the asset
     * @emits iCPSEventRuntimeWarning.WRITE_ASSET_ERROR - When an error occurs while writing the asset to disk - The first argument is the error, the second argument is the asset
     */
    async addAsset(asset: Asset) {
        await this.assetWriter.addAsset(asset);
    }

    /**
     * Removes duplicate asset file writes from the queue.
     * @param assets - Assets scheduled for writing
     * @returns Assets with one entry per target file path
     */
    private getUniqueAssets(assets: Asset[]): Asset[] {
        return this.assetWriter.getUniqueAssets(assets);
    }

    private get assetWriter(): AssetWriter {
        return new AssetWriter(this.icloud, this.photosLibrary, this, this.options);
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
