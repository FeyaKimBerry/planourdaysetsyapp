# Google Drive Sync — Requirements & Decisions

Status: **planning only, no code written yet**
Date captured: 2026-06-02
Branch context: `feature/pdf-export` (sync work to come later)

## Verification progress tracker

Priority right now: **get OAuth verification done.** Update this as we go.

- [x] 1. Create Google Cloud project ("Planourdays")
- [x] 2. Configure OAuth consent screen (External + basic app info)
- [ ] 3. Publish Privacy Policy + have a Homepage on planourdays.com
      - Domain: **planourdays.com** (Namecheap registrar, DNS on Cloudflare)
      - Hosting: **existing Netlify project** (builds Vite app -> dist; SPA catch-all
        redirect /* -> /index.html). Decided AGAINST Cloudflare Pages to avoid a 2nd platform.
      - **Site structure (multi-page Vite build):**
        - `/`            -> `index.html`  = static marketing homepage (beautiful +
                            reviewer transparency section on Google Drive / drive.appdata
                            scope + Limited Use + privacy link). Top nav "Sign in" -> /login.
        - `/login`       -> `login.html`  = the React app (welcome/sign-in + planner).
                            Clean URL via netlify.toml redirect /login -> /login.html (200).
        - `/privacy.html`-> `public/privacy.html` = full privacy policy.
      - vite.config.js: multi-page input { main: index.html, login: login.html }.
      - netlify.toml: removed old SPA catch-all (app has no client-side router);
        added /login -> /login.html rewrite.
      - [x] Build verified locally (npm run build) -> dist has index/login/privacy.html.
      - [x] All changes committed + pushed to GitHub: FeyaKimBerry/planourdaysetsyapp (main).
            (Harness auto-commits/pushes; main == origin/main.)
      - [x] Logos added: public/logo.png (full, hero+login) and public/logo-mark.png
            (nav corners + top-left of all app pages). Nav/hero text removed per user.
      - [x] Terms of Service page added: public/terms.html -> /terms.html, linked in
            homepage footer + privacy page. (Governing law assumed = Australia; user to review.)
      - NOTE: Netlify project = "profound-vacherin-265735", deploys from GitHub,
        custom domain planourdays.com ALREADY connected + SSL secured. Domain step DONE.
        Consent screen URLs to use: home https://planourdays.com ,
        privacy https://planourdays.com/privacy.html , terms https://planourdays.com/terms.html
      - [ ] Confirm Netlify project is git-connected to that repo + latest deploy succeeded
      - [ ] Verify live: <site>.netlify.app  (/, /login, /privacy.html)
      - [ ] Connect custom domain planourdays.com to the Netlify site
            (add CNAME/A record in Cloudflare DNS pointing at Netlify)
      - Live URLs needed: https://planourdays.com  and  https://planourdays.com/privacy.html
      - Note: local dev (npm run dev) serves the app at /login.html; the clean /login
        URL is provided by Netlify in production.
- [ ] 3b. Update consent screen support/contact email to plannerstorebymaki@gmail.com
      (next time in Cloud Console → Branding. Note: the signed-in account must own
      or be allowed to use that address; may need to add it as a project user first.
      Landing pages already use plannerstorebymaki@gmail.com as of 2026-06-02.)
- [ ] 4. Verify domain ownership in Google Search Console
- [ ] 5. Add `drive.appdata` scope to the consent screen
- [ ] 6. Add self as test user (for pre-verification testing)
- [ ] 7. Record a demo video showing the scope in use (needed for submission)
- [ ] 8. Submit for verification
- [ ] 9. Respond to any Google reviewer follow-ups

(Steps 1–3 are the immediate focus. 5–8 come once the app/code exists.)

## Goal

Move from local-only persistence to production-ready cross-device sync by
replicating the app's single JSON state blob to the user's **Google Drive**,
debounced. Keep the app **local-first**: localStorage stays the instant,
offline source of truth; Drive is background replication.

## Product / business constraints

- Sold on Etsy at a **fixed one-time price**. No recurring revenue, so the
  solution must avoid recurring/scaling costs.
- **Backend: not now.** A backend may be added later, but **only if it can stay
  near zero-cost** (e.g. free-tier serverless). Initial release is pure
  client-side.

## OAuth scope

- Use **`https://www.googleapis.com/auth/drive.appdata`** only — the hidden,
  per-app `appDataFolder`. App cannot see/touch any other user files; user
  cannot see the folder. Least privilege.
- This is a Google **"sensitive" scope** → requires OAuth consent screen
  verification for production (otherwise "unverified app" warning + 100-user
  cap).

## Key constraint: token persistence (pure client-side)

- Browser-only OAuth (Google Identity Services token flow) issues access tokens
  that **expire in ~1 hour** and provides **no refresh token** (refresh tokens
  require a confidential/server-side client).
- "Don't log the user out" is implemented via **silent token refresh**:
  on load, call `requestAccessToken({ prompt: '' })`. Returns a fresh token with
  no UI as long as the Google session is alive and consent was previously
  granted. Re-prompts only if access is revoked or the Google session dies.
- Persist **connection state + last token/expiry in localStorage**.
- Security note: tokens in localStorage are exposed to XSS. Acceptable for this
  low-sensitivity app with an appdata-only scope.
- True long-lived "never reauth" sessions would require the later backend
  (refresh-token flow).

## Decisions (locked)

1. **Backend:** None for initial release. Add later *only* if near zero-cost.
   Pure client-side (silent refresh, occasional reauth) for now.
2. **Conflict resolution:** **Last-write-wins** via an `updatedAt` timestamp
   (plus a monotonic `rev` counter) stored in the state. Pull reconciles by
   comparing timestamps.
3. **"Continue without signing in":** Keep it, but:
   - "Sign in with Google" is the **big main CTA**.
   - The alternative is a **small text link** only.
   - Clicking it shows a **modal warning** that local-only is not recommended
     (data won't sync / could be lost).
4. **Verification:** Pursue **real OAuth consent-screen verification ASAP**
   (needed because `drive.appdata` is a sensitive scope).

## Architecture

Keep local-first; add sync as a layer (do NOT replace `LocalStorageAdapter`):

1. **On startup (after auth):** pull remote JSON → reconcile with local
   (last-write-wins) → hydrate.
2. **On state change:** save to localStorage immediately (as today) +
   **debounced push** to Drive (~2–3s after last edit).
3. **On window focus / interval:** optionally re-pull to catch other-device edits.
4. **Offline:** localStorage keeps working; queue the push for when online.

## Drive REST mechanics (no `gapi` client lib)

Use Google Identity Services only for the token, then plain `fetch` against the
Drive REST API. Only new external dependency: the GIS script tag.

- **Find file:** `GET files?spaces=appDataFolder&q=name='planourdays.json'`
- **Create:** multipart upload with `parents: ['appDataFolder']`
- **Update:** `PATCH` media upload by `fileId`
- **Download:** `GET files/{id}?alt=media`

## Implementation gameplan (when we start)

1. **Google Cloud Console setup:** create project → OAuth consent screen →
   OAuth Client ID (type *Web application*) → authorized JS origins
   (localhost + prod domain) → add `drive.appdata` scope. Begin verification.
2. **Auth module:** load GIS; `signIn()` (interactive), `silentRefresh()`
   (on load), `signOut()`. Persist connection state + last token/expiry in
   localStorage.
3. **Drive sync module:** `pull()`, `push(state)` against appDataFolder, with
   find-or-create logic.
4. **Wire into root:** replace in-memory `entered` flag
   ([App.jsx:294](../src/App.jsx)) with real auth state; attempt silent refresh
   on mount; show `WelcomeView` only if not connected.
5. **Welcome screen rework** ([App.jsx:393](../src/App.jsx)): big Google CTA;
   small "continue without signing in" text link + warning modal.
6. **Sync glue:** debounced push in the existing
   `useEffect(() => storage.save(state), [state])` ([App.jsx:296](../src/App.jsx));
   pull-and-reconcile on startup; optional focus re-pull.
7. **State shape:** add `updatedAt` + `rev` to the persisted state; extend
   `hydrate()` to handle them.
8. **UX:** sync status indicator (synced / syncing / offline / error).

## Codebase touchpoints

- Storage adapter layer: [src/App.jsx:33-59](../src/App.jsx)
- `entered` gate: [src/App.jsx:294-307](../src/App.jsx)
- Save effect: [src/App.jsx:296-298](../src/App.jsx)
- `WelcomeView` (sign-in UI): [src/App.jsx:393-417](../src/App.jsx)
- `hydrate()` (state migration): [src/App.jsx:246-261](../src/App.jsx)
