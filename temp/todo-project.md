# Production readiness — project-wide

Ordered by benefit vs. effort. Work top to bottom.

> ⚠️ **Before anything here: finish [`todo-sync.md`](./todo-sync.md).** Sync is a
> launch requirement, not optional. The golden-path sync work comes first, above all
> else. Several Tier-1 items below overlap with the sync build — do those *alongside* it
> where noted.

---

## Tier 1 — data safety (pre-launch)
A bug here means lost wedding data → refund + bad review. Highest leverage. Do the
starred items *alongside* the sync build, not after.

1. **Top-level error boundary.** ★ One unhandled render error currently white-screens the
   whole app, which reads as "it ate my data." Add a React error boundary that says
   "something went wrong — your data is safe locally." A few lines, high impact. Also
   provide an export of their json data on errors, if possible, just in case.

2. **Surface localStorage write failures.** ★ Quota-exceeded / private-mode / disabled
   storage currently fail silently (`catch {}` in the storage adapter and `googleDrive.js`).
   The user believes they saved when they didn't. Detect and surface it — feeds directly
   into the save-state indicator in `todo-sync.md`.

3. **Schema validation on load (pull + hydrate).** ★ We `JSON.parse` and trust whatever
   Drive returns; a truncated/corrupt blob can poison local state on reconcile. Validate
   on load (hand-rolled or Zod); reject malformed blobs and keep the last-good copy.

---

## 🚀 LAUNCH on Etsy

Ship once all of the following are true:

- [ ] `todo-sync.md` golden path complete **and extensively tested** (sync is live but
      not yet hardened — this is the main gate).
- [ ] Tier-1 data-safety items above done.
- [ ] OAuth app published to production / verification confirmed, so buyers don't hit the
      "unverified app" warning or the 100-user cap.
- [ ] Smoke-tested end-to-end on a real purchase flow (sign in → edit → sync → reload on a
      second browser).

Everything below this line is **post-launch**.

---

## Post-launch — do ASAP

4. **Purchase-gated authentication.** Only people who bought on Etsy should be able to use
   the app. No paid database — get by with a free-tier or cheap KV store (e.g. Cloudflare
   Workers KV, Upstash Redis, Deno KV). Likely shape: issue/redeem a license key or code
   tied to the Etsy order, validated against the KV store; gate app entry on a valid
   redemption. Keep it local-first friendly (don't lock out an already-activated device
   when offline). Decide: per-key device limits, transfer/reset policy, and how keys are
   delivered to the buyer (Etsy digital download / message).

## Tier 2 — engineering foundations

5. **Test harness + first tests.** Already designed tests-first in `todo-sync.md`. Get
   Vitest in *before* any refactor so refactoring is safe. Highest-value targets:
   `googleDrive.js` (fetch boundary) and the reconcile / state-machine pure functions.
   *(Note: the sync-related subset of this is pulled earlier as part of the launch gate.)*

6. **CI pipeline.** One GitHub Actions workflow on PR: install → lint → typecheck → test →
   build. Netlify already deploys; CI just guards what reaches it. Do it once there's a
   test/lint to run.

7. **TypeScript — incremental.** Worth it, but *not* a big-bang conversion of the
   2,283-line `App.jsx`. Start with `checkJs` + JSDoc on the logic that matters, or write
   the new `src/sync.js` directly in `.ts`. The state-blob type is the one that actually
   prevents bugs. Convert working, tested code.

## Tier 3 — hygiene & polish

8. **ESLint + Prettier.** Vite ships neither. Catches real bugs (unused vars, missing
   `useEffect` deps — relevant to the save/pull effects).

9. **Break up `App.jsx`.** 2,283 lines is the real obstacle to testing and types.
   Extracting pure logic into `src/sync.js` (already planned in `todo-sync.md`) is the
   first cut.

10. **Env-var guardrail.** A missing `VITE_GOOGLE_CLIENT_ID` at build time silently
    degrades the app to local-only ("sync button does nothing" mystery). Add a build-time
    check or a visible banner.

11. **Dependency security.** `npm audit` in CI + Dependabot. Cheap, automatic.

12. **Error reporting.** No backend and no telemetry = blind to field crashes. A free-tier
    Sentry catches what tests don't.

13. **Accessibility & cross-browser.** Safari / iOS localStorage quirks especially matter
    for a mobile-used wedding app.
