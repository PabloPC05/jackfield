/**
 * The panel, as one page with no build step and no dependencies.
 *
 * It is deliberately small. Everything it does maps to one line of the
 * configuration file, and the file is still what decides — so the page is a
 * convenient way to write YAML, not a second place where your setup lives.
 */

const STYLE = String.raw`
  :root { color-scheme: light dark;
    --ink:#0a0a0a; --ink-2:#474747; --ink-3:#787878;
    --line:#e6e6e6; --line-2:#cfcfcf; --bg:#fff; --bg-2:#f7f7f7; --bg-3:#efefef;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans", Arial, sans-serif; }
  @media (prefers-color-scheme: dark) { :root {
    --ink:#f7f7f7; --ink-2:#c0c0c0; --ink-3:#8c8c8c;
    --line:#242424; --line-2:#3a3a3a; --bg:#080808; --bg-2:#101010; --bg-3:#171717; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font-family:var(--sans);
    font-size:15px; line-height:1.55; -webkit-font-smoothing:antialiased; }
  a { color:inherit; }
  :focus-visible { outline:2px solid var(--ink); outline-offset:2px; }
  code, .mono { font-family:var(--mono); font-size:0.86em; }

  header { border-bottom:1px solid var(--line); position:sticky; top:0; background:var(--bg); z-index:10; }
  .barra { width:min(1100px,100% - 2.5rem); margin-inline:auto; display:flex; align-items:center;
    gap:1rem; height:56px; }
  .logo { display:flex; align-items:center; gap:0.5rem; font-family:var(--mono); font-weight:600; }
  .barra .ruta { margin-left:auto; font-family:var(--mono); font-size:0.78rem; color:var(--ink-3); }

  main { width:min(1100px,100% - 2.5rem); margin:2rem auto 5rem; }
  .aviso { border:1px solid var(--line-2); border-radius:8px; padding:0.8rem 1rem; margin-bottom:1.5rem;
    background:var(--bg-2); font-size:0.9rem; color:var(--ink-2); }
  .aviso.malo { border-color:var(--ink); }

  .columnas { display:grid; grid-template-columns:minmax(260px,320px) 1fr; gap:2.5rem; align-items:start; }
  @media (max-width:880px) { .columnas { grid-template-columns:1fr; } }

  h2 { font-size:0.78rem; letter-spacing:0.1em; text-transform:uppercase; color:var(--ink-3);
    font-weight:600; margin:0 0 0.9rem; }

  .servidor { border:1px solid var(--line); border-radius:8px; padding:0.75rem 0.9rem;
    margin-bottom:0.6rem; display:flex; align-items:center; gap:0.6rem; }
  .servidor .nom { font-weight:560; }
  .servidor .meta { font-size:0.8rem; color:var(--ink-3); font-family:var(--mono); }
  .punto { width:8px; height:8px; border-radius:50%; flex:none; background:var(--ink-3); }
  .punto.ok { background:var(--ink); }
  .punto.mal { background:transparent; border:2px solid var(--ink); }
  .servidor .quitar { margin-left:auto; }

  .destino { border:1px solid var(--line); border-radius:10px; padding:1.1rem 1.2rem; margin-bottom:1rem; }
  .destino header { position:static; border:0; background:none; display:flex; align-items:baseline;
    gap:0.6rem; flex-wrap:wrap; margin-bottom:0.2rem; }
  .destino h3 { margin:0; font-size:1.05rem; font-weight:620; }
  .destino .sub { color:var(--ink-3); font-size:0.85rem; }
  .url { background:var(--bg-2); border:1px solid var(--line); border-radius:6px; padding:0.5rem 0.7rem;
    font-family:var(--mono); font-size:0.78rem; margin:0.8rem 0; display:flex; align-items:center; gap:0.5rem; }
  .url span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }

  .interruptores { display:flex; flex-wrap:wrap; gap:0.45rem; margin-top:0.6rem; }
  .sw { display:inline-flex; align-items:center; gap:0.45rem; border:1px solid var(--line-2);
    background:transparent; color:var(--ink-2); font:inherit; font-size:0.87rem; padding:0.35rem 0.7rem;
    border-radius:999px; cursor:pointer; }
  .sw:hover { border-color:var(--ink); color:var(--ink); }
  .sw[aria-pressed="true"] { background:var(--ink); border-color:var(--ink); color:var(--bg); }
  .sw .tic { font-family:var(--mono); font-size:0.9em; }
  .sw[disabled] { opacity:0.45; cursor:not-allowed; }

  button.b { font:inherit; font-size:0.86rem; border:1px solid var(--line-2); background:transparent;
    color:var(--ink-2); border-radius:6px; padding:0.35rem 0.75rem; cursor:pointer; }
  button.b:hover { border-color:var(--ink); color:var(--ink); }
  button.b.fuerte { background:var(--ink); border-color:var(--ink); color:var(--bg); }
  button.b.fuerte:hover { opacity:0.85; }
  .acciones { display:flex; gap:0.5rem; flex-wrap:wrap; margin-top:1rem; }

  dialog { border:1px solid var(--line-2); border-radius:12px; background:var(--bg); color:var(--ink);
    padding:0; width:min(28rem,100% - 2rem); }
  dialog::backdrop { background:rgba(0,0,0,0.45); }
  dialog .cuerpo { padding:1.4rem; }
  dialog h3 { margin:0 0 1rem; font-size:1.1rem; }
  label { display:block; margin-bottom:0.9rem; font-size:0.86rem; color:var(--ink-2); }
  label span { display:block; margin-bottom:0.25rem; }
  input[type=text], input[type=url], select { width:100%; font:inherit; font-size:0.9rem; padding:0.5rem 0.65rem;
    border:1px solid var(--line-2); border-radius:6px; background:var(--bg); color:var(--ink); }
  label.fila { display:flex; align-items:center; gap:0.5rem; }
  label.fila span { margin:0; }
  .error { color:var(--ink); border-left:2px solid var(--ink); padding-left:0.7rem; margin-bottom:1rem;
    font-size:0.86rem; }
  .vacio { color:var(--ink-3); font-size:0.9rem; padding:0.5rem 0 1rem; }
`;

