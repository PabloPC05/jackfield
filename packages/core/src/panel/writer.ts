import { copyFile, readFile, rename, writeFile, stat, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, basename, join } from 'node:path';

import { parseDocument, type Document } from 'yaml';

import { parseConfig } from '../config/load.js';
import type { Config } from '../config/schema.js';
import { ConfigError, errorMessage } from '../util/errors.js';
import type { Logger } from '../util/logger.js';

/**
 * The panel's hands: it edits your configuration file, in place.
 *
 * The file stays the thing that decides — the panel is a nicer way to write
 * it, not a second source of truth — so three rules hold:
 *
 *  - your comments and your formatting survive, because the document is
 *    edited rather than regenerated;
 *  - nothing is written until the result parses and validates, so a bad edit
 *    fails in the panel instead of on the next restart;
 *  - the previous version is kept as `.bak`, and the write is atomic, so an
 *    interrupted save cannot leave you with half a file.
 */
export class ConfigWriter {
    constructor(
        readonly path: string,
        private readonly logger: Logger,
        private readonly env: Record<string, string | undefined> = process.env
    ) {}

    async readDocument(): Promise<Document> {
        const text = await readFile(this.path, 'utf8');
        return parseDocument(text, { merge: true });
    }

    /** Can this file be written at all? Serverless filesystems are read-only. */
    async writable(): Promise<boolean> {
        const probe = join(dirname(this.path), `.jackfield-write-test-${randomBytes(4).toString('hex')}`);
        try {
            await writeFile(probe, '');
            await unlink(probe);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Applies a change and saves it, or throws and leaves the file untouched.
     * Returns the configuration as it now stands.
     */
    async mutate(change: (document: Document) => void): Promise<Config> {
        const document = await this.readDocument();
        change(document);

        const text = document.toString({ lineWidth: 0 });

        // Validate the result before it reaches disk. A panel that can write a
        // file the gateway then refuses to load is worse than no panel.
        let config: Config;
        try {
            config = parseConfig(text, { path: this.path, env: this.env }).config;
        } catch (error) {
            throw new ConfigError(
                error instanceof ConfigError ? error.message : `the change would break the configuration: ${errorMessage(error)}`
            );
        }

        await this.save(text);
        return config;
    }

    private async save(text: string): Promise<void> {
        const directory = dirname(this.path);
        const temporary = join(directory, `.${basename(this.path)}.${randomBytes(6).toString('hex')}.tmp`);

        let mode = 0o600;
        try {
            mode = (await stat(this.path)).mode & 0o777;
            await copyFile(this.path, `${this.path}.bak`);
        } catch {
            // No previous file, or no permission to back it up: carry on, the
            // atomic write below is what actually protects the save.
        }

        await writeFile(temporary, text, { mode });
        await rename(temporary, this.path);
        this.logger.info('configuration saved', { path: this.path });
    }
}

/** Keys the panel generates for new endpoints. */
export function newKey(): string {
    return randomBytes(32).toString('base64url');
}
