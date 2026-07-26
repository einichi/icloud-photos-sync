import {AxiosError, AxiosRequestConfig} from 'axios';
import {randomUUID} from 'crypto';
import {jsonc} from 'jsonc';
import pTimeout from 'p-timeout';
import {AUTH_ERR, ICLOUD_PHOTOS_ERR, MFA_ERR} from '../../app/error/error-codes.js';
import {iCPSError} from '../../app/error/error.js';
import {iCPSEventCloud, iCPSEventMFA, iCPSEventPhotos, iCPSEventRuntimeWarning} from '../resources/events-types.js';
import {Resources} from '../resources/main.js';
import {CLIENT_ID, COOKIE_KEYS, ENDPOINTS, TrustedPhoneNumber} from '../resources/network-types.js';
import {iCloudPhotos} from './icloud-photos/icloud-photos.js';
import {iCloudCrypto} from './icloud.crypto.js';
import {MFAMethod} from './mfa/mfa-method.js';

type ReadyWait = {
    promise: Promise<boolean>,
    cancel: () => void,
}

type SetupAccountOptions = {
    emitSessionExpired?: boolean,
}

/**
 * This class holds the iCloud connection
 */
export class iCloud {
    private static readonly LOCKED_ACCOUNT_SERVICE_ERROR_CODE = `-20209`;

    /**
     * Access to the iCloud Photos service
     */
    photos: iCloudPhotos;

    /**
     * Timeout for MFA code submission
     */
    mfaTimeout: NodeJS.Timeout;

    /**
     * Trust token snapshot used for the active authentication attempt.
     */
    private currentAuthenticationTrustToken?: string;

    /**
     * Whether an authentication attempt has already looked up the trust token.
     */
    private hasCurrentAuthenticationTrustToken = false;

    /**
     * Whether the active authentication attempt had to retry without a stored trust token.
     */
    private retriedAuthenticationWithoutTrustToken = false;

    /**
     * Creates a new iCloud Object
     * @param ignoreFailOnMfa - If set to true, the authentication will still continue even if MFA is required and the failOnMfa flag is set
     * @emits iCPSEventCloud.ERROR - If the MFA code is required and the failOnMfa flag is set - the iCPSError is provided as argument
     */
    constructor() {
        Resources.events(this)
            .on(iCPSEventMFA.MFA_RECEIVED, this.submitMFA.bind(this))
            .on(iCPSEventMFA.MFA_RESEND, this.resendMFA.bind(this));

        this.photos = new iCloudPhotos();

        // ICloud lifecycle management
        Resources.events(this)
            .on(iCPSEventCloud.MFA_REQUIRED, () => {
                // MFA code needs to be provided within timeout period
                this.mfaTimeout = setTimeout(() => {
                    Resources.emit(iCPSEventMFA.MFA_NOT_PROVIDED, new iCPSError(MFA_ERR.MFA_TIMEOUT));
                }, Resources.manager().mfaTimeout * 1000);
            })
            .on(iCPSEventCloud.TRUSTED, async () => {
                await this.setupAccount();
            })
            .on(iCPSEventCloud.AUTHENTICATED, async () => {
                await this.getTokens();
            })
            .on(iCPSEventCloud.ACCOUNT_READY, async () => {
                await this.getPhotosReady();
            })
            .on(iCPSEventCloud.SESSION_EXPIRED, async () => {
                await this.authenticate();
            })
            .on(iCPSEventCloud.PCS_REQUIRED, async () => {
                await this.acquirePCSCookies();
            });
    }

    /**
     *
     * @returns A promise that will resolve to true, if the connection was established successfully, false in case the MFA code was not provided in time or reject, in case there is an error
     */
    getReady(): Promise<boolean> {
        return this.waitForReady(this.createReadyWait());
    }

