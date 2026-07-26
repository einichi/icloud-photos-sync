import net from 'net';
import tls from 'tls';
import {AssetDownloadReason, iCPSEventCloud, iCPSEventRuntimeError, iCPSEventRuntimeWarning, iCPSEventSyncEngine, iCPSState} from "../../lib/resources/events-types.js";
import {Asset} from "../../lib/photos-library/model/asset.js";
import {Resources} from "../../lib/resources/main.js";
import {SmtpConfig} from "../../lib/resources/resource-manager.js";
import {LogLevel, LogMessage} from "../../lib/resources/state-manager.js";
import {iCPSError} from "../error/error.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const SMTP_TIMEOUT_MS = 30 * 1000;
const MAX_SYNC_REPORT_LIST_ITEMS = 50;

type EmailMessage = {
    subject: string,
    text: string
}

type SyncEmailReport = {
    startedAt: number,
    downloadedNew: string[],
    downloadedRedownloaded: string[],
    failedAssetWrites: FailedAssetWrite[],
    hashCheckingOccurred: boolean,
    hashCheckedCount: number,
    hashCheckTotal?: number,
    errors: string[],
}

type FailedAssetWrite = {
    assetName: string,
    reason: string,
}

class SmtpClient {
    constructor(private readonly config: SmtpConfig) {}

    async send(message: EmailMessage): Promise<void> {
        let socket = await this.connect();
        try {
            await this.readResponse(socket);
            const ehloResponse = await this.sendCommand(socket, `EHLO localhost`);

            if (this.config.secure === `starttls`) {
                if (!/\bSTARTTLS\b/i.test(ehloResponse)) {
                    throw new Error(`SMTP server does not advertise STARTTLS`);
                }
                await this.sendCommand(socket, `STARTTLS`);
                const tlsSocket = tls.connect({
                    socket,
                    servername: this.config.host,
                });
                await new Promise<void>((resolve, reject) => {
                    tlsSocket.once(`secureConnect`, resolve);
                    tlsSocket.once(`error`, reject);
                });
                socket = tlsSocket;
                await this.sendCommand(socket, `EHLO localhost`);
            }

            await this.sendAuthenticatedMail(socket, message);
        } finally {
            socket.end();
        }
    }

    private connect(): Promise<net.Socket> {
        return new Promise((resolve, reject) => {
            const socket = this.config.secure === `implicit`
                ? tls.connect({
                    host: this.config.host,
                    port: this.config.port,
                    servername: this.config.host,
                    timeout: SMTP_TIMEOUT_MS,
                })
                : net.createConnection({
                    host: this.config.host,
                    port: this.config.port,
                    timeout: SMTP_TIMEOUT_MS,
                });

            socket.once(this.config.secure === `implicit` ? `secureConnect` : `connect`, () => resolve(socket));
            socket.once(`timeout`, () => {
                socket.destroy();
                reject(new Error(`SMTP connection timed out`));
            });
            socket.once(`error`, reject);
        });
    }

    private async sendAuthenticatedMail(socket: net.Socket, message: EmailMessage): Promise<void> {
        if (this.config.user && this.config.password) {
            const auth = Buffer.from(`\0${this.config.user}\0${this.config.password}`).toString(`base64`);
            await this.sendCommand(socket, `AUTH PLAIN ${auth}`);
        }

        await this.sendCommand(socket, `MAIL FROM:<${this.extractAddress(this.config.from)}>`);
        for (const recipient of this.config.to) {
            await this.sendCommand(socket, `RCPT TO:<${this.extractAddress(recipient)}>`);
        }
        await this.sendCommand(socket, `DATA`);
        await this.sendCommand(socket, this.formatMessage(message), 250);
        await this.sendCommand(socket, `QUIT`, 221);
    }

    private formatMessage(message: EmailMessage): string {
        const recipients = this.config.to.join(`, `);
        const body = message.text
            .replace(/\r?\n/g, `\r\n`)
            .replace(/^\./gm, `..`);

        return [
            `From: ${this.config.from}`,
            `To: ${recipients}`,
            `Subject: ${message.subject}`,
            `Content-Type: text/plain; charset=utf-8`,
            `Content-Transfer-Encoding: 8bit`,
            ``,
            body,
            `.`,
        ].join(`\r\n`);
    }

