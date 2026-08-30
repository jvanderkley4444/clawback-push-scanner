# Clawback — Push Scanner (requests + "you owe" reminders)

Two free, app-closed nudges on the **free** stack (GitHub Actions cron + Firebase
Admin SDK + FCM — **no Cloud Functions, no Blaze plan, no Firebase cost**):

1. **Request pushes** — a paw 🐾 / smack 🐱 / clawback 💢 money request pings the
   debtor right away (next run, ~15 min).
2. **"You owe $X" reminders** — anyone who still owes gets a gentle daily-window
   nudge, at most once per group every few days, so balances don't go stale. *(This
   is Splitwise's core retention loop — now matched at $0 cost.)*

## How it works
```
GitHub Actions cron (every ~15m)
  → read every trips/{tripId}.state   (Admin SDK; project clawback-2443f)
  Requests:  state.requests (open) → members.find(toMember).linkedUid → users/{uid}.fcmTokens
             → FCM push   (dedupe per requestId+level via pushState/{key})
  Reminders: state.reminders.debts  (the APP writes this: {uid,name,amt} per ower)
             → FCM "💸 You owe $X in <group>"   (rate-limited via remindState/{tripId}_{uid})
  Activity:  state.activity entries with a byUid stamp (app 2026-07-28+) and kind
             expense/income/payment/settle → FCM "🧾 Alex · Weekend Getaway — Added …"
             to every OTHER claimed member (dedupe per entry+recipient via pushState/act_*;
             "-edit" kinds and legacy entries without byUid are never pushed)
  → 📱 arrives even if the app is closed
```
- **Per-category opt-outs**: the app mirrors Settings → Notifications to
  `users/{uid}.notify` = `{muted, requests, activity, reminders}`. `muted:true`
  silences everything; a category `false` silences just that class. Absent = ON.
- The **app owns the split math** and writes a compact `state.reminders` (only
  reachable debtors with a linked account); the scanner just reads it and pushes —
  so reminder amounts always match what the app shows, with no math to keep in sync.
- Only **claimed** members (a `linkedUid`) can be reached; unclaimed are skipped.
- The scanner never writes into the trip blob — it records sent pushes in its own
  `pushState` / `remindState` collections (idempotent, free-tier writes).

## Tuning (workflow `env:`)
| var | default | meaning |
|-----|---------|---------|
| `REMIND_HOUR` | `17` | only send "you owe" reminders in this **UTC hour** (≈ noon ET / 9am PT) so pushes never land overnight. Blank = any hour. |
| `REMIND_DAYS` | `3` | at most one reminder per person per group every N days. |
| `REMIND_MIN` | `1` | ignore balances below this amount. |
| `ACT_WINDOW_HOURS` | `48` | how far back an activity entry may be and still push (pushState dedupes inside the window). |

Request + activity pushes ignore the reminder windows — they go out every run.

## Files
`scan.js` (scanner) · `package.json` · `.github/workflows/push.yml` (cron) · this README.

---

## ✅ One-time setup (the account steps only you can do)

> Clawback's accounts/sync run on the **JS Firebase SDK** in the web view, but
> **push requires the native Firebase iOS SDK** — so this feature needs native
> setup Clawback didn't have before. Most of it mirrors the Tabby Trade push setup.

### A. Firebase (project `clawback-app`)
1. **Authentication → enable Email/Password** (if not already) — users need an
   account (uid) to receive a token. *(Required for anything multi-user.)*
2. **Cloud Messaging → Apple app config → APNs Authentication Key** → upload your
   **`.p8`**. ♻️ You can **reuse the same `.p8` key from Tabby** — an APNs key is
   per Apple *team*, and both apps are under the same team. Enter the same Key ID +
   Team ID.

### B. Clawback iOS app — add native Firebase (in `apps/TripwiseApp`)
3. Add **`GoogleService-Info.plist`** for `clawback-app` to `ios/App/App/`
   (Firebase console → Project settings → add an **iOS app** using the bundle id
   from `apps/TripwiseApp/capacitor.config.ts` → download the plist).
4. In **`ios/App/App/AppDelegate.swift`**: add `import FirebaseCore` and
   `FirebaseApp.configure()` at the top of `didFinishLaunchingWithOptions`, and add
   the **firebase-ios-sdk** Swift Package (FirebaseCore + FirebaseMessaging).
5. In **Xcode** → App target → Signing & Capabilities → **+ Push Notifications**
   (and optionally Background Modes → Remote notifications).
6. `npx cap sync ios`, then build to a device. *(`@capacitor-firebase/messaging` is
   already installed; `firebase-app.js` already registers the token on sign-in.)*

### C. Deploy the poller
7. Firebase console → Project settings → **Service accounts** → **Generate new
   private key** (for `clawback-app`).
8. Create a **new private GitHub repo**, push the contents of
   `apps/ClawbackPushScanner/` to its root.
9. Repo → Settings → Secrets and variables → Actions → **New secret**
   `FIREBASE_SERVICE_ACCOUNT` = the entire service-account JSON.
10. Actions tab → enable → **Run workflow** to test.

### Test end-to-end
- Two signed-in users sharing a trip; the debtor must have **claimed their seat**
  (so their member has a `linkedUid`). One taps 🐾 the other → within ~15 min the
  other device gets the push.

## Local testing
```bash
npm install
GOOGLE_APPLICATION_CREDENTIALS=./service-account.json node scan.js
```

## Note on the dependency chain
Push can only reach a user who (1) signed in, (2) **claimed their member seat** in
the trip (sets `linkedUid`), and (3) registered a device token. Until Email/Password
auth is enabled and a real second user has claimed a seat, there's no reachable
target — the poller will simply find 0 candidates.