    private createReadyWait(): ReadyWait {
        const events = Resources.events(this);
        let cleanup = () => undefined;
        const promise = new Promise<boolean>((resolve, reject) => {
            const onReady = () => {
                cleanup();
                resolve(true);
            };
            const onMfaNotProvided = () => {
                cleanup();
                resolve(false);
            };
            const onError = (err: unknown) => {
                cleanup();
                reject(err);
            };
            cleanup = () => {
                events.removeListener(iCPSEventPhotos.READY, onReady);
                events.removeListener(iCPSEventMFA.MFA_NOT_PROVIDED, onMfaNotProvided);
                events.removeListener(iCPSEventCloud.ERROR, onError);
            };
            events
                .once(iCPSEventPhotos.READY, onReady)
                .once(iCPSEventMFA.MFA_NOT_PROVIDED, onMfaNotProvided)
                .once(iCPSEventCloud.ERROR, onError);
        });

        return {
            promise,
            cancel: cleanup,
        };
    }

    private waitForReady(readyWait: ReadyWait): Promise<boolean> {
        return pTimeout(readyWait.promise, {
            milliseconds: Resources.manager().mfaTimeout * 1000 + (1000 * 60 * 5), // 5 minutes on top of mfa timeout should be sufficient
            message: new iCPSError(AUTH_ERR.SETUP_TIMEOUT),
        }).finally(readyWait.cancel);
    }

    /**
     * Attempts to reuse an existing Apple web-auth session before starting a new MFA-capable authentication flow.
     * @returns True if the existing session brought iCloud Photos to readiness, false if fresh authentication is needed
     */
    async authenticateExistingSession(): Promise<boolean> {
        if (!Resources.manager().hasSessionSecret) {
            return false;
        }

        Resources.logger(this).info(`Reusing existing iCloud web session`);
        const readyWait = this.createReadyWait();

        try {
            if (!await this.setupAccount({emitSessionExpired: false})) {
                readyWait.cancel();
                Resources.logger(this).info(`Existing iCloud web session is no longer accepted; falling back to authentication`);
                return false;
            }

            return await this.waitForReady(readyWait);
        } catch (err) {
            readyWait.cancel();
            Resources.logger(this).warn(`Unable to reuse existing iCloud web session: ${iCPSError.toiCPSError(err).getDescription()}`);
            return false;
        }
    }

