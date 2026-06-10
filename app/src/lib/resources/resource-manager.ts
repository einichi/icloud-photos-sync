import * as path from 'path';
import {RESOURCES_ERR} from "../../app/error/error-codes.js";
import {iCPSError} from "../../app/error/error.js";
import {iCPSAppOptions} from "../../app/factory.js";
import {Resources} from "./main.js";
import {HAR_FILE_NAME, LIBRARY_LOCK_FILE_NAME, LOG_FILE_NAME, METRICS_FILE_NAME, PhotosAccountZone, RESOURCE_FILE_NAME, ResourceFile, iCPSResources} from "./resource-types.js";
import { PushSubscription } from "./web-server-types.js";
import webpush from 'web-push'
import {LogLevel} from "./state-manager.js";
import {ResourceFileStore} from "./resource-file-store.js";

type AppleCredentials = {
    username: string,
    password: string
}

export type SmtpConfig = {
    host: string,
    port: number,
    secure: `starttls` | `implicit`,
    user?: string,
    password?: string,
    from: string,
    to: string[]
}

const DAY_MS = 24 * 60 * 60 * 1000;

function removeUndefinedOptions<T extends object>(options: T): Partial<T> {
    return Object.entries(options).reduce<Partial<T>>((definedOptions, [key, value]) => {
        if (value !== undefined) {
            (definedOptions as Record<string, unknown>)[key] = value;
        }

        return definedOptions;
    }, {});
}

/**
 * This class handles access to the .icloud-photos-sync resource file and handles currently applied configurations from the CLI and environment variables
 */
export class ResourceManager {
    /**
     * The shared resources held by this instances of the icps application
     */
    _resources: iCPSResources = {} as iCPSResources;

    private get resourceFileStore(): ResourceFileStore {
        return new ResourceFileStore(this.resourceFilePath, this);
    }

    private getLogger(): Resources.Types.Logger {
        const noop = () => undefined;
        const noopLogger = {
            log: noop,
            debug: noop,
            info: noop,
            warn: noop,
            error: noop,
        };

        if (!Resources._instances?.event) {
            return noopLogger;
        }

        try {
            return Resources.logger(this);
        } catch (_err) {
            return noopLogger;
        }
    }

    /**
     * Creates the resource manager, based on the previously parsed iCPSAppOptions.
     * Should not be called directly, but through the static setup function.
     * @param appOptions - The parsed app options
     */
    constructor(appOptions: iCPSAppOptions) {
        this._resources.dataDir = appOptions.dataDir;
        const resourceFile = this._readResourceFile();
        // Assign app options & resource files to this data structure
        Object.assign(this._resources, resourceFile, removeUndefinedOptions(appOptions));
        const logger = this.getLogger();
        logger.info(`Resource manager initialized with data dir ${this.dataDir} (resource file trust token: ${resourceFile.trustToken ? `present` : `absent`}, effective trust token: ${this._resources.trustToken ? `present` : `absent`})`);

        // If trustToken should be refreshed, we clear it now
        if(this._resources.refreshToken) {
            logger.warn(`Refresh token option is enabled; clearing stored iCloud trust token`);
            this._resources.trustToken = undefined
            this._resources.trustTokenCreatedAt = undefined
        } else if (this._resources.trustToken && !this._resources.trustTokenCreatedAt) {
            this._resources.trustTokenCreatedAt = Date.now();
        }
        // Making sure new merged configuration is persisted to file
        this._writeResourceFile()
    }

    /**
     * Reads the resource file from disk and parses it
     */
    _readResourceFile(): ResourceFile {
        return this.resourceFileStore.read();
    }

    /**
     * Writes the resources to the resource file
     */
    _writeResourceFile() {
        this.resourceFileStore.write(this._resources);
    }

    /**
     * @returns The data dir read from the CLI Options
     */
    get dataDir(): string {
        return this._resources.dataDir;
    }

    /**
     * @returns The path to the resource file
     */
    get resourceFilePath(): string {
        return path.format({
            dir: this.dataDir,
            base: RESOURCE_FILE_NAME,
        });
    }

    /**
     * @returns The path to the log file
     */
    get logFilePath(): string {
        return path.format({
            dir: this.dataDir,
            base: LOG_FILE_NAME,
        });
    }

