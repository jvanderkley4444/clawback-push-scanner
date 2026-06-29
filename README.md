# Clawback — Request Push Poller

Sends an FCM push for **paw 🐾 / smack 🐱 / clawback 💢** money requests, so the
person being asked gets nudged **even when the app is closed** — on the **free**
stack (GitHub Actions cron + Firebase Admin + FCM, no Blaze plan). Best-effort
timing: the cron runs ~every 15 minutes.

## How it works
```
GitHub Actions cron (every ~15m)
  → read every trips/{tripId}.state.requests  (Admin SDK)
  → for each OPEN request: members.find(toMember).linkedUid → users/{uid}.fcmTokens
  → send FCM push  (dedupe per requestId+level via pushState/{key})
  → 📱 push arrives even if the app is closed
```
- Only **claimed** members (with a `linkedUid`) can be notified — a request to an
  unclaimed participant is skipped (they'll see it in-app when they open Clawback).
- Each escalation is its own push: a *tap* notifies once, a later *smack* and
  *clawback* each notify again (keyed `requestId_L{level}`).
- The poller never writes into the trip blob (the app owns that); it records sent
  pushes in its own `pushState` collection.

## Files
`scan.js` (poller) · `package.json` · `.github/workflows/push.yml` (cron) · this README.

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
   (Firebase console → Project settings → add an **iOS app** with bundle id
   `com.jeffvanderkley.clawback` → download the plist). *(I can fetch this for you
   via the CLI — just ask.)*
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