    /**
     * Initiates authentication flow. Tries to directly login using trustToken, otherwise starts MFA flow
     * @emits iCPSEventCloud.AUTHENTICATION_STARTED - When authentication is started
     * @emits iCPSEventCloud.MFA_REQUIRED - When MFA is required
     * @emits iCPSEventCloud.TRUSTED - When device is trusted - provides trust token as argument
     * @emits iCPSEventCloud.ERROR - When an error occurs - provides iCPSError as argument
     */
    async authenticate(): Promise<boolean> {
        const ready = this.getReady();
        const trustToken = Resources.manager().trustToken;
        this.currentAuthenticationTrustToken = trustToken;
        this.hasCurrentAuthenticationTrustToken = true;
        Resources.logger(this).info(`Authenticating user`);
        Resources.logger(this).info(`iCloud trust token lookup at ${Resources.manager().resourceFilePath}: ${trustToken ? `present` : `absent`}`);
        Resources.logger(this).info(trustToken
            ? `Using stored iCloud trust token for authentication`
            : `No stored iCloud trust token available; MFA may be required`);
        Resources.emit(iCPSEventCloud.AUTHENTICATION_STARTED);

        const config: AxiosRequestConfig = {
            params: {
                isRememberMeEnabled: `true`,
            },
            // 409 is expected, if MFA is required - 200 is expected, if authentication succeeds immediately
            validateStatus: status => status === 409 || status === 200,
        };

        try {
            let response;
            try {
                response = await this.performSignin(config);
            } catch (err) {
                if (!this.shouldRetrySigninWithoutTrustToken(err, trustToken)) {
                    throw err;
                }

                this.retriedAuthenticationWithoutTrustToken = true;
                Resources.logger(this).warn(`iCloud rejected SRP sign-in with stored trust token; retrying once without the stored trust token`);
                response = await this.performSignin(config, false);
            }

            const validatedResponse = Resources.validator().validateSigninResponse(response);
            Resources.network().applySigninResponse(validatedResponse);

            Resources.logger(this).debug(`Acquired signin secrets`);

            if (response.status === 409) {
                Resources.logger(this).debug(`Response status is 409, requiring MFA`);
                if (trustToken) {
                    Resources.logger(this).warn(`iCloud required MFA even though a stored trust token was included; the token may be expired, revoked, or not accepted by Apple`);
                }
                const trustedPhoneNumbers = await this.getTrustedPhoneNumbers()
                await this.requestTrustedDeviceMFA();
                Resources.emit(iCPSEventCloud.MFA_REQUIRED, trustedPhoneNumbers);
                return;
            }

            if (response.status === 200) {
                Resources.logger(this).debug(`Response status is 200, authentication successful - device trusted`);
                Resources.emit(iCPSEventCloud.TRUSTED, trustToken);
            }

            // This should never happen
            // Resources.emit(iCPSEventCloud.ERROR, new iCPSError(AUTH_ERR.ACQUIRE_AUTH_SECRETS));
        } catch (err) {
            if (err instanceof iCPSError) {
                Resources.emit(iCPSEventCloud.ERROR, err);
                return;
            }

            // Does not seem to work
            // if (err instanceof AxiosError) {
            if ((err as AxiosError).isAxiosError) {
                const status = (err as AxiosError).response?.status;
                switch (status) {
                case 401:
                    Resources.emit(iCPSEventCloud.ERROR, new iCPSError(AUTH_ERR.UNAUTHORIZED).addCause(err));
                    break;
                case 403:
                    Resources.emit(iCPSEventCloud.ERROR, new iCPSError(AUTH_ERR.FORBIDDEN)
                        .addMessage(`Apple returned HTTP 403; this can mean invalid credentials, account security state, or a rejected web-auth request`)
                        .addMessage(`Rejected endpoint: ${this.describeAxiosRequest(err as AxiosError)}`)
                        .addMessage(`Response body: ${this.describeAxiosResponseData(err as AxiosError)}`)
                        .addMessage(this.retriedAuthenticationWithoutTrustToken ? `Stored trust token retry: failed without stored trust token` : `Stored trust token retry: not attempted`)
                        .addContext(`status`, status)
                        .addCause(err));
                    break;
                case 412:
                    Resources.emit(iCPSEventCloud.ERROR, new iCPSError(AUTH_ERR.PRECONDITION_FAILED).addCause(err));
                    break;
                default:
                    Resources.emit(iCPSEventCloud.ERROR, new iCPSError(AUTH_ERR.UNEXPECTED_RESPONSE).addCause(err));
                }

                return;
            }

            Resources.emit(iCPSEventCloud.ERROR, new iCPSError(AUTH_ERR.UNKNOWN).addCause(err));
            return;
        } finally {
            this.currentAuthenticationTrustToken = undefined;
            this.hasCurrentAuthenticationTrustToken = false;
            this.retriedAuthenticationWithoutTrustToken = false;
            // Return in finally is required because control flow of try/catch block is complicated
            // eslint-disable-next-line no-unsafe-finally
            return ready;
        }
    }

    private async performSignin(config: AxiosRequestConfig, includeTrustToken: boolean = true) {
        const [url, data] = Resources.manager().legacyLogin
            ? this.getLegacyLogin(includeTrustToken)
            : await this.getSRPLogin(undefined, includeTrustToken);

        return Resources.network().post(url, data, config);
    }

    private shouldRetrySigninWithoutTrustToken(err: unknown, trustToken?: string): boolean {
        return !!trustToken
            && !Resources.manager().legacyLogin
            && (err as AxiosError).isAxiosError
            && (err as AxiosError).response?.status === 403
            && this.describeAxiosRequest(err as AxiosError) === `POST /appleauth/auth/signin/complete`;
    }

    private describeAxiosRequest(err: AxiosError): string {
        try {
            const requestUrl = new URL(err.config?.url ?? ``, err.config?.baseURL);
            return `${err.config?.method?.toUpperCase() ?? `UNKNOWN`} ${requestUrl.pathname}`;
        } catch {
            return `${err.config?.method?.toUpperCase() ?? `UNKNOWN`} unknown`;
        }
    }

    private describeAxiosResponseData(err: AxiosError): string {
        const data = err.response?.data;
        if (!data) {
            return `none`;
        }

        if (typeof data === `string`) {
            return `text length ${data.length}`;
        }

        if (typeof data === `object`) {
            const keys = Object.keys(data).sort();
            const description = keys.length === 0 ? `object with no keys` : `object keys: ${keys.join(`, `)}`;
            const serviceErrors = this.describeServiceErrors(data);
            return serviceErrors ? `${description}; serviceErrors: ${serviceErrors}` : description;
        }

        return typeof data;
    }

