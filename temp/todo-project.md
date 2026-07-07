# Production readiness — project-wide

> **Status (2026-07-05):** The original launch gate (golden-path sync + Tier-1 data
> safety + OAuth published) is **DONE**. We are **not** listing yet. We have chosen to
> add **payment-gating** as a *new, self-imposed launch gate* before going live on Etsy.
> Payment-gating is the **only** thing we will build before launch. Everything under
> "Deferred" stays on the list but is explicitly **not being done now**.

---

# 🚀 LAUNCH GATE — Purchase-gating (the only pre-launch work)

## Goal

Only people who bought Planourdays on Etsy can get into the app. The buyer proves purchase
by entering their **Etsy order number** on a new front-door screen. A valid order number is
one that exists in an allowlist we maintain automatically from Etsy purchase webhooks.

## Decisions already locked (do not re-open)

- **The "key" is the buyer's Etsy order number.** No generated keys, no passwords, no
  emailed codes. The Etsy download PDF is static and identical for everyone.
- **No refunds / no revocation.** Digital product; we do not process refunds, so we do not
  build revoke-on-cancel.
- **No activation cap** for v1. Sharing is accepted as low-risk.
- **No account-binding** (one-wedding-per-receipt) for v1. It requires tying to a Google
  identity, which touches OAuth — deferred to a possible v2.
- **Rate limiting: simple only.** A basic per-IP cap. Do not over-engineer.
- **Local-first is preserved.** Once a device is activated, it works forever offline and
  never re-checks. Activation is a one-time gate, not an ongoing license check.

## Decisions still to confirm before building (Phase 0)

- [ ] **KV provider.** Recommendation: **Upstash Redis (free tier)** — REST API (works from
      any serverless function), a hosted console for manual edits, built-in rate-limiting
      helper. Alternatives: Cloudflare Workers KV, Deno KV. Pick one and stick with it.
- [ ] **Function host.** Recommendation: **Netlify Functions** (site already deploys on
      Netlify, so no new account/infra). Two functions live here.
- [ ] **Confirm the buyer-facing number.** Verify that the "Order #" a buyer actually sees
      in their Etsy confirmation/email is the **same value** the webhook delivers
      (`receipt_id`). This determines what we tell buyers to type and what we store. **This
      must be confirmed against a real payload before Phase 4.**

---

## Inventory — everything that must be created

Code and non-code. Nothing here specifies *how* to build it, only what it must do.

### A. Etsy-side (non-code, account setup)
- **A1. Etsy developer app** (personal app) with webhook access, subscribed to the
  `order.paid` event, pointed at our webhook function's public URL.
- **A2. Etsy webhook signing secret** captured and stored as a server secret (used to
  verify webhooks are genuinely from Etsy).
