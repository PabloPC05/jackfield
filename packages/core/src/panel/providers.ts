/**
 * What to paste, per agent.
 *
 * Every client wants the same two facts — an address and a key — in a
 * different shape, and getting that shape slightly wrong is the single most
 * common way a connection fails before it has begun. So the panel writes it
 * out for each of them instead of leaving you to remember.
 *
 * Shared between the panel and the landing demo: one place to be wrong, and
 * one place to fix.
 */

export interface Provider {
    id: string;
    name: string;
    /** `command` is pasted into a terminal; `file` into a config file; `url` into a form. */
    kind: 'command' | 'file' | 'url';
    /** Where it goes, in one line. */
    where: string;
}

export const PROVIDERS: Provider[] = [
    { id: 'claude-code', name: 'Claude Code', kind: 'command', where: 'Pégalo en la terminal.' },
    { id: 'claude-ai', name: 'claude.ai', kind: 'url', where: 'Ajustes → Conectores → Añadir conector personalizado.' },
    { id: 'codex', name: 'Codex', kind: 'file', where: 'Va en ~/.codex/config.toml' },
    { id: 'cursor', name: 'Cursor · VS Code', kind: 'file', where: 'Va en el mcp.json de tu editor.' },
    { id: 'url', name: 'Solo la dirección', kind: 'url', where: 'Para cualquier otro cliente.' }
];

export interface ConnectionDetails {
    /** Name the agent will see this connection under. */
    label: string;
    url: string;
    key?: string;
    /** True when the key travels inside the URL. */
    keyInPath: boolean;
}

/** The text to copy for one agent. */
export function snippetFor(provider: string, connection: ConnectionDetails): string {
    const { label, url, key, keyInPath } = connection;
    const header = keyInPath || !key ? undefined : `Authorization: Bearer ${key}`;

    switch (provider) {
        case 'claude-code':
            return header
                ? `claude mcp add --transport http ${label} ${url} --header "${header}"`
                : `claude mcp add --transport http ${label} ${url}`;

        case 'codex':
            return header
                ? [
                      `[mcp_servers.${label.replace(/-/g, '_')}]`,
                      `url = "${url}"`,
                      `http_headers = { Authorization = "Bearer ${key}" }`
                  ].join('\n')
                : [`[mcp_servers.${label.replace(/-/g, '_')}]`, `url = "${url}"`].join('\n');

        case 'cursor':
            return JSON.stringify(
                {
                    mcpServers: {
                        [label]: {
                            url,
                            ...(header ? { headers: { Authorization: `Bearer ${key}` } } : {})
                        }
                    }
                },
                null,
                2
            );

        case 'claude-ai':
        case 'url':
        default:
            return url;
    }
}

/**
 * A warning worth showing rather than a connection that silently will not
 * work: claude.ai cannot send a header, so it needs the key in the address.
 */
export function warningFor(provider: string, connection: ConnectionDetails): string | undefined {
    if (provider === 'claude-ai' && !connection.keyInPath) {
        return 'claude.ai no puede mandar cabeceras: enciende «la clave va dentro de la dirección» en esta dirección.';
    }
    return undefined;
}
