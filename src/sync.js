/* ============================================================
   SYNC CORE — intent store + sync state machine
   ------------------------------------------------------------
   Pure, framework-free logic that the app derives its sync
   behaviour from. Kept out of App.jsx so it can be unit-tested
   in isolation later (see todo-sync.md / todo-project.md).

   Two pieces live here:

   1. INTENT STORE — remembers the user's *choice* about how
      their data is stored:
        "sync"  -> chose to sync with Google Drive
        "local" -> chose local-only (no cloud)
        null    -> hasn't chosen yet (show the front door)
      Backed by its own localStorage key, kept separate from the
      state blob (wedding-planner-state-v2) and the Google
      connection key (planourdays-google-connection).

   2. appSyncState() — a pure function that turns (intent,
      hasValidToken) into the single state the UI reacts to.
   ============================================================ */

/* ---------- intent store ---------- */

// Its own key — must not collide with the state blob or the
// Google connection key.
export const INTENT_KEY = "planourdays-sync-intent";

// The only values ever written to storage.
const VALID_INTENTS = ["sync", "local"];

// Anything that isn't a recognised value collapses to null, so
// "never chose" and "corrupt stored value" both read as null —
// never a hidden 4th state.
function normalizeIntent(value) {
  return VALID_INTENTS.includes(value) ? value : null;
}

// Read the stored intent. Missing key, blocked storage, or a
// junk value all read as null.
export function getIntent() {
  try {
    return normalizeIntent(window.localStorage.getItem(INTENT_KEY));
  } catch {
    return null;
  }
}

// Persist the user's choice. Passing null (or anything invalid)
// clears the choice back to "not chosen yet". Writing the same
// value again is a harmless no-op.
export function setIntent(value) {
  const next = normalizeIntent(value);
  try {
    if (next === null) window.localStorage.removeItem(INTENT_KEY);
    else window.localStorage.setItem(INTENT_KEY, next);
  } catch {
    // Storage blocked (private mode / quota). Nothing else we can
    // do here; surfacing write failures is a separate to-do.
  }
  return next;
}

/* ---------- sync state machine ---------- */

// The four states the whole app derives its sync behaviour from.
export const FRONT_DOOR = "FRONT_DOOR"; // hasn't chosen — show welcome
export const LOCAL_ONLY = "LOCAL_ONLY"; // chose local, no cloud
export const SYNCING = "SYNCING"; // chose sync + we hold a valid token
export const NEEDS_RECONNECT = "NEEDS_RECONNECT"; // chose sync, token gone

// Pure: same inputs always give the same output, no side effects.
//   intent        -> "sync" | "local" | null
//   hasValidToken -> boolean
// A "sync" user with no valid token becomes NEEDS_RECONNECT — it
// must never silently fall back to LOCAL_ONLY.
export function appSyncState(intent, hasValidToken) {
  if (intent === "local") return LOCAL_ONLY;
  if (intent === "sync") return hasValidToken ? SYNCING : NEEDS_RECONNECT;
  return FRONT_DOOR; // null or anything unrecognised
}

/* ---------- save-state indicator ---------- */

// The starting flags for a synced session, before the first push
// lands. `dirty` = has unsaved edits; `inFlight` = a push is
// running; `health` = "ok" | "error" | "offline"; `neverSynced` =
// no successful push yet this session. The flags are independent —
// `dirty` and `offline` can both be true at once.
export const INITIAL_SAVE_STATE = {
  dirty: false,
  inFlight: false,
  health: "ok",
  neverSynced: true,
};

// Pure map from the save-state flags to what the indicator shows.
// Priority matters: a failed local save is the most serious (the plan
// isn't even safe on this device), so it outranks everything; then an
// in-flight push, offline, and error all outrank a plain "dirty", so a
// dirty+offline blob reads "Offline — will sync", never "Up to date".
//   tone -> a semantic colour key the UI maps to a dot colour.
export function saveStateLabel({ inFlight, dirty, health, storageError }) {
  if (storageError) return { label: "Couldn't save on this device", tone: "error" };
  if (inFlight) return { label: "Saving…", tone: "busy" };
  if (health === "offline") return { label: "Offline — will sync", tone: "warn" };
  if (health === "error") return { label: "Sync error — reconnect", tone: "error" };
  if (dirty) return { label: "Unsaved changes", tone: "dirty" };
  return { label: "Up to date ✓", tone: "ok" };
}
