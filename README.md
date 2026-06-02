# Planourdays — Wedding Planner

A phone-first wedding planning web app: Home/couple profile, Budget, Checklist,
Vendors, Guests, and Seating. Built as a single React component, scaffolded with
Vite. **No backend, no secrets** — it's a static single-page app.

This README is written for the developer doing the first deploy. The non-technical
owner just needs a live URL back.

---

## Quick start (local)

```bash
npm install
npm run dev
```

Open the printed localhost URL. That's the whole app.

```bash
npm run build      # outputs to /dist
npm run preview    # serve the production build locally
```

---

## Deploy to Netlify (the goal of this handoff)

The app is 100% static, so deployment is trivial.

1. Push this folder to a new GitHub repo (see below).
2. In Netlify: **Add new site → Import an existing project → pick the repo.**
3. Netlify auto-detects the settings from `netlify.toml`:
   - Build command: `npm run build`
   - Publish directory: `dist`
4. Deploy. You'll get a URL like `planourdays.netlify.app`.

HTTPS is automatic — which the Google auth step later depends on.

### Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit: Planourdays"
git branch -M main
git remote add origin https://github.com/<you>/planourdays.git
git push -u origin main
```

---

## Architecture notes (important for the next phase)

### Storage adapter
All persistence goes through a single adapter interface in `src/App.jsx`:

```
storage.load()        -> state | null
storage.save(state)
```

Today it's local-first (localStorage, with an in-memory fallback). **Nothing else
in the app knows or cares where data lives**, so swapping/extending the backend is
isolated to this one place.

### Planned: local-first + debounced sync to Google Drive
The agreed model going forward:

- **Local is the source of truth for speed** — reads/writes hit the local copy
  instantly.
- **A debounced background sync** writes the whole state as a single JSON blob to
  the user's Google Drive.
- Store that JSON in the Drive **`appDataFolder`** (scope `drive.appdata`) — a
  hidden, per-app folder. It doesn't clutter the user's Drive, other apps can't
  see it, and it's a narrower permission than full Drive access (easier OAuth
  verification).

### Auth: OAuth with PKCE — no client secret
Because this is a static SPA, use the **OAuth 2.0 PKCE flow** with only the
**public Client ID**. There is no client secret in the codebase (and there must
never be one). Nothing sensitive ships to the browser.

Setup order (can only happen after deploy, because Google needs the live URL):
1. Create a Google Cloud project.
2. Enable the Google Drive API.
3. Create an OAuth Client ID (type: Web application).
4. Add the Netlify URL as an **Authorized JavaScript origin** and redirect URI.
5. Request the minimal scope: `https://www.googleapis.com/auth/drive.appdata`.
6. Wire the "Sign in with Google" button on the welcome screen to the PKCE flow,
   then add the Drive sync adapter alongside the existing local adapter.

The welcome screen and "Sign in with Google" button already exist in the UI as the
shell for this — currently they just enter the app.

### Possible later: Capacitor (native mobile app)
If wrapped with Capacitor for iOS/Android, swap the local adapter for native
storage (far more reliable than browser storage). Again, contained to the adapter.

---

## Project structure

```
planourdays/
├── index.html          # entry HTML
├── package.json
├── vite.config.js
├── netlify.toml        # Netlify build + SPA redirect config
├── .gitignore
└── src/
    ├── main.jsx        # mounts the app
    ├── App.jsx         # the entire app (one component, default export WeddingPlanner)
    └── index.css       # minimal reset
```

All app logic and styling lives in `src/App.jsx`.
