/** Errors that carry an HTTP status, so the router can answer without guessing. */
export class HttpError extends Error {
    constructor(
        readonly status: number,
        message: string,
        readonly detail?: string
    ) {
        super(message);
        this.name = 'HttpError';
    }
}

/** A problem in the configuration file, reported with the path that caused it. */
export class ConfigError extends Error {
    constructor(
        message: string,
        readonly where?: string
    ) {
        super(where ? `${message} (at ${where})` : message);
        this.name = 'ConfigError';
    }
}

export function isAbortError(error: unknown): boolean {
    return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

export function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}
