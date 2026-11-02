#!/usr/bin/env node
/**
 * Builds the landing page.
 *
 * The template keeps everything in one file because that is easier to edit;
 * the build splits the style and the script out so the deployed page can be
 * served under a strict Content-Security-Policy with no `unsafe-inline`.
 * The feature catalogue is inlined into the script: no fetch, nothing to fail.
 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, 'dist');

const features = JSON.parse(await readFile(resolve(here, 'features.json'), 'utf8'));
const template = await readFile(resolve(here, 'template.html'), 'utf8');

const style = /<style>\n([\s\S]*?)<\/style>/.exec(template);
const script = /<script>\n([\s\S]*?)<\/script>/.exec(template);
if (!style?.[1] || !script?.[1]) throw new Error('could not find the style or script block in the template');

const css = style[1];
const js = script[1].replace('__FEATURES__', JSON.stringify(features));
if (js.includes('__FEATURES__')) throw new Error('the features placeholder was not replaced');

// Content-hashed names: the page can then be cached hard without anyone ever
// seeing a new HTML against an old stylesheet, which is the classic way a
// deployed static site breaks for exactly the people who visited it before.
const sum = text => createHash('sha256').update(text).digest('base64url').slice(0, 10);
const cssName = `app.${sum(css)}.css`;
const jsName = `app.${sum(js)}.js`;

const html = template
    .replace(style[0], `<link rel="stylesheet" href="/${cssName}">`)
    .replace(script[0], `<script src="/${jsName}" defer></script>`);

if (/<style>|<script>\n/.test(html)) throw new Error('an inline block survived the build');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await writeFile(resolve(dist, 'index.html'), html);
await writeFile(resolve(dist, cssName), css);
await writeFile(resolve(dist, jsName), js);

console.log(`site/dist: ${features.length} features`);
for (const [name, text] of [['index.html', html], [cssName, css], [jsName, js]]) {
    console.log(`  ${name.padEnd(26)} ${(text.length / 1024).toFixed(1).padStart(6)} KB`);
}
