import {iCPSError} from "../../app/error/error.js";
import {MFA_ERR, AUTH_ERR, WEB_SERVER_ERR} from "../../app/error/error-codes.js";
import {Resources} from "./main.js";
import {iCPSEventApp, iCPSEventCloud, iCPSEventLog, iCPSEventMFA, iCPSEventPhotos, iCPSEventRuntimeError, iCPSEventRuntimeWarning, iCPSEventSyncEngine, iCPSEventWebServer, iCPSState} from "./events-types.js";
import {CPLAsset} from "../icloud/icloud-photos/query-parser.js";
import {Asset} from "../photos-library/model/asset.js";
import {Album} from "../photos-library/model/album.js";
import {MFAMethod} from "../icloud/mfa/mfa-method.js";
import {TrustedPhoneNumber} from "./network-types.js";
import {AssetProgressSnapshot, AssetProgressTracker} from "./asset-progress-tracker.js";

const SYNC_PROGRESS = {
    FETCH_LOAD_START: 16,
    REMOTE_METADATA_FETCH_END: 20,
    FETCH_LOAD_END: 23,
    VERIFY_LOCAL_ASSETS_START: 25,
    VERIFY_LOCAL_ASSETS_END: 55,
    WRITE_ASSETS_START: 55,
    WRITE_ASSETS_END: 90,
};

export enum StateType {
    READY = `ready`,
    RUNNING = `running`,
    BLOCKED = `blocked`,
}

export enum StateTrigger {
    SYNC = `sync`,
    AUTH = `auth`,
}

type LogFilter = {
    level: LogLevel | `none`,
    source?: RegExp,
    offset?: number,
    limit?: number
}

export enum LogLevel {
    DEBUG = `debug`,
    INFO = `info`,
    WARN = `warn`,
    ERROR = `error`,
}

export type LogMessage = {
    level: LogLevel,
    time: number,
    source: string,
    message: string
}

export type SerializedState = {
    state: StateType,
    timestamp: number,
    hasCredentials?: boolean,
    credentialsProvidedAtStartup?: boolean,
    nextSync?: number,
    prevError?: {
        message: string,
        code: string
    },
    prevTrigger?: StateTrigger,
    progress?: number,
    progressMsg?: string,
    progressDetail?: string,
    trustTokenCreatedAt?: number,
    trustTokenExpiresAt?: number,
    trustedPhoneNumbers?: {
        id: number,
        maskedNumber: string
    }[]
}

export class StateManager {
    /**
     * Keeps track when the next scheduled sync should happen
     */
    nextSync?: number;
    /**
     * If error is present, previous state ended in error
     */
    prevError?: iCPSError
    /**
     * What triggered the current state initially (if applicable)
     */
    prevTrigger?: StateTrigger
    /**
     * The timestamp when the state was last changed
     */
    timestamp: number = Date.now();
    /**
     * THe full log since the last trigger
     */
    log?: LogMessage[]

    /**
     * Additional in progress context to provide more granular information on the current progress
     */
    inProgressContext: {
        message?: string,
        detail?: string,
        progress?: number
    } = {}

    private readonly assetProgressTracker = new AssetProgressTracker();

    trustedPhoneNumbers?: TrustedPhoneNumber[] 

    /**
     * Current state of the application
     */
    state: StateType = StateType.READY;