    /**
     * @returns The path to the library lock file
     */
    get lockFilePath(): string {
        return path.format({
            dir: this.dataDir,
            base: LIBRARY_LOCK_FILE_NAME,
        });
    }

    /**
     * @returns The path to the metrics file
     */
    get metricsFilePath(): string {
        return path.format({
            dir: this.dataDir,
            base: METRICS_FILE_NAME,
        });
    }

    /**
     * @returns The path to the har file
     */
    get harFilePath(): string {
        return path.format({
            dir: this.dataDir,
            base: HAR_FILE_NAME,
        });
    }

    /**
     * Even though present in the resource file, this will only be loaded once and not re-read
     * @returns The currently loaded libraries version
     */
    get libraryVersion(): number {
        return this._resources.libraryVersion;
    }

    /**
     * This will always read the resource file for the most recently trust token and update the internal data structure
     * @returns The currently used trust token, or undefined if none is set.
     */
    get trustToken(): string | undefined {
        const previousTrustToken = this._resources.trustToken;
        const previousTrustTokenCreatedAt = this._resources.trustTokenCreatedAt;
        const resourceFile = this._readResourceFile();
        if (resourceFile.trustToken || !previousTrustToken) {
            this._resources.trustToken = resourceFile.trustToken;
            this._resources.trustTokenCreatedAt = resourceFile.trustTokenCreatedAt;
        } else {
            Resources.logger(this).warn(`Resource file at ${this.resourceFilePath} has no trust token; retaining in-memory trust token`);
            this._resources.trustTokenCreatedAt = previousTrustTokenCreatedAt;
        }
        if (this._resources.trustToken && !this._resources.trustTokenCreatedAt) {
            this._resources.trustTokenCreatedAt = Date.now();
            this._writeResourceFile();
        }
        Resources.logger(this).info(`Trust token lookup from ${this.resourceFilePath}: ${this._resources.trustToken ? `present` : `absent`}`);

        return this._resources.trustToken;
    }

    /**
     * Sets the trust token and syncs the resource file.
     * @param trustToken - The trust token to use
     */
    set trustToken(trustToken: string | undefined) {
        const previousTrustToken = this._resources.trustToken;
        this._resources.trustToken = trustToken;
        if (!trustToken) {
            this._resources.trustTokenCreatedAt = undefined;
        } else if (trustToken !== previousTrustToken || !this._resources.trustTokenCreatedAt) {
            this._resources.trustTokenCreatedAt = Date.now();
        }
        this._writeResourceFile();
    }

    /**
     * @returns The timestamp when the current trust token was first persisted, if available
     */
    get trustTokenCreatedAt(): number | undefined {
        return this._resources.trustTokenCreatedAt;
    }

    /**
     * @returns The timestamp when the current trust token should be considered expired, if known
     */
    get trustTokenExpiresAt(): number | undefined {
        if (!this._resources.trustToken || !this._resources.trustTokenCreatedAt) {
            return undefined;
        }

        return this._resources.trustTokenCreatedAt + (this._resources.trustTokenLifetimeDays * DAY_MS);
    }

    /**
     * @returns How many days before token expiry SMTP warnings should start
     */
    get smtpTokenExpiryWarningDays(): number {
        return this._resources.smtpTokenExpiryWarningDays;
    }

    /**
     * @returns Whether SMTP sync result report emails should be sent
     */
    get smtpSyncReport(): boolean {
        return this._resources.smtpSyncReport;
    }

    /**
     * @returns SMTP configuration, if enough options were provided to enable email notifications
     */
    get smtpConfig(): SmtpConfig | undefined {
        if (!this._resources.smtpHost || !this._resources.smtpFrom || !this._resources.smtpTo) {
            return undefined;
        }

        const recipients = this._resources.smtpTo.split(`,`).map(recipient => recipient.trim()).filter(recipient => recipient.length > 0);
        if (recipients.length === 0) {
            return undefined;
        }

        return {
            host: this._resources.smtpHost,
            port: this._resources.smtpPort,
            secure: this._resources.smtpSecure,
            user: this._resources.smtpUser,
            password: this._resources.smtpPassword,
            from: this.getSmtpFromAddress(),
            to: recipients,
        };
    }

