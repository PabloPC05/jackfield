import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { ConfigError } from '../util/errors.js';
import { registerSecret } from '../util/logger.js';
import { configSchema, type Config, type RawConfig } from './schema.js';

/**
 * Placeholders resolved inside any string of the config file:
 *
 * - `${env:NAME}`        value of an environment variable
 * - `${file:/path}`      contents of a file, trimmed
 * - `${env?:NAME}`       optional: empty when missing
 * - `${file?:/path}`     optional: empty when missing
 *
 * A relative `file:` path is resolved against the config file's directory, so
 * a repository can ship `secrets/` out of git and still be portable.
 */
const PLACEHOLDER = /\$\{(env|file)(\?)?:([^}]+)\}/g;

export interface LoadOptions {
    /** Directory for relative `file:` placeholders. Defaults to the config file's directory. */
    baseDir?: string;
    env?: Record<string, string | undefined>;
    /** Register resolved secrets with the logger so they can never be printed. Default true. */
    protectSecrets?: boolean;
}

export interface LoadedConfig {
    config: Config;
    /** Absolute path of the file this came from, when it came from a file. */
    path?: string;
    baseDir: string;
}

export function resolvePlaceholders(value: string, options: { baseDir: string; env: Record<string, string | undefined>; where: string; protectSecrets: boolean }): string {
    return value.replace(PLACEHOLDER, (_match, kind: string, optional: string | undefined, argument: string) => {
        const target = argument.trim();
        let resolved: string | undefined;

        if (kind === 'env') {
            resolved = options.env[target];
        } else {
            const file = resolvePath(options.baseDir, target);
            try {
                resolved = readFileSync(file, 'utf8');
            } catch (error) {
                if (!optional) {
                    throw new ConfigError(`cannot read ${file}: ${(error as Error).message}`, options.where);
                }
                resolved = undefined;
            }
        }

        if (resolved === undefined) {
            if (optional) return '';
            throw new ConfigError(`${kind}:${target} is not set`, options.where);
        }

        const text = kind === 'file' ? resolved.trim() : resolved;
        if (options.protectSecrets) registerSecret(text);
        return text;
    });
}

function walk(value: unknown, options: { baseDir: string; env: Record<string, string | undefined>; path: string; protectSecrets: boolean }): unknown {
    if (typeof value === 'string') {
        return resolvePlaceholders(value, { ...options, where: options.path });
    }
    if (Array.isArray(value)) {
        return value.map((item, index) => walk(item, { ...options, path: `${options.path}[${index}]` }));
    }
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)) {
            out[key] = walk(item, { ...options, path: options.path ? `${options.path}.${key}` : key });
        }
        return out;
    }
    return value;
}

