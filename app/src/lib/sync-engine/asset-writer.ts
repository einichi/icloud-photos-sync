import fs from 'fs/promises';
import {iCPSError} from '../../app/error/error.js';
import {LIBRARY_ERR, RESOURCES_ERR, SYNC_ERR} from '../../app/error/error-codes.js';
import {iCloud} from '../icloud/icloud.js';
import {PhotosLibrary} from '../photos-library/photos-library.js';
import {AssetChecksum} from '../photos-library/asset-checksum.js';
import {Asset} from '../photos-library/model/asset.js';
import {PLibraryProcessingQueues} from '../photos-library/model/photos-entity.js';
import {AssetDownloadReason, iCPSEventRuntimeWarning, iCPSEventSyncEngine} from '../resources/events-types.js';
import {Resources} from '../resources/main.js';
import type {SyncOptions} from './sync-engine.js';
import {SyncRetryPolicy} from './retry-policy.js';

const ASSET_PROGRESS_LOG_PERCENT_INTERVAL = 10;
const ASSET_WRITE_ATTEMPTS = 3;

type AssetWriteFailure = {
    assetName: string,
    asset: Asset,
    error: iCPSError,
}

/**
 * Writes asset changes to disk by deleting stale local assets and downloading missing remote assets.
 */
export class AssetWriter {
    private readonly retryPolicy = new SyncRetryPolicy();

    constructor(
        private readonly icloud: iCloud,
        private readonly photosLibrary: PhotosLibrary,
        private readonly logSource: object,
        private readonly options: SyncOptions,
    ) {}

    /**
     * Writes the asset changes defined in the processing queue to disk.
     * @param processingQueue - The asset processing queue
     * @returns A promise that settles once all asset changes have been written
     */
    async writeAssets(processingQueue: PLibraryProcessingQueues<Asset>) {
        const toBeDeleted = processingQueue[0];
        const invalidKeptAssets = this.options.verifyKeptAssetChecksums
            ? await this.getInvalidKeptAssets(processingQueue[2])
            : [];
        const toBeAdded = this.getUniqueAssets([
            ...processingQueue[1],
            ...invalidKeptAssets,
        ]);
        const verifiedKeptCount = processingQueue[2].length - invalidKeptAssets.length;

        if (!this.options.verifyKeptAssetChecksums && processingQueue[2].length > 0) {
            Resources.logger(this.logSource).info(`Skipping checksum verification for ${processingQueue[2].length} kept local asset(s)`);
        }
        Resources.emit(iCPSEventSyncEngine.WRITE_ASSETS, toBeDeleted.length, toBeAdded.length, verifiedKeptCount);
        Resources.logger(this.logSource).info(`Writing assets by deleting ${toBeDeleted.length} local asset(s), adding ${toBeAdded.length} remote asset(s), and keeping ${verifiedKeptCount} verified local asset(s)`);

        const totalAssetChanges = toBeDeleted.length + toBeAdded.length;
        let completedAssetChanges = 0;
        let nextProgressLogPercent = ASSET_PROGRESS_LOG_PERCENT_INTERVAL;

        const logAssetWriteProgress = () => {
            completedAssetChanges++;
            const progressLogPercent = this.getProgressLogPercent(completedAssetChanges, totalAssetChanges, nextProgressLogPercent);
            if (progressLogPercent !== undefined) {
                Resources.logger(this.logSource).info(`Asset write progress: ${progressLogPercent}% (${completedAssetChanges}/${totalAssetChanges})`);
                nextProgressLogPercent = progressLogPercent + ASSET_PROGRESS_LOG_PERCENT_INTERVAL;
            }
        };

        await Promise.all(toBeDeleted.map(async asset => {
            await this.photosLibrary.deleteAsset(asset);
            logAssetWriteProgress();
        }));

        const failedAssetWrites: AssetWriteFailure[] = [];
        const nextAsset = toBeAdded.values();
        const configuredWorkerCount = Resources.manager().downloadThreads === Infinity
            ? toBeAdded.length
            : Resources.manager().downloadThreads;
        const workerCount = Math.min(configuredWorkerCount, toBeAdded.length);
        await Promise.all(Array.from({length: workerCount}, async () => {
            for (let next = nextAsset.next(); !next.done; next = nextAsset.next()) {
                const writeError = await this.addAsset(next.value);
                if (writeError) {
                    failedAssetWrites.push({
                        assetName: this.getAssetProgressDisplayName(next.value),
                        asset: next.value,
                        error: writeError,
                    });
                }
                logAssetWriteProgress();
            }
        }));

        if (failedAssetWrites.length > 0) {
            throw this.buildAssetWriteError(failedAssetWrites);
        }
    }

