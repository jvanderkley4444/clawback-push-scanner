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
      title: `${lv.emoji} ${displayName(members, r.fromMember)} ${lv.line} ${money(r.currency, r.amount)}`,
      body: (r.note ? r.note + ' · ' : '') + 'Open Clawback to settle up.'
    });
  }
  return out;
}

async function sendToUser(db, messaging, uid, ev) {
  const userSnap = await db.collection('users').doc(uid).get();
  const u = userSnap.exists ? (userSnap.data() || {}) : {};
  const tokens = u.fcmTokens ? Object.keys(u.fcmTokens) : [];
  if (!tokens.length) return false;                    // not registered for push yet → retry next run
  const res = await messaging.sendEachForMulticast({
    tokens,
    notification: { title: ev.title, body: ev.body },
    apns: { payload: { aps: { sound: 'default', badge: 1 } } },
    data: { reqId: ev.reqId, kind: 'clawback-request' }
  });
  // prune dead tokens
  const dead = {};
  res.responses.forEach((r, i) => {
    if (!r.success && r.error) {
      const code = r.error.code || '';
      if (code.includes('registration-token-not-registered') || code.includes('invalid-argument')) dead['fcmTokens.' + tokens[i]] = admin.firestore.FieldValue.delete();
    }
  });
  if (Object.keys(dead).length) await db.collection('users').doc(uid).update(dead).catch(() => {});
  return res.successCount > 0;
}

async function main() {
  initAdmin();
  const db = admin.firestore();
  const messaging = admin.messaging();
  const now = Date.now();

  const trips = await db.collection('trips').get();
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
  console.log(`Done. ${candidates} open request(s) with a reachable target; pushed ${pushed} new notification(s).`);
}

module.exports = { eventsForTrip, displayName, targetUid, main };

if (require.main === module) {
  main().then(() => process.exit(0)).catch(err => { console.error('SCAN FAILED:', err); process.exit(1); });
}