    constructor() {
        // TRIGGERS
        Resources.events(this)
            .on(iCPSEventApp.SCHEDULED_START, () => {
                this.triggerSync(StateTrigger.SYNC);
            })
            .on(iCPSEventWebServer.REAUTH_REQUESTED, () => {
                this.triggerSync(StateTrigger.AUTH);
            });
        
        // Auth & setup process (0-20%)
        Resources.events(this)
            .on(iCPSEventCloud.AUTHENTICATION_STARTED, () => {
                this.updateState(StateType.RUNNING, {
                    progressMsg: `Authenticating user...`, 
                    progress: 1 * (this.prevTrigger === StateTrigger.AUTH ? 12.5 : 1)
                });
            })
            .on(iCPSEventCloud.MFA_REQUIRED, (trustedPhoneNumbers: TrustedPhoneNumber[]) => {
                this.updateState(StateType.BLOCKED, {
                    progressMsg: `Waiting for MFA code...`, 
                    progress: 2 * (this.prevTrigger === StateTrigger.AUTH ? 12.5 : 1),
                    trustedPhoneNumbers
                })
            })
            .on(iCPSEventMFA.MFA_RESEND, (method: MFAMethod) => {
                this.updateState(StateType.BLOCKED, {
                    progressMsg: `Resending MFA code via ${method.toString()}...`, 
                    progress: 2 * (this.prevTrigger === StateTrigger.AUTH ? 12.5 : 1)
                });
            })
            .on(iCPSEventMFA.MFA_RECEIVED, (method: MFAMethod) => {
                this.updateState(StateType.BLOCKED, {
                    progressMsg: `MFA code received from ${method.toString()}`,
                    progress: 2 * (this.prevTrigger === StateTrigger.AUTH ? 12.5 : 1)
                });
            })
            .on(iCPSEventCloud.AUTHENTICATED, () => {
                this.updateState(StateType.RUNNING, {
                    progressMsg: `User authenticated`, 
                    progress: 5 * (this.prevTrigger === StateTrigger.AUTH ? 12.5 : 1)
                });
            })
            .on(iCPSEventCloud.TRUSTED, () => {
                this.updateState(StateType.RUNNING, {
                    progressMsg: `Device trusted`, 
                    progress: 8 * (this.prevTrigger === StateTrigger.AUTH ? 12.5 : 1)
                });
            })
            .on(iCPSEventCloud.PCS_REQUIRED, () => {
                this.updateState(StateType.RUNNING, {progressMsg: `Advanced Data Protection requires additional cookies, acquiring...`, progress: 9});
            })
            .on(iCPSEventCloud.PCS_NOT_READY, () => {
                this.updateState(StateType.RUNNING, {progressMsg: `Advanced Data Protection request not confirmed yet, retrying...`, progress: 9});
            })
            .on(iCPSEventCloud.ACCOUNT_READY, () => {
                this.updateState(StateType.RUNNING, {progressMsg: `Sign in successful!`, progress: 10});
            })
            .on(iCPSEventCloud.SESSION_EXPIRED, () => {
                this.updateState(StateType.RUNNING, {progressMsg: `Session expired, re-authenticating...`, progress: 0});
            })
            .on(iCPSEventPhotos.SETUP_COMPLETED, () => {
                this.updateState(StateType.RUNNING, {progressMsg: `iCloud Photos setup completed, checking indexing status...`, progress: 11});
            })
            .on(iCPSEventPhotos.READY, () => {
                this.updateState(StateType.RUNNING, {progressMsg: `iCloud Photos ready!`, progress: 15});
            });

        // Sync process
        Resources.events(this)
            .on(iCPSEventSyncEngine.START, () => {
                this.updateState(StateType.RUNNING, {progressMsg: `Starting sync...`, progress: 15});
            })
            .on(iCPSEventSyncEngine.FETCH_N_LOAD, () => {
                this.updateState(StateType.RUNNING, {
                    progressMsg: `Loading local & fetching remote iCloud Library state...`,
                    progressDetail: `Starting local library load and remote metadata fetch...`,
                    progress: SYNC_PROGRESS.FETCH_LOAD_START
                });
            })
            .on(iCPSEventSyncEngine.FETCH_N_LOAD_PROGRESS, (detail: string, progress?: number) => {
                this.updateFetchAndLoadDetail(detail, progress);
            })
            .on(iCPSEventPhotos.FETCH_PROGRESS, (detail: string) => {
                this.updateFetchAndLoadDetail(detail);
            })
            .on(iCPSEventSyncEngine.FETCH_N_LOAD_COMPLETED, (remoteAssetCount: number, remoteAlbumCount: number, localAssetCount: number, localAlbumCount: number) => {
                this.updateState(StateType.RUNNING, {progressMsg: `Loaded local (${localAssetCount} assets in ${localAlbumCount} albums) & remote state (${remoteAssetCount} assets in ${remoteAlbumCount} albums)`, progress: SYNC_PROGRESS.FETCH_LOAD_END});
            })
            .on(iCPSEventSyncEngine.DIFF, () => {
                this.updateState(StateType.RUNNING, {progressMsg: `Diffing remote with local state...`, progress: 24});
            })
            .on(iCPSEventSyncEngine.DIFF_COMPLETED, () => {
                this.updateState(StateType.RUNNING, {progressMsg: `Diffing completed!`, progress: 25});
            })
            .on(iCPSEventSyncEngine.WRITE, () => {
                this.updateState(StateType.RUNNING, {progressMsg: `Preparing local changes...`, progress: 25});
            })
            .on(iCPSEventSyncEngine.VERIFY_LOCAL_ASSETS_PROGRESS, (checkedCount: number, totalCount: number, assetName?: string) => {
                this.updateState(StateType.RUNNING, {
                    progressMsg: `Verifying local asset checksums: ${checkedCount}/${totalCount}`,
                    progressDetail: assetName,
                    progress: this.getProgressInRange(checkedCount, totalCount, SYNC_PROGRESS.VERIFY_LOCAL_ASSETS_START, SYNC_PROGRESS.VERIFY_LOCAL_ASSETS_END),
                });
            })
            .on(iCPSEventSyncEngine.WRITE_ASSETS, (_toBeDeletedCount: number, toBeAddedCount: number, _toBeKept: number) => {
                this.updateState(StateType.RUNNING, {progressMsg: `Syncing assets: 0/${toBeAddedCount}`, progress: SYNC_PROGRESS.WRITE_ASSETS_START});
                this.assetProgressTracker.start(toBeAddedCount, SYNC_PROGRESS.WRITE_ASSETS_START, SYNC_PROGRESS.WRITE_ASSETS_END);
            })
            .on(iCPSEventSyncEngine.WRITE_ASSET_STARTED, (assetName?: string) => {
                this.updateAssetProgress(this.assetProgressTracker.startAsset(assetName));
            })
            .on(iCPSEventSyncEngine.WRITE_ASSET_COMPLETED, (assetName?: string) => {
                this.updateAssetProgress(this.assetProgressTracker.finishAsset(assetName));
            })
            .on(iCPSEventRuntimeWarning.WRITE_ASSET_ERROR, (_err?: Error, asset?: Asset) => {
                const assetName = this.getAssetDisplayName(asset);
                this.updateAssetProgress(this.assetProgressTracker.finishAsset(assetName));
            })
            .on(iCPSEventSyncEngine.WRITE_ASSETS_COMPLETED, () => {
                this.updateState(StateType.RUNNING, {progressMsg: `Asset sync completed!`, progress: SYNC_PROGRESS.WRITE_ASSETS_END});
            })
            .on(iCPSEventSyncEngine.WRITE_ALBUMS, () => {
                this.updateState(StateType.RUNNING, {progressMsg: `Syncing albums...`, progress: 91});
            })
            .on(iCPSEventSyncEngine.WRITE_ALBUMS_COMPLETED, () => {
                this.updateState(StateType.RUNNING, {progressMsg: `Album sync completed!`, progress: 98});
            })
            .on(iCPSEventSyncEngine.WRITE_COMPLETED, () => {
                this.updateState(StateType.RUNNING, {progressMsg: `Successfully wrote diff to disk!`, progress: 99});
            })
            .on(iCPSEventSyncEngine.RETRY, (retryCount: number, err: iCPSError, backoffMs?: number) => {
                const retryMsg = backoffMs
                    ? `Settling outstanding requests, then waiting ${Math.ceil(backoffMs / 1000)}s before refreshing iCloud connection & retrying`
                    : `Refreshing iCloud connection & retrying`;
                this.updateState(StateType.RUNNING, {progressMsg: `Detected error during sync: ${iCPSError.toiCPSError(err).getDescription()}, ${retryMsg} (attempt #${retryCount})...`, progress: 15});
            });


        // SUCCESS
        Resources.events(this)
            .on(iCPSEventApp.SCHEDULED_DONE, (nextSync: Date) => {
                this.updateState(StateType.READY, {nextSync: nextSync.getTime()});
            })
            .on(iCPSEventApp.TOKEN, () => {
                this.updateState(StateType.READY);
            })
            .on(iCPSEventApp.SCHEDULED, (timestamp: Date) => {
                this.updateState(StateType.READY, {nextSync: timestamp.getTime()});
            });

        // ERROR
        Resources.events(this)
            .on(iCPSEventRuntimeError.SCHEDULED_ERROR, (err: iCPSError) => {
                this.updateState(StateType.READY, {error: err});
            })
            .on(iCPSEventMFA.MFA_NOT_PROVIDED, () => {
                this.updateState(StateType.READY, {error: new iCPSError(WEB_SERVER_ERR.MFA_CODE_NOT_PROVIDED)});
            })
            .on(iCPSEventWebServer.REAUTH_ERROR, (err: iCPSError) => {
                this.updateState(StateType.READY, {error: err});
            });

        // Logs
        Resources.events(this)
            .on(iCPSEventLog.DEBUG, (source: unknown, msg: string) => this.addLog(LogLevel.DEBUG, source, msg))
            .on(iCPSEventLog.INFO, (source: unknown, msg: string) => this.addLog(LogLevel.INFO, source, msg))
            .on(iCPSEventLog.WARN, (source: unknown, msg: string) => this.addLog(LogLevel.WARN, source, msg))
            .on(iCPSEventRuntimeWarning.COUNT_MISMATCH, (album: string, expectedCount: number, actualCPLAssets: number, actualCPLMasters: number) => {
                this.addLog(LogLevel.WARN, `RuntimeWarning`, `Expected ${expectedCount} CPLAssets & CPLMasters, but got ${actualCPLAssets} CPLAssets and ${actualCPLMasters} CPLMasters for album ${album}`);
            })
            .on(iCPSEventRuntimeWarning.FILETYPE_ERROR, (ext: string, descriptor: string) => {
                this.addLog(LogLevel.WARN, `RuntimeWarning`, `Unknown file extension ${ext} for descriptor ${descriptor}`);
            })
            .on(iCPSEventRuntimeWarning.LIBRARY_LOAD_ERROR, (err: Error, filePath: string) => {
                this.addLog(LogLevel.WARN, `RuntimeWarning`, `Error while loading file ${filePath}: ${iCPSError.toiCPSError(err).getDescription()}`);
            })
            .on(iCPSEventRuntimeWarning.EXTRANEOUS_FILE, (filePath: string) => {
                this.addLog(LogLevel.WARN, `RuntimeWarning`, `Extraneous file found in directory ${filePath}`);
            })
            .on(iCPSEventRuntimeWarning.ICLOUD_LOAD_ERROR, (err: Error, asset: CPLAsset) => {
                this.addLog(LogLevel.WARN, `RuntimeWarning`, `Error while loading iCloud asset ${asset.recordName}: ${iCPSError.toiCPSError(err).getDescription()}`);
            })
            .on(iCPSEventRuntimeWarning.WRITE_ASSET_ERROR, (err: Error, asset: Asset) => {
                this.addLog(LogLevel.WARN, `RuntimeWarning`, `Error while writing asset ${this.getAssetDisplayName(asset)}: ${iCPSError.toiCPSError(err).getDescription()}`);
            })
            .on(iCPSEventRuntimeWarning.WRITE_ALBUM_ERROR, (err: Error, album: Album) => {
                this.addLog(LogLevel.WARN, `RuntimeWarning`, `Error while writing album ${album?.getDisplayName()}: ${iCPSError.toiCPSError(err).getDescription()}`);
            })
            .on(iCPSEventRuntimeWarning.LINK_ERROR, (err: Error, srcPath: string, dstPath: string) => {
                this.addLog(LogLevel.WARN, `RuntimeWarning`, `Error while linking ${srcPath} to ${dstPath}: ${iCPSError.toiCPSError(err).getDescription()}`);
            })
            .on(iCPSEventRuntimeWarning.MFA_ERROR, (err: iCPSError) => {
                this.addLog(LogLevel.WARN, `RuntimeWarning`, `Error within MFA flow: ${iCPSError.toiCPSError(err).getDescription()}`);
            })
            .on(iCPSEventRuntimeWarning.WEB_SERVER_ERROR, (err: iCPSError) => {
                this.addLog(LogLevel.WARN, `RuntimeWarning`, `Error within web server: ${iCPSError.toiCPSError(err).getDescription()}`);
            })
            .on(iCPSEventRuntimeWarning.RESOURCE_FILE_ERROR, (err: Error) => {
                this.addLog(LogLevel.WARN, `RuntimeWarning`, `Error while accessing resource file: ${iCPSError.toiCPSError(err).getDescription()}`);
            })
            .on(iCPSEventRuntimeWarning.ARCHIVE_ASSET_ERROR, (err: Error, assetPath: string) => {
                this.addLog(LogLevel.WARN, `RuntimeWarning`, `Error while archiving asset ${assetPath}: ${iCPSError.toiCPSError(err).getDescription()}`);
            })
            .on(iCPSEventSyncEngine.RETRY, (_retryCount: number, err: Error) => {
                this.addLog(LogLevel.WARN, `RuntimeWarning`, `Detected error during sync: ${iCPSError.toiCPSError(err).getDescription()}`);
            })
            .on(iCPSEventLog.ERROR, (source: unknown, msg: string) => this.addLog(LogLevel.ERROR, source, msg))
            .on(iCPSEventRuntimeError.HANDLED_ERROR, (err: iCPSError) => this.addLog(LogLevel.ERROR, `RuntimeError`, iCPSError.toiCPSError(err).getDescription()));
    }

