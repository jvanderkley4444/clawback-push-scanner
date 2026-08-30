'use strict';
/*
 * scan.js — Clawback request-push poller (runs free on GitHub Actions cron).
 *
 * Scans every trip for OPEN paw 🐾 / smack 🐱 / clawback 💢 money requests and
 * sends an FCM push to the *target* user (the debtor) — so they get nudged even
 * when the app is closed. Mirrors the Tabby Trade scanner stack (Admin SDK +
 * FCM, no Blaze plan). Best-effort timing: the cron runs ~every 15 min.
 *
 * Data model (see the app): requests live inside trips/{tripId}.state.requests,
 * each = { id, fromMember, toMember (local member ids), amount, currency, note,
 * level (1=tap,2=smack,3=clawback), status }. The target user is resolved
 * members.find(toMember).linkedUid → users/{uid}.fcmTokens. Unclaimed members
 * (linkedUid null) can't be reached, so they're skipped.
 *
 * Idempotency: we DON'T write into the trip blob (the client owns it). Instead
 * each notified event is recorded as pushState/{requestId}_L{level} — so a tap
 * notifies once, and a later smack/clawback (a new level) notifies again.
 */
const admin = require('firebase-admin');

const LEVELS = {
  1: { emoji: '🐾', line: 'is requesting' },
  2: { emoji: '🐱', line: 'smacked you for' },
  3: { emoji: '💢', line: 'is clawing back' }
};

function initAdmin() {
  if (admin.apps.length) return;
  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (saJson && saJson.trim()) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(saJson)) });
  } else {
    admin.initializeApp();   // GOOGLE_APPLICATION_CREDENTIALS / ADC
  }
}

// ── Learnings carried over from the cwf-push-scanner rebuild (2026-08-30) ───
// That scanner went DARK for five days and nobody noticed, because nothing
// recorded whether it had run. It also re-read a widening window whenever one
// step failed. Both lessons apply here, plus one this scanner has and that one
// did not: `trips.get()` is a FULL COLLECTION SCAN on every run, so Firestore
// reads grow linearly with the number of trips forever.
const HOUR_MS = 3600000;

// How far back an incremental pass may reach, however long the gap since the
// last successful run. Bounds a catch-up scan after an outage.
const MAX_LOOKBACK_MS = (Number(process.env.MAX_LOOKBACK_HOURS) || 72) * HOUR_MS;

// Re-examine a short window before the cursor so a late cron or a little clock
// skew can't drop an event; pushState de-dupes the overlap.
const OVERLAP_MS = 5 * 60 * 1000;

// Run an async fn over items with bounded concurrency. The old code awaited a
// pushState get + an FCM send + a pushState set one event at a time, so a busy
// trip list ran for minutes of pure round-trip latency.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async function () {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function memberById(members, id) { return (members || []).find(m => m && m.id === id) || null; }
function displayName(members, id) { const m = memberById(members, id); return m ? (m.linkedName || m.name || 'Someone') : 'Someone'; }
function targetUid(members, id) { const m = memberById(members, id); return (m && m.linkedUid) ? m.linkedUid : null; }
function money(cur, amt) { const n = Number(amt) || 0; return (cur ? cur + ' ' : '') + n.toFixed(2); }

// Build the {events} a single trip currently owes — pure, exported for tests.
function eventsForTrip(state) {
  const reqs = (state && state.requests) || [];
  const members = (state && state.members) || [];
  const out = [];
  for (const r of reqs) {
    if (!r || r.status !== 'open') continue;          // only open requests nudge
    const level = r.level || 1;
    const uid = targetUid(members, r.toMember);
    if (!uid) continue;                                // unclaimed target → can't reach
    const lv = LEVELS[level] || LEVELS[1];
    out.push({
      key: r.id + '_L' + level,                        // dedupe key: one push per request+level
      uid,
      reqId: r.id,
      level,
      pref: 'requests',                                // per-category opt-out key on users/{uid}.notify
      title: `${lv.emoji} ${displayName(members, r.fromMember)} ${lv.line} ${money(r.currency, r.amount)}`,
      body: (r.note ? r.note + ' · ' : '') + 'Open Clawback to settle up.'
    });
  }
  return out;
}