- **A3. Static download file** attached to the listing: a one-page **instructions PDF**
  ("To activate: open planourdays.app and enter your Etsy order number, found in your
  order confirmation email"). Same file for every buyer.
- **A4. Listing copy update** telling buyers activation is by order number, and that it may
  take a minute after purchase.

### B. Infrastructure (non-code, account setup)
- **B1. KV store** (per Phase 0 choice), holding the allowlist of valid order numbers.
- **B2. Secrets/config** set as environment variables on the function host (never in the
  app bundle): Etsy signing secret, KV connection URL, KV auth token.

### C. Code job — Webhook receiver function
- **Outcome:** when someone buys, the order number lands in the allowlist automatically.
- **Input:** an HTTP request from Etsy carrying an `order.paid` event.
- **Behaviour/requirements:**
  - Verify the request is genuinely from Etsy (signature check with the Etsy secret).
    Reject anything unsigned/invalid.
  - Extract the order number, **normalise** it (trim, strip `#`/spaces, consistent case).
  - Write it to the allowlist in KV (idempotent — a repeat of the same order is harmless).
- **Output:** the normalised order number stored in KV; a success response to Etsy.
- **Must not:** expose the allowlist, require the app, or store anything about the buyer
  beyond what's needed to match the order number later.

### D. Code job — Validation function (the app's only backend touchpoint)
- **Outcome:** the app can ask "is this order number valid?" without ever seeing the list.
- **Input:** an order number submitted by the app.
- **Behaviour/requirements:**
  - **Normalise** the input the same way the receiver does.
  - Look it up in KV; return a simple valid / not-valid answer.
  - **Simple rate limit** per IP (e.g. a small number of attempts per minute) to blunt
    brute force. Keep it minimal.
  - Cheap **format pre-check** (reject obviously malformed input before any KV read).
  - Allow the app's origin (CORS).
- **Output:** `{ valid: true }` or `{ valid: false }`. Nothing else — never the list, never
  KV credentials.
- **Must not:** hold KV credentials in anything the browser can read; leak whether the list
  exists or its size.

### E. Code job — App front-door "activation" screen
- **Outcome:** a new gate that runs **before** the existing Google / local-only welcome
  screen ([WelcomeView in App.jsx](src/App.jsx)).
- **Inputs:** the buyer typing their order number; the local activation record on boot.
- **Behaviour/requirements:**
  - **On boot:** if a local activation record exists → skip the gate, go straight to the
    normal welcome flow. (No online re-check; works fully offline.)
  - **If not activated:** show an "Enter your Etsy order number" screen. On submit, call the
    validation function.
  - **On valid:** save a local activation record, then proceed to the existing welcome flow.
  - **On not-valid:** clear, non-scary error, plus a **"just purchased? wait a minute and
    try again"** path for the timing race (order entered before the webhook lands).
  - Normalise the buyer's input in the UI too (forgive spaces / `#` / case).
- **Outputs:** a persisted local activation record; entry into the app.
- **Must not:** block an already-activated device when offline; hard-fail on a slow/no
  network in a way that looks like data loss.

### F. Operations (non-code)
- **F1. Manual-add fallback SOP:** if a webhook is ever missed, the owner adds the order
  number to the allowlist by hand via the KV provider's web console. Write the 3–4 step
  procedure down (where to log in, what to paste, normalised format).
- **F2. Monitoring note:** where to see if webhooks are failing (function logs on the host).

---

## Order of operations (do in this sequence)

**Phase 0 — Confirm decisions.** Settle the three open items above (KV provider, function
host, buyer-facing number format). Do not start C/D until the number format is confirmed.

**Phase 1 — Stand up infrastructure.**
1. Create the KV store (B1) and capture its credentials (B2).
2. Create the Etsy developer app (A1) — but you can't finish the subscription until the
   webhook URL exists, so this phase just gets the app + secret (A2) ready.

**Phase 2 — Webhook receiver (C).** Deploy it (even as a minimal working endpoint) so it
has a public URL. Then finish the Etsy subscription (A1) pointing at that URL.

**Phase 3 — Validation function (D).** Deploy it.

**Phase 4 — App front-door screen (E).** Wire the gate in front of the existing welcome
flow. Requires the confirmed number format from Phase 0.

**Phase 5 — Etsy assets (A3, A4) + Ops docs (F).** Create the instructions PDF, update
listing copy, write the manual-add SOP.

**Phase 6 — End-to-end test (see below).**

**Phase 7 — Launch.** Flip the listing live once Phase 6 passes.

---

## How we test that it works

Test each piece as it's built, then prove the whole chain with a real purchase.

**Phase 2 — Webhook receiver**
- Send a sample `order.paid` payload to the endpoint (Etsy's test tooling, or a crafted
  request). ✅ Pass = the (normalised) order number appears in the KV store.
- Send a request with a **bad/missing signature**. ✅ Pass = rejected, nothing written.

**Phase 3 — Validation function**
- Call it with an order number **known to be in** KV. ✅ Pass = `valid: true`.
- Call it with a random/absent number. ✅ Pass = `valid: false`.
- Call it rapidly many times from one IP. ✅ Pass = rate limit kicks in.
- Confirm **no KV credentials** appear in the app bundle or any browser-visible response.

**Phase 4 — App screen**
- Enter a valid order number. ✅ Pass = activates and proceeds to the welcome screen.
- Enter an invalid one. ✅ Pass = friendly error, no entry.
- Enter a valid number with messy formatting (spaces, `#`). ✅ Pass = still accepted.
- Reload after activating. ✅ Pass = goes straight in, no gate.
- Reload **offline** after activating. ✅ Pass = still goes straight in.
- Simulate the timing race (number not yet in KV). ✅ Pass = "wait a minute" guidance, not
  a dead-end.

**Phase 6 — Full end-to-end smoke test (the real gate)**
1. Make a **real low-cost test purchase** from the live listing (your own account or a
   helper). 
2. ✅ Webhook fires → order number auto-appears in KV.
3. Grab the order number exactly as the buyer sees it.
4. Open the app fresh, enter it → ✅ activates and lets you in.
5. Try a made-up number → ✅ rejected.
6. Exercise the **manual-add fallback (F1)** once by hand to confirm the SOP is correct.

Launch only after step 6 passes.

---

## Risks / watch-list
- **Buyer-facing number ≠ `receipt_id`.** If Phase 0 finds a mismatch, fix what we store /
  what we ask buyers to type before Phase 4. (Highest-risk unknown.)
- **Webhook missed or delayed.** Covered by the "wait a minute" UX (E) and the manual-add
  fallback (F1). If it turns out to be common, revisit.
- **Client-side ceiling.** A determined developer can bypass any client-only gate via
  devtools. Accepted — goal is stopping casual non-buyers, not cracking.

---

# Deferred — NOT doing before launch (kept for later)

Everything below is post-launch. Listed in rough benefit/effort order. Do not start any of
these until the launch gate above is shipped.

## Tier 2 — engineering foundations
- **Test harness + first tests** (Vitest). Highest-value targets: `googleDrive.js` (fetch
  boundary) and the reconcile / state-machine pure functions in `sync.js`.
- **CI pipeline.** One GitHub Actions workflow on PR: install → lint → typecheck → test →
  build. Netlify already deploys; CI just guards what reaches it.
- **TypeScript — incremental.** Not a big-bang conversion of `App.jsx`. Start with
  `checkJs` + JSDoc, or write new logic in `.ts`. The state-blob type matters most.

## Tier 3 — hygiene & polish
- **ESLint + Prettier.** Catches unused vars, missing `useEffect` deps.
- **Break up `App.jsx`.** ~2,283 lines is the real obstacle to testing and types.
- **Env-var guardrail.** A missing `VITE_GOOGLE_CLIENT_ID` at build time silently degrades
  to local-only. Add a build-time check or visible banner.
- **Dependency security.** `npm audit` in CI + Dependabot.
- **Error reporting.** Free-tier Sentry to catch field crashes (no telemetry today).
- **Accessibility & cross-browser.** Safari / iOS localStorage quirks especially.

## v2 candidates for purchase-gating (only if problems show up)
- **Account-binding / one-wedding-per-receipt** — tie a receipt to the first Google account
  that uses it. Needs Google identity passed to the validation function (touches OAuth).
- **Activation cap** — limit devices per receipt. Same identity requirement; do it with
  binding or not at all.