    /**
     * This function updates the state using the provided context
     * @param newState - the new state
     * @param ctx - context for the new state, note: only relevant properties will be overwritten
     * @emits iCPSState.STATE_CHANGED with a serialized copy of the new state
     */
    updateState(newState: StateType, ctx? : {error?: iCPSError, nextSync?: number, progress?: number, progressMsg?: string, progressDetail?: string, trustedPhoneNumbers?: TrustedPhoneNumber[]}) {
        this.timestamp = Date.now();
        this.state = newState;
        if(ctx) {
            if(ctx.nextSync) {
                this.nextSync = ctx.nextSync;
            }
            if(ctx.error) {
                this.prevError = iCPSError.toiCPSError(ctx.error);
            }
            if(ctx.progress || ctx.progressMsg) {
                this.inProgressContext = {
                    progress: ctx.progress,
                    message: ctx.progressMsg,
                    detail: ctx.progressDetail,
                }
            }
            if(ctx.trustedPhoneNumbers) {
                this.trustedPhoneNumbers = ctx.trustedPhoneNumbers
            }
        }
        Resources.event().emit(iCPSState.STATE_CHANGED, this.serialize())
    }

    /**
     * Publishes asset progress to state consumers.
     * @param snapshot - Current progress snapshot, if this update should be published
     */
    private updateAssetProgress(snapshot?: AssetProgressSnapshot) {
        if (!snapshot) {
            return;
        }

        this.updateState(StateType.RUNNING, {
            progressMsg: snapshot.message,
            progressDetail: snapshot.detail,
            progress: snapshot.progress
        });
    }