// Activity pushes ("Alex added Dinner CA$80") from the trip's synced activity log.
// The app stamps each entry with the ACTOR's uid (byUid, 2026-07-28+); recipients are
// every OTHER claimed member. Entries without byUid (legacy) are skipped — that also
// means the first scan after this deploys pushes nothing historical. `since` bounds
// the window so a pruned pushState collection can never replay old entries.
const ACTIVITY_KINDS = { expense: '🧾', income: '💵', payment: '💸', settle: '✅' };
function activityEventsForTrip(state, sinceMs) {
  const acts = (state && state.activity) || [];
  const members = (state && state.members) || [];
  const tripName = (state && state.trip && state.trip.name) || 'your group';
  const out = [];
  for (const a of acts) {
    if (!a || !a.id || !a.byUid || !ACTIVITY_KINDS[a.kind]) continue;
    const at = Date.parse(a.at || '');
    if (!isFinite(at) || at < sinceMs) continue;
    for (const m of members) {
      if (!m || !m.linkedUid || m.linkedUid === a.byUid) continue;   // unreachable, or the actor
      out.push({
        key: 'act_' + a.id + '_' + m.linkedUid,        // one push per entry per recipient
        uid: m.linkedUid,
        reqId: a.id,
        kind: 'clawback-activity',
        pref: 'activity',
        title: `${ACTIVITY_KINDS[a.kind]} ${a.who || 'Someone'} · ${tripName}`,
        body: String(a.summary || 'made a change') + ' · Open Clawback to see it.'
      });
    }
  }
  return out;
}

// "You owe $X" reminders. Reads the compact debtor list the APP writes into
// state.reminders ({cur, debts:[{uid,name,amt}]}) — the app owns the split math, so we
// just push. Pure + exported for tests. Rate-limiting happens in main() (remindState).
function reminderEventsForTrip(state) {
  const rem = (state && state.reminders) || {};
  const debts = rem.debts || [];
  const cur = rem.cur || (state && state.trip && state.trip.currency) || '';
  const tripName = (state && state.trip && state.trip.name) || 'your group';
  const min = Number(process.env.REMIND_MIN) || 1;
  const out = [];
  for (const d of debts) {
    if (!d || !d.uid) continue;
    const amt = Number(d.amt) || 0;
    if (amt < min) continue;                            // ignore trivial balances
    out.push({
      uid: d.uid, amt, kind: 'clawback-reminder', reqId: 'remind', pref: 'reminders',
      title: `💸 You owe ${money(cur, amt)} in ${tripName}`,
      body: 'Open Clawback to settle up.'
    });
  }
  return out;
}

async function sendToUser(db, messaging, uid, ev) {
  const userSnap = await db.collection('users').doc(uid).get();
  const u = userSnap.exists ? (userSnap.data() || {}) : {};
  // Notification opt-out: the app mirrors the Settings toggle to users/{uid}.notify.muted.
  // A muted user gets no request nudges OR debt reminders. Returning false (rather than
  // recording pushState) means an un-mute resumes any still-open nudge on the next run.
  if (u.notify && u.notify.muted === true) return false;
  // Per-category opt-out (users/{uid}.notify.requests|activity|reminders, mirrored from
  // Settings → Notifications). Absent key = ON; only an explicit false silences the class.
  if (ev.pref && u.notify && u.notify[ev.pref] === false) return false;
  const tokens = u.fcmTokens ? Object.keys(u.fcmTokens) : [];
  if (!tokens.length) return false;                    // not registered for push yet → retry next run
  const res = await messaging.sendEachForMulticast({
    tokens,
    notification: { title: ev.title, body: ev.body },
    apns: { payload: { aps: { sound: 'default', badge: 1 } } },
    data: { reqId: ev.reqId, kind: ev.kind || 'clawback-request' }
  });
  // prune dead tokens (2026-07 fixes, ported from StockAlertScanner):
  //  (A) key ONLY on token-specific codes. 'invalid-argument' was removed — FCM
  //      also returns it for a malformed MESSAGE, so one bad payload would have
  //      wiped every healthy token for every user. Log other errors instead.
  //  (B) delete via FieldPath('fcmTokens', token), NOT the string
  //      `'fcmTokens.' + token`: FCM tokens contain ':' and '/', which are
  //      illegal in a string field path, so update() threw into the silent
  //      catch below and pruning NEVER actually worked.
  const deadPaths = [];
  res.responses.forEach((r, i) => {
    if (!r.success && r.error) {
      const code = r.error.code || '';
      if (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token')) {
        deadPaths.push(new admin.firestore.FieldPath('fcmTokens', tokens[i]), admin.firestore.FieldValue.delete());
      } else {
        console.warn(`send error for ${uid} token[${i}]: ${code}`);
      }
    }
  });
  if (deadPaths.length) await db.collection('users').doc(uid).update(deadPaths[0], deadPaths[1], ...deadPaths.slice(2)).catch(() => {});
  return res.successCount > 0;
}

