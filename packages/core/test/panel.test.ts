import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { Gateway, loadConfig, nullLogger, serve, type RunningServer } from '../dist/index.js';
import { startStubUpstream, type StubUpstream } from './helpers.ts';

let alpha: StubUpstream;
let beta: StubUpstream;
let directory: string;
let configPath: string;
let running: RunningServer;

const PANEL = 'clave-del-panel-0123456789abc';
const AGENTE = 'clave-del-agente-0123456789ab';

const base = () => `
# Mi pasarela.
server:
  host: 127.0.0.1
  port: 0
  logLevel: silent
panel:
  key: ${PANEL}

upstreams:
  alfa:
    # este lo uso todos los días
    transport: http
    url: ${alpha.url}
  beta:
    transport: http
    url: ${beta.url}

clients:
  general:
    description: todo junto
    key: ${AGENTE}
    upstreams: ["*"]
`;

async function panel(ruta: string, opciones: RequestInit = {}): Promise<Response> {
    return fetch(`${running.url}/panel${ruta}`, {
        ...opciones,
        headers: {
            Authorization: `Bearer ${PANEL}`,
            'Content-Type': 'application/json',
            'X-Jackfield-Panel': '1',
            ...(opciones.headers ?? {})
        }
    });
}

async function estado(): Promise<any> {
    const response = await panel('/api/state');
    assert.equal(response.status, 200);
    return response.json();
}

async function arranca(): Promise<void> {
    await writeFile(configPath, base());
    const { config } = await loadConfig(configPath);
    running = await serve({
        gateway: new Gateway({ config, logger: nullLogger, configPath }),
        warmUp: true,
        logger: nullLogger
    });
}

before(async () => {
    alpha = await startStubUpstream('alfa');
    beta = await startStubUpstream('beta');
    directory = await mkdtemp(join(tmpdir(), 'jackfield-panel-'));
    configPath = join(directory, 'jackfield.yaml');
});

after(async () => {
    await running?.close();
    await alpha?.close();
    await beta?.close();
});

beforeEach(async () => {
    await running?.close();
    await arranca();
});

/**
 * El panel es una forma cómoda de escribir el archivo. Lo que se comprueba
 * aquí es justo eso: que lo escribe bien, que no lo rompe y que lo que pulsas
 * tiene efecto sin reiniciar nada.
 */