    /**
     * Updates the fetch/load detail line while the sync engine is loading local and remote state.
     * @param detail - Human-readable detail to display below the main status
     * @param progress - Optional overall progress percentage
     */
    private updateFetchAndLoadDetail(detail: string, progress?: number) {
        if (this.state !== StateType.RUNNING || this.inProgressContext.message !== `Loading local & fetching remote iCloud Library state...`) {
            return;
        }

        this.updateState(StateType.RUNNING, {
            progressMsg: this.inProgressContext.message,
            progressDetail: detail,
            progress: progress ?? this.parseFetchAndLoadProgress(detail) ?? this.inProgressContext.progress
        });
    }

    /**
     * Parses known iCloud Photos fetch detail strings into the fetch/load phase progress range.
     * @param detail - Human-readable fetch/load detail
     * @returns Overall progress percentage if the detail includes countable work
     */
    private parseFetchAndLoadProgress(detail: string): number | undefined {
        const pageRangeMatch = detail.match(/pages \d+-(\d+)\/(\d+)/);
        if (pageRangeMatch) {
            return this.getProgressInRange(
                Number.parseInt(pageRangeMatch[1], 10),
                Number.parseInt(pageRangeMatch[2], 10),
                SYNC_PROGRESS.FETCH_LOAD_START,
                SYNC_PROGRESS.REMOTE_METADATA_FETCH_END,
            );
        }

        const pageBatchMatch = detail.match(/(\d+)\/(\d+) page batches/);
        if (pageBatchMatch) {
            return this.getProgressInRange(
                Number.parseInt(pageBatchMatch[1], 10),
                Number.parseInt(pageBatchMatch[2], 10),
                SYNC_PROGRESS.FETCH_LOAD_START,
                SYNC_PROGRESS.REMOTE_METADATA_FETCH_END,
            );
        }

        return undefined;
    }

