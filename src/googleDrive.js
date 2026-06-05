/* ============================================================
   GOOGLE DRIVE SYNC  (Stage B)
   ------------------------------------------------------------
   Pure client-side OAuth + Drive REST. No backend, no client
   secret. Uses Google Identity Services (GIS) for an access
   token, then plain fetch() against the Drive REST API.

   Scope: drive.appdata ONLY — a hidden, per-app folder. The app
   can't see any other Drive file and the user can't see this
   folder in their Drive. This is the least-privilege scope and
   the one Planourdays is being OAuth-verified for.

   The app stores its whole state as a single JSON file
   ("planourdays.json") inside that appDataFolder.

   Public API:
     isConfigured()    -> bool   (is a Client ID present?)
     isConnected()     -> bool   (has the user connected Drive before?)
     getConnection()   -> { connected, email? } | null
     signIn()          -> token  (interactive — shows Google consent)
     silentRefresh()   -> token | null  (no UI; reuses live session)
     signOut()         -> void   (revoke + forget)
     pull()            -> state | null   (read the Drive copy)
     push(state)       -> void           (write the Drive copy)
   ============================================================ */

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";
const SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const FILE_NAME = "planourdays.json";
const GIS_SRC = "https://accounts.google.com/gsi/client";
const CONN_KEY = "planourdays-google-connection";

const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

/* ---------- connection state (localStorage) ---------- */

export function getConnection() {
  try {
    return JSON.parse(window.localStorage.getItem(CONN_KEY)) || null;
  } catch {
    return null;
  }
}

function setConnection(patch) {
  const next = { ...(getConnection() || {}), ...patch };
  try {
    window.localStorage.setItem(CONN_KEY, JSON.stringify(next));
  } catch {}
  return next;
}

function clearConnection() {
  try {
    window.localStorage.removeItem(CONN_KEY);
  } catch {}
}

function saveToken(token, expiresIn) {
  // Refresh a minute early so a token never expires mid-request.
  setConnection({
    connected: true,
    token,
    expiry: Date.now() + (Number(expiresIn || 3600) - 60) * 1000,
  });
}

function liveToken() {
  const c = getConnection();
  if (c && c.token && c.expiry && Date.now() < c.expiry) return c.token;
  return null;
}

export function isConfigured() {
  return !!CLIENT_ID;
}

export function isConnected() {
  return !!(getConnection() && getConnection().connected);
}

/* ---------- Google Identity Services loader ---------- */

let gisPromise = null;

function loadGis() {
  if (window.google && window.google.accounts && window.google.accounts.oauth2) {
    return Promise.resolve();
  }
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = GIS_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => {
      gisPromise = null;
      reject(new Error("Could not load Google sign-in. Check your connection."));
    };
    document.head.appendChild(s);
  });
  return gisPromise;
}

/* ---------- token client (one shared instance) ---------- */

let tokenClient = null;
let pending = null; // { resolve, reject } for the in-flight requestAccessToken

async function ensureTokenClient() {
  if (!CLIENT_ID) {
    throw new Error(
      "Google sign-in isn't configured yet (missing VITE_GOOGLE_CLIENT_ID)."
    );
  }
  await loadGis();
  if (!tokenClient) {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: (resp) => {
        const p = pending;
        pending = null;
        if (!p) return;
        if (resp && resp.error) {
          p.reject(new Error(resp.error));
          return;
        }
        saveToken(resp.access_token, resp.expires_in);
        p.resolve(resp.access_token);
      },
      error_callback: (err) => {
        const p = pending;
        pending = null;
        if (p) p.reject(new Error((err && err.type) || "auth_failed"));
      },
    });
  }
  return tokenClient;
}

// prompt: 'consent' = interactive (first connect); '' = silent (reuse session).
function requestToken(prompt) {
  return new Promise((resolve, reject) => {
    ensureTokenClient()
      .then((client) => {
        pending = { resolve, reject };
        client.requestAccessToken({ prompt });
      })
      .catch(reject);
  });
}

/* ---------- public auth API ---------- */

export async function signIn() {
  const token = await requestToken("consent");
  return token;
}

// Returns a token with NO user interaction if the Google session is alive and
// consent was already granted. Returns null instead of throwing on failure, so
// callers can quietly fall back to "needs sign-in".
export async function silentRefresh() {
  if (!isConnected()) return null;
  const cached = liveToken();
  if (cached) return cached;
  try {
    return await requestToken("");
  } catch {
    return null;
  }
}

export function signOut() {
  const c = getConnection();
  if (c && c.token && window.google && window.google.accounts) {
    try {
      window.google.accounts.oauth2.revoke(c.token, () => {});
    } catch {}
  }
  clearConnection();
}

// Internal: a valid token or throw a recoverable "needs sign-in" error.
async function getToken() {
  const cached = liveToken();
  if (cached) return cached;
  const refreshed = await silentRefresh();
  if (refreshed) return refreshed;
  throw new Error("not_authenticated");
}

/* ---------- Drive REST ---------- */

async function findFileId(token) {
  const q = encodeURIComponent(`name='${FILE_NAME}'`);
  const url = `${DRIVE_FILES}?spaces=appDataFolder&q=${q}&fields=files(id)`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    clearConnection();
    throw new Error("not_authenticated");
  }
  if (!res.ok) throw new Error("drive_list_failed");
  const data = await res.json();
  return data.files && data.files[0] ? data.files[0].id : null;
}

// Read the saved plan from Drive. null = no file there yet.
export async function pull() {
  const token = await getToken();
  const id = await findFileId(token);
  if (!id) return null;
  const res = await fetch(`${DRIVE_FILES}/${id}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("drive_download_failed");
  return await res.json();
}

// Write the plan to Drive (create on first push, update thereafter).
export async function push(state) {
  const token = await getToken();
  const id = await findFileId(token);
  const body = JSON.stringify(state);

  if (id) {
    const res = await fetch(`${DRIVE_UPLOAD}/${id}?uploadType=media`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body,
    });
    if (!res.ok) throw new Error("drive_update_failed");
    return;
  }

  // Create: multipart so we can set parents:['appDataFolder'] alongside content.
  const boundary = "planourdays_" + Date.now();
  const metadata = { name: FILE_NAME, parents: ["appDataFolder"] };
  const multipart =
    `--${boundary}\r\n` +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    "Content-Type: application/json\r\n\r\n" +
    `${body}\r\n` +
    `--${boundary}--`;

  const res = await fetch(`${DRIVE_UPLOAD}?uploadType=multipart`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body: multipart,
  });
  if (!res.ok) throw new Error("drive_create_failed");
}