    private extractAddress(address: string): string {
        return address.match(/<([^>]+)>/)?.[1] ?? address.trim();
    }

    private async sendCommand(socket: net.Socket, command: string, expectedCode?: number): Promise<string> {
        socket.write(`${command}\r\n`);
        const response = await this.readResponse(socket);
        if (expectedCode && !response.startsWith(String(expectedCode))) {
            throw new Error(`Unexpected SMTP response: ${response.split(`\n`)[0]}`);
        }
        if (!expectedCode && !/^(2|3)\d{2}/.test(response)) {
            throw new Error(`Unexpected SMTP response: ${response.split(`\n`)[0]}`);
        }
        return response;
    }

    private readResponse(socket: net.Socket): Promise<string> {
        return new Promise((resolve, reject) => {
            let response = ``;
            const timeout = setTimeout(() => {
                cleanup();
                reject(new Error(`SMTP response timed out`));
            }, SMTP_TIMEOUT_MS);

            const cleanup = () => {
                clearTimeout(timeout);
                socket.off(`data`, onData);
                socket.off(`error`, onError);
            };
            const onError = (err: Error) => {
                cleanup();
                reject(err);
            };
            const onData = (chunk: Buffer) => {
                response += chunk.toString(`utf-8`);
                const lines = response.split(/\r?\n/).filter(line => line.length > 0);
                const lastLine = lines[lines.length - 1];
                if (/^\d{3} /.test(lastLine)) {
                    cleanup();
                    resolve(response);
                }
            };

            socket.on(`data`, onData);
            socket.on(`error`, onError);
        });
    }
}

export class EmailNotifier {
    private readonly smtpClient?: SmtpClient;
    private tokenExpiryTimer?: NodeJS.Timeout;
    private lastTokenExpiryWarningDate?: string;
    private currentSyncReport?: SyncEmailReport;

    constructor() {
        const smtpConfig = Resources.manager().smtpConfig;
        if (!smtpConfig || smtpConfig.to.length === 0) {
            return;
        }

        this.smtpClient = new SmtpClient(smtpConfig);
        this.registerSyncReportListeners();
        this.sendStartupAuthenticationReminder()
            .catch(err => Resources.logger(this).error(`Failed to send startup authentication email: ${err}`));
        this.checkTokenExpiry()
            .catch(err => Resources.logger(this).error(`Failed to send token expiry email: ${err}`));

        this.tokenExpiryTimer = setInterval(() => {
            this.checkTokenExpiry()
                .catch(err => Resources.logger(this).error(`Failed to send token expiry email: ${err}`));
        }, DAY_MS);
        this.tokenExpiryTimer.unref();

        Resources.events(this).on(iCPSEventCloud.TRUSTED, () => {
            this.lastTokenExpiryWarningDate = undefined;
        });
    }

