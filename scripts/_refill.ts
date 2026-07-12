/**
 * Re-parse + re-plan companies that already have a discovered form_url, so they
 * pick up the L2 (consent-checkbox) and L4 (consent-check) fixes without paying
 * for slow L1 re-discovery. Resets each to FORM_FOUND (keeps form_url), then runs
 * L2 parse + L4 Plan. Ends at PENDING_APPROVAL (or SUPPRESSED if a no-sales
 * policy is detected). Pass ids as args, or omit to refill all PENDING_APPROVAL.
 */
import Database from 'better-sqlite3';
import { companies } from '../src/db/repositories.js';
import { discoverAndParse, buildPlan } from '../src/pipeline/pipeline.js';

const db = new Database('./data/app.db');
let ids = process.argv.slice(2).map(Number).filter(Boolean);
if (ids.length === 0) {
  ids = (db.prepare("SELECT id FROM companies WHERE status='PENDING_APPROVAL' ORDER BY id").all() as any[]).map((r) => r.id);
}
const setFound = db.prepare("UPDATE companies SET status='FORM_FOUND', updated_at=datetime('now') WHERE id=? AND form_url IS NOT NULL");

for (const id of ids) {
  const c = companies.byId(id);
  if (!c || !c.form_url) { console.log(`skip #${id} (no form_url)`); continue; }
  setFound.run(id);
  try {
    await discoverAndParse(id);              // L2 parse (status FORM_FOUND -> PARSED)
    const after = companies.byId(id)!;
    if (after.status === 'PARSED') {
      await buildPlan(id);                    // L3 + L4 Plan -> PENDING_APPROVAL
      console.log(`#${id} ${c.name} -> ${companies.byId(id)!.status}`);
    } else {
      console.log(`#${id} ${c.name} -> ${after.status} (not re-planned)`);
    }
  } catch (e) {
    console.log(`#${id} ${c.name} ERROR: ${(e as Error).message}`);
  }
}