async function main() {
  initAdmin();
  const db = admin.firestore();
  const messaging = admin.messaging();
  const now = Date.now();

  // ── Cursor + heartbeat ────────────────────────────────────────────────────
  // Requests and activity are CHANGE-driven, so they only need trips touched
  // since the last good run. Reminders are TIME-driven over every still-open
  // debt, so they must see trips that have not changed at all — those get the
  // full scan, but only inside the once-a-day REMIND_HOUR window, which turns
  // ~96 full collection scans a day into ~4.
  const metaRef = db.collection('pushState').doc('_meta');
  const meta = await metaRef.get().then(d => (d.exists ? d.data() || {} : {})).catch(() => ({}));
  const sinceMs = meta.lastOkAt ? Math.max(meta.lastOkAt - OVERLAP_MS, now - MAX_LOOKBACK_MS) : 0;
  let hadError = false;

  // One phase in isolation: a failure logs, marks hadError (so the cursor is
  // held and the window retries next run) and never aborts the other phases.
  async function step(label, fn) {
    try { return await fn(); }
    catch (e) { hadError = true; console.error(`[${label}] failed — cursor held, will retry: ${(e && e.message) || e}`); }
  }

  // sinceMs === 0 means "no cursor yet" (first run after this deploys, or a
  // wiped _meta) → full scan, exactly the old behaviour. pushState still
  // de-dupes, so this can never replay a notification that already went out.
  let incTrips = [];
  await step('trips_incremental', async () => {
    incTrips = sinceMs
      ? (await db.collection('trips').where('updatedAt', '>', admin.firestore.Timestamp.fromMillis(sinceMs)).get()).docs
      : (await db.collection('trips').get()).docs;
  });
  const trips = { docs: incTrips };
  console.log(`Trips scanned: ${incTrips.length}${sinceMs ? ` (changed since ${new Date(sinceMs).toISOString()})` : ' (full scan — no cursor yet)'}`);

  let pushed = 0, candidates = 0;
  for (const doc of trips.docs) {
    const state = (doc.data() || {}).state || {};
    for (const ev of eventsForTrip(state)) {
      candidates++;
      const psRef = db.collection('pushState').doc(ev.key);
      if ((await psRef.get()).exists) continue;        // already notified this request+level
      const ok = await sendToUser(db, messaging, ev.uid, ev);
      if (ok) { await psRef.set({ sentAt: now, reqId: ev.reqId, level: ev.level, tripId: doc.id }); pushed++; }
      // if !ok (no tokens), leave unrecorded so it retries once they register
    }
  }
  console.log(`Requests: ${candidates} open with a reachable target; pushed ${pushed} new.`);

  // ── Activity pushes ("X added Dinner $80") ──────────────────────────────
  // Window = 2× the poll cadence would be too tight for a slow/failed run; 48h is
  // safe because pushState dedupes per entry+recipient — the window only caps how
  // far back a BRAND-NEW recipient (or wiped pushState) could be spammed.
  const ACT_WINDOW_MS = (Number(process.env.ACT_WINDOW_HOURS) || 48) * 3600000;
  let actPushed = 0, actCandidates = 0;
  for (const doc of trips.docs) {
    const state = (doc.data() || {}).state || {};
    for (const ev of activityEventsForTrip(state, now - ACT_WINDOW_MS)) {
      actCandidates++;
      const psRef = db.collection('pushState').doc(ev.key);
      if ((await psRef.get()).exists) continue;          // this recipient already got this entry
      const ok = await sendToUser(db, messaging, ev.uid, ev);
      if (ok) { await psRef.set({ sentAt: now, actId: ev.reqId, tripId: doc.id, uid: ev.uid }); actPushed++; }
      // if !ok (no tokens / muted / activity off), leave unrecorded — an un-mute within
      // the window resumes; after the window it ages out naturally.
    }
  }
  console.log(`Activity: ${actCandidates} candidate deliveries; pushed ${actPushed} new.`);

  // ── "You owe $X" reminders ──────────────────────────────────────────────
  // Nudge anyone who still owes, at most once per REMIND_DAYS (default 3), and only
  // during the daily window REMIND_HOUR (UTC) so pushes never land at 3am. The cron runs
  // every 15 min for timely Tap pings; this self-rate-limits so it can share that cadence.
  const REMIND_MS = (Number(process.env.REMIND_DAYS) || 3) * 86400000;
  const remindHour = process.env.REMIND_HOUR;
  const inWindow = (remindHour === undefined || remindHour === '') ? true : (new Date(now).getUTCHours() === Number(remindHour));
  let reminded = 0, owers = 0;
  if (inWindow) {
    // FULL scan on purpose. A reminder is not triggered by a change — someone who
    // has owed you money for a week has a trip whose updatedAt has not moved, and
    // the incremental set above would never surface them. This is the only phase
    // that needs every trip, and it runs only inside the once-a-day REMIND_HOUR.
    const allTrips = await step('reminders_scan', async () =>
      (await db.collection('trips').get()).docs) || [];
    console.log(`Reminders: full scan of ${allTrips.length} trip(s) (REMIND_HOUR window).`);
    for (const doc of allTrips) {
      const state = (doc.data() || {}).state || {};
      for (const ev of reminderEventsForTrip(state)) {
        owers++;
        const rsRef = db.collection('remindState').doc(doc.id + '_' + ev.uid);
        const prev = await rsRef.get();
        if (prev.exists && (now - (prev.data().lastAt || 0)) < REMIND_MS) continue;   // reminded recently
        const ok = await sendToUser(db, messaging, ev.uid, ev);
        if (ok) { await rsRef.set({ lastAt: now, amt: ev.amt, tripId: doc.id, uid: ev.uid }); reminded++; }
      }
    }
    console.log(`Reminders: ${owers} reachable ower(s); pushed ${reminded} new nudge(s).`);
  } else {
    console.log(`Reminders: outside the daily window (REMIND_HOUR=${remindHour} UTC) — skipped.`);
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────────
  // The cwf scanner was dead for five days before anyone noticed, because
  // nothing anywhere recorded that it had run. lastRunAt ALWAYS advances, so
  // "is push alive?" is answerable at a glance; lastOkAt is the cursor and only
  // moves on a fully clean run, so a failed phase replays its window next time.
  await metaRef.set({
    lastRunAt: now,
    lastOkAt: hadError ? (meta.lastOkAt || null) : now,
    lastStatus: hadError ? 'partial' : 'ok',
    lastCounts: { requests: pushed, activity: actPushed, reminders: reminded }
  }, { merge: true }).catch(() => {});
  console.log(hadError
    ? 'Scan finished WITH ERRORS — cursor held, the window retries next run.'
    : `Scan complete — cursor → ${new Date(now).toISOString()}`);
}

module.exports = { eventsForTrip, reminderEventsForTrip, activityEventsForTrip, displayName, targetUid, sendToUser, mapLimit, main, MAX_LOOKBACK_MS, OVERLAP_MS };

if (require.main === module) {
  main().then(() => process.exit(0)).catch(err => { console.error('SCAN FAILED:', err); process.exit(1); });
}