    /**
     * Gets the latest crossed 10% progress threshold for asset write logging.
     * @param completedCount - The number of completed asset writes
     * @param totalCount - The total number of asset writes
     * @param nextProgressLogPercent - The next percentage threshold that should be logged
     * @returns The crossed percentage threshold, or undefined if no threshold was reached
     */
    private getProgressLogPercent(completedCount: number, totalCount: number, nextProgressLogPercent: number): number | undefined {
        if (totalCount === 0) {
            return undefined;
        }

        const completedPercent = Math.floor((completedCount / totalCount) * 100);
        const completedProgressLogPercent = Math.floor(completedPercent / ASSET_PROGRESS_LOG_PERCENT_INTERVAL)
            * ASSET_PROGRESS_LOG_PERCENT_INTERVAL;
        if (completedProgressLogPercent < nextProgressLogPercent) {
            return undefined;
        }

        return Math.min(100, completedProgressLogPercent);
    }

    /**
     * Downloads and stores a given asset, unless a valid file is already present on disk.
     * @param asset - The asset that needs to be downloaded
     * @returns A promise that resolves once the file has been successfully written to disk
     */
    async addAsset(asset: Asset): Promise<iCPSError | undefined> {
        const assetProgressDisplayName = this.getAssetProgressDisplayName(asset);
        // Captured before any verification or cleanup deletes the existing file: a download that replaces a file already
        // on disk is a redownload (the local copy was missing, corrupted, or no longer matched iCloud), as opposed to a
        // genuinely new asset. This is determined from disk so it covers size/modification-time mismatches too, not just
        // kept assets that failed checksum verification.
        const replacedExistingAsset = await this.assetFilePresent(asset);
        try {
            if (await this.hasValidLocalAsset(asset)) {
                Resources.emit(iCPSEventSyncEngine.WRITE_ASSET_COMPLETED, assetProgressDisplayName);
                return;
            }
        } catch (err) {
            const syncError = iCPSError.toiCPSError(err);
            await this.deleteFailedAsset(asset);
            Resources.emit(iCPSEventRuntimeWarning.WRITE_ASSET_ERROR, syncError, asset);
            return syncError;
        }

        Resources.emit(iCPSEventSyncEngine.WRITE_ASSET_STARTED, assetProgressDisplayName);
        for (let attempt = 1; attempt <= ASSET_WRITE_ATTEMPTS; attempt++) {
            try {
                await this.icloud.photos.downloadAsset(asset);
                await asset.verify();
                break;
            } catch (err) {
                await this.deleteFailedAsset(asset);
                if (attempt < ASSET_WRITE_ATTEMPTS && this.isRetryableAssetWriteError(err)) {
                    Resources.logger(this.logSource).warn(
                        `Retrying asset write for ${assetProgressDisplayName} after retryable error `
                        + `(attempt ${attempt}/${ASSET_WRITE_ATTEMPTS}): ${iCPSError.toiCPSError(err).getDescription()}`,
                    );
                    continue;
                }

                const syncError = iCPSError.toiCPSError(err);
                Resources.emit(iCPSEventRuntimeWarning.WRITE_ASSET_ERROR, syncError, asset);
                return syncError;
            }
        }

        const downloadReason: AssetDownloadReason = replacedExistingAsset ? `redownloaded` : `new`;
        Resources.emit(iCPSEventSyncEngine.WRITE_ASSET_DOWNLOADED, assetProgressDisplayName, downloadReason);
        Resources.emit(iCPSEventSyncEngine.WRITE_ASSET_COMPLETED, assetProgressDisplayName);
    }

    /**
     * Builds a sync-failing error after all queued asset writes have been attempted.
     * @param failedAssetWrites - Asset writes that were permanently unsuccessful
     * @returns An aggregate write failure
     */
    private buildAssetWriteError(failedAssetWrites: AssetWriteFailure[]): iCPSError {
        return new iCPSError(SYNC_ERR.WRITE_ASSETS)
            .addMessage(`${failedAssetWrites.length} asset(s) were not copied`)
            .addContext(`failedAssetWrites`, failedAssetWrites.map(failure => ({
                assetName: failure.assetName,
                assetRecordName: failure.asset.recordName,
                downloadRecordName: failure.asset.downloadRecordName,
                reason: failure.error.getDescription(),
            })))
            .addCause(failedAssetWrites[0].error);
    }

    /**
     * Determines whether a per-asset write should be retried without restarting the full sync.
     * @param err - Error raised while downloading or verifying an asset
     * @returns True if another attempt is likely to help
     */
    private isRetryableAssetWriteError(err: unknown): boolean {
        const syncError = iCPSError.toiCPSError(err);
        if (syncError.code === RESOURCES_ERR.DOWNLOAD_TIMEOUT.code) {
            return true;
        }

        const axiosError = this.retryPolicy.getAxiosError(err);
        if (!axiosError) {
            return false;
        }

        return this.retryPolicy.isRetryableSyncError(err);
    }

