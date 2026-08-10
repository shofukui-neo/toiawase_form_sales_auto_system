/**
 * Process-level guard for undici's HTTP parser assertions.
 *
 * undici asserts its internal parser state, and a hostile/broken peer can put it
 * in a state it did not expect (see `http.ts` for the concrete bug we hit). Those
 * assertions are thrown from a socket event listener — *outside* any promise —
 * so no `try/catch` around `fetch()` can see them and the whole process dies:
 * one bad company site kills a discovery batch mid-list.
 *
 * We swallow exactly that shape (ERR_ASSERTION raised inside undici) and let the
 * request it belonged to fail on its own (every crawler fetch has an
 * AbortController timeout, so it settles). Anything else keeps the default
 * behaviour: report and exit non-zero.
 */
import { logger } from './logger.js';

const log = logger('crashguard');

/** ERR_ASSERTION from our own code must NOT be swallowed — hence the stack test. */
const UNDICI_FRAME = /undici|client-h1|llhttp/i;

export function isUndiciParserAssertion(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException | null;
  if (!e || e.code !== 'ERR_ASSERTION') return false;
  return UNDICI_FRAME.test(String(e.stack ?? ''));
}

let installed = false;
let swallowed = 0;

/** Log-and-count an undici parser assertion. Returns true when it was handled. */
export function swallowIfUndiciAssertion(err: unknown): boolean {
  if (!isUndiciParserAssertion(err)) return false;
  swallowed++;
  log.warn(
    `undici parser assertion swallowed (#${swallowed}); its request fails via its own timeout`,
    (err as Error).message,
  );
  return true;
}

export function installCrashGuard(): void {
  if (installed) return;
  installed = true;

  process.on('uncaughtException', (err) => {
    if (swallowIfUndiciAssertion(err)) return;
    log.error('uncaught exception — exiting', err);
    process.exit(1);
  });
}

/** Number of undici assertions swallowed so far (diagnostics / tests). */
export function swallowedAssertions(): number {
  return swallowed;
}
