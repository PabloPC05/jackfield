import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const CANDIDATES = ['jackfield.yaml', 'jackfield.yml', 'jackfield.json', '.jackfield.yaml'];

/**
 * Finds the config file: `--config`, then `JACKFIELD_CONFIG`, then the working
 * directory, then `~/.config/jackfield/config.yaml`.
 */
export async function findConfig(explicit?: string): Promise<string> {
    if (explicit) return resolve(explicit);
    const fromEnv = process.env['JACKFIELD_CONFIG'];
    if (fromEnv) return resolve(fromEnv);

    for (const name of CANDIDATES) {
        const candidate = resolve(process.cwd(), name);
        if (await exists(candidate)) return candidate;
    }
    const home = join(homedir(), '.config', 'jackfield', 'config.yaml');
    if (await exists(home)) return home;

    throw new Error(
        `no configuration found. Looked for ${CANDIDATES.join(', ')} here and ~/.config/jackfield/config.yaml.\n` +
            `Write one with "jackfield init", or point at it with --config.`
    );
}

async function exists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * A rough token count for a tool definition: about four bytes per token for
 * English JSON. Good enough to compare sources, not a billing figure.
 */
export function estimateTokens(bytes: number): number {
    return Math.round(bytes / 4);
}

export function table(rows: string[][], headers: string[]): string {
    const all = [headers, ...rows];
    const widths = headers.map((_, column) => Math.max(...all.map(row => (row[column] ?? '').length)));
    const line = (row: string[]) => row.map((cell, index) => (cell ?? '').padEnd(widths[index] ?? 0)).join('  ').trimEnd();
    return [line(headers), line(widths.map(width => '-'.repeat(width))), ...rows.map(line)].join('\n');
}
