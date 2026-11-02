/**
 * Jackfield as a serverless function.
 *
 * One of several ways to run it, not the intended one: a function cannot keep
 * a session, a child process, or a stream open for an hour. What this host
 * cannot do, a Jackfield executor on a machine you own does — see
 * `docs/deploying.md`.
 *
 * Deploying:
 *   1. Put a `jackfield.yaml` next to this folder, with no secrets in it:
 *      reference them as ${env:NAME} and set them as project variables.
 *   2. `vercel --prod`
 *   3. Agents connect to https://<project>.vercel.app/api/mcp
 */
import { createWebHandler } from '@jackfield/core';

const handler = createWebHandler({
    configPath: new URL('../jackfield.yaml', import.meta.url).pathname,
    // No invocation outlives its request, so sessions cannot work here.
    stateless: true
});

export default async function mcp(request) {
    return handler(request);
}
