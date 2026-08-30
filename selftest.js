'use strict';
/* Offline unit checks for the pure logic in scan.js — no network, no Firebase.
   Run:  npm test   (also runs in CI on every push).

   Ported from cwf-push-scanner, which had these and caught real regressions;
   this repo had no tests at all until 2026-08-30. */
const assert = require('assert');
const { eventsForTrip, reminderEventsForTrip, activityEventsForTrip,
        displayName, targetUid, mapLimit, MAX_LOOKBACK_MS, OVERLAP_MS } = require('./scan');

let n = 0;
function ok(desc, fn) { fn(); n++; console.log('  ✓ ' + desc); }
console.log('scan.js pure-logic self-test');

const MEMBERS = [
  { id: 'm1', name: 'Ann', linkedUid: 'u1', linkedName: 'Ann L.' },
  { id: 'm2', name: 'Bob', linkedUid: null },           // unclaimed — unreachable
  { id: 'm3', name: 'Cy',  linkedUid: 'u3' }
];

ok('displayName prefers linkedName, then name, then a safe fallback', () => {
  assert.strictEqual(displayName(MEMBERS, 'm1'), 'Ann L.');
  assert.strictEqual(displayName(MEMBERS, 'm2'), 'Bob');
  assert.strictEqual(displayName(MEMBERS, 'nope'), 'Someone');
  assert.strictEqual(displayName(null, 'm1'), 'Someone');
});

ok('targetUid resolves a linked member and refuses an unclaimed one', () => {
  assert.strictEqual(targetUid(MEMBERS, 'm1'), 'u1');
  assert.strictEqual(targetUid(MEMBERS, 'm2'), null);   // no linkedUid -> unreachable
  assert.strictEqual(targetUid(MEMBERS, 'nope'), null);
});

ok('eventsForTrip only yields OPEN requests aimed at a reachable member', () => {
  const state = { members: MEMBERS, requests: [
    { id: 'r1', fromMember: 'm1', toMember: 'm3', amount: 10, level: 1, status: 'open' },
    { id: 'r2', fromMember: 'm1', toMember: 'm2', amount: 20, level: 1, status: 'open' },   // unclaimed
    { id: 'r3', fromMember: 'm1', toMember: 'm3', amount: 30, level: 2, status: 'settled' } // closed
  ] };
  const ids = eventsForTrip(state).map(e => e.reqId);
  assert.ok(ids.includes('r1'), 'open + reachable must notify');
  assert.ok(!ids.includes('r2'), 'unclaimed member must be skipped');
  assert.ok(!ids.includes('r3'), 'settled request must not notify');
});

ok('a request key embeds the LEVEL, so an escalation notifies again', () => {
  const mk = (level) => eventsForTrip({ members: MEMBERS, requests: [
    { id: 'r1', fromMember: 'm1', toMember: 'm3', amount: 10, level, status: 'open' }] })[0];
  assert.notStrictEqual(mk(1).key, mk(2).key, 'tap and smack must be separate pushState keys');
});

ok('activityEventsForTrip honours its since-window', () => {
  const now = Date.now();
  const state = { members: MEMBERS, entries: [
    { id: 'e1', by: 'm1', at: now - 1000, label: 'Dinner', amount: 80 },
    { id: 'e2', by: 'm1', at: now - 90 * 3600000, label: 'Old', amount: 5 }
  ] };
  const fresh = activityEventsForTrip(state, now - 48 * 3600000).map(e => e.reqId);
  assert.ok(!fresh.includes('e2'), 'an entry older than the window must be excluded');
});

ok('reminderEventsForTrip never targets an unreachable member', () => {
  const evs = reminderEventsForTrip({ members: MEMBERS, requests: [
    { id: 'r9', fromMember: 'm1', toMember: 'm2', amount: 50, level: 1, status: 'open' }] });
  assert.ok(evs.every(e => e.uid), 'every reminder must carry a real uid');
});

ok('the lookback clamp and overlap are sane', () => {
  assert.ok(MAX_LOOKBACK_MS >= 3600000, 'lookback must be at least an hour');
  assert.ok(OVERLAP_MS > 0 && OVERLAP_MS < MAX_LOOKBACK_MS, 'overlap must be positive and smaller than the clamp');
});

(async () => {
  let live = 0, peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (v) => {
    live++; peak = Math.max(peak, live);
    await new Promise(r => setTimeout(r, 1));
    live--; return v * 2;
  });
  assert.deepStrictEqual(out, [2, 4, 6, 8, 10, 12, 14]);
  assert.ok(peak <= 3, 'concurrency exceeded the limit: ' + peak);
  assert.deepStrictEqual(await mapLimit([], 4, async () => 1), []);
  n++; console.log('  ✓ mapLimit is bounded (peak ' + peak + ') and order-preserving');
  console.log(`\nAll ${n} checks passed.`);
})().catch((e) => { console.error(e); process.exit(1); });