    /**
     * Checks whether a file already occupies the asset's target path on disk.
     * @param asset - The asset being written
     * @returns True if a file is already present at the asset's path
     */
    private async assetFilePresent(asset: Asset): Promise<boolean> {
        try {
            await fs.stat(asset.getAssetFilePath());
            return true;
        } catch (_err) {
            return false;
        }
    }

    /**
     * Removes duplicate asset file writes from the queue.
     * @param assets - Assets scheduled for writing
     * @returns Assets with one entry per target file path
     */
    getUniqueAssets(assets: Asset[]): Asset[] {
        const uniqueAssets = new Map<string, Asset>();
        assets.forEach(asset => {
            uniqueAssets.set(asset.getAssetFilePath(), asset);
        });

        if (uniqueAssets.size !== assets.length) {
            Resources.logger(this.logSource).info(`Collapsed ${assets.length - uniqueAssets.size} duplicate asset write(s) targeting files already queued`);
        }

        return [...uniqueAssets.values()];
    }

    /**
     * Verifies kept assets against iCloud metadata and checksum before leaving them untouched.
     * @param assets - Assets that matched the remote metadata during diffing
     * @returns Assets that failed verification and need to be redownloaded
     */
    private async getInvalidKeptAssets(assets: Asset[]): Promise<Asset[]> {
        const invalidAssets: Asset[] = [];
        for (let index = 0; index < assets.length; index++) {
            const asset = assets[index];
            Resources.emit(iCPSEventSyncEngine.VERIFY_LOCAL_ASSETS_PROGRESS, index, assets.length, this.getAssetProgressDisplayName(asset));
            try {
                await asset.verify();
            } catch (err) {
                Resources.logger(this.logSource).warn(`Kept asset ${this.getAssetProgressDisplayName(asset)} failed verification and will be redownloaded: ${iCPSError.toiCPSError(err).getDescription()}`);
                invalidAssets.push(asset);
            }
        }

        if (assets.length > 0) {
            Resources.emit(iCPSEventSyncEngine.VERIFY_LOCAL_ASSETS_PROGRESS, assets.length, assets.length);
        }

        return invalidAssets;
    }

    /**
     * Checks whether the local asset file already matches iCloud.
     * @param asset - The asset being written
     * @returns True if the asset is already valid locally
     */
    private async hasValidLocalAsset(asset: Asset): Promise<boolean> {
        try {
            await fs.stat(asset.getAssetFilePath());
        } catch (_err) {
            return false;
        }

        try {
            await asset.verify();
            Resources.logger(this.logSource).debug(`Asset ${this.getAssetProgressDisplayName(asset)} already exists locally and passed verification`);
            return true;
        } catch (err) {
            if (await this.repairMetadataOnlyMismatch(asset, err)) {
                return true;
            }

            await this.deleteFailedAsset(asset);
            return false;
        }
    }

    /**
     * Repairs a local file whose bytes match iCloud but whose mtime drifted.
     * @param asset - The asset being checked
     * @param err - Verification failure
     * @returns True if the file was repaired and can be kept
     */
    private async repairMetadataOnlyMismatch(asset: Asset, err: unknown): Promise<boolean> {
        const syncError = iCPSError.toiCPSError(err);
        if (syncError.code !== LIBRARY_ERR.ASSET_MODIFICATION_TIME.code) {
            return false;
        }

        const assetPath = asset.getAssetFilePath();
        try {
            const fileStat = await fs.stat(assetPath);
            if (fileStat.size !== asset.size) {
                return false;
            }

            const localChecksum = await AssetChecksum.forFile(assetPath);
            if (localChecksum !== asset.fileChecksum) {
                return false;
            }

            await fs.utimes(assetPath, new Date(asset.modified), new Date(asset.modified));
            Resources.logger(this.logSource).info(`Repaired modification time for ${this.getAssetProgressDisplayName(asset)} without redownloading`);
            return true;
        } catch (repairErr) {
            Resources.logger(this.logSource).warn(`Unable to repair modification time for ${this.getAssetProgressDisplayName(asset)}: ${iCPSError.toiCPSError(repairErr).getDescription()}`);
            return false;
        }
    }

    /**
     * Removes a failed local asset so the next sync attempt starts with a clean download.
     * @param asset - The asset that failed while being written
     */
    private async deleteFailedAsset(asset: Asset): Promise<void> {
        try {
            await this.photosLibrary.deleteAsset(asset);
        } catch (err) {
            Resources.logger(this.logSource).warn(`Unable to delete failed asset ${this.getAssetProgressDisplayName(asset)}: ${iCPSError.toiCPSError(err).getDescription()}`);
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
}