    private describeServiceErrors(data: object): string | undefined {
        const serviceErrors = this.getRecordField(data, `serviceErrors`) ?? this.getRecordField(data, `service_errors`);
        if (!Array.isArray(serviceErrors)) {
            return undefined;
        }

        if (serviceErrors.length === 0) {
            return `none`;
        }

        return serviceErrors
            .map((serviceError, index) => this.describeServiceError(serviceError, index))
            .join(` | `);
    }

    private describeServiceError(serviceError: unknown, index: number): string {
        if (!this.isRecord(serviceError)) {
            return `#${index + 1} ${typeof serviceError}`;
        }

        const allowUrls = this.isLockedAccountServiceError(serviceError);
        const fields = [`#${index + 1}`];
        for (const key of [`code`, `errorCode`, `reason`, `title`, `message`, `errorMessage`]) {
            const value = serviceError[key];
            if ([`string`, `number`, `boolean`].includes(typeof value)) {
                fields.push(`${key}=${this.sanitizeDiagnosticText(String(value), allowUrls)}`);
            }
        }

        return fields.join(` `);
    }

    private isLockedAccountServiceError(serviceError: Record<string, unknown>): boolean {
        return String(serviceError.code ?? serviceError.errorCode ?? ``) === iCloud.LOCKED_ACCOUNT_SERVICE_ERROR_CODE;
    }

    private getRecordField(record: object, key: string): unknown {
        return (record as Record<string, unknown>)[key];
    }

