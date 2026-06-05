# Sync — features to build

Convention: `intent` is `"sync"` | `"local"` | `null` (null = not chosen yet).
Priority: the **golden path** first — one user, chooses sync, single device, rock
solid. "Bonus polish" (multi-device / conflicts) comes after.

---

# Golden path

## Intent state + persistence

**Story.** The app must remember whether the user chose to sync, chose local-only, or
hasn't chosen yet. Today these are tangled in transient `connected`/`entered` booleans,
so "never chose" is indistinguishable from "chose local" — which makes the front door
and opt-out impossible to do cleanly.

**Instruction.** Create an `intent` store backed by its own localStorage key, with
get/set. Values are `"sync"` | `"local"` | `null`. Keep it separate from the state blob
and the Google connection keys.

**Definition of done.** A missing key reads as `null`. An unrecognized/corrupt stored
value normalizes to `null` (never a hidden 4th state). Setting a value persists it
across reload; setting the same value again is a harmless no-op. The key never collides
with the state-blob or connection keys.

## App sync state machine

**Story.** Behaviour must derive from two facts — the user's intent and whether we hold
a valid token — in one place, not scattered booleans. This is what lets
"opted-in-but-disconnected" be its own state instead of silently looking like
local-only.

**Instruction.** Create a pure `appSyncState(intent, hasValidToken)` returning
`FRONT_DOOR` | `LOCAL_ONLY` | `SYNCING` | `NEEDS_RECONNECT`.

**Definition of done.** `null` → FRONT_DOOR and `"local"` → LOCAL_ONLY regardless of
token. `"sync"` → SYNCING with a valid token, NEEDS_RECONNECT without one (never falls
back to LOCAL_ONLY). Pure function: no side effects, same input → same output.

## Front door wired to intent

**Story.** The welcome screen is currently gated by the transient `entered` flag, so a
reload doesn't respect the user's earlier choice. It should be gated by real intent.

**Instruction.** Render `WelcomeView` only when state === FRONT_DOOR. Wire "Sign in" to
set intent `"sync"` and "Continue without signing in" to set `"local"`. Remove the
`entered` boolean.

**Definition of done.** `null` intent shows the door; `"local"`/`"sync"` skip it on
reload with no re-prompt. Choosing an option sets intent and leaves the door
immediately. If sign-in is cancelled or fails, intent stays `null` (user remains on the
door with an error) — never left half-set.

## Save-state mini state machine

**Story.** A synced user needs to trust that a save actually landed. That requires a
single model of save status that both the indicator and the push engine read from.

**Instruction.** Create a save-state holding independent flags: `dirty`, `inFlight`,
`health` (`ok` | `error` | `offline`), `neverSynced`. Update them on edit, push start,
and push result.

**Definition of done.** An edit sets `dirty`; a push sets `inFlight`; success clears
`dirty`, sets `health=ok`, clears `neverSynced`; failure sets `health=error|offline`
and leaves `dirty` set. Offline edits queue and flush on reconnect with no loss. Rapid
edits coalesce into a single debounced push (~2.5s). `"local"` intent never pushes.
Flags are independent — `dirty` and `offline` can be true at once.

## Save-state indicator (UI element)

**Story.** Like a game's save icon, the user should always be able to glance and see
whether their work is safe.

**Instruction.** Add an always-visible indicator that purely maps the save-state flags
to a label/icon: inFlight→"Saving…", dirty&&!inFlight→"Unsaved changes",
offline→"Offline — will sync", error→"Sync error — reconnect", else→"Up to date ✓".

**Definition of done.** Each flag combination shows the correct label. `dirty`+`offline`
shows the offline message, not "Up to date". It appears in every signed-in view, updates
promptly on state change, and doesn't flicker during rapid (debounced) edits.

## Reconnect flow (NEEDS_RECONNECT)

**Story.** A token can die mid-session (1hr expiry, revoke, 401). Today the app silently
stops syncing with no prompt, so the user believes they're safe while nothing reaches
Drive.

**Instruction.** On `not_authenticated` mid-session, drop only the token and keep intent
`"sync"`, moving to NEEDS_RECONNECT. Surface a reconnect action that re-runs `signIn`
and resumes the pending push.

**Definition of done.** A 401 keeps intent `"sync"` (does not wipe it). The UI surfaces
a reconnect action. Reconnecting restores SYNCING and flushes the pending/dirty push.
Declining leaves local edits safe with the indicator showing the reconnect state. A
reload while in NEEDS_RECONNECT stays opted-in and retries a silent refresh — it does
not drop to the front door or to local-only.

## Settings sync panel

**Story.** The user needs one place to see and control how their data is stored.

**Instruction.** Build a settings panel showing current intent, and when `"sync"`: the
connection state, last sync time, and up-to-date vs dirty. Include a toggle to switch
between sync and local.

**Definition of done.** Status reflects the live sync/save state (including
NEEDS_RECONNECT). → local stops pushes and keeps the Drive file (with an optional
"delete cloud copy"). → sync runs signIn → pull → reconcile. Last-sync time updates
after each successful push. Toggling quickly doesn't double-push or corrupt state.

---

# Bonus polish (multi-device / conflicts)

## Device identity

**Story.** To detect which device wrote a save (the basis for conflict detection), each
device needs a stable id that does not travel inside the synced blob.

**Instruction.** Generate a `deviceId` once into its own localStorage key; expose it;
never include it in the pushed blob. Optional human `label`.

**Definition of done.** The id is stable across reloads and regenerated only if its key
is cleared. It is absent from the pushed JSON. Two different devices hold distinct ids.

## Conflict-aware reconcile (per-device rev map)

**Story.** Plain last-write-wins can silently drop a device's changes. We need to detect
true divergence rather than blindly overwrite.

**Instruction.** Add `writers: { [deviceId]: highestRev }` and
`lastWriter {deviceId,label,ts}` to the blob. Make reconcile classify the relationship:
local-ancestor (remote wins), remote-ancestor (local wins), neither → conflict (no
auto-clobber). Add a `conflict` save-state flag.

**Definition of done.** Fast-forward cases (one side an ancestor of the other) auto-
resolve to the correct side. Divergent writers raise `conflict` and clobber neither
blob. Null / first-time / equal cases are safe; the existing rev tiebreak still applies.
The writers map merges monotonically (max per device).

## Conflict resolution UI (id-keyed diff)

**Story.** When a conflict is detected, the user needs a way to keep their data instead
of losing a whole device's worth of edits.

**Instruction.** Diff the two blobs by item `id` (guests/vendors/categories/checklist).
Present added/removed/changed per list and let the user keep both or pick per item, then
produce a merged blob.

**Definition of done.** The diff accurately reports added/removed/changed items per
list. The chosen resolution yields the expected merged blob with bumped rev/writers.
Cancelling leaves both copies intact. A successful resolved push clears the `conflict`
flag.

---

# General / systematic tests (do last)

Vitest + @testing-library/react; fake timers for debounce; mock at the token boundary.

- googleDrive.js fetch-level: file exists → PATCH media (googleDrive.js:229); none →
  multipart POST parents:['appDataFolder'] (:254); 401 → not_authenticated (:202);
  list query targets spaces=appDataFolder.
- in-memory fake Drive: first push creates file, second updates same id.
- boot integration: prior connection → silentRefresh→pull→reconcile→SYNCING.
- `hydrate` — old saved blobs gain missing keys, arrays preserved.