    private registerSyncReportListeners(): void {
        if (!Resources.manager().smtpSyncReport) {
            return;
        }

        Resources.events(this)
            .on(iCPSEventSyncEngine.START, () => {
                this.currentSyncReport = {
                    startedAt: Date.now(),
                    downloadedNew: [],
                    downloadedRedownloaded: [],
                    failedAssetWrites: [],
                    hashCheckingOccurred: false,
                    hashCheckedCount: 0,
                    errors: [],
                };
            })
            .on(iCPSEventSyncEngine.VERIFY_LOCAL_ASSETS_PROGRESS, (checkedCount: number, totalCount: number) => {
                const report = this.currentSyncReport;
                if (!report || totalCount === 0) {
                    return;
                }

                report.hashCheckingOccurred = true;
                report.hashCheckedCount = Math.max(report.hashCheckedCount, checkedCount);
                report.hashCheckTotal = totalCount;
            })
            .on(iCPSEventSyncEngine.WRITE_ASSET_DOWNLOADED, (assetName: string, reason: AssetDownloadReason) => {
                const report = this.currentSyncReport;
                if (!report) {
                    return;
                }

                if (reason === `redownloaded`) {
                    report.downloadedRedownloaded.push(assetName);
                    return;
                }

                report.downloadedNew.push(assetName);
            })
            .on(iCPSEventRuntimeWarning.WRITE_ASSET_ERROR, (err: Error, asset?: Asset) => {
                const report = this.currentSyncReport;
                if (!report) {
                    return;
                }

                const syncError = iCPSError.toiCPSError(err);
                report.failedAssetWrites.push({
                    assetName: this.getAssetDisplayName(asset),
                    reason: this.getFailedAssetWriteReason(syncError),
                });
            })
            .on(iCPSEventSyncEngine.RETRY, () => {
                const report = this.currentSyncReport;
                if (!report) {
                    return;
                }

                report.failedAssetWrites = [];
            })
            .on(iCPSState.LOG_ADDED, (logMsg: LogMessage) => {
                const report = this.currentSyncReport;
                if (!report || ![LogLevel.WARN, LogLevel.ERROR].includes(logMsg.level)) {
                    return;
                }

                if (this.shouldExcludeFromReportWarnings(logMsg)) {
                    return;
                }

                report.errors.push(`${logMsg.level.toUpperCase()} ${logMsg.source}: ${logMsg.message}`);
            })
            .on(iCPSEventSyncEngine.DONE, () => {
                this.sendSyncReport(`success`)
                    .catch(err => Resources.logger(this).error(`Failed to send sync result email: ${err}`));
            })
            .on(iCPSEventRuntimeError.SCHEDULED_ERROR, (err: iCPSError) => {
                this.addSyncReportError(err);
                this.sendSyncReport(`failed`)
                    .catch(sendErr => Resources.logger(this).error(`Failed to send sync result email: ${sendErr}`));
            })
            .on(iCPSEventRuntimeError.HANDLED_ERROR, (err: iCPSError) => {
                this.addSyncReportError(err);
            });
    }

    private addSyncReportError(err: iCPSError): void {
        const report = this.currentSyncReport;
        if (!report) {
            return;
        }

        report.errors.push(`ERROR RuntimeError: ${iCPSError.toiCPSError(err).getDescription()}`);
    }

    private async sendSyncReport(status: `success` | `failed`): Promise<void> {
        const report = this.currentSyncReport;
        if (!report) {
            return;
        }

        this.currentSyncReport = undefined;
        const downloadedNewCount = report.downloadedNew.length;
        const downloadedRedownloadedCount = report.downloadedRedownloaded.length;
        const downloadedTotalCount = downloadedNewCount + downloadedRedownloadedCount;
        const failedAssetWriteCount = report.failedAssetWrites.length;
        const errorCount = report.errors.length + failedAssetWriteCount;
        const displayStatus = status === `failed`
            ? `failed`
            : errorCount > 0 ? `completed with warnings` : `success`;
        const finishedAt = Date.now();

        await this.send({
            subject: `iCloud Photos Sync ${displayStatus}: ${downloadedTotalCount} downloaded, ${failedAssetWriteCount} not copied, ${errorCount} warning/error(s)`,
            text: [
                `Summary`,
                `-------`,
                `Status: ${displayStatus}`,
                `Started: ${new Date(report.startedAt).toLocaleString()}`,
                `Finished: ${new Date(finishedAt).toLocaleString()}`,
                `Duration: ${this.formatDuration(finishedAt - report.startedAt)}`,
                `Downloaded: ${downloadedTotalCount} file(s) (${downloadedNewCount} new, ${downloadedRedownloadedCount} redownloaded after mismatch)`,
                `Files not copied: ${failedAssetWriteCount}`,
                `Hash checking: ${report.hashCheckingOccurred ? `yes (${report.hashCheckedCount}/${report.hashCheckTotal} kept asset(s) checked)` : `no`}`,
                `Warnings/errors: ${errorCount} (${report.errors.length} other, ${failedAssetWriteCount} failed file(s))`,
                ``,
                `New Downloads`,
                `-------------`,
                this.formatList(report.downloadedNew),
                ``,
                `Redownloaded After Mismatch`,
                `---------------------------`,
                this.formatList(report.downloadedRedownloaded),
                ``,
                `Files Not Copied`,
                `----------------`,
                this.formatFailedAssetWrites(report.failedAssetWrites),
                ``,
                `Warnings/Errors`,
                `---------------`,
                this.formatList(report.errors),
                ``,
                `Web UI: ${this.webUiUrl}`,
            ].join(`\n`),
        });
    }

