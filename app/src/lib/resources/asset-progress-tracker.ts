const ASSET_PROGRESS_UI_INTERVAL = 10;
const ASSET_PROGRESS_UI_THROTTLE_THRESHOLD = 100;

export type AssetProgressSnapshot = {
    message: string,
    detail?: string,
    progress: number
}

/**
 * Tracks asset sync progress and throttles high-volume UI updates.
 */
export class AssetProgressTracker {
    private totalAssets = 0;
    private completedAssets = 0;
    private activeAssetNames: string[] = [];

    /**
     * Resets all progress counters.
     */
    reset() {
        this.totalAssets = 0;
        this.completedAssets = 0;
        this.activeAssetNames = [];
    }

    /**
     * Starts a new asset sync run.
     * @param totalAssets - Number of assets expected to be added
     */
    start(totalAssets: number) {
        this.totalAssets = totalAssets;
        this.completedAssets = 0;
        this.activeAssetNames = [];
    }

    /**
     * Records an asset as actively downloading and returns an immediate progress snapshot.
     * @param assetName - Display name of the asset
     * @returns Snapshot for state consumers
     */
    startAsset(assetName?: string): AssetProgressSnapshot {
        if (assetName) {
            this.activeAssetNames.push(assetName);
        }

        return this.getSnapshot();
    }

    /**
     * Records an asset as completed or failed.
     * @param assetName - Display name of the asset
     * @returns Snapshot when progress should be published, otherwise undefined
     */
    finishAsset(assetName?: string): AssetProgressSnapshot | undefined {
        this.completedAssets++;
        this.removeActiveAsset(assetName);
        if (!this.shouldPublishAssetProgress()) {
            return undefined;
        }

        return this.getSnapshot();
    }

    /**
     * Builds a progress snapshot for state consumers.
     * @returns Current progress details
     */
    getSnapshot(): AssetProgressSnapshot {
        const inProgressPercentage = this.totalAssets > 0
            ? this.completedAssets/this.totalAssets
            : 1;

        return {
            message: `Syncing assets: ${this.completedAssets}/${this.totalAssets}`,
            detail: this.getCurrentActiveAssetName(),
            progress: 25 + (inProgressPercentage * 65)
        };
    }

    private removeActiveAsset(assetName?: string) {
        if (!assetName) {
            return;
        }

        const activeIndex = this.activeAssetNames.lastIndexOf(assetName);
        if (activeIndex >= 0) {
            this.activeAssetNames.splice(activeIndex, 1);
        }
    }

    private getCurrentActiveAssetName(): string | undefined {
        return this.activeAssetNames[this.activeAssetNames.length - 1];
    }

    private shouldPublishAssetProgress(): boolean {
        if (this.totalAssets <= ASSET_PROGRESS_UI_THROTTLE_THRESHOLD) {
            return true;
        }

        return this.completedAssets === 1
            || this.completedAssets === this.totalAssets
            || this.completedAssets % ASSET_PROGRESS_UI_INTERVAL === 0;
    }
}