const SCRIPT = String.raw`
const $ = sel => document.querySelector(sel);
let estado = null;

async function api(ruta, opciones) {
  const respuesta = await fetch('api' + ruta, {
    ...opciones,
    headers: { 'Content-Type': 'application/json', 'X-Jackfield-Panel': '1', ...(opciones?.headers || {}) }
  });
  const cuerpo = await respuesta.json();
  if (!respuesta.ok) throw new Error(cuerpo.error || 'no se pudo guardar');
  return cuerpo;
}

function copiar(texto, boton) {
  navigator.clipboard?.writeText(texto).then(() => {
    const antes = boton.textContent;
    boton.textContent = 'copiado';
    setTimeout(() => { boton.textContent = antes; }, 1200);
  });
}

function pinta() {
  const servidores = $('#servidores');
  servidores.replaceChildren();

  if (!estado.servers.length) {
    const vacio = document.createElement('p');
    vacio.className = 'vacio';
    vacio.textContent = 'Todavía no has conectado ningún servidor.';
    servidores.append(vacio);
  }

  for (const servidor of estado.servers) {
    const fila = document.createElement('div');
    fila.className = 'servidor';

    const punto = document.createElement('span');
    punto.className = 'punto ' + (servidor.state === 'ready' ? 'ok' : servidor.state === 'failed' ? 'mal' : '');
    punto.title = servidor.state === 'ready' ? 'conectado' : servidor.state === 'failed' ? (servidor.error || 'no responde') : 'sin usar todavía';

    const texto = document.createElement('div');
    const nombre = document.createElement('div');
    nombre.className = 'nom';
    nombre.textContent = servidor.id;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = servidor.kind + (servidor.toolCount ? ' · ' + servidor.toolCount + ' herramientas' : '')
      + (servidor.needsLogin ? ' · falta iniciar sesión' : '');
    texto.append(nombre, meta);

    const quitar = document.createElement('button');
    quitar.className = 'b quitar';
    quitar.textContent = 'quitar';
    quitar.disabled = !estado.writable;
    quitar.addEventListener('click', async () => {
      if (!confirm('¿Quitar «' + servidor.id + '»? Desaparecerá de todas las direcciones.')) return;
      await guardar(() => api('/servers/' + servidor.id, { method: 'DELETE' }));
    });

    fila.append(punto, texto, quitar);
    servidores.append(fila);
  }

  const destinos = $('#destinos');
  destinos.replaceChildren();

  if (!estado.endpoints.length) {
    const vacio = document.createElement('p');
    vacio.className = 'vacio';
    vacio.textContent = 'Crea una dirección y pégala en tu agente.';
    destinos.append(vacio);
  }

  for (const destino of estado.endpoints) {
    const caja = document.createElement('article');
    caja.className = 'destino';

    const cabecera = document.createElement('header');
    const titulo = document.createElement('h3');
    titulo.textContent = destino.id;
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = (destino.description ? destino.description + ' · ' : '')
      + (destino.mode === 'all' ? 'lleva todo lo que haya' : 'lleva lo que elijas')
      + ' · ' + destino.toolCount + ' herramientas';
    cabecera.append(titulo, sub);

    const direccion = destino.urlWithKey || destino.url;
    const caja_url = document.createElement('div');
    caja_url.className = 'url';
    const texto_url = document.createElement('span');
    texto_url.textContent = direccion;
    const copia = document.createElement('button');
    copia.className = 'b';
    copia.textContent = 'copiar';
    copia.addEventListener('click', () => copiar(direccion, copia));
    caja_url.append(texto_url, copia);

    const caja_clave = document.createElement('div');
    caja_clave.className = 'url';
    const texto_clave = document.createElement('span');
    texto_clave.textContent = destino.keyInPath ? 'la clave va dentro de la dirección' : 'Authorization: Bearer ' + (destino.key || '—');
    const copia_clave = document.createElement('button');
    copia_clave.className = 'b';
    copia_clave.textContent = 'copiar';
    copia_clave.addEventListener('click', () => copiar(destino.key || '', copia_clave));
    caja_clave.append(texto_clave, copia_clave);

    const interruptores = document.createElement('div');
    interruptores.className = 'interruptores';
    for (const servidor of destino.servers) {
      const boton = document.createElement('button');
      boton.className = 'sw';
      boton.type = 'button';
      boton.setAttribute('aria-pressed', String(servidor.on));
      boton.disabled = !estado.writable;
      const tic = document.createElement('span');
      tic.className = 'tic';
      tic.textContent = servidor.on ? '✓' : '+';
      boton.append(tic, document.createTextNode(servidor.id));
      boton.addEventListener('click', () =>
        guardar(() => api('/endpoints/' + destino.id + '/toggle', {
          method: 'POST',
          body: JSON.stringify({ server: servidor.id, on: !servidor.on })
        }))
      );
      interruptores.append(boton);
    }
    if (!destino.servers.length) {
      const vacio = document.createElement('p');
      vacio.className = 'vacio';
      vacio.textContent = 'Conecta un servidor y aquí aparecerá su botón.';
      interruptores.append(vacio);
    }

    const acciones = document.createElement('div');
    acciones.className = 'acciones';

    const modo = document.createElement('button');
    modo.className = 'b';
    modo.disabled = !estado.writable;
    modo.textContent = destino.mode === 'all' ? 'pasar a elegir uno a uno' : 'que lleve todo';
    modo.addEventListener('click', () =>
      guardar(() => api('/endpoints/' + destino.id, {
        method: 'PATCH',
        body: JSON.stringify({ mode: destino.mode === 'all' ? 'pick' : 'all' })
      }))
    );

    const ahorro = document.createElement('button');
    ahorro.className = 'b';
    ahorro.disabled = !estado.writable;
    ahorro.textContent = destino.expose === 'search' ? 'enseñar todas las herramientas' : 'modo ahorro (2 herramientas)';
    ahorro.addEventListener('click', () =>
      guardar(() => api('/endpoints/' + destino.id, {
        method: 'PATCH',
        body: JSON.stringify({ expose: destino.expose === 'search' ? 'all' : 'search' })
      }))
    );

    const clave = document.createElement('button');
    clave.className = 'b';
    clave.disabled = !estado.writable;
    clave.textContent = 'cambiar la clave';
    clave.addEventListener('click', async () => {
      if (!confirm('El agente que use la clave actual dejará de entrar. ¿Seguimos?')) return;
      await guardar(() => api('/endpoints/' + destino.id + '/key', { method: 'POST' }));
    });

    const borrar = document.createElement('button');
    borrar.className = 'b';
    borrar.disabled = !estado.writable;
    borrar.textContent = 'borrar';
    borrar.addEventListener('click', async () => {
      if (!confirm('¿Borrar la dirección «' + destino.id + '»?')) return;
      await guardar(() => api('/endpoints/' + destino.id, { method: 'DELETE' }));
    });

    acciones.append(modo, ahorro, clave, borrar);
    caja.append(cabecera, caja_url, caja_clave, interruptores, acciones);
    destinos.append(caja);
  }

  $('#solo-lectura').hidden = estado.writable;
  if (!estado.writable) $('#solo-lectura').textContent = estado.readOnlyReason || '';
  $('#ruta').textContent = estado.configPath;
  for (const boton of document.querySelectorAll('[data-necesita-escritura]')) boton.disabled = !estado.writable;
}

async function guardar(accion) {
  try {
    estado = await accion();
    pinta();
  } catch (error) {
    alert(error.message);
  }
}

async function cargar() {
  estado = await api('/state');
  pinta();
}

// --- formularios -------------------------------------------------------
$('#nuevo-servidor').addEventListener('click', () => {
  $('#error-servidor').textContent = '';
  $('#dlg-servidor').showModal();
});
$('#tipo-servidor').addEventListener('change', evento => {
  const esHttp = evento.target.value === 'http';
  $('#campos-http').hidden = !esHttp;
  $('#campos-stdio').hidden = esHttp;
});
$('#form-servidor').addEventListener('submit', async evento => {
  evento.preventDefault();
  const datos = Object.fromEntries(new FormData(evento.target));
  const cuerpo = { id: datos.id.trim(), kind: datos.kind, description: datos.description?.trim() || undefined };
  if (datos.kind === 'http') {
    cuerpo.url = datos.url?.trim();
    if (datos.acceso === 'oauth') cuerpo.oauth = true;
    else if (datos.token?.trim()) cuerpo.token = datos.token.trim();
  } else {
    cuerpo.command = datos.command?.trim();
    cuerpo.args = (datos.args || '').split(' ').map(s => s.trim()).filter(Boolean);
  }
  try {
    estado = await api('/servers', { method: 'POST', body: JSON.stringify(cuerpo) });
    pinta();
    $('#dlg-servidor').close();
    evento.target.reset();
  } catch (error) {
    $('#error-servidor').textContent = error.message;
  }
});

$('#nueva-direccion').addEventListener('click', () => {
  $('#error-direccion').textContent = '';
  $('#dlg-direccion').showModal();
});
$('#form-direccion').addEventListener('submit', async evento => {
  evento.preventDefault();
  const datos = Object.fromEntries(new FormData(evento.target));
  try {
    estado = await api('/endpoints', {
      method: 'POST',
      body: JSON.stringify({
        id: datos.id.trim(),
        description: datos.description?.trim() || undefined,
        mode: datos.mode,
        servers: datos.mode === 'pick' ? [] : undefined,
        keyInPath: datos.keyInPath === 'on'
      })
    });
    pinta();
    $('#dlg-direccion').close();
    evento.target.reset();
  } catch (error) {
    $('#error-direccion').textContent = error.message;
  }
});

for (const boton of document.querySelectorAll('[data-cerrar]')) {
  boton.addEventListener('click', evento => evento.target.closest('dialog').close());
}

cargar().catch(error => alert(error.message));
`;