    private async sendStartupAuthenticationReminder(): Promise<void> {
        if (Resources.manager().hasCredentials) {
            return;
        }

        await this.send({
            subject: `iCloud Photos Sync authentication required`,
            text: [
                `iCloud Photos Sync started and is waiting for Apple ID credentials.`,
                ``,
                `Open the Web UI and authenticate to allow syncs to run.`,
                `Web UI: ${this.webUiUrl}`,
                ``,
                `Credentials submitted through the Web UI are kept in memory only and will be required again after the service restarts.`,
            ].join(`\n`),
        });
    }

    private async checkTokenExpiry(now = Date.now()): Promise<void> {
        const expiresAt = Resources.manager().trustTokenExpiresAt;
        if (!expiresAt) {
            return;
        }

        const warningWindowMs = Resources.manager().smtpTokenExpiryWarningDays * DAY_MS;
        const remainingMs = expiresAt - now;
        if (remainingMs > warningWindowMs) {
            return;
        }

        const today = new Date(now).toISOString().slice(0, 10);
        if (this.lastTokenExpiryWarningDate === today) {
            return;
        }
        this.lastTokenExpiryWarningDate = today;

        const expired = remainingMs <= 0;
        const remaining = expired
            ? `already expired`
            : `expires in ${Math.max(0, Math.ceil(remainingMs / DAY_MS))} day(s)`;

        await this.send({
            subject: expired
                ? `iCloud Photos Sync trust token expired`
                : `iCloud Photos Sync trust token expires soon`,
            text: [
                `The stored iCloud trust token ${remaining}.`,
                `Expiry time: ${new Date(expiresAt).toLocaleString()}`,
                ``,
                `Open the Web UI and renew authentication if MFA is required.`,
                `Web UI: ${this.webUiUrl}`,
            ].join(`\n`),
        });
    }

    private formatList(items: string[]): string {
        if (items.length === 0) {
            return `None`;
        }

        const listedItems = items.slice(0, MAX_SYNC_REPORT_LIST_ITEMS).map(item => `- ${item}`);
        if (items.length > MAX_SYNC_REPORT_LIST_ITEMS) {
            listedItems.push(`- ... ${items.length - MAX_SYNC_REPORT_LIST_ITEMS} more omitted`);
        }

        return listedItems.join(`\n`);
    }

    private formatFailedAssetWrites(items: FailedAssetWrite[]): string {
        if (items.length === 0) {
            return `None`;
        }

        const groups = new Map<string, string[]>();
        for (const item of items) {
            const group = groups.get(item.reason) ?? [];
            group.push(item.assetName);
            groups.set(item.reason, group);
        }

        return Array.from(groups.entries())
            .map(([reason, assetNames]) => [
                `${reason} (${assetNames.length})`,
                ...assetNames.sort().map(assetName => `- ${assetName}`),
            ].join(`\n`))
            .join(`\n\n`);
    }

    private getAssetDisplayName(asset?: Asset): string {
        if (!asset) {
            return `unknown asset`;
        }

        if (asset.origFilename) {
            return asset.getPrettyFilename();
        }

        return asset.getAssetFilename();
    }

    private getFailedAssetWriteReason(err: iCPSError): string {
        const statusCode = err.getDescription().match(/status code (\d+)/)?.[1];
        const reason = err.getRootErrorCode(true);

        return statusCode ? `${reason} (HTTP ${statusCode})` : reason;
    }

    private shouldExcludeFromReportWarnings(logMsg: LogMessage): boolean {
        return (logMsg.source === `SyncEngine` && logMsg.message.startsWith(`Retrying asset write for `))
            || (logMsg.source === `RuntimeWarning` && logMsg.message.startsWith(`Error while writing asset `));
    }

    private formatDuration(durationMs: number): string {
        const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;

        if (minutes === 0) {
            return `${seconds}s`;
        }

        return `${minutes}m ${seconds}s`;
    }

    private async send(message: EmailMessage): Promise<void> {
        if (!this.smtpClient) {
            return;
        }

        await this.smtpClient.send(message);
        Resources.logger(this).info(`Sent SMTP notification email: ${message.subject}`);
    }

    private get webUiUrl(): string {
        return Resources.manager().notificationWebUrl;
    }
}