describe('el panel', () => {
    it('enseña los servidores conectados y las direcciones', async () => {
        const vista = await estado();

        assert.equal(vista.writable, true);
        assert.deepEqual(vista.servers.map((s: any) => s.id), ['alfa', 'beta']);
        assert.equal(vista.servers[0].state, 'ready');

        assert.equal(vista.endpoints.length, 1);
        assert.equal(vista.endpoints[0].id, 'general');
        assert.equal(vista.endpoints[0].mode, 'all');
        assert.deepEqual(vista.endpoints[0].servers, [
            { id: 'alfa', on: true },
            { id: 'beta', on: true }
        ]);
    });

    it('apaga un servidor en una dirección con un botón, y lo deja escrito', async () => {
        const despues = await (
            await panel('/api/endpoints/general/toggle', {
                method: 'POST',
                body: JSON.stringify({ server: 'beta', on: false })
            })
        ).json();

        assert.deepEqual(despues.endpoints[0].servers, [
            { id: 'alfa', on: true },
            { id: 'beta', on: false }
        ]);

        const texto = await readFile(configPath, 'utf8');
        assert.match(texto, /exclude:/);
        assert.match(texto, /beta\.\*/);
        // Y sigue llevando todo lo demás, incluso lo que conectes mañana;
        // además respeta cómo estaba escrito el archivo (aquí, en línea).
        assert.match(texto, /upstreams: \[ "\*" \]/);
    });

    it('no se carga tus comentarios al escribir', async () => {
        await panel('/api/endpoints/general/toggle', {
            method: 'POST',
            body: JSON.stringify({ server: 'beta', on: false })
        });

        const texto = await readFile(configPath, 'utf8');
        assert.match(texto, /# Mi pasarela\./);
        assert.match(texto, /# este lo uso todos los días/);
    });

    it('el agente ve el cambio sin que nadie reinicie nada', async () => {
        const cliente = new Client({ name: 'agente', version: '1.0.0' });
        await cliente.connect(
            new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`), {
                requestInit: { headers: { Authorization: `Bearer ${AGENTE}` } }
            })
        );
        const antes = await cliente.listTools();
        assert.ok(antes.tools.some(t => t.name.startsWith('beta_')));
        await cliente.close();

        await panel('/api/endpoints/general/toggle', {
            method: 'POST',
            body: JSON.stringify({ server: 'beta', on: false })
        });

        const otro = new Client({ name: 'agente', version: '1.0.0' });
        await otro.connect(
            new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`), {
                requestInit: { headers: { Authorization: `Bearer ${AGENTE}` } }
            })
        );
        const despues = await otro.listTools();
        assert.equal(despues.tools.some(t => t.name.startsWith('beta_')), false);
        assert.ok(despues.tools.some(t => t.name.startsWith('alfa_')));
        await otro.close();
    });

    it('crea una dirección nueva con su clave, lista para pegar', async () => {
        const vista = await (
            await panel('/api/endpoints', {
                method: 'POST',
                body: JSON.stringify({ id: 'para-codex', description: 'Codex', mode: 'pick' })
            })
        ).json();

        const nueva = vista.endpoints.find((e: any) => e.id === 'para-codex');
        assert.ok(nueva, 'debería existir');
        assert.equal(nueva.mode, 'pick');
        assert.ok(nueva.key.length >= 32, 'la clave se genera sola');
        assert.deepEqual(nueva.servers, [
            { id: 'alfa', on: false },
            { id: 'beta', on: false }
        ]);

        // Y se le van añadiendo con el botón.
        const conAlfa = await (
            await panel('/api/endpoints/para-codex/toggle', {
                method: 'POST',
                body: JSON.stringify({ server: 'alfa', on: true })
            })
        ).json();
        assert.deepEqual(
            conAlfa.endpoints.find((e: any) => e.id === 'para-codex').servers,
            [{ id: 'alfa', on: true }, { id: 'beta', on: false }]
        );
    });

    it('conecta un servidor nuevo y aparece en las direcciones que llevan todo', async () => {
        const vista = await (
            await panel('/api/servers', {
                method: 'POST',
                body: JSON.stringify({ id: 'gamma', kind: 'http', url: alpha.url, description: 'otro más' })
            })
        ).json();

        assert.ok(vista.servers.some((s: any) => s.id === 'gamma'));
        assert.deepEqual(
            vista.endpoints[0].servers.map((s: any) => s.id).sort(),
            ['alfa', 'beta', 'gamma']
        );
        assert.equal(vista.endpoints[0].servers.find((s: any) => s.id === 'gamma').on, true);
    });

    it('al quitar un servidor no deja referencias sueltas', async () => {
        await panel('/api/endpoints', {
            method: 'POST',
            body: JSON.stringify({ id: 'solo-beta', mode: 'pick' })
        });
        await panel('/api/endpoints/solo-beta/toggle', {
            method: 'POST',
            body: JSON.stringify({ server: 'beta', on: true })
        });

        const vista = await (await panel('/api/servers/beta', { method: 'DELETE' })).json();

        assert.equal(vista.servers.some((s: any) => s.id === 'beta'), false);
        const texto = await readFile(configPath, 'utf8');
        assert.doesNotMatch(texto, /- beta\b/);
        // Y la configuración sigue siendo válida: se ha recargado sin quejarse.
        assert.ok(vista.endpoints.length >= 2);
    });

    it('se niega a guardar algo que rompería el archivo', async () => {
        const antes = await readFile(configPath, 'utf8');

        const respuesta = await panel('/api/endpoints', {
            method: 'POST',
            body: JSON.stringify({ id: 'general', mode: 'all' })
        });
        const cuerpo = await respuesta.json();

        assert.equal(respuesta.status, 400);
        assert.match(cuerpo.error, /ya (hay|existe)|already/i);
        assert.equal(await readFile(configPath, 'utf8'), antes, 'el archivo no se toca');
    });

    it('guarda una copia de la versión anterior', async () => {
        await panel('/api/endpoints/general/toggle', {
            method: 'POST',
            body: JSON.stringify({ server: 'beta', on: false })
        });
        const copia = await readFile(`${configPath}.bak`, 'utf8');
        assert.match(copia, /# Mi pasarela\./);
        assert.doesNotMatch(copia, /exclude/);
    });

    it('no abre sin su clave, y la del agente no sirve', async () => {
        const sinNada = await fetch(`${running.url}/panel`);
        assert.equal(sinNada.status, 401);
        await sinNada.text();

        const conLaDelAgente = await fetch(`${running.url}/panel/api/state`, {
            headers: { Authorization: `Bearer ${AGENTE}` }
        });
        assert.equal(conLaDelAgente.status, 401);
        await conLaDelAgente.text();
    });

    it('saca la clave de la barra de direcciones en cuanto entras', async () => {
        const respuesta = await fetch(`${running.url}/panel?key=${PANEL}`, { redirect: 'manual' });
        assert.equal(respuesta.status, 303);
        assert.equal(respuesta.headers.get('location'), '/panel');
        assert.match(respuesta.headers.get('set-cookie') ?? '', /HttpOnly; SameSite=Strict/);
        await respuesta.text();
    });

    it('rechaza una escritura que venga de otra página', async () => {
        const respuesta = await fetch(`${running.url}/panel/api/endpoints/general/toggle`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${PANEL}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ server: 'beta', on: false })
        });
        assert.equal(respuesta.status, 403);
        await respuesta.text();
    });

    it('sirve la página en español', async () => {
        const respuesta = await panel('/');
        const html = await respuesta.text();

        assert.equal(respuesta.status, 200);
        assert.match(html, /Servidores conectados/);
        assert.match(html, /Tus direcciones MCP/);
        assert.match(html, /conectar un servidor/);
    });
});