export function renderPanel(): string {
    return `<!DOCTYPE html>
<html lang="es"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Tus MCP — jackfield</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <div class="barra">
    <span class="logo">
      <svg width="18" height="18" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.6" aria-hidden="true">
        <circle cx="10" cy="11" r="3"/><circle cx="22" cy="11" r="3"/><circle cx="10" cy="22" r="3"/><circle cx="22" cy="22" r="3"/>
        <path d="M10 14v5M13 22h6" stroke-linecap="round"/>
      </svg>
      jackfield
    </span>
    <span class="ruta" id="ruta"></span>
  </div>
</header>

<main>
  <p class="aviso malo" id="solo-lectura" hidden></p>
  <p class="aviso">
    Todo lo que cambies aquí se escribe en tu archivo de configuración, con tus comentarios intactos.
    Puedes seguir editándolo a mano: el archivo manda, esto solo es una forma cómoda de escribirlo.
  </p>

  <div class="columnas">
    <section>
      <h2>Servidores conectados</h2>
      <div id="servidores"></div>
      <button class="b fuerte" id="nuevo-servidor" data-necesita-escritura>+ conectar un servidor</button>
    </section>

    <section>
      <h2>Tus direcciones MCP</h2>
      <div id="destinos"></div>
      <button class="b fuerte" id="nueva-direccion" data-necesita-escritura>+ crear una dirección</button>
    </section>
  </div>
</main>

<dialog id="dlg-servidor"><div class="cuerpo">
  <h3>Conectar un servidor</h3>
  <p class="error" id="error-servidor"></p>
  <form id="form-servidor">
    <label><span>Nombre corto</span><input type="text" name="id" required placeholder="correo" pattern="[a-z0-9][a-z0-9_-]*"></label>
    <label><span>Para qué es (opcional)</span><input type="text" name="description" placeholder="mi correo y mis carpetas"></label>
    <label><span>Tipo</span>
      <select name="kind" id="tipo-servidor">
        <option value="http">Una dirección web (lo normal)</option>
        <option value="stdio">Un programa en esta máquina</option>
      </select>
    </label>
    <div id="campos-http">
      <label><span>Dirección</span><input type="url" name="url" placeholder="https://ejemplo.com/mcp"></label>
      <label><span>Cómo entra</span>
        <select name="acceso">
          <option value="token">Con una clave que yo pego</option>
          <option value="oauth">Iniciando sesión (OAuth)</option>
          <option value="ninguno">Sin nada, es abierto</option>
        </select>
      </label>
      <label><span>La clave, si la hay</span><input type="text" name="token" placeholder="se guarda en tu archivo"></label>
    </div>
    <div id="campos-stdio" hidden>
      <label><span>Comando</span><input type="text" name="command" placeholder="npx"></label>
      <label><span>Argumentos, separados por espacios</span><input type="text" name="args" placeholder="-y algun-servidor-mcp"></label>
    </div>
    <div class="acciones">
      <button class="b fuerte" type="submit">Conectar</button>
      <button class="b" type="button" data-cerrar>Cancelar</button>
    </div>
  </form>
</div></dialog>

<dialog id="dlg-direccion"><div class="cuerpo">
  <h3>Crear una dirección</h3>
  <p class="error" id="error-direccion"></p>
  <form id="form-direccion">
    <label><span>Nombre corto</span><input type="text" name="id" required placeholder="claude-ai" pattern="[a-z0-9][a-z0-9_-]*"></label>
    <label><span>Para qué agente es (opcional)</span><input type="text" name="description" placeholder="el chat de claude.ai"></label>
    <label><span>Qué lleva</span>
      <select name="mode">
        <option value="all">Todo lo que haya, ahora y en adelante</option>
        <option value="pick">Solo lo que yo elija</option>
      </select>
    </label>
    <label class="fila"><input type="checkbox" name="keyInPath"><span>La clave va dentro de la dirección (para agentes que no admiten cabeceras, como claude.ai)</span></label>
    <div class="acciones">
      <button class="b fuerte" type="submit">Crear</button>
      <button class="b" type="button" data-cerrar>Cancelar</button>
    </div>
  </form>
</div></dialog>

<script>${SCRIPT}</script>
</body></html>`;
}
