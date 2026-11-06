/**
 * Host half of dsh-cost-strip.
 *
 * This is a pure UI plugin: the browser half ships through the
 * `exports["./client"]` entry discovered via the package.json `dsh.client`
 * declaration. The empty `apply` exists only so the row resolves and activates
 * in the host composition — all behaviour lives in lib/client.js.
 */

/** Host plugin body — no host-side behaviour for this UI-only plugin. */
export function apply() {}