    /**
     * Maps phase-local completion into the overall sync progress range.
     * @param completed - Completed units within the phase
     * @param total - Total units within the phase
     * @param start - Overall progress percentage at phase start
     * @param end - Overall progress percentage at phase completion
     * @returns Overall progress percentage
     */
    private getProgressInRange(completed: number, total: number, start: number, end: number): number {
        if (total <= 0) {
            return end;
        }

        const ratio = Math.max(0, Math.min(completed / total, 1));
        return Math.round((start + (ratio * (end - start))) * 100) / 100;
    }

    /**
     * Gets a human-facing asset name for state updates.
     * @param asset - The asset being processed
     * @returns A filename suitable for the Web UI
     */
    private getAssetDisplayName(asset?: Asset): string | undefined {
        if (!asset) {
            return undefined;
        }

        if (asset.origFilename) {
            return asset.getPrettyFilename();
        }

        return asset.getAssetFilename();
    }

    /**
     * Indicates that the current state was changed due to a trigger (such as sync or auth).
     * This will clear any previous error and logs.
     * @param trigger - The trigger that caused the state change
     */
    triggerSync(trigger: StateTrigger) {
        this.prevTrigger = trigger;
        this.prevError = undefined;
        this.log = []
        this.assetProgressTracker.reset();
        this.updateState(StateType.RUNNING, {progress: 0, progressMsg: `Starting ${trigger}...`})
    }

