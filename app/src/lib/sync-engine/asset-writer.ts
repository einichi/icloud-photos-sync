import fs from 'fs/promises';
import {iCPSError} from '../../app/error/error.js';
import {iCloud} from '../icloud/icloud.js';
import {PhotosLibrary} from '../photos-library/photos-library.js';
import {Asset} from '../photos-library/model/asset.js';
import {PLibraryProcessingQueues} from '../photos-library/model/photos-entity.js';
import {iCPSEventRuntimeWarning, iCPSEventSyncEngine} from '../resources/events-types.js';
import {Resources} from '../resources/main.js';

const ASSET_PROGRESS_LOG_INTERVAL = 25;

/**
 * Writes asset changes to disk by deleting stale local assets and downloading missing remote assets.
 */
export class AssetWriter {
    constructor(
        private readonly icloud: iCloud,
        private readonly photosLibrary: PhotosLibrary,
        private readonly logSource: object,
    ) {}

    /**
     * Writes the asset changes defined in the processing queue to disk.
     * @param processingQueue - The asset processing queue
     * @returns A promise that settles once all asset changes have been written
     */
    async writeAssets(processingQueue: PLibraryProcessingQueues<Asset>) {
        const toBeDeleted = processingQueue[0];
        const invalidKeptAssets = await this.getInvalidKeptAssets(processingQueue[2]);
        const toBeAdded = this.getUniqueAssets([
            ...processingQueue[1],
            ...invalidKeptAssets,
        ]);

        Resources.logger(this.logSource).info(`Writing assets by deleting ${toBeDeleted.length} local asset(s), adding ${toBeAdded.length} remote asset(s), and keeping ${processingQueue[2].length - invalidKeptAssets.length} verified local asset(s)`);

        await Promise.all(toBeDeleted.map(asset => this.photosLibrary.deleteAsset(asset)));

        let completedAssets = 0;
        const nextAsset = toBeAdded.values();
        const configuredWorkerCount = Resources.manager().downloadThreads === Infinity
            ? toBeAdded.length
            : Resources.manager().downloadThreads;
        const workerCount = Math.min(configuredWorkerCount, toBeAdded.length);
        await Promise.all(Array.from({length: workerCount}, async () => {
            for (let next = nextAsset.next(); !next.done; next = nextAsset.next()) {
                await this.addAsset(next.value);
                completedAssets++;
                if (completedAssets % ASSET_PROGRESS_LOG_INTERVAL === 0 || completedAssets === toBeAdded.length) {
                    Resources.logger(this.logSource).info(`Asset sync progress: ${completedAssets}/${toBeAdded.length}`);
                }
            }
        }));
    }

    /**
     * Downloads and stores a given asset, unless a valid file is already present on disk.
     * @param asset - The asset that needs to be downloaded
     * @returns A promise that resolves once the file has been successfully written to disk
     */
    async addAsset(asset: Asset) {
        try {
            const assetProgressDisplayName = this.getAssetProgressDisplayName(asset);
            if (await this.hasValidLocalAsset(asset)) {
                Resources.emit(iCPSEventSyncEngine.WRITE_ASSET_COMPLETED, assetProgressDisplayName);
                return;
            }

            Resources.emit(iCPSEventSyncEngine.WRITE_ASSET_STARTED, assetProgressDisplayName);
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
        for (const asset of assets) {
            try {
                await asset.verify();
            } catch (err) {
                Resources.logger(this.logSource).warn(`Kept asset ${this.getAssetProgressDisplayName(asset)} failed verification and will be redownloaded: ${iCPSError.toiCPSError(err).getDescription()}`);
                invalidAssets.push(asset);
            }
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
        } catch (_err) {
            await this.deleteFailedAsset(asset);
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
