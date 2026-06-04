import net from 'net';
import tls from 'tls';
import {iCPSEventCloud} from "../../lib/resources/events-types.js";
import {Resources} from "../../lib/resources/main.js";
import {SmtpConfig} from "../../lib/resources/resource-manager.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const SMTP_TIMEOUT_MS = 30 * 1000;

type EmailMessage = {
    subject: string,
    text: string
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

    constructor() {
        const smtpConfig = Resources.manager().smtpConfig;
        if (!smtpConfig || smtpConfig.to.length === 0) {
            return;
        }

        this.smtpClient = new SmtpClient(smtpConfig);
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