    addLog(level: LogLevel, source: string | any, message: string) {
        if(!this.log) {
            this.log = []
        }

        const msg = {
            level,
            message,
            source: typeof source === `string` ? source : String(source.constructor.name),
            time: Date.now()
        }

        this.log.push(msg)
        Resources.event().emit(iCPSState.LOG_ADDED, msg)
    }

    /**
     * Serializes the state object for transfer
     * @returns The serialized object
     */
    serialize(): SerializedState {
        let error = undefined
        if(this.prevError) {
            error = {
                message: this.prevError.getDescription(),
                code: this.prevError.getRootErrorCode(),
            }

            /**
             * If possible, this will try to convert known error codes into user-friendly messages
             */
            switch (error.code) {
            case MFA_ERR.FAIL_ON_MFA.code:
                error.message = `MFA code required. Use the 'Renew Authentication' button to request and enter a new code.`;
                break;
            case AUTH_ERR.UNAUTHORIZED.code:
                error.message = `Your credentials seem to be invalid. Please check your iCloud credentials and try again.`;
                break;
            case WEB_SERVER_ERR.MFA_CODE_NOT_PROVIDED.code:
                error.message = `MFA code not provided within timeout period. Use the 'Renew Authentication' button to request and enter a new code.`;
                break;
            }
        }

        let trustedPhoneNumbers = undefined
        if(this.trustedPhoneNumbers) {
            trustedPhoneNumbers = this.trustedPhoneNumbers.map((value) => {
                return {
                    id: value.id, 
                    maskedNumber: value.numberWithDialCode
                }
            })
        }

        return {
            state: this.state,
            hasCredentials: Resources.manager().hasCredentials,
            credentialsProvidedAtStartup: Resources.manager().credentialsProvidedAtStartup,
            nextSync: this.nextSync,
            prevError: error,
            prevTrigger: this.prevTrigger,
            timestamp: this.timestamp,
            progress: this.inProgressContext?.progress,
            progressMsg: this.inProgressContext?.message,
            progressDetail: this.inProgressContext?.detail,
            trustTokenCreatedAt: Resources.manager().trustTokenCreatedAt,
            trustTokenExpiresAt: Resources.manager().trustTokenExpiresAt,
            trustedPhoneNumbers
        };
    }

    /**
     * @param logFilter - A filter that will provide log messages for the current run
     * @returns An array of log messages filtered by log level
     */
    serializeLog(logFilter: LogFilter): LogMessage[] {
        if(logFilter.level === `none`) {
            return []
        }

        const logLevels: LogLevel[] = []
        /* eslint-disable no-fallthrough */
        switch(logFilter.level) {
        case LogLevel.DEBUG:
            logLevels.push(LogLevel.DEBUG)
        case LogLevel.INFO:
            logLevels.push(LogLevel.INFO)
        case LogLevel.WARN:
            logLevels.push(LogLevel.WARN)
        case LogLevel.ERROR:
            logLevels.push(LogLevel.ERROR)
        }

        const filteredLog = (this.log ?? []).filter(_value => {
            return logLevels.includes(_value.level) && _value.source.match(logFilter?.source) // .match(undefined) returns true
        });

        const offset = logFilter.offset ?? 0;
        const limit = logFilter.limit ?? filteredLog.length;
        return filteredLog.slice(offset, offset + limit);
    }
}
