/**
 * Structured logging with redaction.
 *
 * Jackfield routes carry client keys, and some clients (claude.ai) put the key
 * in the URL path. Nothing that reaches a log line may contain one, so every
 * message goes through {@link redact} before it is written.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVELS: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
    silent: 100
};

export interface LogFields {
    [key: string]: unknown;
}

export interface Logger {
    level: LogLevel;
    debug(msg: string, fields?: LogFields): void;
    info(msg: string, fields?: LogFields): void;
    warn(msg: string, fields?: LogFields): void;
    error(msg: string, fields?: LogFields): void;
    child(fields: LogFields): Logger;
}

/** Secrets registered at config load time, longest first so overlaps redact fully. */
const secrets = new Set<string>();

/**
 * Registers a value that must never appear in a log line. Short values are
 * ignored: redacting a 3-character string would mangle unrelated text.
 */
export function registerSecret(value: string | undefined | null): void {
    if (typeof value === 'string' && value.length >= 8) secrets.add(value);
}

export function forgetSecrets(): void {
    secrets.clear();
}

/** Replaces every registered secret in `text` with a stable placeholder. */
export function redact(text: string): string {
    if (secrets.size === 0) return text;
    let out = text;
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
        if (out.includes(secret)) out = out.split(secret).join('«redacted»');
    }
    return out;
}

function redactDeep(value: unknown, depth = 0): unknown {
    if (depth > 6) return '«deep»';
    if (typeof value === 'string') return redact(value);
    if (Array.isArray(value)) return value.map(v => redactDeep(v, depth + 1));
    if (value instanceof Error) return { name: value.name, message: redact(value.message) };
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, depth + 1);
        return out;
    }
    return value;
}

export interface LoggerOptions {
    level?: LogLevel;
    /** `json` for machines (journald, Vercel), `pretty` for a terminal. */
    format?: 'json' | 'pretty';
    write?: (line: string) => void;
}

export function createLogger(options: LoggerOptions = {}): Logger {
    const level = options.level ?? 'info';
    const format = options.format ?? (process.env['NO_COLOR'] ? 'json' : 'pretty');
    const write = options.write ?? ((line: string) => process.stderr.write(line + '\n'));

    const make = (base: LogFields): Logger => {
        const emit = (msgLevel: LogLevel, msg: string, fields?: LogFields) => {
            if (LEVELS[msgLevel] < LEVELS[level]) return;
            const merged = { ...base, ...(fields ?? {}) };
            const safe = redactDeep(merged) as LogFields;
            const text = redact(msg);
            if (format === 'json') {
                write(JSON.stringify({ time: new Date().toISOString(), level: msgLevel, msg: text, ...safe }));
            } else {
                const extras = Object.entries(safe)
                    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
                    .join(' ');
                write(`${msgLevel.padEnd(5)} ${text}${extras ? ' ' + extras : ''}`);
            }
        };
        return {
            level,
            debug: (m, f) => emit('debug', m, f),
            info: (m, f) => emit('info', m, f),
            warn: (m, f) => emit('warn', m, f),
            error: (m, f) => emit('error', m, f),
            child: fields => make({ ...base, ...fields })
        };
    };

    return make({});
}

export const nullLogger: Logger = {
    level: 'silent',
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => nullLogger
};