    private isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === `object` && value !== null && !Array.isArray(value);
    }

    private sanitizeDiagnosticText(value: string, allowUrls: boolean = false): string {
        const redactedValue = value
            .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, `[redacted-email]`);

        return (allowUrls ? redactedValue : redactedValue.replace(/https?:\/\/\S+/gi, `[redacted-url]`))
            .slice(0, 200);
    }

    /**
     * Gets the stored trust token as an auth payload array.
     * @returns An array containing the trust token if present, otherwise an empty array
     */
    private getTrustTokens(includeTrustToken: boolean = true): string[] {
        if (!includeTrustToken) {
            Resources.logger(this).info(`Authentication payload will not include stored iCloud trust token for retry`);
            return [];
        }

        const trustToken = this.hasCurrentAuthenticationTrustToken
            ? this.currentAuthenticationTrustToken
            : Resources.manager().trustToken;
        Resources.logger(this).info(`Authentication payload ${trustToken ? `will include` : `will not include`} an iCloud trust token`);
        return trustToken ? [trustToken] : [];
    }

    /**
     * Generates the legacy plain-text login payload and url
     * @returns A tuple containing the url and payload required for the legacy login method
     */
    getLegacyLogin(includeTrustToken: boolean = true): [url: string, payload: any] {
        Resources.logger(this).info(`Generating plain text login payload`);
        return [
            ENDPOINTS.AUTH.BASE + ENDPOINTS.AUTH.PATH.SIGNIN.LEGACY,
            {
                accountName: Resources.manager().username,
                password: Resources.manager().password,
                trustTokens: this.getTrustTokens(includeTrustToken),
            },
        ];
    }

    /**
     * Generates the SRP login payload and url from the iCloud server challenge
     * @param authenticator - The authenticator crypto instance for generating the SRP proof - parameterized for testing purposes, will be initiated by default
     * @returns A tuple containing the url and payload required for the SRP login method
     */
    async getSRPLogin(authenticator: iCloudCrypto = new iCloudCrypto(), includeTrustToken: boolean = true): Promise<[url: string, payload: any]> {
        Resources.logger(this).info(`Generating SRP challenge`);
        try {
            const frameId = `auth-${randomUUID().toLowerCase()}`;
            Resources.network().authFrame = frameId;
            await this.initializeAuthSession(frameId);
            await this.federateAuthSession();

            const initResponse = await Resources.network().post(ENDPOINTS.AUTH.BASE + ENDPOINTS.AUTH.PATH.SIGNIN.INIT, {
                a: await authenticator.getClientEphemeral(),
                accountName: Resources.manager().username,
                protocols: [
                    `s2k`,
                    `s2k_fo`,
                ],
            });

            const validatedInitResponse = Resources.validator().validateSigninInitResponse(initResponse);

            const derivedPassword = await authenticator.derivePassword(validatedInitResponse.data.protocol, validatedInitResponse.data.salt, validatedInitResponse.data.iteration);
            const [m1Proof, m2Proof] = await authenticator.getProofValues(derivedPassword, validatedInitResponse.data.b, validatedInitResponse.data.salt);

            return [
                ENDPOINTS.AUTH.BASE + ENDPOINTS.AUTH.PATH.SIGNIN.COMPLETE,
                {
                    accountName: Resources.manager().username,
                    rememberMe: true,
                    trustTokens: this.getTrustTokens(includeTrustToken),
                    m1: m1Proof,
                    m2: m2Proof,
                    c: validatedInitResponse.data.c,
                },
            ];
        } catch (err) {
            throw new iCPSError(AUTH_ERR.SRP_INIT_FAILED).addCause(err);
        }
    }

    /**
     * Starts Apple's current web-auth SRP session.
     * @param frameId - Auth frame used to bind Apple web-auth requests together
     */
    async initializeAuthSession(frameId: string): Promise<void> {
        Resources.logger(this).debug(`Initializing Apple SRP auth session`);
        await Resources.network().get(
            ENDPOINTS.AUTH.BASE + ENDPOINTS.AUTH.PATH.SIGNIN.AUTHORIZE,
            {
                headers: {
                    Accept: `*/*`,
                },
                params: {
                    frame_id: frameId,
                    language: `en_US`,
                    skVersion: `7`,
                    iframeId: frameId,
                    client_id: CLIENT_ID,
                    redirect_uri: `https://www.icloud.com`,
                    response_type: `code`,
                    response_mode: `web_message`,
                    state: frameId,
                    authVersion: `latest`,
                },
                validateStatus: status => status === 200,
            },
        );
    }

    /**
     * Submits the account name to Apple's federate endpoint before SRP init.
     */
    async federateAuthSession(): Promise<void> {
        Resources.logger(this).debug(`Federating Apple SRP auth session`);
        await Resources.network().post(
            ENDPOINTS.AUTH.BASE + ENDPOINTS.AUTH.PATH.SIGNIN.FEDERATE,
            {
                accountName: Resources.manager().username,
                rememberMe: true,
            },
            {
                params: {
                    isRememberMeEnabled: `true`,
                },
                validateStatus: status => status === 200,
            },
        );
    }

    async getTrustedPhoneNumbers(): Promise<TrustedPhoneNumber[]> {
        Resources.logger(this).info(`Getting trusted phone numbers`)

        try {
            const authInformationResponse = await Resources.network().get(ENDPOINTS.AUTH.BASE)
            const validatedAuthInformationResponse = Resources.validator().validateAuthInformationResponse(authInformationResponse)
            return this.getTrustedPhoneNumbersFromAuthInformation(validatedAuthInformationResponse)
        } catch (err) {
            Resources.emit(iCPSEventRuntimeWarning.TRUSTED_PHONE_NUMBERS_ERROR, new iCPSError(MFA_ERR.NO_PHONE_NUMBERS).addCause(err));
        }
        return []
    }

    private getTrustedPhoneNumbersFromAuthInformation(authInformationResponse: {data: {
        trustedPhoneNumbers?: TrustedPhoneNumber[],
        trustedPhoneNumber?: TrustedPhoneNumber,
        phoneNumberVerification?: {
            trustedPhoneNumbers?: TrustedPhoneNumber[],
            trustedPhoneNumber?: TrustedPhoneNumber,
        }
    }}): TrustedPhoneNumber[] {
        const phoneNumberVerification = authInformationResponse.data.phoneNumberVerification;
        const trustedPhoneNumbers = authInformationResponse.data.trustedPhoneNumbers
            ?? phoneNumberVerification?.trustedPhoneNumbers
            ?? [];
        const trustedPhoneNumber = authInformationResponse.data.trustedPhoneNumber
            ?? phoneNumberVerification?.trustedPhoneNumber;

        if (trustedPhoneNumbers.length > 0) {
            return trustedPhoneNumbers;
        }

        return trustedPhoneNumber ? [trustedPhoneNumber] : [];
    }

    /**
     * Explicitly requests a trusted-device MFA push. Newer Apple auth flows no longer reliably send this from the SRP 409 alone.
     */
    async requestTrustedDeviceMFA(): Promise<void> {
        Resources.logger(this).info(`Requesting MFA code on trusted devices`);

        try {
            await Resources.network().put(
                ENDPOINTS.AUTH.BASE + ENDPOINTS.AUTH.PATH.MFA.DEVICE_RESEND,
                undefined,
                {
                    validateStatus: status => status === 202 || status === 204,
                },
            );
            Resources.logger(this).info(`Successfully requested new MFA code on trusted devices`);
        } catch (err) {
            Resources.emit(iCPSEventRuntimeWarning.MFA_ERROR, new iCPSError(MFA_ERR.RESEND_FAILED).addCause(err));
        }
    }

    /**
     * This function will ask the iCloud backend, to re-send the MFA token, using the provided method and number
     * @param method - The method to be used
     * @returns A promise that resolves once all activity has been completed
     * @emits iCPSEventRuntimeWarning.MFA_ERROR - When the resend failed - provides iCPSError as argument
     */
    async resendMFA(method: MFAMethod) {
        Resources.logger(this).info(`Resending MFA code with ${method}`);

        const url = method.getResendURL();
        const config: AxiosRequestConfig = {
            validateStatus: method.resendSuccessful.bind(method),
        };
        const data = method.getResendPayload();

        Resources.logger(this).debug(`Requesting MFA code via URL ${url} with data ${jsonc.stringify(data)}`);

        try {
            const response = await Resources.network().put(url, data, config);

            if (method.isSMS || method.isVoice) {
                const validatedResponse = Resources.validator().validateResendMFAPhoneResponse(response);
                Resources.logger(this).info(`Successfully requested new MFA code using phone ${validatedResponse.data.trustedPhoneNumber.numberWithDialCode}`);
                return;
            }

            if (method.isDevice) {
                if (response.status === 204 || !response.data) {
                    Resources.logger(this).info(`Successfully requested new MFA code on trusted devices`);
                    return;
                }

                const validatedResponse = Resources.validator().validateResendMFADeviceResponse(response);
                Resources.logger(this).info(`Successfully requested new MFA code using ${validatedResponse.data.trustedDeviceCount} trusted device(s)`);
            }
        } catch (err) {
            Resources.emit(iCPSEventRuntimeWarning.MFA_ERROR, new iCPSError(MFA_ERR.RESEND_FAILED).addCause(err));
        }
    }

    /**
     * Enters and validates the MFA code in order to acquire necessary account tokens
     * @param mfa - The MFA code
     * @emits iCPSEventCloud.AUTHENTICATED - When authentication is successful
     * @emits iCPSEventCloud.ERROR - When an error occurs - provides iCPSError as argument
     */
    async submitMFA(method: MFAMethod, mfa: string) {
        try {
            Resources.logger(this).info(`Authenticating MFA code`);

            const url = method.getEnterURL();
            const config: AxiosRequestConfig = {
                validateStatus: method.enterSuccessful.bind(method),
            };
            const data = method.getEnterPayload(mfa);

            Resources.logger(this).debug(`Entering MFA code via URL ${url} with redacted payload`);
            await Resources.network().post(url, data, config);

            Resources.logger(this).info(`MFA code correct!`);
            Resources.emit(iCPSEventCloud.AUTHENTICATED);
            this.clearMFATimeout();
        } catch (err) {
            if (err.response?.status === 400) {
                const augmentedErr = new iCPSError(MFA_ERR.CODE_REJECTED).addCause(err);
                if (Array.isArray(err.response?.data?.service_errors)) {
                    augmentedErr.addMessage(err.response.data.service_errors.map((serviceError: any) => serviceError?.message));
                }

                Resources.emit(iCPSEventCloud.ERROR, augmentedErr);
                return;
            }

            if (err.response?.status === 409) {
                if (this.isAcceptedMFAConflict(err)) {
                    Resources.logger(this).info(`MFA code accepted with conflict response`);
                    Resources.emit(iCPSEventCloud.AUTHENTICATED);
                    this.clearMFATimeout();
                    return;
                }

                this.clearMFATimeout();
                Resources.emit(iCPSEventCloud.ERROR, new iCPSError(MFA_ERR.CHALLENGE_MISMATCH)
                    .addMessage(`Start a new authentication request and enter the newest MFA code`)
                    .addMessage(`Submitted endpoint: ${this.describeAxiosRequest(err as AxiosError)}`)
                    .addMessage(`Response body: ${this.describeAxiosResponseData(err as AxiosError)}`)
                    .addContext(`mfaMethod`, method.toString())
                    .addCause(err));
                return;
            }

            const submitError = new iCPSError(MFA_ERR.SUBMIT_FAILED).addCause(err);
            if ((err as AxiosError).isAxiosError) {
                submitError
                    .addMessage(`Submitted endpoint: ${this.describeAxiosRequest(err as AxiosError)}`)
                    .addMessage(`Response body: ${this.describeAxiosResponseData(err as AxiosError)}`)
                    .addContext(`status`, (err as AxiosError).response?.status);
            }
            Resources.emit(iCPSEventCloud.ERROR, submitError);
        }
    }

    private isAcceptedMFAConflict(err: unknown): boolean {
        if (!(err as AxiosError).isAxiosError) {
            return false;
        }

        const data = (err as AxiosError).response?.data;
        return this.getSecurityCodeValid(data) === true;
    }

    private getSecurityCodeValid(data: unknown): boolean | undefined {
        if (!this.isRecord(data)) {
            return undefined;
        }

        const securityCode = data.securityCode;
        if (this.isRecord(securityCode) && typeof securityCode.valid === `boolean`) {
            return securityCode.valid;
        }

        const phoneNumberVerification = data.phoneNumberVerification;
        if (this.isRecord(phoneNumberVerification)) {
            return this.getSecurityCodeValid(phoneNumberVerification);
        }

        return undefined;
    }

    /**
     * Clears the active MFA timeout after the MFA challenge has reached a terminal state.
     */
    private clearMFATimeout(): void {
        if (!this.mfaTimeout) {
            return;
        }

        clearTimeout(this.mfaTimeout);
        this.mfaTimeout = undefined;
    }

    /**
     * Acquires sessionToken and two factor trust token after successful authentication
     * @emits iCPSEventCloud.TRUSTED - When trust token has been acquired - provides trust token as argument
     * @emits iCPSEventCloud.ERROR - When an error occurs - provides iCPSError as argument
     */
    async getTokens() {
        try {
            Resources.logger(this).info(`Trusting device and acquiring trust tokens`);

            const url = ENDPOINTS.AUTH.BASE + ENDPOINTS.AUTH.PATH.TRUST;
            const config: AxiosRequestConfig = {
                validateStatus: status => status === 204,
            };

            const response = await Resources.network().get(url, config);
            const validatedResponse = Resources.validator().validateTrustResponse(response);
            Resources.network().applyTrustResponse(validatedResponse);

            Resources.logger(this).debug(`Acquired account tokens`);
            Resources.emit(iCPSEventCloud.TRUSTED, Resources.manager().trustToken);
        } catch (err) {
            Resources.emit(iCPSEventCloud.ERROR, new iCPSError(AUTH_ERR.ACQUIRE_ACCOUNT_TOKENS).addCause(err));
        }
    }

    /**
     * Acquiring necessary cookies from trust and auth token for further processing. Also gets the user specific domain to interact with the Photos backend
     * @emits iCPSEventCloud.ACCOUNT_READY - When account is ready to be used
     * @emits iCPSEventCloud.SESSION_EXPIRED - When the session token has expired
     * @emits iCPSEventCloud.PCS_REQUIRED - When the account is setup using ADP and PCS cookies are required
     * @emits iCPSEventCloud.ERROR - When an error occurs - provides iCPSError as argument
     */
    async setupAccount(options: SetupAccountOptions = {}): Promise<boolean> {
        try {
            Resources.logger(this).info(`Setting up iCloud connection`);

            const url = ENDPOINTS.SETUP.BASE() + ENDPOINTS.SETUP.PATH.ACCOUNT_LOGIN;
            const data = {
                dsWebAuthToken: Resources.manager().sessionSecret,
            };

            const response = await Resources.network().post(url, data);
            const validatedResponse = Resources.validator().validateSetupResponse(response);
            if (!Resources.network().applySetupResponse(validatedResponse)) {
                Resources.logger(this).debug(`PCS required, acquiring...`);
                Resources.emit(iCPSEventCloud.PCS_REQUIRED);
                return true;
            }

            Resources.logger(this).debug(`Account ready`);
            Resources.emit(iCPSEventCloud.ACCOUNT_READY);
            return true;
        } catch (err) {
            const axiosError = err as AxiosError;
            if (axiosError.isAxiosError && axiosError.response?.status === 421) {
                Resources.logger(this).debug(`Session token expired, re-acquiring...`);
                if (options.emitSessionExpired !== false) {
                    Resources.emit(iCPSEventCloud.SESSION_EXPIRED);
                }
                return false;
            }

            Resources.emit(iCPSEventCloud.ERROR, new iCPSError(AUTH_ERR.ACCOUNT_SETUP).addCause(err));
            return false;
        }
    }

    /**
     * Acquires PCS cookies for ADP accounts
     * @emits iCPSEventCloud.ACCOUNT_READY - When account is ready to be used
     * @emits iCPSEventCloud.PCS_NOT_READY - When PCS cookies are not ready yet
     * @emits iCPSEventCloud.PCS_REQUIRED - When the account is setup using ADP and PCS cookies are still required
     * @emits iCPSEventCloud.ERROR - When an error occurs - provides iCPSError as argument
     */
    async acquirePCSCookies() {
        try {
            Resources.logger(this).info(`Acquiring PCS cookies`);

            const url = ENDPOINTS.SETUP.BASE() + ENDPOINTS.SETUP.PATH.REQUEST_PCS;
            const data = {
                appName: `photos`,
                derivedFromUserAction: true,
            };

            const response = await Resources.network().post(url, data);
            const validatedResponse = Resources.validator().validatePCSResponse(response);

            if (validatedResponse.data.status === `failure`) {
                Resources.logger(this).info(`Failed to acquire PCS cookies: ${validatedResponse.data.message}`);
                Resources.emit(iCPSEventCloud.PCS_NOT_READY);
                setTimeout(() => Resources.emit(iCPSEventCloud.PCS_REQUIRED), 10000);
                return;
            }

            if (!validatedResponse.headers[`set-cookie`]
                || validatedResponse.headers[`set-cookie`].filter(cookieString => cookieString.startsWith(COOKIE_KEYS.PCS_PHOTOS) || cookieString.startsWith(COOKIE_KEYS.PCS_SHARING)).length !== 2) {
                throw new iCPSError(AUTH_ERR.PCS_COOKIE_MISSING).addContext(`response`, validatedResponse);
            }

            Resources.logger(this).debug(`Account ready with PCS cookies`);
            Resources.emit(iCPSEventCloud.ACCOUNT_READY);
        } catch (err) {
            Resources.emit(iCPSEventCloud.ERROR, new iCPSError(AUTH_ERR.PCS_REQUEST_FAILED).addCause(err));
        }
    }

    /**
     * Performs a logout, while retaining the trust token
     */
    async logout() {
        try {
            const url = ENDPOINTS.SETUP.BASE() + ENDPOINTS.SETUP.PATH.LOGOUT;
            const data = {
                trustBrowser: true,
                allBrowsers: false,
            };

            const config: AxiosRequestConfig = {
                // 421 is expected, if user was not logged in - 200 is expected, if logout was successful
                validateStatus: status => status === 421 || status === 200,
            };

            Resources.logger(this).info(`Logging current account out`);

            await Resources.network().post(url, data, config);
        } catch (err) {
            throw new iCPSError(AUTH_ERR.LOGOUT_FAILED).addCause(err);
        }
    }

    /**
     * Creating iCloud Photos sub-class and linking it
     * @emits iCPSEventCloud.ERROR - When an error occurs - provides iCPSError as argument
    */
    async getPhotosReady() {
        try {
            Resources.logger(this).info(`Getting iCloud Photos Service ready`);
            await this.photos.setup();
        } catch (err) {
            Resources.emit(iCPSEventCloud.ERROR, new iCPSError(ICLOUD_PHOTOS_ERR.SETUP_FAILED).addCause(err));
        }
    }
}