/** Parses an already-read document (YAML or JSON) into a validated config. */
export function parseConfig(text: string, options: LoadOptions & { path?: string } = {}): LoadedConfig {
    const baseDir = options.baseDir ?? (options.path ? dirname(resolvePath(options.path)) : process.cwd());
    const env = options.env ?? process.env;
    const protectSecrets = options.protectSecrets ?? true;

    let document: unknown;
    try {
        document = parseYaml(text, { merge: true });
    } catch (error) {
        throw new ConfigError(`not valid YAML or JSON: ${(error as Error).message}`, options.path);
    }
    if (document === null || document === undefined) document = {};
    if (typeof document !== 'object' || Array.isArray(document)) {
        throw new ConfigError('the top level of the config must be a mapping', options.path);
    }

    const resolved = walk(document, { baseDir, env, path: '', protectSecrets }) as RawConfig;
    const parsed = configSchema.safeParse(resolved);
    if (!parsed.success) {
        const issues = parsed.error.issues
            .slice(0, 12)
            .map(issue => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('\n');
        throw new ConfigError(`invalid configuration:\n${issues}`, options.path);
    }

    const config = parsed.data;
    validateReferences(config, options.path);
    registerConfigSecrets(config, protectSecrets);
    return { config, baseDir, ...(options.path ? { path: resolvePath(options.path) } : {}) };
}

export async function loadConfig(path: string, options: LoadOptions = {}): Promise<LoadedConfig> {
    let text: string;
    try {
        text = await readFile(path, 'utf8');
    } catch (error) {
        throw new ConfigError(`cannot read config file: ${(error as Error).message}`, path);
    }
    return parseConfig(text, { ...options, path });
}

/** Checks the things zod cannot: dangling references and reused keys. */
function validateReferences(config: Config, where?: string): void {
    const problems: string[] = [];
    const upstreamIds = new Set(Object.keys(config.upstreams));
    const profileIds = new Set(Object.keys(config.profiles));
    const executorIds = new Set(Object.keys(config.executors));

    for (const [id, executor] of Object.entries(config.executors)) {
        if (!executor.url && !executor.attach) {
            problems.push(`executors.${id}: needs a url, or attach: true so it dials in`);
        }
        if (executor.url && executor.attach) {
            problems.push(`executors.${id}: has both a url and attach: true; pick one`);
        }
    }

    for (const [id, upstream] of Object.entries(config.upstreams)) {
        if (upstream.transport === 'executor' && !executorIds.has(upstream.executor)) {
            problems.push(`upstreams.${id}.executor: no executor named "${upstream.executor}"`);
        }
    }

    for (const [id, profile] of Object.entries(config.profiles)) {
        for (const parent of profile.extends ?? []) {
            if (!profileIds.has(parent)) problems.push(`profiles.${id}.extends: no profile named "${parent}"`);
            if (parent === id) problems.push(`profiles.${id}.extends: a profile cannot extend itself`);
        }
        for (const selector of profile.upstreams ?? []) {
            if (!isKnownSelector(selector, upstreamIds)) {
                problems.push(`profiles.${id}.upstreams: "${selector}" matches no upstream`);
            }
        }
    }

    const linkRules = [
        ...config.permissions.map((rule, index) => ({ rule, where: `permissions[${index}]` })),
        ...Object.entries(config.clients).flatMap(([id, client]) =>
            (client.permissions ?? []).map((rule, index) => ({ rule, where: `clients.${id}.permissions[${index}]` }))
        ),
        ...Object.entries(config.profiles).flatMap(([id, profile]) =>
            (profile.permissions ?? []).map((rule, index) => ({ rule, where: `profiles.${id}.permissions[${index}]` }))
        )
    ].filter(entry => entry.rule.action === 'ask' && entry.rule.via !== 'client');

    for (const entry of linkRules) {
        if (!config.approvals.publicUrl) {
            problems.push(`${entry.where}: via "${entry.rule.via}" needs approvals.publicUrl, or nobody can open the link`);
        }
        if (!config.notify) {
            problems.push(`${entry.where}: via "${entry.rule.via}" needs a notify block, or the link reaches no one`);
        }
    }

    const seenKeys = new Map<string, string>();
    for (const [id, client] of Object.entries(config.clients)) {
        if (client.profile && !profileIds.has(client.profile)) {
            problems.push(`clients.${id}.profile: no profile named "${client.profile}"`);
        }
        if (!client.key && !client.public) {
            problems.push(`clients.${id}: needs a key, or public: true`);
        }
        if (client.keyInPath && !client.key) {
            problems.push(`clients.${id}: keyInPath needs a key`);
        }
        for (const key of [client.key, ...(client.altKeys ?? [])]) {
            if (!key) continue;
            const owner = seenKeys.get(key);
            if (owner && owner !== id) problems.push(`clients.${id}: shares a key with clients.${owner}`);
            seenKeys.set(key, id);
        }
        for (const selector of client.upstreams ?? []) {
            if (!isKnownSelector(selector, upstreamIds)) {
                problems.push(`clients.${id}.upstreams: "${selector}" matches no upstream`);
            }
        }
    }

    if (problems.length) {
        throw new ConfigError(`invalid configuration:\n${problems.map(p => '  ' + p).join('\n')}`, where);
    }
}

function isKnownSelector(selector: string, upstreamIds: Set<string>): boolean {
    if (selector === '*' || selector.startsWith('tag:') || selector.includes('*')) return true;
    return upstreamIds.has(selector);
}

function registerConfigSecrets(config: Config, protectSecrets: boolean): void {
    if (!protectSecrets) return;
    for (const client of Object.values(config.clients)) {
        registerSecret(client.key);
        for (const key of client.altKeys ?? []) registerSecret(key);
    }
    for (const executor of Object.values(config.executors)) registerSecret(executor.token);
    for (const upstream of Object.values(config.upstreams)) {
        if (upstream.transport === 'http' || upstream.transport === 'sse') {
            registerSecret(upstream.token);
            for (const value of Object.values(upstream.headers ?? {})) registerSecret(value);
        }
        if (upstream.transport === 'stdio') {
            for (const value of Object.values(upstream.env ?? {})) registerSecret(value);
        }
    }
}