    /**
     * @returns Sender address formatted with optional display name
     */
    private getSmtpFromAddress(): string {
        if (!this._resources.smtpFromName) {
            return this._resources.smtpFrom!;
        }

        const escapedName = this._resources.smtpFromName.replace(/["\\]/g, `\\$&`);
        return `"${escapedName}" <${this.extractEmailAddress(this._resources.smtpFrom!)}>`;
    }

    /**
     * @param address - Raw or display-formatted email address
     * @returns The email address without a display name wrapper
     */
    private extractEmailAddress(address: string): string {
        return address.match(/<([^>]+)>/)?.[1] ?? address.trim();
    }

    /**
     * Retrieves the notification vapid credentials, generating them if they do not exist.
     * @returns The notification vapid credentials, containing the public and private key
     */
    get notificationVapidCredentials(): { publicKey: string, privateKey: string } {
        let credentials = this._resources.notificationVapidCredentials;
        if (!credentials) {
            credentials = webpush.generateVAPIDKeys();
            this._resources.notificationVapidCredentials = credentials;
            this._writeResourceFile();
        }
        return credentials;
    }

    /**
     * Gets the notification subscriptions from the resource file.
     * @returns The notification subscriptions, or an empty map if none are set
     */
    get notificationSubscriptions(): webpush.PushSubscription[] {
        return this._resources.notificationSubscriptions 
            ? Object.values(this._resources.notificationSubscriptions) 
            : [];
    }

    /**
     * Adds a subscription to the notification subscriptions in the resource file.
     * @param subscription - The notification subscription to add
     */
    addNotificationSubscription(subscription: PushSubscription) {
        this._resources.notificationSubscriptions = this._resources.notificationSubscriptions || {};
        this._resources.notificationSubscriptions[subscription.endpoint] = subscription;
        this._writeResourceFile();
    }

    /**
     * Removes a subscription from the notification subscriptions in the resource file.
     * @param subscription - The notification subscription to remove
     */
    removeNotificationSubscription(subscription: webpush.PushSubscription) {
        if (this._resources.notificationSubscriptions && subscription.endpoint in this._resources.notificationSubscriptions) {
            delete this._resources.notificationSubscriptions[subscription.endpoint]
            this._writeResourceFile();
        } else {
            Resources.logger(this).warn(`No notification subscriptions found to remove endpoint: ${subscription.endpoint}`);
        }
    }

    /**
     * @returns True if complete Apple ID credentials are currently available in memory.
     */
    get hasCredentials(): boolean {
        return Boolean(this._resources.username && this._resources.password);
    }

    /**
     * @returns True if complete Apple ID credentials were supplied at process startup.
     */
    get credentialsProvidedAtStartup(): boolean {
        return Boolean(this._resources.credentialsProvidedAtStartup);
    }

    /**
     * Stores Apple ID credentials in memory for this process only.
     * Startup credentials are treated as authoritative and cannot be replaced from the Web UI.
     * @param credentials - The credentials to store
     * @returns True if the credentials were accepted, false if startup credentials are already present
     */
    setCredentials(credentials: AppleCredentials): boolean {
        if (this.credentialsProvidedAtStartup) {
            return false;
        }

        this._resources.username = credentials.username;
        this._resources.password = credentials.password;
        return true;
    }

    /**
     * @returns The iCloud username
     * @throws If no complete credentials are set
     */
    get username(): string {
        if (!this.hasCredentials) {
            throw new iCPSError(RESOURCES_ERR.NO_CREDENTIALS);
        }
        return this._resources.username!;
    }

    /**
     * @returns The iCloud user password
     * @throws If no complete credentials are set
     */
    get password(): string {
        if (!this.hasCredentials) {
            throw new iCPSError(RESOURCES_ERR.NO_CREDENTIALS);
        }
        return this._resources.password!;
    }

    /**
     * @returns The port to use for the MFA server
     */
    get webServerPort(): number {
        return this._resources.port;
    }

    /**
     * @returns The web base path for subpath deployment
     */
    get webBasePath(): string {
        return this._resources.webBasePath;
    }

    /**
     * @returns The Web UI URL to render in notification emails
     */
    get notificationWebUrl(): string {
        const host = this._resources.notificationWebHostIp?.trim() || `localhost`;
        const port = this._resources.notificationWebExposedPort ?? this.webServerPort;
        return `http://${host}:${port}${this.webBasePath}/state`;
    }

    /**
     * @returns The number of retries to use for downloading
     */
    get maxRetries(): number {
        return this._resources.maxRetries;
    }

    /**
     * @returns The number of threads to use for downloading
     */
    get downloadThreads(): number {
        return this._resources.downloadThreads;
    }

    /**
     * @returns The schedule of the application
     */
    get schedule(): string {
        return this._resources.schedule;
    }

    /**
     * @returns Cron schedule for scheduled syncs that should checksum-verify already-present local assets
     */
    get scheduledChecksumVerificationCron(): string | undefined {
        return this._resources.scheduledChecksumVerificationCron;
    }

    /**
     * @returns If the application should enable crash reporting
     */
    get enableCrashReporting(): boolean {
        return this._resources.enableCrashReporting;
    }

    /**
     * @returns If the application should fail on MFA requirement
     */
    get mfaTimeout(): number {
        return this._resources.mfaTimeout;
    }

    /**
     * @returns If an existing library lock should be forcefully removed
     */
    get force(): boolean {
        return this._resources.force;
    }

    /**
     * @returns If the application should delete remote files
     */
    get remoteDelete(): boolean {
        return this._resources.remoteDelete;
    }

    /**
     * @returns The log level of the application
     */
    get logLevel(): LogLevel {
        return this._resources.logLevel;
    }

    /**
     * @returns If the application should run in silent mode
     */
    get silent(): boolean {
        return this._resources.silent;
    }

    /**
     * @returns If the application should log to the CLI
     */
    get logToCli(): boolean {
        return this._resources.logToCli;
    }

    /**
     * @returns If the application should suppress warnings
     */
    get suppressWarnings(): boolean {
        return this._resources.suppressWarnings;
    }

    /**
     * @returns If the application should export metrics
     */
    get exportMetrics(): boolean {
        return this._resources.exportMetrics;
    }

    /**
     * @returns The rate at which the metadata should be downloaded
     */
    get metadataRate(): [number, number] {
        return this._resources.metadataRate;
    }

    /**
     * @returns If the application should capture network traffic
     */
    get enableNetworkCapture(): boolean {
        return this._resources.enableNetworkCapture;
    }

    /**
     * @returns The region to be used for this app
     */
    get region(): Resources.Types.Region {
        return this._resources.region;
    }

    /**
     * @returns The session secret of the account
     * @throws If no session secret is set
     */
    get sessionSecret(): string {
        if (this._resources.sessionSecret === undefined) {
            throw new iCPSError(RESOURCES_ERR.NO_SESSION_SECRET);
        }

        return this._resources.sessionSecret;
    }

    /**
     * Sets the session secret of the account
     * @param sessionSecret - The session secret to set
     */
    set sessionSecret(sessionSecret: string) {
        this._resources.sessionSecret = sessionSecret;
    }

    /**
     * @returns The primary zone of the account
     * @throws If no primary zone is set
     */
    get primaryZone(): PhotosAccountZone {
        if (!this._resources.primaryZone) {
            throw new iCPSError(RESOURCES_ERR.NO_PRIMARY_ZONE);
        }

        return this._resources.primaryZone;
    }

    /**
     * Sets the primary zone of the account
     * @param primaryZone - The primary zone to set
     */
    set primaryZone(primaryZone: PhotosAccountZone) {
        this._resources.primaryZone = primaryZone;
    }

    /**
     * @returns The shared zone of the account
     * @throws If no shared zone is set
     */
    get sharedZone(): PhotosAccountZone {
        if (!this._resources.sharedZone) {
            throw new iCPSError(RESOURCES_ERR.NO_SHARED_ZONE);
        }

        return this._resources.sharedZone;
    }

    /**
     * Sets the shared zone of the account
     * @param sharedZone - The shared zone to set
     */
    set sharedZone(sharedZone: PhotosAccountZone) {
        this._resources.sharedZone = sharedZone;
    }

    /**
     * @returns If the shared zone is available
     */
    get sharedZoneAvailable(): boolean {
        return Boolean(this._resources.sharedZone);
    }

    /**
     * @returns True if legacy login should be used, false otherwise
     */
    get legacyLogin(): boolean {
        return this._resources.legacyLogin;
    }

    get healthCheckUrl(): string {
        return this._resources.healthCheckUrl;
    }
}
