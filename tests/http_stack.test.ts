import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getGlobalDispatcher } from 'undici';
import { isUndiciParserAssertion, swallowIfUndiciAssertion, swallowedAssertions } from '../src/utils/crash_guard.js';
import { crawlerAgent } from '../src/utils/http.js';

/**
 * Regression guards for the crash that killed a discovery batch mid-list:
 *
 *   AssertionError [ERR_ASSERTION]: false == true
 *       at Parser.finish (undici/lib/dispatcher/client-h1.js:367)   // assert(!this.paused)
 *       at TLSSocket.onHttpSocketEnd
 *
 * A peer ended the connection while undici's HTTP/1.1 parser was paused by
 * backpressure. The throw happens in a socket listener, so no try/catch around
 * fetch() can see it — the process just dies. See src/utils/http.ts.
 */

const require = createRequire(import.meta.url);

test('fetch runs on undici >= 8 — the release that drains a paused parser at EOF instead of asserting', () => {
  const { version } = require('undici/package.json') as { version: string };
  const major = Number(version.split('.')[0]);
  assert.ok(major >= 8, `undici ${version} still has assert(!this.paused) in Parser.finish()`);
});

test('importing the HTTP stack makes our undici pool the process-wide dispatcher', () => {
  assert.equal(getGlobalDispatcher(), crawlerAgent);
  // Node's own fetch (used by the Anthropic / googleapis SDKs) reads the legacy
  // v1 symbol, so owning that too is what puts *every* request in the process on
  // the fixed parser rather than the older undici Node bundles.
  const legacy = (globalThis as Record<symbol, unknown>)[Symbol.for('undici.globalDispatcher.1')];
  assert.ok(legacy, 'legacy dispatcher slot must point at our pool');
});

test('no source file imports plain cheerio — it installs its own undici as the global dispatcher', () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts') && /from ['"]cheerio['"]/.test(readFileSync(p, 'utf8'))) offenders.push(p);
    }
  };
  walk('src');
  assert.deepEqual(offenders, [], `import from 'cheerio/slim' instead in: ${offenders.join(', ')}`);
});

test('the crash guard swallows undici parser assertions and nothing else', () => {
  const undiciAssertion = Object.assign(new Error('false == true'), {
    code: 'ERR_ASSERTION',
    stack: 'AssertionError: false == true\n    at Parser.finish (/app/node_modules/undici/lib/dispatcher/client-h1.js:367:5)',
  });
  assert.equal(isUndiciParserAssertion(undiciAssertion), true);

  // Our own assertions must still crash the process — they are real bugs.
  const ourAssertion = Object.assign(new Error('false == true'), {
    code: 'ERR_ASSERTION',
    stack: 'AssertionError: false == true\n    at buildPlan (/app/src/pipeline/pipeline.ts:120:3)',
  });
  assert.equal(isUndiciParserAssertion(ourAssertion), false);

  assert.equal(isUndiciParserAssertion(new TypeError('boom')), false);
  assert.equal(isUndiciParserAssertion(null), false);
});

test('the crash guard is installed by the HTTP stack and counts what it swallows', () => {
  assert.ok(
    process.listeners('uncaughtException').length >= 1,
    'importing src/utils/http.ts must install the guard',
  );

  const before = swallowedAssertions();
  const err = Object.assign(new Error('false == true'), {
    code: 'ERR_ASSERTION',
    stack: 'AssertionError: false == true\n    at Parser.finish (/app/node_modules/undici/lib/dispatcher/client-h1.js:367:5)',
  });
  assert.equal(swallowIfUndiciAssertion(err), true);
  assert.equal(swallowIfUndiciAssertion(new TypeError('boom')), false);
  assert.equal(swallowedAssertions(), before + 1);
});
