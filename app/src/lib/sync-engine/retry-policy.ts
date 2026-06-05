import {AxiosError} from 'axios';
import {iCPSError} from '../../app/error/error.js';
import {SYNC_ERR} from '../../app/error/error-codes.js';

const RETRY_BACKOFF_BASE_MS = 30 * 1000;
const RETRY_BACKOFF_MAX_MS = 5 * 60 * 1000;
const RETRY_BACKOFF_JITTER_MS = 5 * 1000;
const RETRYABLE_HTTP_STATUS_CODES = new Set([408, 409, 421, 425, 429, 500, 502, 503, 504]);

/**
 * Encapsulates sync retry classification, backoff and safe diagnostic context.
 */
export class SyncRetryPolicy {
    /**
     * Builds a sync-level error while preserving the original cause chain.
     * @param err - The original error
     * @returns The sync-level error
     */
    buildSyncError(err: unknown): iCPSError {
        const cause = err instanceof Error ? err : iCPSError.toiCPSError(err);
        return new iCPSError(this.getAxiosError(err) ? SYNC_ERR.NETWORK : SYNC_ERR.UNKNOWN)
            .addCause(cause);
    }

    /**
     * Determines whether a failed sync request should be retried.
     * @param err - The original error
     * @returns True if retrying is expected to help
     */
    isRetryableSyncError(err: unknown): boolean {
        const axiosError = this.getAxiosError(err);
        if (!axiosError?.response?.status) {
            return true;
        }

        return RETRYABLE_HTTP_STATUS_CODES.has(axiosError.response.status);
    }

    /**
     * Computes a bounded exponential backoff delay with small jitter.
     * @param retryCount - The retry attempt number that will run after the delay
     * @param err - The original error, inspected for retryAfter guidance
     * @returns Delay in milliseconds
     */
    getRetryBackoffMs(retryCount: number, err?: unknown): number {
        const retryAfterMs = this.getRetryAfterMs(err);
        if (retryAfterMs !== undefined) {
            return retryAfterMs;
        }

        const exponentialDelay = RETRY_BACKOFF_BASE_MS * (2 ** Math.max(retryCount - 2, 0));
        const cappedDelay = Math.min(exponentialDelay, RETRY_BACKOFF_MAX_MS);
        return cappedDelay + Math.floor(Math.random() * RETRY_BACKOFF_JITTER_MS);
    }

    /**
     * Creates safe retry context without request bodies, credentials or headers.
     * @param err - The original error
     * @returns A sanitized error context object
     */
    getRetryErrorContext(err: unknown): Record<string, unknown> {
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
     * Extracts the root Axios error from an app error cause chain.
     * @param err - The original error
     * @returns The nested Axios error, if present
     */
    getAxiosError(err: unknown): AxiosError | undefined {
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
}
