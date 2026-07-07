import React, { useState, useEffect, useCallback, useRef } from "react";
import * as drive from "./googleDrive";
import { getIntent, setIntent, appSyncState, FRONT_DOOR, NEEDS_RECONNECT, INITIAL_SAVE_STATE, saveStateLabel } from "./sync";

/* ============================================================
   STORAGE ADAPTER LAYER
   ------------------------------------------------------------
   The whole app talks ONLY to this `storage` interface:
       storage.load()  -> state | null
       storage.save(state)
   Swapping backends never touches app code. That's the
   future-proofing — the Google Sheets adapter slots in here.

   STAGE A (now): persist to the browser's localStorage so data
   survives reloads and revisits on the same device. Falls back
   to in-memory where localStorage is blocked (sandboxed preview).

   STAGE B (later): const storage = GoogleSheetsAdapter; — same
   load()/save() shape, data lives in the user's own Sheet.
   ============================================================ */

export const STORAGE_KEY = "wedding-planner-state-v2";

function localStorageAvailable() {
  try {
    const t = "__probe__";
    window.localStorage.setItem(t, "1");
    window.localStorage.removeItem(t);
    return true;
  } catch {
    return false;
  }
}

const LocalStorageAdapter = {
  load() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  // Returns true on success, false if the write was rejected (quota
  // exceeded, private mode, storage disabled) so the caller can tell the
  // user instead of silently pretending the save landed.
  save(state) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch {
      return false;
    }
  },
};

const MemoryAdapter = {
  load() {
    return typeof window !== "undefined" ? window.__weddingPlanner || null : null;
  },
  save(state) {
    if (typeof window !== "undefined") window.__weddingPlanner = state;
    return true;
  },
};

const PERSISTS = typeof window !== "undefined" && localStorageAvailable();
const storage = PERSISTS ? LocalStorageAdapter : MemoryAdapter;

/* ============================================================
   DEFAULTS
   ============================================================ */

const DEFAULT_TOTAL = 30000;

const PRESET_CATEGORIES = [
  { id: "venue", name: "Venue & Rentals", pct: 0.4 },
  { id: "catering", name: "Catering & Drinks", pct: 0.2 },
  { id: "photo", name: "Photography & Video", pct: 0.12 },
  { id: "attire", name: "Attire & Beauty", pct: 0.08 },
  { id: "flowers", name: "Flowers & Decor", pct: 0.08 },
  { id: "music", name: "Music & Entertainment", pct: 0.05 },
  { id: "stationery", name: "Stationery & Favors", pct: 0.04 },
  { id: "misc", name: "Miscellaneous", pct: 0.03 },
];

// Time buckets for the checklist, ordered far-out -> the day -> after.
const CHECKLIST_BUCKETS = [
  {
    id: "12mo",
    label: "12+ Months Before",
    tasks: [
      "Set your overall budget",
      "Draft a rough guest list",
      "Choose & book your venue",
      "Pick a wedding date",
      "Research & shortlist photographers",
    ],
  },
  {
    id: "9mo",
    label: "9 Months Before",
    tasks: [
      "Book photographer & videographer",
      "Book caterer / confirm venue catering",
      "Start dress / attire shopping",
      "Book entertainment (band or DJ)",
      "Reserve a block of hotel rooms for guests",
    ],
  },
  {
    id: "6mo",
    label: "6 Months Before",
    tasks: [
      "Send save-the-dates",
      "Order invitations",
      "Book florist",
      "Plan ceremony details & officiant",
      "Arrange transportation",
    ],
  },
  {
    id: "3mo",
    label: "3 Months Before",
    tasks: [
      "Finalize the menu & cake tasting",
      "Mail invitations",
      "Buy wedding rings",
      "Schedule hair & makeup trials",
      "Write your vows",
    ],
  },
  {
    id: "1mo",
    label: "1 Month Before",
    tasks: [
      "Confirm final guest count",
      "Confirm details with all vendors",
      "Create seating chart",
      "Final dress fitting",
      "Apply for marriage license",
    ],
  },
  {
    id: "1wk",
    label: "1 Week Before",
    tasks: [
      "Give final headcount to caterer",
      "Pack for the honeymoon",
      "Prepare vendor final payments & tips",
      "Confirm day-of timeline with party",
      "Rehearsal & rehearsal dinner",
    ],
  },
  {
    id: "after",
    label: "After the Wedding",
    tasks: [
      "Send thank-you cards",
      "Return any rentals",
      "Preserve the dress & bouquet",
      "Review & tip vendors online",
      "Change name / update documents (if applicable)",
    ],
  },
];

function makeInitialState() {
  return {
    // Sync bookkeeping for last-write-wins reconciliation across devices.
    updatedAt: 0,
    rev: 0,
    partner1: "",
    partner2: "",
    weddingDate: "",
    venue: "",
    vision: "",
    photos: [],
    currency: "AUD",
    tables: [],
    total: DEFAULT_TOTAL,
    categories: PRESET_CATEGORIES.map((c) => ({
      id: c.id,
      name: c.name,
      allocated: Math.round(DEFAULT_TOTAL * c.pct),
      expenses: [],
    })),
    checklist: CHECKLIST_BUCKETS.map((b) => ({
      id: b.id,
      label: b.label,
      tasks: b.tasks.map((name) => ({
        id: uid(),
        name,
        done: false,
        due: "",
        note: "",
      })),
    })),
    vendors: [],
    guests: [],
    venues: [],
    mealOptions: ["Chicken", "Beef", "Fish", "Vegetarian", "Vegan", "Kids", "Other"],
    groupOptions: ["Bride's family", "Groom's family", "Bride's friends", "Groom's friends", "Work", "Other"],
  };
}

/* ============================================================
   HELPERS
   ============================================================ */

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

// Locale hint per currency so symbols render naturally (A$, $, £, €…).
const CURRENCIES = {
  AUD: { label: "Australian Dollar (A$)", locale: "en-AU" },
  USD: { label: "US Dollar ($)", locale: "en-US" },
  NZD: { label: "New Zealand Dollar (NZ$)", locale: "en-NZ" },
  GBP: { label: "British Pound (£)", locale: "en-GB" },
  EUR: { label: "Euro (€)", locale: "en-IE" },
  CAD: { label: "Canadian Dollar (C$)", locale: "en-CA" },
  SGD: { label: "Singapore Dollar (S$)", locale: "en-SG" },
  HKD: { label: "Hong Kong Dollar (HK$)", locale: "en-HK" },
  JPY: { label: "Japanese Yen (¥)", locale: "ja-JP" },
  CNY: { label: "Chinese Yuan (¥)", locale: "zh-CN" },
  INR: { label: "Indian Rupee (₹)", locale: "en-IN" },
  KRW: { label: "South Korean Won (₩)", locale: "ko-KR" },
  PHP: { label: "Philippine Peso (₱)", locale: "en-PH" },
  THB: { label: "Thai Baht (฿)", locale: "th-TH" },
  MYR: { label: "Malaysian Ringgit (RM)", locale: "ms-MY" },
  IDR: { label: "Indonesian Rupiah (Rp)", locale: "id-ID" },
  VND: { label: "Vietnamese Dong (₫)", locale: "vi-VN" },
  AED: { label: "UAE Dirham (د.إ)", locale: "ar-AE" },
  SAR: { label: "Saudi Riyal (﷼)", locale: "ar-SA" },
  CHF: { label: "Swiss Franc (CHF)", locale: "de-CH" },
  ZAR: { label: "South African Rand (R)", locale: "en-ZA" },
  MXN: { label: "Mexican Peso (Mex$)", locale: "es-MX" },
  BRL: { label: "Brazilian Real (R$)", locale: "pt-BR" },
};

// Current currency is kept in sync by the root component each render, so every
// existing fmt(n) call across the app reflects the user's choice with no plumbing.
let CURRENT_CURRENCY = "AUD";

const fmt = (n) => {
  const cur = CURRENCIES[CURRENT_CURRENCY] ? CURRENT_CURRENCY : "AUD";
  return new Intl.NumberFormat(CURRENCIES[cur].locale, {
    style: "currency",
    currency: cur,
    maximumFractionDigits: 0,
  }).format(isNaN(n) ? 0 : n);
};

const catSpent = (cat) =>
  cat.expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);

// Merge any missing top-level keys so old saved data still works.
function hydrate(loaded) {
  const base = makeInitialState();
  if (!loaded) return base;
  return {
    ...base,
    ...loaded,
    updatedAt: loaded.updatedAt || base.updatedAt,
    rev: loaded.rev || base.rev,
    categories: loaded.categories || base.categories,
    checklist: loaded.checklist || base.checklist,
    vendors: loaded.vendors || base.vendors,
    guests: loaded.guests || base.guests,
    venues: loaded.venues || base.venues,
    mealOptions: loaded.mealOptions || base.mealOptions,
    groupOptions: loaded.groupOptions || base.groupOptions,
    currency: loaded.currency || base.currency,
    tables: loaded.tables || base.tables,
  };
}

// The list fields the app iterates over; if any exist but aren't arrays,
// the blob is malformed and would crash a view (or poison local state).
const STATE_ARRAY_FIELDS = ["categories", "checklist", "vendors", "guests", "venues", "tables", "mealOptions", "groupOptions"];

// Guards the load boundary. A truncated/corrupt blob from Drive (or a
// bad backup file) must NOT be trusted: parses fine as JSON but has the
// wrong shape. Returns false for anything we can't safely hydrate.
export function isValidStateBlob(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  for (const f of STATE_ARRAY_FIELDS) {
    if (obj[f] != null && !Array.isArray(obj[f])) return false;
  }
  // reconcile compares these numerically; reject non-number values.
  if (obj.updatedAt != null && typeof obj.updatedAt !== "number") return false;
  if (obj.rev != null && typeof obj.rev !== "number") return false;
  return true;
}

// Validate a pulled blob, then hydrate it. An invalid blob becomes null
// so reconcile keeps the last-good local copy instead of clobbering it.
function hydrateRemote(remote) {
  if (!isValidStateBlob(remote)) return null;
  return hydrate(remote);
}

// Last-write-wins: newer updatedAt wins; rev breaks same-timestamp ties.
// If remote looks empty (no names, guests, vendors) but local has real data, always keep local.
function hasRealData(s) {
  return !!(s && (s.partner1 || s.partner2 || s.weddingDate || (s.guests && s.guests.length > 0) || (s.vendors && s.vendors.length > 0)));
}

function reconcile(local, remote) {
  if (!remote) return local;
  if (!local) return remote;
  // Never overwrite real local data with an empty remote
  if (hasRealData(local) && !hasRealData(remote)) return local;
  const lu = local.updatedAt || 0;
  const ru = remote.updatedAt || 0;
  if (ru > lu) return remote;
  if (ru < lu) return local;
  return (remote.rev || 0) > (local.rev || 0) ? remote : local;
}

const RSVP_STATUSES = ["Invited", "Yes", "No", "Maybe"];

// Total people coming = each "Yes" guest's party size (min 1).
function headcount(guests) {
  return guests
    .filter((g) => g.rsvp === "Yes")
    .reduce((s, g) => s + Math.max(1, Number(g.party) || 1), 0);
}

const VENDOR_STATUSES = ["Researching", "Contacted", "Booked"];

// All expenses across the budget that belong to a given vendor.
function vendorExpenses(state, vendorId) {
  const out = [];
  for (const c of state.categories) {
    for (const e of c.expenses) {
      if (e.vendorId === vendorId) out.push({ ...e, catId: c.id });
    }
  }
  return out;
}

/* ============================================================
   ROOT — shell + bottom nav
   ============================================================ */

// Save indicator — always visible for a synced user, like a game's
// save icon. Purely maps the save-state flags to a label + a small
// coloured dot so a glance tells them their work is safe.
const SAVE_TONE_COLOR = {
  busy: "#b07a72",   // saving in progress
  ok: "#5c7a59",     // up to date
  dirty: "#b07a72",  // unsaved edits
  warn: "#b8862f",   // offline
  error: "#b0524a",  // sync error
};

function SaveIndicator({ saveState }) {
  const { label, tone } = saveStateLabel(saveState);
  const color = SAVE_TONE_COLOR[tone] || "#7a655f";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, flex: "none" }} />
      <span>{label}</span>
    </span>
  );
}

// Shown when the Google session lapsed mid-use (NEEDS_RECONNECT). The
// user's edits are safe locally; this offers a one-tap re-consent that
// resumes syncing. Dismissing it just leaves them in local-safe mode.
function ReconnectBanner({ busy, onReconnect }) {
  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
        background: "#fbecd8", borderBottom: "1px solid #f0d9b3",
        color: "#7a5a1e", padding: "10px 16px", fontSize: 14,
      }}
    >
      <span style={{ flex: 1, minWidth: 180 }}>
        Your Google session ended. Your changes are saved on this device — reconnect to sync them.
      </span>
      <button
        onClick={onReconnect}
        disabled={busy}
        style={{
          border: "none", borderRadius: 999, padding: "8px 18px",
          background: "#b07a72", color: "#fff", fontWeight: 600, fontSize: 14,
          cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1, flex: "none",
        }}
      >
        {busy ? "Reconnecting…" : "Reconnect"}
      </button>
    </div>
  );
}

// Brief splash while we silently restore a previous Google session on load.
function BootingView() {
  return (
    <div style={S.welcomePage}>
      <style>{CSS}</style>
      <div style={{ ...S.welcomeInner, opacity: 0.9 }}>
        <img src="/logo.png" alt="Planourdays" style={{ width: 160, maxWidth: "60%", height: "auto", display: "block", margin: "0 auto 18px" }} />
        <p style={S.welcomeTag}>Reconnecting your plan…</p>
      </div>
    </div>
  );
}

const GUIDE_KEY = "planourdays-guide-seen";
const SIGNED_OUT_KEY = "planourdays-signed-out";
const LAST_SYNC_KEY = "planourdays-last-sync";

/* ------------------------------------------------------------
   PURCHASE GATE (launch: single shared password from the PDF)
   The buyer types the password printed in their download PDF.
   On a match we store a one-time local "activated" record and
   never ask again on this device (works offline forever after).
   ------------------------------------------------------------ */
const ACTIVATED_KEY = "planourdays-activated";

// Forgive spaces / "#" / casing so a buyer can't fail on formatting.
function normalizeCode(s) {
  return String(s || "").replace(/[\s#]/g, "").toUpperCase();
}

// Valid password(s) come from a build-time env var so it can be changed
// in Netlify without a code edit. Comma-separated allows accepting an old
// AND a new password during a rotation. Falls back to a default if unset.
const ACCESS_PASSWORDS = (import.meta.env.VITE_ACCESS_PASSWORD || "POD-6MCT-ZJBJ")
  .split(",")
  .map(normalizeCode)
  .filter(Boolean);

function isActivated() {
  try { return window.localStorage.getItem(ACTIVATED_KEY) === "1"; } catch { return false; }
}
function markActivated() {
  try { window.localStorage.setItem(ACTIVATED_KEY, "1"); } catch {}
}

const GUIDE_SLIDES = [
  {
    emoji: "🤍",
    title: "Welcome to Planourdays",
    body: "Your calm, all-in-one wedding planner. Here's a quick tour of everything you can do — it only takes a minute!",
  },
  {
    emoji: "🏠",
    title: "Home",
    body: "Add your names, wedding date, venue and a vision note. Upload a photo of the two of you — it becomes your banner. The countdown ticks down to your big day.",
  },
  {
    emoji: "💰",
    title: "Budget",
    body: "Set your total budget and track spending by category (Venue, Catering, Photography and more). Log expenses as Paid or Upcoming so you always know what's left.",
  },
  {
    emoji: "🏛️",
    title: "Venues",
    body: "Add venues you're considering and compare them side by side — price, capacity, catering, pros and cons. Tick one and it automatically appears in your Budget and Vendors.",
  },
  {
    emoji: "📋",
    title: "Checklist",
    body: "A timeline of tasks from 12+ months out all the way to after the wedding. Tick things off as you go, add due dates and notes to any task.",
  },
  {
    emoji: "🤝",
    title: "Vendors",
    body: "Keep track of your photographer, florist, caterer and every other vendor. Log their status (Researching → Contacted → Booked), contracted amount and payments.",
  },
  {
    emoji: "💌",
    title: "Guests",
    body: "Build your guest list, track RSVPs (Yes / No / Maybe), party sizes, meal choices and groups. Your caterer headcount updates automatically.",
  },
  {
    emoji: "🪑",
    title: "Seating",
    body: "Create tables and assign guests with a tap. Unseated guests stay in a tray at the bottom — tap a guest then tap a table to seat them.",
  },
  {
    emoji: "☁️",
    title: "Sync & backup",
    body: "Sign in with Google to sync your plan across all your devices. You can also export a backup file or a printable PDF from Settings anytime.",
  },
];

const SETUP_KEY = "planourdays-setup-seen";

const SETUP_STEPS = [
  { key: "names",    emoji: "💑", title: "First, who's getting married?",     hint: "These names appear on your home page and PDF export." },
  { key: "date",     emoji: "📅", title: "When's the big day?",               hint: "We'll count down the days for you." },
  { key: "budget",   emoji: "💰", title: "What's your total wedding budget?", hint: "You can always change this later in the Budget tab." },
  { key: "venue",    emoji: "🏛️", title: "Do you have a venue in mind?",      hint: "Optional — skip if you haven't decided yet." },
];

function SetupWizard({ onFinish, onSkipAll }) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState({ partner1: "", partner2: "", weddingDate: "", total: "", currency: "AUD", venue: "" });
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const total = SETUP_STEPS.length;
  const s = SETUP_STEPS[step];
  const isLast = step === total - 1;

  const canNext = () => {
    if (s.key === "names") return draft.partner1.trim() !== "";
    if (s.key === "date") return draft.weddingDate !== "";
    if (s.key === "budget") return draft.total !== "" && Number(draft.total) > 0;
    return true; // venue is optional
  };

  const handleNext = () => {
    if (isLast) { onFinish(draft); return; }
    setStep(step + 1);
  };

  return (
    <div style={S.guideOverlay}>
      <div style={S.guideCard}>
        <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", color: "#c4aaa4", marginBottom: 18 }}>
          Step {step + 1} of {total}
        </div>

        <div style={S.guideEmoji}>{s.emoji}</div>
        <h2 style={S.guideTitle}>{s.title}</h2>
        <p style={{ ...S.guideBody, marginBottom: 18 }}>{s.hint}</p>

        {/* Step inputs */}
        {s.key === "names" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 22 }}>
            <input style={S.setupInput} placeholder="Partner 1 name" value={draft.partner1}
              onChange={(e) => set({ partner1: e.target.value })} autoFocus />
            <input style={S.setupInput} placeholder="Partner 2 name (optional)" value={draft.partner2}
              onChange={(e) => set({ partner2: e.target.value })} />
          </div>
        )}

        {s.key === "date" && (
          <div style={{ marginBottom: 22 }}>
            <input type="date" style={S.setupInput} value={draft.weddingDate}
              onChange={(e) => set({ weddingDate: e.target.value })} />
          </div>
        )}

        {s.key === "budget" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 22 }}>
            <div style={{ display: "flex", alignItems: "center", background: "#fbf6f3", borderRadius: 12, padding: "12px 16px", border: "1px solid #f0e2dd" }}>
              <span style={{ color: "#b58e87", fontSize: 20, marginRight: 6 }}>$</span>
              <input type="number" inputMode="numeric" style={{ ...S.setupInput, background: "transparent", border: "none", padding: 0, fontSize: 22, fontWeight: 600 }}
                placeholder="30000" value={draft.total} onChange={(e) => set({ total: e.target.value })} autoFocus />
            </div>
            <select style={{ ...S.setupInput, color: "#3a2e2c" }} value={draft.currency}
              onChange={(e) => set({ currency: e.target.value })}>
              {Object.entries(CURRENCIES).map(([code, info]) => (
                <option key={code} value={code}>{info.label}</option>
              ))}
            </select>
          </div>
        )}

        {s.key === "venue" && (
          <div style={{ marginBottom: 22 }}>
            <input style={S.setupInput} placeholder="e.g. The Botanical Gardens" value={draft.venue}
              onChange={(e) => set({ venue: e.target.value })} autoFocus />
          </div>
        )}

        {/* Progress dots */}
        <div style={S.guideDots}>
          {SETUP_STEPS.map((_, i) => (
            <div key={i} style={{ ...S.guideDot, background: i <= step ? "#c98b94" : "#f0e2dd", cursor: "default" }} />
          ))}
        </div>

        <div style={S.guideBtnRow}>
          {step > 0 && (
            <button style={S.guideBack} onClick={() => setStep(step - 1)}>Back</button>
          )}
          <button style={{ ...S.guideNext, opacity: canNext() || s.key === "venue" ? 1 : 0.5 }} onClick={handleNext}>
            {isLast ? "All done!" : "Next"}
          </button>
        </div>

        <div style={{ display: "flex", justifyContent: "center", gap: 16, marginTop: 14 }}>
          <button style={{ background: "none", border: "none", color: "#c4aaa4", fontSize: 13, cursor: "pointer" }}
            onClick={handleNext}>
            Skip this step
          </button>
          <span style={{ color: "#f0e2dd", fontSize: 13 }}>·</span>
          <button style={{ background: "none", border: "none", color: "#c4aaa4", fontSize: 13, cursor: "pointer" }}
            onClick={onSkipAll}>
            Fill in myself
          </button>
        </div>
      </div>
    </div>
  );
}

function GuideModal({ onClose }) {
  const [slide, setSlide] = useState(0);
  const total = GUIDE_SLIDES.length;
  const s = GUIDE_SLIDES[slide];
  const isLast = slide === total - 1;

  return (
    <div style={S.guideOverlay}>
      <div style={S.guideCard}>
        <button style={S.guideClose} onClick={onClose}>×</button>

        <div style={S.guideEmoji}>{s.emoji}</div>
        <h2 style={S.guideTitle}>{s.title}</h2>
        <p style={S.guideBody}>{s.body}</p>

        <div style={S.guideDots}>
          {GUIDE_SLIDES.map((_, i) => (
            <button key={i} onClick={() => setSlide(i)}
              style={{ ...S.guideDot, background: i === slide ? "#c98b94" : "#f0e2dd" }} />
          ))}
        </div>

        <div style={S.guideBtnRow}>
          {slide > 0 && (
            <button style={S.guideBack} onClick={() => setSlide(slide - 1)}>Back</button>
          )}
          <button style={S.guideNext} onClick={() => isLast ? onClose() : setSlide(slide + 1)}>
            {isLast ? "Let's go!" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function WeddingPlanner() {
  const [state, setState] = useState(() => hydrate(storage.load()));
  // Purchase gate: true once this device has entered the access password.
  const [activated, setActivated] = useState(isActivated);
  const [tab, setTab] = useState(() => localStorage.getItem("planourdays-tab") || "home");
  const goTab = (t) => { setTab(t); localStorage.setItem("planourdays-tab", t); };
  // intent = the user's stored choice about how data is saved
  // ("sync" | "local" | null). connected = Google Drive holds a live
  // token this session. Together they derive appSyncState() below.
  const [intent, setIntentState] = useState(() => {
    const stored = getIntent();
    if (stored) return stored;
    // Migrate users who chose before the intent store existed: honour a
    // prior sign-out, otherwise infer intent from their old signals.
    if (localStorage.getItem(SIGNED_OUT_KEY)) return null;
    if (drive.isConfigured() && drive.isConnected()) return setIntent("sync");
    if (hasRealData(storage.load())) return setIntent("local");
    return null;
  });
  const [connected, setConnected] = useState(false);
  // Persist the choice and update React state together.
  const chooseIntent = (v) => { setIntent(v); setIntentState(v); };
  const [showGuide, setShowGuide] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  // Independent save-state flags (dirty / inFlight / health / neverSynced).
  // saveStateLabel() maps them to what the save indicator shows.
  const [saveState, setSaveState] = useState(INITIAL_SAVE_STATE);
  // False when the last localStorage write was rejected (quota / private
  // mode). Surfaced in the footer so a silent save failure is visible.
  const [storageOk, setStorageOk] = useState(true);
  // Timestamp of the last successful push/pull (ms). Persisted so the
  // settings panel can show "last synced" across reloads.
  const [lastSync, setLastSync] = useState(
    () => Number(localStorage.getItem(LAST_SYNC_KEY)) || null
  );
  // True only while we silently restore a previous Google session on first load.
  // A user who chose local-only is never auto-restored to sync.
  const [booting, setBooting] = useState(
    () => getIntent() !== "local" && drive.isConfigured() && drive.isConnected()
  );

  const pushTimer = useRef(null);
  const didMount = useRef(false);

  const recordSync = useCallback(() => {
    const t = Date.now();
    setLastSync(t);
    try { localStorage.setItem(LAST_SYNC_KEY, String(t)); } catch {}
  }, []);

  // First load: if the user linked Google before, restore the session silently
  // (no UI) and reconcile the Drive copy with the local copy (last-write-wins).
  useEffect(() => {
    if (intent === "local") return; // respect an explicit local-only choice
    if (!(drive.isConfigured() && drive.isConnected())) return;
    let cancelled = false;
    (async () => {
      const token = await drive.silentRefresh();
      if (cancelled) return;
      if (!token) {
        // Session lapsed but they're still opted in: stay in the app in
        // NEEDS_RECONNECT (connected stays false) and surface a reconnect
        // prompt — don't drop to the front door or silently to local-only.
        setSaveState((s) => ({ ...s, health: "error" }));
        setBooting(false);
        return;
      }
      try {
        const remote = await drive.pull();
        if (cancelled) return;
        setState((local) => reconcile(local, hydrateRemote(remote)));
        setSaveState((s) => ({ ...s, health: "ok", neverSynced: false }));
        recordSync();
      } catch {
        // Linked, but Drive unreachable right now.
        setSaveState((s) => ({ ...s, health: "offline" }));
      }
      if (cancelled) return;
      setConnected(true);
      chooseIntent("sync");
      setBooting(false);
    })();
    return () => { cancelled = true; };
  }, []);

  // Persist on every change: localStorage immediately, Drive debounced (~2.5s).
  // `state` already carries its edit-time updatedAt/rev (stamped by the mutators
  // below), so reconciliation compares real edit times, not save times.
  useEffect(() => {
    setStorageOk(storage.save(state)); // no-op re-render unless it changed

    if (!didMount.current) { didMount.current = true; return; }
    if (!connected) return; // local-only intent never pushes

    // The edit is now unsaved to Drive. Rapid edits coalesce: each
    // one resets the debounce timer, so only one push runs (~2.5s).
    setSaveState((s) => ({ ...s, dirty: true }));
    if (pushTimer.current) clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(() => {
      setSaveState((s) => ({ ...s, inFlight: true }));
      drive
        .push(state)
        .then(() => {
          setSaveState((s) => ({ ...s, dirty: false, inFlight: false, health: "ok", neverSynced: false }));
          recordSync();
        })
        .catch((err) => {
          // Keep dirty set so the edit is retried. A dead token
          // (not_authenticated) means the session lapsed mid-use:
          // flip to NEEDS_RECONNECT so the reconnect prompt appears.
          if (err && err.message === "not_authenticated") setConnected(false);
          setSaveState((s) => ({ ...s, inFlight: false, health: navigator.onLine ? "error" : "offline" }));
        });
    }, 2500);
  }, [state, connected]);

  // Stamp every user edit with an edit time + rev so last-write-wins works
  // across devices. Reconcile results (from pull) deliberately keep their own
  // timestamp, so they use the raw setState, not this.
  const stamp = (s) => { s.updatedAt = Date.now(); s.rev = (s.rev || 0) + 1; return s; };
  const update = useCallback((fn) => setState((s) => stamp(fn(structuredClone(s)))), []);
  // Wraps import/reset in SettingsView so those count as fresh edits and win.
  const setStateStamped = useCallback((next) => setState(stamp({ ...next })), []);

  // Keep the module-level currency in sync so every fmt() call reflects the setting.
  CURRENT_CURRENCY = state.currency || "AUD";

  // Interactive Google connect (welcome screen). Throws on failure/cancel so
  // WelcomeView can surface the error.
  const handleGoogleSignIn = async () => {
    await drive.signIn();
    try {
      const remote = await drive.pull();
      setState((local) => reconcile(local, hydrateRemote(remote)));
    } catch {
      // Couldn't read Drive this moment; the debounced push will sync soon.
    }
    localStorage.removeItem(SIGNED_OUT_KEY);
    setConnected(true);
    setTab("home");
    chooseIntent("sync");
    const isExisting = hasRealData(storage.load());
    if (isExisting) { localStorage.setItem(SETUP_KEY, "1"); localStorage.setItem(GUIDE_KEY, "1"); return; }
    if (!localStorage.getItem(SETUP_KEY)) setShowSetup(true);
    else if (!localStorage.getItem(GUIDE_KEY)) setShowGuide(true);
  };

  const enterLocalOnly = () => {
    localStorage.removeItem(SIGNED_OUT_KEY);
    setTab("home");
    chooseIntent("local");
    const isExisting = hasRealData(storage.load());
    if (isExisting) { localStorage.setItem(SETUP_KEY, "1"); localStorage.setItem(GUIDE_KEY, "1"); return; }
    if (!localStorage.getItem(SETUP_KEY)) setShowSetup(true);
    else if (!localStorage.getItem(GUIDE_KEY)) setShowGuide(true);
  };

  const handleSignOut = () => {
    if (pushTimer.current) clearTimeout(pushTimer.current);
    drive.signOut();
    setConnected(false);
    setSaveState(INITIAL_SAVE_STATE);
    chooseIntent(null);
    localStorage.setItem(SIGNED_OUT_KEY, "1");
  };

  // Re-consent after the token lapsed (NEEDS_RECONNECT). Keeps intent
  // "sync" throughout; on success reconciles with Drive and flips
  // connected on, which resumes the debounced push of any dirty edits.
  // If the user cancels, their local edits stay safe and the reconnect
  // prompt remains.
  const [reconnecting, setReconnecting] = useState(false);
  const handleReconnect = async () => {
    if (reconnecting) return;
    setReconnecting(true);
    try {
      await drive.signIn();
      try {
        const remote = await drive.pull();
        setState((local) => reconcile(local, hydrateRemote(remote)));
        recordSync();
      } catch {
        // Couldn't read Drive this instant; the resumed push will sync soon.
      }
      setSaveState((s) => ({ ...s, health: "ok" }));
      setConnected(true); // -> SYNCING; the push effect flushes dirty edits
    } catch {
      // Cancelled or failed — stay in NEEDS_RECONNECT, edits untouched.
    } finally {
      setReconnecting(false);
    }
  };

  // Settings toggle: sync -> local. Stops pushes and cancels any pending
  // one, but leaves the Drive file untouched so switching back is lossless.
  const switchToLocal = () => {
    if (pushTimer.current) clearTimeout(pushTimer.current);
    setConnected(false);
    setSaveState(INITIAL_SAVE_STATE);
    chooseIntent("local");
  };

  // Settings toggle: local -> sync. Runs signIn -> pull -> reconcile, then
  // flips connected on so the push effect flushes the merged state. Reuses
  // the `reconnecting` busy flag so rapid toggling can't double-push.
  const switchToSync = async () => {
    if (reconnecting) return;
    setReconnecting(true);
    try {
      await drive.signIn();
      try {
        const remote = await drive.pull();
        setState((local) => reconcile(local, hydrateRemote(remote)));
        recordSync();
      } catch {
        // Couldn't read Drive this instant; the debounced push will sync soon.
      }
      localStorage.removeItem(SIGNED_OUT_KEY);
      setSaveState((s) => ({ ...s, health: "ok" }));
      setConnected(true);
      chooseIntent("sync");
    } catch {
      // Cancelled or failed — stay local, nothing changes.
    } finally {
      setReconnecting(false);
    }
  };

  // Purchase gate first: an un-activated device sees only the password
  // screen. Once activated (a one-time local record) it never reappears.
  if (!activated) return <ActivationGate onActivated={() => setActivated(true)} />;

  if (booting) return <BootingView />;

  // One place derives the app's sync state from the two facts above.
  const syncState = appSyncState(intent, connected);

  if (syncState === FRONT_DOOR) {
    return (
      <WelcomeView
        configured={drive.isConfigured()}
        onGoogleSignIn={handleGoogleSignIn}
        onLocalOnly={enterLocalOnly}
      />
    );
  }

  const closeGuide = () => {
    localStorage.setItem(GUIDE_KEY, "1");
    setShowGuide(false);
  };

  const finishSetup = (draft) => {
    localStorage.setItem(SETUP_KEY, "1");
    update((s) => {
      if (draft.partner1.trim()) s.partner1 = draft.partner1.trim();
      if (draft.partner2.trim()) s.partner2 = draft.partner2.trim();
      if (draft.weddingDate) s.weddingDate = draft.weddingDate;
      if (draft.total && Number(draft.total) > 0) {
        s.total = Number(draft.total);
        s.currency = draft.currency;
        s.categories = s.categories.map((c) => ({
          ...c,
          allocated: Math.round(Number(draft.total) * (PRESET_CATEGORIES.find((p) => p.id === c.id)?.pct || 0)),
        }));
      }
      if (draft.venue.trim()) s.venue = draft.venue.trim();
      return s;
    });
    setShowSetup(false);
    setShowGuide(true);
  };

  return (
    <div style={S.page}>
      <style>{CSS}</style>

      <button style={S.appLogoBtn} onClick={() => goTab("home")} aria-label="Home">
        <img src="/logo-mark.png" alt="Planourdays" style={S.appLogoImg} />
      </button>

      {tab !== "settings" && (
        <>
          <button style={S.helpBtn} onClick={() => setShowGuide(true)} aria-label="Help">
            <span style={{ fontSize: 15, fontWeight: 700, color: "#b07a72", lineHeight: 1 }}>?</span>
          </button>
          <button style={S.gearBtn} onClick={() => goTab("settings")} aria-label="Settings">
            <Icon name="gear" size={22} color="#b07a72" />
          </button>
        </>
      )}

      {showSetup && <SetupWizard onFinish={finishSetup} onSkipAll={() => { localStorage.setItem(SETUP_KEY, "1"); setShowSetup(false); setShowGuide(true); }} />}
      {showGuide && <GuideModal onClose={closeGuide} />}

      {syncState === NEEDS_RECONNECT && (
        <ReconnectBanner busy={reconnecting} onReconnect={handleReconnect} />
      )}

      <div style={S.scroll}>
        {tab === "home" && <HomeView state={state} update={update} go={goTab} />}
        {tab === "budget" && <BudgetView state={state} update={update} />}
        {tab === "checklist" && <ChecklistView state={state} update={update} />}
        {tab === "vendors" && <VendorsView state={state} update={update} />}
        {tab === "guests" && <GuestsView state={state} update={update} />}
        {tab === "seating" && <SeatingView state={state} update={update} />}
        {tab === "venues" && <VenueComparisonView state={state} update={update} />}
        {tab === "settings" && <SettingsView state={state} update={update} setState={setStateStamped} go={goTab} connected={connected} onSignOut={handleSignOut}
          sync={{ intent, syncState, saveState, lastSync, busy: reconnecting, onSwitchToLocal: switchToLocal, onSwitchToSync: switchToSync, onReconnect: handleReconnect }} />}

        <footer style={S.footer}>
          {intent === "sync" ? (
            <SaveIndicator
              saveState={{
                ...(syncState === NEEDS_RECONNECT ? { ...saveState, inFlight: false, health: "error" } : saveState),
                storageError: !storageOk,
              }}
            />
          ) : !storageOk ? (
            <SaveIndicator saveState={{ storageError: true }} />
          ) : PERSISTS ? (
            "Saved on this device · sign in to sync across devices"
          ) : (
            "Preview mode · data won't persist here, but saving works in the deployed app"
          )}
        </footer>
      </div>

      <nav style={S.nav}>
        <NavBtn active={tab === "home"} onClick={() => goTab("home")} icon="home" label="Home" />
        <NavBtn active={tab === "budget"} onClick={() => goTab("budget")} icon="budget" label="Budget" />
        <NavBtn active={tab === "checklist"} onClick={() => goTab("checklist")} icon="check" label="Checklist" />
        <NavBtn active={tab === "venues"} onClick={() => goTab("venues")} icon="venue" label="Venues" />
        <NavBtn active={tab === "vendors"} onClick={() => goTab("vendors")} icon="vendor" label="Vendors" />
        <NavBtn active={tab === "guests"} onClick={() => goTab("guests")} icon="guest" label="Guests" />
        <NavBtn active={tab === "seating"} onClick={() => goTab("seating")} icon="seating" label="Seating" />
      </nav>
    </div>
  );
}

// Line-style SVG icons — consistent across all phones (no emoji substitution).
function Icon({ name, size = 22, color = "currentColor" }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: color, strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" };
  const paths = {
    home: <><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5" /></>,
    budget: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v10M9.5 9.2c0-1 1.1-1.7 2.5-1.7s2.5.8 2.5 1.8c0 2.4-5 1.3-5 3.6 0 1 1.1 1.8 2.5 1.8s2.5-.7 2.5-1.7" /></>,
    check: <><path d="M4 12.5 9 17.5 20 6.5" /></>,
    vendor: <><path d="M3.5 9.5 7 5h10l3.5 4.5L12 21 3.5 9.5Z" /><path d="M3.5 9.5h17M9 5l-1.5 4.5L12 21M15 5l1.5 4.5L12 21" /></>,
    guest: <><path d="M12 20.5s-7-4.3-9.2-9C1.4 8.6 2.6 5.5 5.6 5c1.9-.3 3.6.8 4.4 2.3.8-1.5 2.5-2.6 4.4-2.3 3 .5 4.2 3.6 2.8 6.5-2.2 4.7-9.2 9-9.2 9Z" /></>,
    gear: <><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" /><path d="M19.43 12.98c.04-.32.07-.65.07-.98 0-.33-.03-.66-.07-.98l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65A.49.49 0 0 0 14 2h-4a.49.49 0 0 0-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1a.49.49 0 0 0-.61.22l-2 3.46a.49.49 0 0 0 .12.64l2.11 1.65c-.04.32-.07.65-.07.98 0 .33.03.66.07.98L2.46 14.63a.5.5 0 0 0-.12.64l2 3.46a.5.5 0 0 0 .61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.08.42.45.42.49.42h4c.24 0 .45-.17.49-.42l.38-2.65c.61-.25 1.17-.58 1.69-.98l2.49 1a.49.49 0 0 0 .61-.22l2-3.46a.49.49 0 0 0-.12-.64l-2.11-1.65Z" /></>,
    back: <><path d="M15 18l-6-6 6-6" /></>,
    venue: <><path d="M3 21h18M4 21V9l8-6 8 6v12M9 21v-6h6v6" /></>,
    seating: <><circle cx="12" cy="12" r="5" /><circle cx="12" cy="3.5" r="1.6" /><circle cx="12" cy="20.5" r="1.6" /><circle cx="3.5" cy="12" r="1.6" /><circle cx="20.5" cy="12" r="1.6" /></>,
    trash: <><path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" /></>,
  };
  return <svg {...common} style={{ display: "block" }}>{paths[name]}</svg>;
}

function NavBtn({ active, onClick, icon, label }) {
  return (
    <button onClick={onClick} style={{ ...S.navBtn, color: active ? "#6b4a45" : "#c4aaa4" }}>
      <span style={{ ...S.navIcon, background: active ? "#f4e3df" : "transparent" }}>
        <Icon name={icon} size={20} color={active ? "#b07a72" : "#c4aaa4"} />
      </span>
      <span style={S.navLabel}>{label}</span>
    </button>
  );
}

/* ============================================================
   WELCOME / SIGN-IN  (visual front door)
   ------------------------------------------------------------
   "Sign in with Google" runs the real OAuth flow (drive.appdata
   scope) and connects Drive sync. "Continue without signing in"
   keeps the app local-only after a warning modal.
   ============================================================ */

function GoogleG({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" style={{ display: "block" }}>
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.9 2.4 30.4 0 24 0 14.6 0 6.4 5.4 2.6 13.2l7.9 6.2C12.3 13.6 17.6 9.5 24 9.5Z" />
      <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 7l7.1 5.5c4.2-3.9 6.6-9.6 6.6-17Z" />
      <path fill="#FBBC05" d="M10.5 28.4c-.5-1.4-.7-2.9-.7-4.4s.3-3 .7-4.4l-7.9-6.2C1 16.5 0 20.1 0 24s1 7.5 2.6 10.6l7.9-6.2Z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.1-5.5c-2 1.3-4.5 2.1-8.8 2.1-6.4 0-11.7-4.1-13.5-9.9l-7.9 6.2C6.4 42.6 14.6 48 24 48Z" />
    </svg>
  );
}

function WelcomeView({ configured, onGoogleSignIn, onLocalOnly }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [warnLocal, setWarnLocal] = useState(false);

  const signIn = async () => {
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      await onGoogleSignIn();
    } catch (e) {
      // popup_closed / access_denied / config errors all land here.
      setError(
        e && e.message && e.message.includes("configured")
          ? "Google sign-in isn't set up yet. You can still continue without signing in."
          : "Sign-in didn't complete. Please try again."
      );
      setBusy(false);
    }
  };

  return (
    <div style={S.welcomePage}>
      <style>{CSS}</style>
      <div style={S.welcomeInner}>
        <img src="/logo.png" alt="Planourdays — Wedding App"
          style={{ width: 200, maxWidth: "72%", height: "auto", display: "block", margin: "0 auto 10px" }} />
        <h1 style={S.welcomeTitle}>Planourdays</h1>
        <p style={S.welcomeTag}>
          Budget, checklist, guests, vendors and seating — every part of your big day, in one calm place.
        </p>

        <button style={{ ...S.googleBtn, opacity: busy ? 0.6 : 1, cursor: busy ? "default" : "pointer" }} onClick={signIn} disabled={busy}>
          <GoogleG size={18} />
          <span>{busy ? "Connecting…" : "Sign in with Google"}</span>
        </button>

        {error && <div style={S.welcomeError}>{error}</div>}

        <button style={S.welcomeGhost} onClick={() => setWarnLocal(true)}>
          Continue without signing in
        </button>

        <div style={S.welcomeFinePrint}>
          Signing in saves a private copy of your plan to a hidden folder in your
          own Google Drive, so it syncs across your devices. Planourdays can't see
          any of your other Drive files.
        </div>
      </div>

      {warnLocal && (
        <div style={S.modalOverlay} onClick={() => setWarnLocal(false)}>
          <div style={S.modalCard} onClick={(e) => e.stopPropagation()}>
            <h2 style={S.modalTitle}>Continue without signing in?</h2>
            <p style={S.modalBody}>
              Your plan will be saved only in this browser on this device. It
              won't sync to your other devices or be backed up, and clearing your
              browser data would erase it. We recommend signing in with Google.
            </p>
            <button style={S.modalPrimary} onClick={() => { setWarnLocal(false); signIn(); }}>
              Sign in with Google
            </button>
            <button style={S.modalGhost} onClick={() => { setWarnLocal(false); onLocalOnly(); }}>
              Continue without signing in
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Front-door purchase gate: shown before the welcome flow until this
// device is activated with the password from the buyer's download PDF.
function ActivationGate({ onActivated }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");

  const submit = (e) => {
    e.preventDefault();
    const entered = normalizeCode(code);
    if (!entered) { setError("Please enter your access password."); return; }
    if (ACCESS_PASSWORDS.includes(entered)) {
      markActivated();
      onActivated();
    } else {
      setError("That password didn't match. Please check the PDF from your Etsy download and try again.");
    }
  };

  return (
    <div style={S.welcomePage}>
      <style>{CSS}</style>
      <div style={S.welcomeInner}>
        <img src="/logo.png" alt="Planourdays — Wedding App"
          style={{ width: 200, maxWidth: "72%", height: "auto", display: "block", margin: "0 auto 10px" }} />
        <h1 style={S.welcomeTitle}>Welcome to Planourdays</h1>
        <p style={S.welcomeTag}>
          Enter the access password from your Etsy download to unlock the app on this device.
        </p>

        <form onSubmit={submit}>
          <input
            style={S.activateInput}
            value={code}
            onChange={(e) => { setCode(e.target.value); if (error) setError(""); }}
            placeholder="Access password"
            aria-label="Access password"
            autoFocus
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
          />
          {error && <div style={S.welcomeError}>{error}</div>}
          <button type="submit" style={S.activateBtn}>Unlock</button>
        </form>

        <div style={S.welcomeFinePrint}>
          The password is printed in the PDF you received with your Etsy purchase.
          You only need to enter it once on this device.
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   BUDGET VIEW
   ============================================================ */

/* ============================================================
   HOME / COUPLE PROFILE VIEW
   ============================================================ */

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const wd = new Date(dateStr + "T00:00:00");
  if (isNaN(wd)) return null;
  return Math.round((wd - today) / 86400000);
}

function HomeView({ state, update, go }) {
  const set = (patch) => update((s) => { Object.assign(s, patch); return s; });
  const photos = state.photos || [];

  // Read an image file, downscale it, and store as a data URL (keeps size sane).
  const addPhotos = (fileList) => {
    const files = Array.from(fileList).slice(0, 8);
    files.forEach((file) => {
      if (!file.type.startsWith("image/")) return;
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const max = 1000;
          let { width, height } = img;
          if (width > max || height > max) {
            const r = Math.min(max / width, max / height);
            width = Math.round(width * r); height = Math.round(height * r);
          }
          const canvas = document.createElement("canvas");
          canvas.width = width; canvas.height = height;
          canvas.getContext("2d").drawImage(img, 0, 0, width, height);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
          update((s) => { if (!s.photos) s.photos = []; s.photos.push({ id: uid(), src: dataUrl }); return s; });
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  };

  const removePhoto = (id) =>
    update((s) => { s.photos = (s.photos || []).filter((p) => p.id !== id); return s; });

  const dateRef = React.useRef(null);
  const openDatePicker = () => {
    const el = dateRef.current;
    if (!el) return;
    el.focus();
    try { el.showPicker?.(); } catch {}
  };

  const days = daysUntil(state.weddingDate);
  let countdown;
  const noDate = days === null;
  if (noDate) countdown = "Set your date";
  else if (days > 1) countdown = `${days} days to go`;
  else if (days === 1) countdown = "1 day to go";
  else if (days === 0) countdown = "Today's the day! 🤍";
  else countdown = "Married 🤍";

  // pillar summaries
  const totalSpent = state.categories.reduce((s, c) => s + catSpent(c), 0);
  const tasks = state.checklist.flatMap((b) => b.tasks);
  const tasksDone = tasks.filter((t) => t.done).length;
  const heads = headcount(state.guests);
  const vendorsBooked = state.vendors.filter((v) => v.status === "Booked").length;

  const names = state.partner1 && state.partner2
    ? `${state.partner1} & ${state.partner2}`
    : (state.partner1 || state.partner2 || "Your Wedding");

  const dateLabel = state.weddingDate
    ? new Date(state.weddingDate + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" })
    : "";

  return (
    <>
      {/* hero photo */}
      {photos.length > 0 && (
        <div style={S.heroPhotoWrap}>
          <img src={photos[0].src} alt="The couple" style={S.heroPhoto} />
          <button style={S.heroPhotoRemove} onClick={() => removePhoto(photos[0].id)}>×</button>
        </div>
      )}

      {/* hero */}
      <div style={S.hero}>
        <div style={S.kicker}>We're getting married</div>
        <h1 style={S.heroNames}>{names}</h1>
        {dateLabel && <div style={S.heroDate}>{dateLabel}</div>}
        <button style={{ ...S.countdownPill, border: "none", cursor: "pointer" }} onClick={openDatePicker}>
          {countdown}
        </button>
      </div>

      {/* couple profile editor */}
      <section style={S.dashboard}>
        <div style={S.profileGrid}>
          <Field label="Partner 1">
            <input style={S.fieldInput} placeholder="Name" value={state.partner1} onChange={(e) => set({ partner1: e.target.value })} />
          </Field>
          <Field label="Partner 2">
            <input style={S.fieldInput} placeholder="Name" value={state.partner2} onChange={(e) => set({ partner2: e.target.value })} />
          </Field>
          <Field label="Wedding date">
            <input ref={dateRef} type="date" style={S.fieldInput} value={state.weddingDate} onChange={(e) => set({ weddingDate: e.target.value })} />
          </Field>
          <Field label="Venue">
            <input style={S.fieldInput} placeholder="Where?" value={state.venue} onChange={(e) => set({ venue: e.target.value })} />
          </Field>
        </div>
        <div style={{ marginTop: 12 }}>
          <label style={S.smallLabel}>Our vision</label>
          <textarea style={S.visionInput} rows={3}
            placeholder="A few words about the day you're dreaming of…"
            value={state.vision} onChange={(e) => set({ vision: e.target.value })} />
        </div>
      </section>

      {/* photo gallery */}
      <section style={S.dashboard}>
        <div style={S.galleryHead}>
          <label style={S.smallLabel}>Our photos</label>
          <label style={S.addPhotoBtn}>
            + Add photos
            <input type="file" accept="image/*" multiple style={{ display: "none" }}
              onChange={(e) => { addPhotos(e.target.files); e.target.value = ""; }} />
          </label>
        </div>
        {photos.length === 0 ? (
          <div style={S.galleryEmpty}>Add a favorite photo of the two of you. The first one becomes your banner.</div>
        ) : (
          <div style={S.galleryGrid}>
            {photos.map((p, i) => (
              <div key={p.id} style={S.galleryItem}>
                <img src={p.src} alt="" style={S.galleryImg} />
                {i === 0 && <span style={S.bannerTag}>Banner</span>}
                <button style={S.galleryRemove} onClick={() => removePhoto(p.id)}>×</button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* summary cards */}
      <div style={S.summaryGrid}>
        <SummaryCard onClick={() => go("budget")} icon="budget" label="Budget"
          big={fmt(totalSpent)} sub={`of ${fmt(state.total)} spent`} />
        <SummaryCard onClick={() => go("checklist")} icon="check" label="Checklist"
          big={`${tasksDone}/${tasks.length}`} sub="tasks done" />
        <SummaryCard onClick={() => go("guests")} icon="guest" label="Guests"
          big={`${heads}`} sub="coming (incl. +1s)" />
        <SummaryCard onClick={() => go("vendors")} icon="vendor" label="Vendors"
          big={`${vendorsBooked}/${state.vendors.length}`} sub="booked" />
      </div>
    </>
  );
}

function SummaryCard({ onClick, icon, label, big, sub }) {
  return (
    <button style={S.summaryCard} onClick={onClick}>
      <div style={S.summaryTop}>
        <Icon name={icon} size={17} color="#c98b94" />
        <span style={S.summaryLabel}>{label}</span>
      </div>
      <div style={S.summaryBig}>{big}</div>
      <div style={S.summarySub}>{sub}</div>
    </button>
  );
}


function BudgetView({ state, update }) {
  const [openCat, setOpenCat] = useState(null);
  const [confirmDeleteCat, setConfirmDeleteCat] = useState(null);

  const totalAllocated = state.categories.reduce((s, c) => s + (Number(c.allocated) || 0), 0);
  const totalSpent = state.categories.reduce((s, c) => s + catSpent(c), 0);
  const remaining = state.total - totalSpent;
  const upcoming = state.categories.reduce(
    (s, c) => s + c.expenses.filter((e) => !e.paid).reduce((a, e) => a + (Number(e.amount) || 0), 0),
    0
  );
  const spentPct = state.total > 0 ? Math.min(100, (totalSpent / state.total) * 100) : 0;
  const overBudget = totalSpent > state.total;

  // What's contractually committed to vendors but not yet paid:
  // for each vendor, max(0, contracted - payments logged so far).
  const vendorsOwed = (state.vendors || [])
    .map((v) => {
      const paid = vendorExpenses(state, v.id).reduce((s, e) => s + (Number(e.amount) || 0), 0);
      return { name: v.name, owed: Math.max(0, (Number(v.contracted) || 0) - paid) };
    })
    .filter((v) => v.owed > 0);
  const totalCommitted = vendorsOwed.reduce((s, v) => s + v.owed, 0);

  const setTotal = (v) => update((s) => { s.total = Math.max(0, Number(v) || 0); return s; });
  const addCategory = () => update((s) => { s.categories.push({ id: uid(), name: "New Category", allocated: 0, expenses: [] }); return s; });
  const editCategory = (id, patch) => update((s) => { const c = s.categories.find((x) => x.id === id); if (c) Object.assign(c, patch); return s; });
  const deleteCategory = (id) => update((s) => { s.categories = s.categories.filter((x) => x.id !== id); return s; });
  const addExpense = (catId, exp) => update((s) => { const c = s.categories.find((x) => x.id === catId); if (c) c.expenses.push({ id: uid(), ...exp }); return s; });
  const editExpense = (catId, expId, patch) => update((s) => { const c = s.categories.find((x) => x.id === catId); const e = c?.expenses.find((x) => x.id === expId); if (e) Object.assign(e, patch); return s; });
  const deleteExpense = (catId, expId) => update((s) => { const c = s.categories.find((x) => x.id === catId); if (c) c.expenses = c.expenses.filter((x) => x.id !== expId); return s; });

  return (
    <>
      <header style={S.header}>
        <div style={S.kicker}>The Wedding</div>
        <h1 style={S.title}>Budget</h1>
      </header>

      <section style={S.dashboard}>
        <div style={S.totalRow}>
          <label style={S.totalLabel}>Total Budget</label>
          <div style={S.totalInputWrap}>
            <span style={S.dollar}>$</span>
            <input type="number" inputMode="numeric" value={state.total === 0 ? "" : state.total}
              placeholder="0" onChange={(e) => setTotal(e.target.value)} style={S.totalInput} />
          </div>
        </div>

        <div style={S.bar}>
          <div style={{ ...S.barFill, width: `${spentPct}%`, background: overBudget ? "#c2566b" : "linear-gradient(90deg,#d9a7a0,#c98b94)" }} />
        </div>

        <div style={S.stats} className="stats-grid">
          <Stat label="Spent" value={fmt(totalSpent)} accent={overBudget ? "#c2566b" : "#8a6d68"} />
          <Stat label="Remaining" value={fmt(remaining)} accent={remaining < 0 ? "#c2566b" : "#6f8a6d"} />
          <Stat label="Upcoming" value={fmt(upcoming)} accent="#a8862f" />
          <Stat label="Allocated" value={fmt(totalAllocated)} accent="#8a6d68" />
        </div>
        {totalAllocated !== state.total && (
          <div style={S.allocNote}>
            {totalAllocated > state.total
              ? `You've allocated ${fmt(totalAllocated - state.total)} more than your budget.`
              : `${fmt(state.total - totalAllocated)} of your budget is unallocated.`}
          </div>
        )}

        {totalCommitted > 0 && (
          <div style={S.committedBox}>
            <div style={S.committedTop}>
              <span style={S.committedLabel}>Still to pay vendors</span>
              <span style={S.committedValue}>{fmt(totalCommitted)}</span>
            </div>
            <div style={S.committedHint}>Contracted amounts you haven't paid yet</div>
            <div style={S.owedList}>
              {vendorsOwed.map((v, i) => (
                <div key={i} style={S.owedRow}>
                  <span style={S.owedName}>{v.name || "Vendor"}</span>
                  <span style={S.owedAmt}>{fmt(v.owed)} owing</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      <section>
        {state.categories.map((cat) => {
          const spent = catSpent(cat);
          const diff = cat.allocated - spent;
          const isOpen = openCat === cat.id;
          return (
            <div key={cat.id} style={S.card}>
              <div style={{ ...S.cardHead, display: "flex", alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", flex: 1, cursor: "pointer" }} onClick={() => { setOpenCat(isOpen ? null : cat.id); setConfirmDeleteCat(null); }}>
                <span style={{ ...S.chevron, transform: isOpen ? "rotate(90deg)" : "none" }}>›</span>
                <div style={S.catMain}>
                  <div style={S.catName}>{cat.name}</div>
                  <div style={S.catNumbers}>
                    <span style={S.catSpent}>{fmt(spent)}</span>
                    <span style={S.catOf}>of {fmt(cat.allocated)}</span>
                    <span style={{ ...S.diffPill, background: diff < 0 ? "#f7dde2" : "#e4eede", color: diff < 0 ? "#c2566b" : "#5c7a59" }}>
                      {diff < 0 ? `${fmt(-diff)} over` : `${fmt(diff)} left`}
                    </span>
                  </div>
                </div>
                </div>
                {confirmDeleteCat === cat.id ? (
                  <div style={{ display: "flex", gap: 4, paddingRight: 10 }}>
                    <button onClick={(e) => { e.stopPropagation(); deleteCategory(cat.id); setConfirmDeleteCat(null); }}
                      style={S.trashConfirm}>Delete</button>
                    <button onClick={(e) => { e.stopPropagation(); setConfirmDeleteCat(null); }}
                      style={S.trashCancel}>Cancel</button>
                  </div>
                ) : (
                  <button onClick={(e) => { e.stopPropagation(); setConfirmDeleteCat(cat.id); }}
                    style={S.trashBtn}><Icon name="trash" size={18} color="#c98b94" /></button>
                )}
              </div>

              {isOpen && (
                <div style={S.cardBody}>
                  <div style={S.allocEdit}>
                    <Field label="Category name">
                      <input style={S.fieldInput} value={cat.name} onChange={(e) => editCategory(cat.id, { name: e.target.value })} />
                    </Field>
                  </div>
                  <div style={S.allocEdit}>
                    <label style={S.smallLabel}>Allocated</label>
                    <div style={S.miniInputWrap}>
                      <span style={S.miniDollar}>$</span>
                      <input type="number" inputMode="numeric" value={cat.allocated === 0 ? "" : cat.allocated}
                        placeholder="0" onChange={(e) => editCategory(cat.id, { allocated: Number(e.target.value) || 0 })} style={S.miniInput} />
                    </div>
                    <button style={S.deleteCat} onClick={() => deleteCategory(cat.id)}>Delete</button>
                  </div>
                  <ExpenseList cat={cat} vendors={state.vendors}
                    onAdd={(exp) => addExpense(cat.id, exp)}
                    onEdit={(eid, patch) => editExpense(cat.id, eid, patch)}
                    onDelete={(eid) => deleteExpense(cat.id, eid)} />
                  <button style={S.doneBtn} onClick={() => setOpenCat(null)}>Done</button>
                </div>
              )}
            </div>
          );
        })}
        <button style={S.addCat} onClick={addCategory}>+ Add category</button>
      </section>
    </>
  );
}

function Stat({ label, value, accent }) {
  return (
    <div style={S.statBox}>
      <div style={S.statLabel}>{label}</div>
      <div style={{ ...S.statValue, color: accent }}>{value}</div>
    </div>
  );
}

function ExpenseList({ cat, vendors = [], onAdd, onEdit, onDelete }) {
  const [desc, setDesc] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [paid, setPaid] = useState(true);

  const vendorName = (id) => vendors.find((v) => v.id === id)?.name;

  const submit = () => {
    if (!desc.trim() || !amount) return;
    onAdd({ desc: desc.trim(), amount: Number(amount) || 0, date, paid });
    setDesc(""); setAmount(""); setPaid(true);
  };

  return (
    <div>
      {cat.expenses.map((e) => (
        <div key={e.id} style={S.expItem}>
          <div style={S.expItemTop}>
            <input style={S.expDesc} value={e.desc} onChange={(ev) => onEdit(e.id, { desc: ev.target.value })} />
            <button style={S.expDelete} onClick={() => onDelete(e.id)}>×</button>
          </div>
          {e.vendorId && vendorName(e.vendorId) && (
            <div style={S.vendorTag}>♦ {vendorName(e.vendorId)}</div>
          )}
          <div style={S.expItemBottom}>
            <div style={S.expAmtWrap}>
              <span style={S.miniDollar}>$</span>
              <input type="number" inputMode="numeric" style={S.expAmt} value={e.amount}
                onChange={(ev) => onEdit(e.id, { amount: Number(ev.target.value) || 0 })} />
            </div>
            <input type="date" style={S.expDate} value={e.date} onChange={(ev) => onEdit(e.id, { date: ev.target.value })} />
            <button style={{ ...S.statusToggle, color: e.paid ? "#5c7a59" : "#a8862f", background: e.paid ? "#e4eede" : "#faf0d8" }}
              onClick={() => onEdit(e.id, { paid: !e.paid })}>
              {e.paid ? "Paid" : "Upcoming"}
            </button>
          </div>
        </div>
      ))}

      <div style={S.addBox}>
        <div style={S.addBoxLabel}>Add an expense</div>
        <input style={S.addDesc} placeholder="What's it for? (e.g. Venue deposit)" value={desc} onChange={(e) => setDesc(e.target.value)} />
        <div style={S.addRow}>
          <div style={S.expAmtWrap}>
            <span style={S.miniDollar}>$</span>
            <input type="number" inputMode="numeric" style={S.expAmt} placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <input type="date" style={S.expDate} value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div style={S.addRow}>
          <button style={{ ...S.statusToggleWide, color: paid ? "#5c7a59" : "#a8862f", background: paid ? "#e4eede" : "#faf0d8" }}
            onClick={() => setPaid(!paid)}>
            {paid ? "✓ Paid" : "◷ Upcoming"}
          </button>
        </div>
        <button style={{ ...S.addBtn, opacity: desc.trim() && amount ? 1 : 0.5 }} onClick={submit}>+ Add expense</button>
      </div>
    </div>
  );
}

/* ============================================================
   CHECKLIST VIEW
   ============================================================ */

function ChecklistView({ state, update }) {
  const [openBucket, setOpenBucket] = useState(state.checklist[0]?.id || null);
  const [expanded, setExpanded] = useState(null);
  const [confirmDeleteBucket, setConfirmDeleteBucket] = useState(null);

  const allTasks = state.checklist.flatMap((b) => b.tasks);
  const doneCount = allTasks.filter((t) => t.done).length;
  const totalCount = allTasks.length;
  const pct = totalCount ? Math.round((doneCount / totalCount) * 100) : 0;

  const setWeddingDate = (v) => update((s) => { s.weddingDate = v; return s; });
  const toggleTask = (bid, tid) => update((s) => { const b = s.checklist.find((x) => x.id === bid); const t = b?.tasks.find((x) => x.id === tid); if (t) t.done = !t.done; return s; });
  const editTask = (bid, tid, patch) => update((s) => { const b = s.checklist.find((x) => x.id === bid); const t = b?.tasks.find((x) => x.id === tid); if (t) Object.assign(t, patch); return s; });
  const deleteTask = (bid, tid) => update((s) => { const b = s.checklist.find((x) => x.id === bid); if (b) b.tasks = b.tasks.filter((x) => x.id !== tid); return s; });
  const addTask = (bid, name) => update((s) => { const b = s.checklist.find((x) => x.id === bid); if (b) b.tasks.push({ id: uid(), name, done: false, due: "", note: "" }); return s; });
  const editBucket = (bid, patch) => update((s) => { const b = s.checklist.find((x) => x.id === bid); if (b) Object.assign(b, patch); return s; });
  const deleteBucket = (bid) => update((s) => { s.checklist = s.checklist.filter((x) => x.id !== bid); return s; });
  const addBucket = () => update((s) => { s.checklist.push({ id: uid(), label: "New Section", tasks: [] }); return s; });

  return (
    <>
      <header style={S.header}>
        <div style={S.kicker}>The Wedding</div>
        <h1 style={S.title}>Checklist</h1>
      </header>

      <section style={S.dashboard}>
        <div style={S.totalRow}>
          <label style={S.totalLabel}>Wedding Date</label>
          <input type="date" value={state.weddingDate} onChange={(e) => setWeddingDate(e.target.value)} style={S.dateInput} />
        </div>
        <div style={S.bar}>
          <div style={{ ...S.barFill, width: `${pct}%`, background: "linear-gradient(90deg,#d9a7a0,#c98b94)" }} />
        </div>
        <div style={S.progressRow}>
          <span style={S.progressBig}>{doneCount} of {totalCount}</span>
          <span style={S.progressSmall}>tasks done · {pct}%</span>
        </div>
      </section>

      <section>
        {state.checklist.map((bucket) => {
          const bDone = bucket.tasks.filter((t) => t.done).length;
          const isOpen = openBucket === bucket.id;
          return (
            <div key={bucket.id} style={S.card}>
              <div style={{ ...S.cardHead, display: "flex", alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", flex: 1, cursor: "pointer" }} onClick={() => { setOpenBucket(isOpen ? null : bucket.id); setConfirmDeleteBucket(null); }}>
                  <span style={{ ...S.chevron, transform: isOpen ? "rotate(90deg)" : "none" }}>›</span>
                  <div style={S.catMain}>
                    <div style={S.bucketLabel}>{bucket.label}</div>
                    <div style={S.bucketCount}>{bDone}/{bucket.tasks.length} done</div>
                  </div>
                </div>
                {confirmDeleteBucket === bucket.id ? (
                  <div style={{ display: "flex", gap: 4, paddingRight: 10 }}>
                    <button onClick={(e) => { e.stopPropagation(); deleteBucket(bucket.id); setConfirmDeleteBucket(null); setOpenBucket(null); }}
                      style={S.trashConfirm}>Delete</button>
                    <button onClick={(e) => { e.stopPropagation(); setConfirmDeleteBucket(null); }}
                      style={S.trashCancel}>Cancel</button>
                  </div>
                ) : (
                  <button onClick={(e) => { e.stopPropagation(); setConfirmDeleteBucket(bucket.id); }}
                    style={S.trashBtn}><Icon name="trash" size={18} color="#c98b94" /></button>
                )}
              </div>

              {isOpen && (
                <div style={S.cardBody}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 0 4px" }}>
                    <input style={{ ...S.fieldInput, flex: 1, fontFamily: "'Fraunces', serif", fontSize: 16, fontWeight: 600, color: "#6b4a45" }}
                      value={bucket.label} onChange={(e) => editBucket(bucket.id, { label: e.target.value })} />
                    <button style={{ ...S.deleteCat, flexShrink: 0 }} onClick={() => { deleteBucket(bucket.id); setOpenBucket(null); }}>Delete section</button>
                  </div>
                  {bucket.tasks.map((t) => {
                    const open = expanded === t.id;
                    return (
                      <div key={t.id} style={S.taskItem}>
                        <div style={S.taskTop}>
                          <button style={{ ...S.check, background: t.done ? "#c98b94" : "#fff", borderColor: t.done ? "#c98b94" : "#d9b8b2" }}
                            onClick={() => toggleTask(bucket.id, t.id)}>
                            {t.done ? "✓" : ""}
                          </button>
                          <input style={{ ...S.taskName, textDecoration: t.done ? "line-through" : "none", color: t.done ? "#b9a39e" : "#3a2e2c" }}
                            value={t.name} onChange={(e) => editTask(bucket.id, t.id, { name: e.target.value })} />
                          <button style={S.taskExpand} onClick={() => setExpanded(open ? null : t.id)}>
                            {open ? "−" : "⋯"}
                          </button>
                        </div>
                        {(open || t.due || t.note) && (
                          <div style={S.taskDetail}>
                            <div style={S.taskDetailRow}>
                              <label style={S.smallLabel}>Due</label>
                              <input type="date" style={S.taskDate} value={t.due} onChange={(e) => editTask(bucket.id, t.id, { due: e.target.value })} />
                              <button style={S.taskDelete} onClick={() => deleteTask(bucket.id, t.id)}>Delete</button>
                            </div>
                            <input style={S.taskNote} placeholder="Add a note…" value={t.note}
                              onChange={(e) => editTask(bucket.id, t.id, { note: e.target.value })} />
                          </div>
                        )}
                      </div>
                    );
                  })}
                  <AddTask onAdd={(name) => addTask(bucket.id, name)} />
                  <button style={S.doneBtn} onClick={() => setOpenBucket(null)}>Done</button>
                </div>
              )}
            </div>
          );
        })}
        <button style={S.addCat} onClick={addBucket}>+ Add section</button>
      </section>
    </>
  );
}

function AddTask({ onAdd }) {
  const [name, setName] = useState("");
  const submit = () => { if (!name.trim()) return; onAdd(name.trim()); setName(""); };
  return (
    <div style={S.addTaskRow}>
      <input style={S.addTaskInput} placeholder="Add a task…" value={name}
        onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
      <button style={{ ...S.expAdd, opacity: name.trim() ? 1 : 0.5 }} onClick={submit}>+</button>
    </div>
  );
}

/* ============================================================
   VENDORS VIEW
   ============================================================ */

function VendorsView({ state, update }) {
  const [openVendor, setOpenVendor] = useState(null);
  const [confirmDeleteVendor, setConfirmDeleteVendor] = useState(null);
  const [query, setQuery] = useState("");

  const booked = state.vendors.filter((v) => v.status === "Booked").length;
  const q = query.trim().toLowerCase();
  const shownVendors = !q
    ? state.vendors
    : state.vendors.filter((v) =>
        [v.name, v.type, v.notes].some((f) => (f || "").toLowerCase().includes(q))
      );

  const addVendor = () =>
    update((s) => {
      const v = {
        id: uid(),
        name: "New Vendor",
        type: "",
        categoryId: s.categories[0]?.id || "",
        phone: "",
        email: "",
        status: "Researching",
        notes: "",
        contracted: 0,
      };
      s.vendors.push(v);
      return s;
    });

  const editVendor = (id, patch) =>
    update((s) => { const v = s.vendors.find((x) => x.id === id); if (v) Object.assign(v, patch); return s; });

  const deleteVendor = (id) =>
    update((s) => {
      // Unlink this vendor from any expenses, but keep the expenses themselves.
      for (const c of s.categories) for (const e of c.expenses) if (e.vendorId === id) delete e.vendorId;
      s.vendors = s.vendors.filter((x) => x.id !== id);
      return s;
    });

  // Add a payment = create an expense in the vendor's linked category, tagged with vendorId.
  const addPayment = (vendor, pay) =>
    update((s) => {
      const cat = s.categories.find((c) => c.id === vendor.categoryId) || s.categories[0];
      if (cat) cat.expenses.push({ id: uid(), vendorId: vendor.id, ...pay });
      return s;
    });

  const editPayment = (catId, expId, patch) =>
    update((s) => { const c = s.categories.find((x) => x.id === catId); const e = c?.expenses.find((x) => x.id === expId); if (e) Object.assign(e, patch); return s; });

  const deletePayment = (catId, expId) =>
    update((s) => { const c = s.categories.find((x) => x.id === catId); if (c) c.expenses = c.expenses.filter((x) => x.id !== expId); return s; });

  return (
    <>
      <header style={S.header}>
        <div style={S.kicker}>The Wedding</div>
        <h1 style={S.title}>Vendors</h1>
      </header>

      <section style={S.dashboard}>
        <div style={S.progressRow}>
          <span style={S.progressBig}>{booked} of {state.vendors.length}</span>
          <span style={S.progressSmall}>vendors booked</span>
        </div>
      </section>

      {/* search */}
      {state.vendors.length > 0 && (
        <div style={S.searchWrap}>
          <span style={S.searchIcon}>⌕</span>
          <input style={S.searchInput} placeholder="Search by name, type, or notes…"
            value={query} onChange={(e) => setQuery(e.target.value)} />
          {query && <button style={S.searchClear} onClick={() => setQuery("")}>×</button>}
        </div>
      )}

      <section>
        {state.vendors.length === 0 && (
          <div style={S.emptyNote}>No vendors yet. Add your photographer, florist, caterer and more below.</div>
        )}
        {state.vendors.length > 0 && shownVendors.length === 0 && (
          <div style={S.emptyNote}>No vendors match your search.</div>
        )}

        {shownVendors.map((vendor) => {
          const cat = state.categories.find((c) => c.id === vendor.categoryId);
          const payments = vendorExpenses(state, vendor.id);
          const paid = payments.reduce((s, e) => s + (Number(e.amount) || 0), 0);
          const isOpen = openVendor === vendor.id;
          const statusColor =
            vendor.status === "Booked" ? { bg: "#e4eede", fg: "#5c7a59" }
            : vendor.status === "Contacted" ? { bg: "#faf0d8", fg: "#a8862f" }
            : { bg: "#f4e8e4", fg: "#b07a72" };

          return (
            <div key={vendor.id} style={S.card}>
              <div style={{ ...S.cardHead, display: "flex", alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", flex: 1, cursor: "pointer" }} onClick={() => { setOpenVendor(isOpen ? null : vendor.id); setConfirmDeleteVendor(null); }}>
                  <span style={{ ...S.chevron, transform: isOpen ? "rotate(90deg)" : "none" }}>›</span>
                  <div style={S.catMain}>
                    <div style={S.catName}>{vendor.name || "New Vendor"}</div>
                    <div style={S.catNumbers}>
                      <span style={{ ...S.diffPill, background: statusColor.bg, color: statusColor.fg }}>{vendor.status}</span>
                      {vendor.type && <span style={S.catOf}>{vendor.type}</span>}
                      <span style={S.catSpent}>{fmt(paid)}</span>
                      {vendor.contracted > 0 && <span style={S.catOf}>of {fmt(vendor.contracted)}</span>}
                    </div>
                  </div>
                </div>
                {confirmDeleteVendor === vendor.id ? (
                  <div style={{ display: "flex", gap: 4, paddingRight: 10 }}>
                    <button onClick={(e) => { e.stopPropagation(); deleteVendor(vendor.id); setConfirmDeleteVendor(null); }}
                      style={S.trashConfirm}>Delete</button>
                    <button onClick={(e) => { e.stopPropagation(); setConfirmDeleteVendor(null); }}
                      style={S.trashCancel}>Cancel</button>
                  </div>
                ) : (
                  <button onClick={(e) => { e.stopPropagation(); setConfirmDeleteVendor(vendor.id); }}
                    style={S.trashBtn}><Icon name="trash" size={18} color="#c98b94" /></button>
                )}
              </div>

              {isOpen && (
                <div style={S.cardBody}>
                  {/* details */}
                  <div style={S.vendorFields}>
                    <Field label="Vendor name">
                      <input style={S.fieldInput} value={vendor.name} placeholder="Vendor name"
                        onChange={(e) => editVendor(vendor.id, { name: e.target.value })} />
                    </Field>
                    <Field label="Type">
                      <input style={S.fieldInput} placeholder="e.g. Photographer" value={vendor.type}
                        onChange={(e) => editVendor(vendor.id, { type: e.target.value })} />
                    </Field>
                    <Field label="Budget category">
                      <select style={S.fieldSelect} value={vendor.categoryId}
                        onChange={(e) => editVendor(vendor.id, { categoryId: e.target.value })}>
                        {state.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </Field>
                    <Field label="Status">
                      <select style={S.fieldSelect} value={vendor.status}
                        onChange={(e) => editVendor(vendor.id, { status: e.target.value })}>
                        {VENDOR_STATUSES.map((st) => <option key={st} value={st}>{st}</option>)}
                      </select>
                    </Field>
                    <Field label="Contracted total">
                      <div style={S.miniInputWrap}>
                        <span style={S.miniDollar}>$</span>
                        <input type="number" inputMode="numeric" style={S.miniInput}
                          value={vendor.contracted === 0 ? "" : vendor.contracted} placeholder="0"
                          onChange={(e) => editVendor(vendor.id, { contracted: Number(e.target.value) || 0 })} />
                      </div>
                    </Field>
                    <Field label="Phone">
                      <input style={S.fieldInput} placeholder="Phone" value={vendor.phone}
                        onChange={(e) => editVendor(vendor.id, { phone: e.target.value })} />
                    </Field>
                    <Field label="Email">
                      <input style={S.fieldInput} placeholder="Email" value={vendor.email}
                        onChange={(e) => editVendor(vendor.id, { email: e.target.value })} />
                    </Field>
                  </div>
                  <input style={S.taskNote} placeholder="Notes (quote details, what's included)…" value={vendor.notes}
                    onChange={(e) => editVendor(vendor.id, { notes: e.target.value })} />

                  {/* contracted vs paid bar */}
                  {vendor.contracted > 0 && (
                    <div style={{ marginTop: 14 }}>
                      <div style={S.bar}>
                        <div style={{ ...S.barFill, width: `${Math.min(100, (paid / vendor.contracted) * 100)}%`, background: "linear-gradient(90deg,#d9a7a0,#c98b94)" }} />
                      </div>
                      <div style={S.vendorPaidLine}>
                        {fmt(paid)} paid · {fmt(Math.max(0, vendor.contracted - paid))} remaining
                      </div>
                    </div>
                  )}

                  {/* payments — these ARE budget expenses */}
                  <div style={S.payLabel}>Payments {cat && <span style={S.payHint}>→ shown in {cat.name}</span>}</div>
                  {payments.map((e) => (
                    <div key={e.id} style={S.expItem}>
                      <div style={S.expItemTop}>
                        <input style={S.expDesc} value={e.desc} onChange={(ev) => editPayment(e.catId, e.id, { desc: ev.target.value })} />
                        <button style={S.expDelete} onClick={() => deletePayment(e.catId, e.id)}>×</button>
                      </div>
                      <div style={S.expItemBottom}>
                        <div style={S.expAmtWrap}>
                          <span style={S.miniDollar}>$</span>
                          <input type="number" inputMode="numeric" style={S.expAmt} value={e.amount}
                            onChange={(ev) => editPayment(e.catId, e.id, { amount: Number(ev.target.value) || 0 })} />
                        </div>
                        <input type="date" style={S.expDate} value={e.date} onChange={(ev) => editPayment(e.catId, e.id, { date: ev.target.value })} />
                        <button style={{ ...S.statusToggle, color: e.paid ? "#5c7a59" : "#a8862f", background: e.paid ? "#e4eede" : "#faf0d8" }}
                          onClick={() => editPayment(e.catId, e.id, { paid: !e.paid })}>
                          {e.paid ? "Paid" : "Upcoming"}
                        </button>
                      </div>
                    </div>
                  ))}
                  <PaymentAdd onAdd={(pay) => addPayment(vendor, pay)} />

                  <button style={{ ...S.deleteCat, marginTop: 14, display: "block" }} onClick={() => deleteVendor(vendor.id)}>
                    Delete vendor
                  </button>
                  <button style={S.doneBtn} onClick={() => setOpenVendor(null)}>Done</button>
                </div>
              )}
            </div>
          );
        })}

        <button style={S.addCat} onClick={addVendor}>+ Add vendor</button>
      </section>
    </>
  );
}

function Field({ label, children }) {
  return (
    <div style={S.field}>
      <label style={S.smallLabel}>{label}</label>
      {children}
    </div>
  );
}

function PaymentAdd({ onAdd }) {
  const [desc, setDesc] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [paid, setPaid] = useState(true);

  const submit = () => {
    if (!desc.trim() || !amount) return;
    onAdd({ desc: desc.trim(), amount: Number(amount) || 0, date, paid });
    setDesc(""); setAmount(""); setPaid(true);
  };

  return (
    <div style={S.addBox}>
      <div style={S.addBoxLabel}>Add a payment</div>
      <input style={S.addDesc} placeholder="e.g. Deposit" value={desc} onChange={(e) => setDesc(e.target.value)} />
      <div style={S.addRow}>
        <div style={S.expAmtWrap}>
          <span style={S.miniDollar}>$</span>
          <input type="number" inputMode="numeric" style={S.expAmt} placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <input type="date" style={S.expDate} value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      <div style={S.addRow}>
        <button style={{ ...S.statusToggleWide, color: paid ? "#5c7a59" : "#a8862f", background: paid ? "#e4eede" : "#faf0d8" }}
          onClick={() => setPaid(!paid)}>
          {paid ? "✓ Paid" : "◷ Upcoming"}
        </button>
      </div>
      <button style={{ ...S.addBtn, opacity: desc.trim() && amount ? 1 : 0.5 }} onClick={submit}>+ Add payment</button>
    </div>
  );
}

/* ============================================================
   GUESTS VIEW
   ============================================================ */

function GuestsView({ state, update }) {
  const [openGuest, setOpenGuest] = useState(null);
  const [filter, setFilter] = useState("All");
  const [query, setQuery] = useState("");
  const [managing, setManaging] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState({});
  const toggleGroup = (grp) => setCollapsedGroups((prev) => ({ ...prev, [grp]: !prev[grp] }));
  const [newGroupFor, setNewGroupFor] = useState(null);
  const [newGroupDraft, setNewGroupDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(null);

  const addOption = (listKey, val) =>
    update((s) => { if (val.trim() && !s[listKey].includes(val.trim())) s[listKey].push(val.trim()); return s; });
  const renameOption = (listKey, idx, val) =>
    update((s) => {
      const old = s[listKey][idx];
      s[listKey][idx] = val;
      const field = listKey === "mealOptions" ? "meal" : "group";
      for (const g of s.guests) if (g[field] === old) g[field] = val;
      return s;
    });
  const removeOption = (listKey, idx) =>
    update((s) => {
      const removed = s[listKey][idx];
      s[listKey].splice(idx, 1);
      const field = listKey === "mealOptions" ? "meal" : "group";
      for (const g of s.guests) if (g[field] === removed) g[field] = "";
      return s;
    });

  const guests = state.guests;
  const counts = {
    invited: guests.length,
    yes: guests.filter((g) => g.rsvp === "Yes").length,
    no: guests.filter((g) => g.rsvp === "No").length,
    waiting: guests.filter((g) => g.rsvp === "Invited" || g.rsvp === "Maybe").length,
  };
  const heads = headcount(guests);

  const byStatus = filter === "All" ? guests : guests.filter((g) => g.rsvp === filter);
  const q = query.trim().toLowerCase();
  const shown = !q
    ? byStatus
    : byStatus.filter((g) =>
        [g.name, g.group, g.notes].some((f) => (f || "").toLowerCase().includes(q))
      );

  const addGuest = () =>
    update((s) => {
      s.guests.push({ id: uid(), name: "", rsvp: "Invited", party: 1, meal: "", group: "", notes: "" });
      return s;
    });
  const editGuest = (id, patch) =>
    update((s) => { const g = s.guests.find((x) => x.id === id); if (g) Object.assign(g, patch); return s; });
  const deleteGuest = (id) =>
    update((s) => { s.guests = s.guests.filter((x) => x.id !== id); return s; });

  const rsvpColor = (st) =>
    st === "Yes" ? { bg: "#e4eede", fg: "#5c7a59" }
    : st === "No" ? { bg: "#f7dde2", fg: "#c2566b" }
    : st === "Maybe" ? { bg: "#faf0d8", fg: "#a8862f" }
    : { bg: "#f4e8e4", fg: "#b07a72" };

  return (
    <>
      <header style={S.header}>
        <div style={S.kicker}>The Wedding</div>
        <h1 style={S.title}>Guests</h1>
      </header>

      <section style={S.dashboard}>
        <div style={S.guestStats}>
          <GuestStat n={counts.yes} label="Coming" accent="#5c7a59" />
          <GuestStat n={counts.waiting} label="Awaiting" accent="#a8862f" />
          <GuestStat n={counts.no} label="Declined" accent="#c2566b" />
          <GuestStat n={counts.invited} label="Invited" accent="#8a6d68" />
        </div>
        <div style={S.headcountBox}>
          <span style={S.headcountNum}>{heads}</span>
          <span style={S.headcountLabel}>total guests coming (incl. +1s) — your caterer headcount</span>
        </div>
      </section>

      {/* search */}
      <div style={S.searchWrap}>
        <span style={S.searchIcon}>⌕</span>
        <input style={S.searchInput} placeholder="Search by name, group, or notes…"
          value={query} onChange={(e) => setQuery(e.target.value)} />
        {query && <button style={S.searchClear} onClick={() => setQuery("")}>×</button>}
      </div>

      {/* filter pills */}
      <div style={S.filterRow}>
        {["All", "Invited", "Yes", "Maybe", "No"].map((f) => (
          <button key={f} onClick={() => setFilter(f)}
            style={{ ...S.filterPill, background: filter === f ? "#c98b94" : "#fff", color: filter === f ? "#fff" : "#b58e87", borderColor: filter === f ? "#c98b94" : "#f0e2dd" }}>
            {f}
          </button>
        ))}
        <button onClick={() => setManaging((m) => !m)}
          style={{ ...S.filterPill, marginLeft: "auto", background: managing ? "#6b4a45" : "#fff", color: managing ? "#fff" : "#b58e87", borderColor: managing ? "#6b4a45" : "#f0e2dd" }}>
          {managing ? "Done" : "⚙ Options"}
        </button>
      </div>

      {managing && (
        <section style={S.dashboard}>
          <OptionEditor title="Meal options" listKey="mealOptions" items={state.mealOptions}
            onAdd={addOption} onRename={renameOption} onRemove={removeOption} />
          <div style={{ height: 18 }} />
          <OptionEditor title="Group / side options" listKey="groupOptions" items={state.groupOptions}
            onAdd={addOption} onRename={renameOption} onRemove={removeOption} />
        </section>
      )}

      <section>
        {guests.length === 0 && (
          <div style={S.emptyNote}>No guests yet. Tap "Add guest" to start your list.</div>
        )}
        {guests.length > 0 && shown.length === 0 && (
          <div style={S.emptyNote}>No guests match your search or filter.</div>
        )}

        {(() => {
          // Group guests: named groups first (sorted), then ungrouped under "Other"
          const groupNames = [...new Set(shown.map((g) => g.group || ""))];
          const named = groupNames.filter((x) => x).sort();
          const hasUngrouped = groupNames.includes("");
          const allGroups = [...named, ...(hasUngrouped ? [""] : [])];

          return allGroups.map((grp) => {
            const members = shown.filter((g) => (g.group || "") === grp);
            const label = grp || "No group";
            const isCollapsed = !!collapsedGroups[grp];
            const yesCount = members.filter((g) => g.rsvp === "Yes").length;
            return (
              <div key={grp || "__none__"} style={{ marginBottom: 6 }}>
                {/* Group header */}
                <div onClick={() => toggleGroup(grp)}
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 14px", background: "#fdf4f1", borderRadius: 10, cursor: "pointer", userSelect: "none", marginBottom: 2 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 13, color: "#b58e87", transition: "transform 0.15s", display: "inline-block", transform: isCollapsed ? "rotate(0deg)" : "rotate(90deg)" }}>›</span>
                    <span style={{ fontFamily: "'Fraunces', serif", fontSize: 15, fontWeight: 600, color: "#6b4a45" }}>{label}</span>
                  </div>
                  <span style={{ fontSize: 12, color: "#c4aaa4" }}>
                    {yesCount > 0 ? `${yesCount} coming · ` : ""}{members.length} guest{members.length !== 1 ? "s" : ""}
                  </span>
                </div>

                {/* Compact rows */}
                {!isCollapsed && (
                  <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #f0e2dd", overflow: "hidden" }}>
                    {members.map((g, idx) => {
                      const isOpen = openGuest === g.id;
                      const c = rsvpColor(g.rsvp);
                      return (
                        <div key={g.id}>
                          <div style={{ display: "flex", alignItems: "center", borderBottom: idx < members.length - 1 || isOpen ? "1px solid #f7ece8" : "none" }}>
                            <div onClick={() => { setOpenGuest(isOpen ? null : g.id); setConfirmDelete(null); }}
                              style={{ display: "flex", alignItems: "center", flex: 1, padding: "10px 14px", cursor: "pointer", gap: 10, minWidth: 0 }}>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: 15, fontWeight: 600, color: "#3a2e2c", fontFamily: "'Fraunces', serif", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                  {g.name || "Guest"}
                                </div>
                                {(g.meal || Number(g.party) > 1) && (
                                  <div style={{ fontSize: 12, color: "#b58e87", marginTop: 1 }}>
                                    {g.meal && <span>{g.meal}</span>}
                                    {g.meal && Number(g.party) > 1 && <span> · </span>}
                                    {Number(g.party) > 1 && <span>+{Number(g.party) - 1}</span>}
                                  </div>
                                )}
                              </div>
                              <span style={{ ...S.diffPill, background: c.bg, color: c.fg, fontSize: 11, flexShrink: 0 }}>{g.rsvp}</span>
                              <span style={{ color: "#d9c8c3", fontSize: 16, flexShrink: 0 }}>›</span>
                            </div>
                            {confirmDelete === g.id ? (
                              <div style={{ display: "flex", gap: 4, paddingRight: 10, flexShrink: 0 }}>
                                <button onClick={(e) => { e.stopPropagation(); deleteGuest(g.id); setConfirmDelete(null); }}
                                  style={{ background: "#c2566b", color: "#fff", border: "none", borderRadius: 8, padding: "6px 10px", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>Delete</button>
                                <button onClick={(e) => { e.stopPropagation(); setConfirmDelete(null); }}
                                  style={{ background: "#f4e8e4", color: "#b58e87", border: "none", borderRadius: 8, padding: "6px 10px", fontSize: 12, cursor: "pointer" }}>Cancel</button>
                              </div>
                            ) : (
                              <button onClick={(e) => { e.stopPropagation(); setConfirmDelete(g.id); }}
                                style={S.trashBtn}>
                                <Icon name="trash" size={18} color="#c98b94" />
                              </button>
                            )}
                          </div>

                          {isOpen && (
                            <div style={{ ...S.cardBody, borderTop: "none", borderBottom: idx < members.length - 1 ? "1px solid #f7ece8" : "none" }}>
                              <div style={S.vendorFields}>
                                <Field label="Guest name">
                                  <input style={S.fieldInput} placeholder="Guest name" value={g.name}
                                    onChange={(e) => editGuest(g.id, { name: e.target.value })} />
                                </Field>
                                <Field label="RSVP">
                                  <select style={S.fieldSelect} value={g.rsvp} onChange={(e) => editGuest(g.id, { rsvp: e.target.value })}>
                                    {RSVP_STATUSES.map((st) => <option key={st} value={st}>{st}</option>)}
                                  </select>
                                </Field>
                                <Field label="Party size (incl. guest)">
                                  <input type="number" inputMode="numeric" min="1" style={S.fieldInput}
                                    value={g.party} onChange={(e) => editGuest(g.id, { party: Math.max(1, Number(e.target.value) || 1) })} />
                                </Field>
                                <Field label="Meal">
                                  <select style={S.fieldSelect} value={g.meal} onChange={(e) => editGuest(g.id, { meal: e.target.value })}>
                                    <option value="">—</option>
                                    {state.mealOptions.map((m) => <option key={m} value={m}>{m}</option>)}
                                  </select>
                                </Field>
                                <Field label="Group / side">
                                  <select style={S.fieldSelect} value={g.group}
                                    onChange={(e) => {
                                      if (e.target.value === "__add__") { setNewGroupFor(g.id); setNewGroupDraft(""); }
                                      else editGuest(g.id, { group: e.target.value });
                                    }}>
                                    <option value="">—</option>
                                    {state.groupOptions.map((gr) => <option key={gr} value={gr}>{gr}</option>)}
                                    <option value="__add__">+ New group…</option>
                                  </select>
                                  {newGroupFor === g.id && (
                                    <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
                                      <input
                                        ref={(el) => el && setTimeout(() => el.focus(), 80)}
                                        style={{ ...S.fieldInput, width: "100%", boxSizing: "border-box", fontSize: 15 }}
                                        placeholder="Type group name…"
                                        value={newGroupDraft}
                                        onChange={(e) => setNewGroupDraft(e.target.value)}
                                        onKeyDown={(e) => {
                                          if (e.key === "Enter" && newGroupDraft.trim()) {
                                            addOption("groupOptions", newGroupDraft.trim());
                                            editGuest(g.id, { group: newGroupDraft.trim() });
                                            setNewGroupFor(null); setNewGroupDraft("");
                                          } else if (e.key === "Escape") { setNewGroupFor(null); setNewGroupDraft(""); }
                                        }} />
                                      <div style={{ display: "flex", gap: 8 }}>
                                        <button style={{ ...S.addBtn, marginTop: 0, flex: 1, fontSize: 14, padding: "12px" }}
                                          onClick={() => {
                                            if (!newGroupDraft.trim()) return;
                                            addOption("groupOptions", newGroupDraft.trim());
                                            editGuest(g.id, { group: newGroupDraft.trim() });
                                            setNewGroupFor(null); setNewGroupDraft("");
                                          }}>Save group</button>
                                        <button style={{ background: "transparent", border: "1px solid #f0e2dd", borderRadius: 10, padding: "12px 16px", color: "#b58e87", fontSize: 14, cursor: "pointer" }}
                                          onClick={() => { setNewGroupFor(null); setNewGroupDraft(""); }}>Cancel</button>
                                      </div>
                                    </div>
                                  )}
                                </Field>
                              </div>
                              <input style={S.taskNote} placeholder="Notes (dietary needs, address)…" value={g.notes}
                                onChange={(e) => editGuest(g.id, { notes: e.target.value })} />
                              <button style={{ ...S.deleteCat, marginTop: 14, display: "block" }} onClick={() => deleteGuest(g.id)}>
                                Remove guest
                              </button>
                              <button style={S.doneBtn} onClick={() => setOpenGuest(null)}>Done</button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          });
        })()}

        <button style={S.addCat} onClick={addGuest}>+ Add guest</button>
      </section>
    </>
  );
}

function GuestStat({ n, label, accent }) {
  return (
    <div style={S.statBox}>
      <div style={{ ...S.statValue, color: accent }}>{n}</div>
      <div style={S.statLabel}>{label}</div>
    </div>
  );
}

function OptionEditor({ title, listKey, items, onAdd, onRename, onRemove }) {
  const [draft, setDraft] = useState("");
  const submit = () => { if (!draft.trim()) return; onAdd(listKey, draft); setDraft(""); };
  return (
    <div>
      <div style={S.smallLabel}>{title}</div>
      <div style={S.optList}>
        {items.map((item, i) => (
          <div key={i} style={S.optRow}>
            <input style={S.optInput} value={item} onChange={(e) => onRename(listKey, i, e.target.value)} />
            <button style={S.expDelete} onClick={() => onRemove(listKey, i)}>×</button>
          </div>
        ))}
      </div>
      <div style={S.addTaskRow}>
        <input style={S.addTaskInput} placeholder={`Add an option…`} value={draft}
          onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
        <button style={{ ...S.expAdd, opacity: draft.trim() ? 1 : 0.5 }} onClick={submit}>+</button>
      </div>
    </div>
  );
}

/* ============================================================
   PDF EXPORT
   ------------------------------------------------------------
   Dependency-free: we build a print-optimized HTML document for
   the whole plan and hand it to the browser's print dialog, where
   "Save as PDF" is available on every platform. Keeping it library-
   free matches the rest of the app (React + nothing else).
   ============================================================ */

// Escape user-entered text before it goes into the print document.
function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildPlannerHtml(state) {
  const names =
    state.partner1 && state.partner2
      ? `${state.partner1} & ${state.partner2}`
      : state.partner1 || state.partner2 || "Our Wedding";
  const dateLabel = state.weddingDate
    ? new Date(state.weddingDate + "T00:00:00").toLocaleDateString(undefined, {
        weekday: "long", year: "numeric", month: "long", day: "numeric",
      })
    : "Date to be decided";

  // ---- Budget ----
  const totalSpent = state.categories.reduce((s, c) => s + catSpent(c), 0);
  const remaining = state.total - totalSpent;
  const budgetRows = state.categories
    .map((c) => {
      const spent = catSpent(c);
      const expenses = c.expenses
        .map(
          (e) =>
            `<div class="sub">${esc(e.desc) || "Expense"} — ${esc(fmt(e.amount))} <span class="muted">(${e.paid ? "Paid" : "Upcoming"}${e.date ? ` · ${esc(e.date)}` : ""})</span></div>`
        )
        .join("");
      return `<tr><td><strong>${esc(c.name)}</strong>${expenses}</td><td class="num">${esc(fmt(spent))}</td><td class="num muted">${esc(fmt(c.allocated))}</td></tr>`;
    })
    .join("");

  // ---- Checklist ----
  const checklistHtml = state.checklist
    .map((b) => {
      const done = b.tasks.filter((t) => t.done).length;
      const items = b.tasks
        .map(
          (t) =>
            `<li class="${t.done ? "done" : ""}">${t.done ? "☑" : "☐"} ${esc(t.name)}${t.due ? ` <span class="muted">— due ${esc(t.due)}</span>` : ""}${t.note ? `<div class="note">${esc(t.note)}</div>` : ""}</li>`
        )
        .join("");
      return `<div class="block"><h3>${esc(b.label)} <span class="muted">(${done}/${b.tasks.length})</span></h3><ul>${items}</ul></div>`;
    })
    .join("");

  // ---- Vendors ----
  const vendorRows = (state.vendors || [])
    .map((v) => {
      const paid = vendorExpenses(state, v.id).reduce((s, e) => s + (Number(e.amount) || 0), 0);
      const contact = [v.phone, v.email].filter(Boolean).map(esc).join(" · ");
      return `<tr><td><strong>${esc(v.name)}</strong>${v.type ? `<div class="muted">${esc(v.type)}</div>` : ""}${contact ? `<div class="sub">${contact}</div>` : ""}</td><td>${esc(v.status)}</td><td class="num">${esc(fmt(paid))}${v.contracted > 0 ? ` <span class="muted">/ ${esc(fmt(v.contracted))}</span>` : ""}</td></tr>`;
    })
    .join("");

  // ---- Guests ----
  const heads = headcount(state.guests);
  const guestRows = (state.guests || [])
    .map(
      (g) =>
        `<tr><td>${esc(g.name) || "Guest"}${Number(g.party) > 1 ? ` <span class="muted">+${g.party - 1}</span>` : ""}</td><td>${esc(g.rsvp)}</td><td>${esc(g.group) || "—"}</td><td>${esc(g.meal) || "—"}</td></tr>`
    )
    .join("");

  // ---- Seating ----
  const guestName = (id) => (state.guests || []).find((g) => g.id === id)?.name || "Unnamed";
  const seatingHtml = (state.tables || [])
    .map((t) => {
      const seated = (t.seated || []).map((gid) => `<li>${esc(guestName(gid))}</li>`).join("");
      return `<div class="block"><h3>${esc(t.name)} <span class="muted">(${(t.seated || []).length}/${t.capacity})</span></h3><ul>${seated || '<li class="muted">Empty</li>'}</ul></div>`;
    })
    .join("");

  const section = (title, body, show = true) =>
    show ? `<section><h2>${title}</h2>${body}</section>` : "";

  return `<!doctype html><html><head><meta charset="utf-8" />
<title>${esc(names)} — Wedding Plan</title>
<style>
  @page { margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body { font-family: Georgia, 'Times New Roman', serif; color: #3a2e2c; margin: 0; line-height: 1.45; }
  .cover { text-align: center; padding: 40px 0 28px; border-bottom: 2px solid #e9d3cd; margin-bottom: 28px; }
  .kicker { text-transform: uppercase; letter-spacing: 0.18em; font-size: 12px; color: #b07a72; }
  h1 { font-size: 34px; margin: 8px 0 6px; font-weight: 600; }
  .cover .date { font-size: 16px; color: #6b4a45; }
  .cover .venue { font-size: 14px; color: #8a6d68; margin-top: 4px; }
  .vision { font-style: italic; color: #6b4a45; max-width: 460px; margin: 14px auto 0; }
  section { margin-bottom: 26px; page-break-inside: avoid; }
  h2 { font-size: 19px; color: #b07a72; border-bottom: 1px solid #f0e2dd; padding-bottom: 5px; margin: 0 0 12px; }
  h3 { font-size: 14px; margin: 0 0 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td, th { text-align: left; padding: 7px 6px; border-bottom: 1px solid #f2e6e2; vertical-align: top; }
  th { color: #b58e87; text-transform: uppercase; letter-spacing: 0.06em; font-size: 11px; }
  .num { text-align: right; white-space: nowrap; }
  .muted { color: #a98e88; font-weight: normal; }
  .sub { font-size: 12px; color: #8a6d68; margin-top: 2px; }
  .note { font-size: 12px; color: #8a6d68; margin-left: 18px; }
  .block { margin-bottom: 14px; page-break-inside: avoid; }
  ul { margin: 0; padding-left: 20px; font-size: 13px; }
  li { margin: 2px 0; }
  li.done { color: #9c8f8b; }
  .summary { display: flex; gap: 10px; margin-bottom: 14px; }
  .stat { flex: 1; border: 1px solid #f0e2dd; border-radius: 8px; padding: 10px; text-align: center; }
  .stat .big { font-size: 18px; font-weight: 600; }
  .stat .lbl { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #b58e87; }
  .foot { text-align: center; font-size: 11px; color: #b58e87; margin-top: 30px; }
</style></head>
<body>
  <div class="cover">
    <div class="kicker">Wedding Plan</div>
    <h1>${esc(names)}</h1>
    <div class="date">${esc(dateLabel)}</div>
    ${state.venue ? `<div class="venue">${esc(state.venue)}</div>` : ""}
    ${state.vision ? `<div class="vision">“${esc(state.vision)}”</div>` : ""}
  </div>

  ${section(
    "Budget",
    `<div class="summary">
      <div class="stat"><div class="big">${esc(fmt(state.total))}</div><div class="lbl">Total</div></div>
      <div class="stat"><div class="big">${esc(fmt(totalSpent))}</div><div class="lbl">Spent</div></div>
      <div class="stat"><div class="big">${esc(fmt(remaining))}</div><div class="lbl">Remaining</div></div>
    </div>
    <table><thead><tr><th>Category</th><th class="num">Spent</th><th class="num">Allocated</th></tr></thead><tbody>${budgetRows}</tbody></table>`
  )}

  ${section("Checklist", checklistHtml)}

  ${section(
    "Vendors",
    `<table><thead><tr><th>Vendor</th><th>Status</th><th class="num">Paid</th></tr></thead><tbody>${vendorRows}</tbody></table>`,
    (state.vendors || []).length > 0
  )}

  ${section(
    "Guests",
    `<div class="summary"><div class="stat"><div class="big">${heads}</div><div class="lbl">Coming (incl. +1s)</div></div></div>
    <table><thead><tr><th>Name</th><th>RSVP</th><th>Group</th><th>Meal</th></tr></thead><tbody>${guestRows}</tbody></table>`,
    (state.guests || []).length > 0
  )}

  ${section("Seating", `<div class="seating">${seatingHtml}</div>`, (state.tables || []).length > 0)}

  <div class="foot">Created with Planourdays · ${esc(new Date().toLocaleDateString())}</div>
</body></html>`;
}

/* ============================================================
   SETTINGS VIEW
   ============================================================ */

// "3 min ago" / "2 hours ago" / a date for older syncs. null = never.
function relTime(ts) {
  if (!ts) return "never";
  const diff = Date.now() - ts;
  if (diff < 60 * 1000) return "just now";
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  return new Date(ts).toLocaleDateString();
}

function SettingsView({ state, update, setState, go, connected, onSignOut, sync }) {
  const [confirmingReset, setConfirmingReset] = useState(false);

  const setCurrency = (code) => update((s) => { s.currency = code; return s; });

  const exportData = () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `wedding-planner-backup-${stamp}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportPDF = () => {
    const html = buildPlannerHtml(state);
    const win = window.open("", "_blank");
    if (!win) {
      alert("Please allow pop-ups for this site to export your plan to PDF.");
      return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
    // Wait for fonts/layout before invoking the browser's print → Save as PDF.
    win.onload = () => {
      win.focus();
      win.print();
    };
  };

  const importData = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!isValidStateBlob(parsed)) {
          alert("That file couldn't be read as a valid backup.");
          return;
        }
        setState(hydrate(parsed));
        go("home");
      } catch {
        alert("That file couldn't be read as a valid backup.");
      }
    };
    reader.readAsText(file);
  };

  const doReset = () => {
    setState(makeInitialState());
    setConfirmingReset(false);
    go("home");
  };

  return (
    <>
      <header style={S.settingsHeader}>
        <button style={S.backBtn} onClick={() => go("home")}>
          <Icon name="back" size={20} color="#b07a72" />
        </button>
        <h1 style={S.settingsTitle}>Settings</h1>
        <div style={{ width: 36 }} />
      </header>

      {/* Currency */}
      <section style={S.dashboard}>
        <div style={S.smallLabel}>Currency</div>
        <p style={S.settingHint}>Used everywhere money is shown.</p>
        <select style={{ ...S.fieldSelect, width: "100%", marginTop: 6 }} value={state.currency || "AUD"}
          onChange={(e) => setCurrency(e.target.value)}>
          {Object.entries(CURRENCIES).map(([code, info]) => (
            <option key={code} value={code}>{info.label}</option>
          ))}
        </select>
        <div style={S.currencyPreview}>Preview: {fmt(12500)}</div>
      </section>

      {/* Export to PDF */}
      <section style={S.dashboard}>
        <div style={S.smallLabel}>Export to PDF</div>
        <p style={S.settingHint}>Create a printable PDF of your whole plan — couple details, budget, checklist, vendors, guests and seating. Opens your print dialog; choose “Save as PDF”.</p>
        <button style={S.settingBtn} onClick={exportPDF}>Export plan to PDF</button>
      </section>

      {/* Backup */}
      <section style={S.dashboard}>
        <div style={S.smallLabel}>Backup & restore</div>
        <p style={S.settingHint}>Save a copy of everything to a file, or restore from one. Handy while your data lives on this device.</p>
        <button style={S.settingBtn} onClick={exportData}>Export a backup file</button>
        <label style={{ ...S.settingBtn, ...S.settingBtnOutline, display: "block", textAlign: "center", marginTop: 10 }}>
          Restore from a backup file
          <input type="file" accept="application/json,.json" style={{ display: "none" }}
            onChange={(e) => { importData(e.target.files[0]); e.target.value = ""; }} />
        </label>
      </section>

      {/* Reset */}
      <section style={S.dashboard}>
        <div style={S.smallLabel}>Reset</div>
        <p style={S.settingHint}>Clears everything and starts fresh. This can't be undone — export a backup first if unsure.</p>
        {!confirmingReset ? (
          <button style={{ ...S.settingBtn, ...S.settingBtnDanger }} onClick={() => setConfirmingReset(true)}>
            Reset all data
          </button>
        ) : (
          <div style={S.confirmBox}>
            <div style={S.confirmText}>Really erase everything and start over?</div>
            <div style={S.confirmRow}>
              <button style={{ ...S.settingBtn, ...S.settingBtnOutline, flex: 1 }} onClick={() => setConfirmingReset(false)}>Cancel</button>
              <button style={{ ...S.settingBtn, ...S.settingBtnDanger, flex: 1 }} onClick={doReset}>Yes, reset</button>
            </div>
          </div>
        )}
      </section>

      {/* Sync */}
      {sync && <SyncPanel sync={sync} />}

      <section style={S.dashboard}>
        <div style={S.smallLabel}>Account</div>
        <p style={S.settingHint}>
          {connected
            ? "Your plan syncs to a private folder in your Google Drive. Signing out disconnects Drive and returns you to the welcome screen; your plan stays on this device."
            : "You'll return to the welcome screen, where you can sign in with Google to sync across devices. Your saved plan stays on this device."}
        </p>
        <button style={{ ...S.settingBtn, ...S.settingBtnOutline }} onClick={() => onSignOut && onSignOut()}>
          {connected ? "Disconnect Google & sign out" : "Sign out"}
        </button>
      </section>
    </>
  );
}

// One place to see and control how the plan is stored. Reflects the
// live sync/save state (including NEEDS_RECONNECT) and lets the user
// toggle between syncing to Google Drive and this-device-only.
function SyncPanel({ sync }) {
  const { intent, syncState, saveState, lastSync, busy, onSwitchToLocal, onSwitchToSync, onReconnect } = sync;
  const isSync = intent === "sync";
  const needsReconnect = syncState === NEEDS_RECONNECT;
  const statusLabel = needsReconnect ? "Reconnect needed" : saveStateLabel(saveState).label;

  const rowStyle = { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: "1px solid #f4e8e4", fontSize: 14 };

  return (
    <section style={S.dashboard}>
      <div style={S.smallLabel}>Sync</div>
      <p style={S.settingHint}>
        {isSync
          ? "Your plan syncs privately to your own Google Drive, so it's backed up and follows you across devices."
          : "Your plan is saved on this device only. Turn on sync to back it up to your own Google Drive and use it on other devices."}
      </p>

      <div style={{ margin: "6px 0 14px" }}>
        <div style={rowStyle}>
          <span style={{ color: "#7a655f" }}>Storage</span>
          <span style={{ fontWeight: 600, color: "#3a2e2c" }}>{isSync ? "Google Drive" : "This device only"}</span>
        </div>
        {isSync && (
          <>
            <div style={rowStyle}>
              <span style={{ color: "#7a655f" }}>Status</span>
              <span style={{ fontWeight: 600, color: needsReconnect ? "#b0524a" : "#3a2e2c" }}>{statusLabel}</span>
            </div>
            <div style={{ ...rowStyle, borderBottom: "none" }}>
              <span style={{ color: "#7a655f" }}>Last synced</span>
              <span style={{ fontWeight: 600, color: "#3a2e2c" }}>{relTime(lastSync)}</span>
            </div>
          </>
        )}
      </div>

      {needsReconnect && (
        <button style={{ ...S.settingBtn, opacity: busy ? 0.6 : 1 }} onClick={onReconnect} disabled={busy}>
          {busy ? "Reconnecting…" : "Reconnect Google Drive"}
        </button>
      )}

      {isSync ? (
        <button style={{ ...S.settingBtn, ...S.settingBtnOutline, marginTop: needsReconnect ? 10 : 0 }} onClick={onSwitchToLocal} disabled={busy}>
          Switch to this-device-only
        </button>
      ) : (
        <button style={{ ...S.settingBtn, opacity: busy ? 0.6 : 1 }} onClick={onSwitchToSync} disabled={busy}>
          {busy ? "Connecting…" : "Turn on sync with Google"}
        </button>
      )}
    </section>
  );
}

/* ============================================================
   SEATING VIEW
   ------------------------------------------------------------
   Visual floor plan. Guests come from the real guest list.
   Seating is stored as { [tableId]: [guestId, ...] } on each table.
   Interaction: tap a guest then tap a table (always works), OR
   drag a guest chip onto a table (pointer-based so it doesn't
   fight page scroll on touch).
   ============================================================ */

const TABLE_TYPES = [
  { type: "Round", icon: "⬤", capacity: 8  },
  { type: "Long",  icon: "▬", capacity: 20 },
];

function SeatingView({ state, update }) {
  const [selectedGuest, setSelectedGuest] = useState(null);
  const [addingTable, setAddingTable] = useState(false);

  const tables = state.tables || [];
  const guests = state.guests || [];

  // Which table each guest is at (or null).
  const seatOf = {};
  for (const t of tables) for (const gid of t.seated || []) seatOf[gid] = t.id;
  const unseated = guests.filter((g) => !seatOf[g.id]);
  const seatedCount = guests.length - unseated.length;

  /* ---- table mutations ---- */
  const addTable = (type, capacity) =>
    update((s) => {
      const n = (s.tables?.length || 0) + 1;
      if (!s.tables) s.tables = [];
      s.tables.push({ id: uid(), name: `${type} ${n}`, capacity, tableType: type, seated: [] });
      return s;
    });
  const editTable = (id, patch) =>
    update((s) => { const t = s.tables.find((x) => x.id === id); if (t) Object.assign(t, patch); return s; });
  const removeTable = (id) =>
    update((s) => { s.tables = s.tables.filter((x) => x.id !== id); return s; });

  /* ---- seating mutations ---- */
  const assign = (guestId, tableId) =>
    update((s) => {
      for (const t of s.tables) t.seated = (t.seated || []).filter((gid) => gid !== guestId);
      if (tableId) {
        const t = s.tables.find((x) => x.id === tableId);
        if (t) t.seated.push(guestId);
      }
      return s;
    });

  const guestById = (id) => guests.find((g) => g.id === id);
  const rsvpDot = (g) =>
    g.rsvp === "Yes" ? "#5c7a59" : g.rsvp === "No" ? "#c2566b" : g.rsvp === "Maybe" ? "#a8862f" : "#b07a72";

  // Group the unseated guests by their Group/side, preserving the order
  // groups were defined in, with anyone ungrouped last.
  const groupedUnseated = (() => {
    const buckets = new Map();
    for (const g of unseated) {
      const key = g.group || "Ungrouped";
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(g);
    }
    const order = [...(state.groupOptions || []), "Ungrouped"];
    return [...buckets.entries()].sort(
      (a, b) => (order.indexOf(a[0]) + 1 || 999) - (order.indexOf(b[0]) + 1 || 999)
    );
  })();

  /* ---- tap to assign ---- */
  const onGuestTap = (guestId) => setSelectedGuest((cur) => (cur === guestId ? null : guestId));
  const onTableTap = (tableId) => {
    if (selectedGuest) { assign(selectedGuest, tableId); setSelectedGuest(null); }
  };
  const selectedName = selectedGuest ? (guestById(selectedGuest)?.name || "guest") : null;

  return (
    <>
      <header style={S.header}>
        <div style={S.kicker}>The Wedding</div>
        <h1 style={S.title}>Seating</h1>
      </header>

      <section style={S.dashboard}>
        <div style={S.progressRow}>
          <span style={S.progressBig}>{seatedCount} of {guests.length}</span>
          <span style={S.progressSmall}>guests seated</span>
        </div>
        <p style={{ ...S.settingHint, textAlign: "center", marginTop: 10 }}>
          Tap a guest below, then tap a table to seat them. Tap a seated name to remove them.
        </p>
      </section>

      {guests.length === 0 && (
        <div style={S.emptyNote}>Add guests on the Guests tab first — they'll appear here to seat.</div>
      )}

      {/* TABLES */}
      <div style={S.tableGrid}>
        {tables.map((t) => {
          const over = t.seated.length;
          const full = over > t.capacity;
          const armed = !!selectedGuest; // a guest is staged, so tables are tap targets
          return (
            <div key={t.id}
              onClick={() => onTableTap(t.id)}
              style={{
                ...S.table,
                borderColor: full ? "#c2566b" : armed ? "#c98b94" : "#e9d3cd",
                boxShadow: armed ? "0 0 0 3px rgba(201,139,148,0.22)" : S.table.boxShadow,
                cursor: armed ? "pointer" : "default",
              }}>
              <div style={S.tableTopRow}>
                <span style={{ fontSize: 14, marginRight: 4, opacity: 0.7 }}>{TABLE_TYPES.find((x) => x.type === t.tableType)?.icon || "⬤"}</span>
                <input style={S.tableName} value={t.name} onClick={(e) => e.stopPropagation()}
                  onChange={(e) => editTable(t.id, { name: e.target.value })} />
                <button style={S.tableRemove} onClick={(e) => { e.stopPropagation(); removeTable(t.id); }}>×</button>
              </div>

              <div style={S.tableCircle}>
                <span style={{ ...S.tableCount, color: full ? "#c2566b" : "#6b4a45" }}>{over}/{t.capacity}</span>
              </div>

              <div style={S.seatedList}>
                {t.seated.map((gid) => {
                  const g = guestById(gid);
                  if (!g) return null;
                  return (
                    <span key={gid} style={S.seatedChip} onClick={(e) => { e.stopPropagation(); assign(gid, null); }}>
                      <span style={{ ...S.dot, background: rsvpDot(g) }} />
                      {g.name || "Unnamed"} <span style={S.chipX}>×</span>
                    </span>
                  );
                })}
                {t.seated.length === 0 && <span style={S.seatHint}>{armed ? "Tap to seat here" : "Empty"}</span>}
              </div>

              <div style={S.capRow} onClick={(e) => e.stopPropagation()}>
                <span style={S.smallLabel}>Seats</span>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <button onClick={() => editTable(t.id, { capacity: Math.max(1, t.capacity - 1) })}
                    style={{ width: 28, height: 28, borderRadius: 8, border: "1px solid #f0e2dd", background: "#fff", fontSize: 18, lineHeight: 1, cursor: "pointer", color: "#6b4a45", display: "flex", alignItems: "center", justifyContent: "center" }}>−</button>
                  <span style={{ minWidth: 24, textAlign: "center", fontWeight: 600, color: "#6b4a45", fontSize: 14 }}>{t.capacity}</span>
                  <button onClick={() => editTable(t.id, { capacity: t.capacity + 1 })}
                    style={{ width: 28, height: 28, borderRadius: 8, border: "1px solid #f0e2dd", background: "#fff", fontSize: 18, lineHeight: 1, cursor: "pointer", color: "#6b4a45", display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
                </div>
              </div>

              <select
                value=""
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => { if (e.target.value) { assign(e.target.value, t.id); e.target.value = ""; } }}
                style={S.tableAddSelect}>
                <option value="">+ Add guest…</option>
                {groupedUnseated.map(([groupName, members]) => (
                  <optgroup key={groupName} label={groupName}>
                    {members.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name || "Unnamed"}{Number(g.party) > 1 ? ` +${g.party - 1}` : ""}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
          );
        })}

        {addingTable ? (
          <div style={{ ...S.table, cursor: "default", display: "flex", flexDirection: "column", gap: 8, justifyContent: "center" }}>
            <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.08em", color: "#b58e87", fontWeight: 600, marginBottom: 4 }}>Choose table type</div>
            {TABLE_TYPES.map((tt) => (
              <button key={tt.type} onClick={() => { addTable(tt.type, tt.capacity); setAddingTable(false); }}
                style={{ display: "flex", alignItems: "center", gap: 10, background: "#fdf4f1", border: "1px solid #f0e2dd", borderRadius: 10, padding: "10px 14px", cursor: "pointer", textAlign: "left" }}>
                <span style={{ fontSize: 18, width: 24, textAlign: "center" }}>{tt.icon}</span>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "#6b4a45" }}>{tt.type}</div>
                  <div style={{ fontSize: 11, color: "#b58e87" }}>{tt.capacity} seats</div>
                </div>
              </button>
            ))}
            <button onClick={() => setAddingTable(false)}
              style={{ background: "none", border: "none", color: "#b58e87", fontSize: 13, cursor: "pointer", marginTop: 4 }}>Cancel</button>
          </div>
        ) : (
          <button style={S.addTable} onClick={() => setAddingTable(true)}>+ Add table</button>
        )}
      </div>

      {/* UNSEATED TRAY */}
      <div style={S.tray}>
        <div style={S.smallLabel}>Unseated guests ({unseated.length})</div>
        {unseated.length === 0 && guests.length > 0 && (
          <div style={{ ...S.trayChips, marginTop: 10 }}><span style={S.seatHint}>Everyone's seated 🎉</span></div>
        )}
        {groupedUnseated.map(([groupName, members]) => (
          <div key={groupName} style={S.traySection}>
            <div style={S.traySectionHead}>{groupName} <span style={S.traySectionCount}>{members.length}</span></div>
            <div style={S.trayChips}>
              {members.map((g) => (
                <span key={g.id}
                  onClick={() => onGuestTap(g.id)}
                  style={{
                    ...S.guestChip,
                    borderColor: selectedGuest === g.id ? "#c98b94" : "#ead7d1",
                    background: selectedGuest === g.id ? "#c98b94" : "#fff",
                    color: selectedGuest === g.id ? "#fff" : "#6b4a45",
                  }}>
                  <span style={{ ...S.dot, background: selectedGuest === g.id ? "#fff" : rsvpDot(g) }} />
                  {g.name || "Unnamed"}{Number(g.party) > 1 ? ` +${g.party - 1}` : ""}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* floating "now seating" banner */}
      {selectedGuest && (
        <div style={S.seatingBanner}>
          Seating <strong>{selectedName}</strong> — tap a table
          <button style={S.seatingCancel} onClick={() => setSelectedGuest(null)}>Cancel</button>
        </div>
      )}
    </>
  );
}

/* ============================================================
   VENUE COMPARISON VIEW
   ============================================================ */

function VenueComparisonView({ state, update }) {
  const [openVenue, setOpenVenue] = useState(null);
  const [confirmDeleteVenue, setConfirmDeleteVenue] = useState(null);

  const venues = state.venues || [];
  const chosen = venues.find((v) => v.chosen);

  const addVenue = () =>
    update((s) => {
      if (!s.venues) s.venues = [];
      s.venues.push({ id: uid(), name: "New Venue", price: 0, capacity: 0, catering: false, location: "", available: "", notes: "", pros: "", cons: "", chosen: false, shortlisted: false });
      return s;
    });

  const editVenue = (id, patch) =>
    update((s) => { const v = s.venues.find((x) => x.id === id); if (v) Object.assign(v, patch); return s; });

  const deleteVenue = (id) =>
    update((s) => { s.venues = s.venues.filter((x) => x.id !== id); return s; });

  const chooseVenue = (id) =>
    update((s) => {
      const v = s.venues.find((x) => x.id === id);
      if (!v) return s;

      // Unmark all venues
      for (const x of s.venues) x.chosen = false;
      v.chosen = true;
      s.venue = v.name;

      // Remove any previously auto-created venue vendor + its expenses
      const old = s.vendors.find((x) => x.fromVenue);
      if (old) {
        for (const c of s.categories)
          c.expenses = c.expenses.filter((e) => e.vendorId !== old.id);
        s.vendors = s.vendors.filter((x) => x.id !== old.id);
      }

      // Create new vendor
      const vendorId = uid();
      s.vendors.push({
        id: vendorId,
        name: v.name,
        type: "Venue",
        categoryId: s.categories.find((c) => c.id === "venue")?.id || s.categories[0]?.id || "",
        phone: "",
        email: "",
        status: "Booked",
        notes: v.notes || "",
        contracted: v.price || 0,
        fromVenue: true,
      });

      // Add upcoming expense in Venue & Rentals category
      const cat = s.categories.find((c) => c.id === "venue") || s.categories[0];
      if (cat) {
        cat.expenses.push({
          id: uid(),
          vendorId,
          desc: v.name,
          amount: v.price || 0,
          date: new Date().toISOString().slice(0, 10),
          paid: false,
        });
      }

      return s;
    });

  const unchoose = () =>
    update((s) => {
      for (const v of s.venues) v.chosen = false;
      s.venue = "";
      // Remove auto-created vendor + expenses
      const old = s.vendors.find((x) => x.fromVenue);
      if (old) {
        for (const c of s.categories)
          c.expenses = c.expenses.filter((e) => e.vendorId !== old.id);
        s.vendors = s.vendors.filter((x) => x.id !== old.id);
      }
      return s;
    });

  const shortlisted = venues.filter((v) => v.shortlisted || v.chosen);
  const tableVenues = shortlisted.length > 0 ? shortlisted : venues.slice(0, 4);

  const COMPARE_ROWS = [
    { key: "price",     label: "Price",      render: (v) => v.price > 0 ? fmt(v.price) : "—" },
    { key: "capacity",  label: "Capacity",   render: (v) => v.capacity > 0 ? `${v.capacity} guests` : "—" },
    { key: "catering",  label: "Catering",   render: (v) => v.catering ? "✓ Included" : "✗ Not included" },
    { key: "available", label: "Our date",   render: (v) => v.available || "—" },
    { key: "location",  label: "Location",   render: (v) => v.location || "—" },
    { key: "pros",      label: "Pros",       render: (v) => v.pros || "—" },
    { key: "cons",      label: "Cons",       render: (v) => v.cons || "—" },
  ];

  return (
    <>
      <header style={S.header}>
        <div style={S.kicker}>The Wedding</div>
        <h1 style={S.title}>Venues</h1>
      </header>

      {chosen && (
        <section style={{ ...S.dashboard, borderColor: "#b8d4b4", background: "#f4faf3" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <div>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#5c7a59", marginBottom: 4 }}>Chosen venue</div>
              <div style={{ fontFamily: "'Fraunces', serif", fontSize: 20, fontWeight: 600, color: "#3a5c38" }}>{chosen.name}</div>
              {chosen.location && <div style={{ fontSize: 13, color: "#5c7a59", marginTop: 2 }}>{chosen.location}</div>}
            </div>
            <button style={{ background: "transparent", color: "#5c7a59", fontSize: 13, border: "1px solid #b8d4b4", borderRadius: 8, padding: "6px 12px" }} onClick={unchoose}>
              Undo
            </button>
          </div>
        </section>
      )}

      {venues.length === 0 && (
        <div style={S.emptyNote}>Add venues you're considering — compare price, capacity, catering and more side by side.</div>
      )}

      {/* ── Comparison table ── */}
      {venues.length > 0 && (
        <section style={{ ...S.dashboard, padding: 0, overflow: "hidden" }}>
          <div style={{ padding: "12px 16px 8px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.08em", color: "#b58e87", fontWeight: 600 }}>Comparison</span>
            <span style={{ fontSize: 12, color: "#c4aaa4" }}>
  {shortlisted.length > 0 ? `${shortlisted.length} venue${shortlisted.length > 1 ? "s" : ""} in comparison` : "★ Star a venue below to add it here"}
            </span>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: tableVenues.length > 1 ? tableVenues.length * 150 : "100%" }}>
              <thead>
                <tr>
                  <th style={S.cmpRowLabel} />
                  {tableVenues.map((v) => (
                    <th key={v.id} style={{ ...S.cmpColHead, borderColor: v.chosen ? "#b8d4b4" : "#f0e2dd", background: v.chosen ? "#f4faf3" : "#fff" }}>
                      <div style={{ fontFamily: "'Fraunces', serif", fontSize: 15, fontWeight: 600, color: "#6b4a45" }}>{v.name}</div>
                      {v.chosen && <span style={{ ...S.diffPill, background: "#e4eede", color: "#5c7a59", fontSize: 10, marginTop: 4, display: "inline-block" }}>Chosen</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {COMPARE_ROWS.map((row) => (
                  <tr key={row.key}>
                    <td style={S.cmpRowLabel}>{row.label}</td>
                    {tableVenues.map((v) => {
                      const val = row.render(v);
                      const isGood = row.key === "catering" && v.catering;
                      const isBad = row.key === "catering" && !v.catering;
                      return (
                        <td key={v.id} style={{ ...S.cmpCell, background: v.chosen ? "#f4faf3" : "#fff", color: isGood ? "#5c7a59" : isBad ? "#b58e87" : "#3a2e2c" }}>
                          {val}
                        </td>
                      );
                    })}
                  </tr>
                ))}
                <tr>
                  <td style={S.cmpRowLabel} />
                  {tableVenues.map((v) => (
                    <td key={v.id} style={{ ...S.cmpCell, background: v.chosen ? "#f4faf3" : "#fff", paddingTop: 12, paddingBottom: 14 }}>
                      {!v.chosen ? (
                        <button style={{ ...S.addBtn, marginTop: 0, fontSize: 13, padding: "10px 8px" }} onClick={() => chooseVenue(v.id)}>
                          Choose
                        </button>
                      ) : (
                        <div style={{ fontSize: 13, color: "#5c7a59", fontWeight: 600, textAlign: "center" }}>✓ Chosen</div>
                      )}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── Edit cards ── */}
      {venues.length > 0 && <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.08em", color: "#b58e87", margin: "20px 0 10px" }}>Edit details</div>}
      <section>
        {venues.map((v) => {
          const isOpen = openVenue === v.id;
          return (
            <div key={v.id} style={{ ...S.card, borderColor: v.chosen ? "#b8d4b4" : "#f0e2dd" }}>
              <div style={{ ...S.cardHead, display: "flex", alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", flex: 1, cursor: "pointer" }} onClick={() => { setOpenVenue(isOpen ? null : v.id); setConfirmDeleteVenue(null); }}>
                  <span style={{ ...S.chevron, transform: isOpen ? "rotate(90deg)" : "none" }}>›</span>
                  <div style={{ ...S.catMain, flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={S.catName}>{v.name || "New Venue"}</div>
                      {v.chosen && <span style={{ ...S.diffPill, background: "#e4eede", color: "#5c7a59", fontSize: 11 }}>Chosen</span>}
                    </div>
                    <div style={S.catNumbers}>
                      {v.price > 0 && <span style={S.catSpent}>{fmt(v.price)}</span>}
                      {v.capacity > 0 && <span style={S.catOf}>up to {v.capacity} guests</span>}
                      {v.catering && <span style={{ ...S.diffPill, background: "#faf0d8", color: "#a8862f" }}>Catering incl.</span>}
                    </div>
                  </div>
                </div>
                <button onClick={(e) => { e.stopPropagation(); editVenue(v.id, { shortlisted: !v.shortlisted }); }}
                  title={v.shortlisted ? "Remove from comparison table" : "Add to comparison table"}
                  style={{ background: "none", border: "none", fontSize: 13, cursor: "pointer", padding: "4px 6px", lineHeight: 1.3, color: v.shortlisted ? "#e8a838" : "#c4aaa4", display: "flex", flexDirection: "column", alignItems: "center", gap: 1, flexShrink: 0 }}>
                  <span style={{ fontSize: 18 }}>{v.shortlisted ? "★" : "☆"}</span>
                  <span style={{ fontSize: 10 }}>{v.shortlisted ? "In table" : "Compare"}</span>
                </button>
                {confirmDeleteVenue === v.id ? (
                  <div style={{ display: "flex", gap: 4, paddingRight: 4 }}>
                    <button onClick={(e) => { e.stopPropagation(); deleteVenue(v.id); setConfirmDeleteVenue(null); }}
                      style={S.trashConfirm}>Delete</button>
                    <button onClick={(e) => { e.stopPropagation(); setConfirmDeleteVenue(null); }}
                      style={S.trashCancel}>Cancel</button>
                  </div>
                ) : (
                  <button onClick={(e) => { e.stopPropagation(); setConfirmDeleteVenue(v.id); }}
                    style={S.trashBtn}><Icon name="trash" size={18} color="#c98b94" /></button>
                )}
              </div>

              {isOpen && (
                <div style={S.cardBody}>
                  <div style={{ marginBottom: 12 }}>
                    <Field label="Venue name">
                      <input style={S.fieldInput} value={v.name} placeholder="Venue name"
                        onChange={(e) => editVenue(v.id, { name: e.target.value })} />
                    </Field>
                  </div>
                  <div style={S.vendorFields}>
                    <Field label="Estimated price">
                      <div style={S.miniInputWrap}>
                        <span style={S.miniDollar}>$</span>
                        <input type="number" inputMode="numeric" style={S.miniInput}
                          value={v.price === 0 ? "" : v.price} placeholder="0"
                          onChange={(e) => editVenue(v.id, { price: Number(e.target.value) || 0 })} />
                      </div>
                    </Field>
                    <Field label="Guest capacity">
                      <input type="number" inputMode="numeric" style={S.fieldInput}
                        value={v.capacity === 0 ? "" : v.capacity} placeholder="0"
                        onChange={(e) => editVenue(v.id, { capacity: Number(e.target.value) || 0 })} />
                    </Field>
                    <Field label="Location">
                      <input style={S.fieldInput} placeholder="Suburb or address"
                        value={v.location} onChange={(e) => editVenue(v.id, { location: e.target.value })} />
                    </Field>
                    <Field label="Our date available?">
                      <input style={S.fieldInput} placeholder="Yes / No / TBC"
                        value={v.available} onChange={(e) => editVenue(v.id, { available: e.target.value })} />
                    </Field>
                  </div>

                  <div style={{ marginTop: 14 }}>
                    <button onClick={() => editVenue(v.id, { catering: !v.catering })}
                      style={{ ...S.statusToggle, color: v.catering ? "#5c7a59" : "#b58e87", background: v.catering ? "#e4eede" : "#fbf6f3", border: "1px solid", borderColor: v.catering ? "#b8d4b4" : "#f0e2dd" }}>
                      {v.catering ? "✓ Catering included" : "Catering not included"}
                    </button>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 14 }}>
                    <div>
                      <label style={S.smallLabel}>Pros</label>
                      <textarea rows={3} style={{ ...S.visionInput, marginTop: 5, fontSize: 13 }}
                        placeholder="What you love about it…"
                        value={v.pros} onChange={(e) => editVenue(v.id, { pros: e.target.value })} />
                    </div>
                    <div>
                      <label style={S.smallLabel}>Cons</label>
                      <textarea rows={3} style={{ ...S.visionInput, marginTop: 5, fontSize: 13 }}
                        placeholder="Concerns or drawbacks…"
                        value={v.cons} onChange={(e) => editVenue(v.id, { cons: e.target.value })} />
                    </div>
                  </div>

                  <input style={{ ...S.taskNote, marginTop: 12 }} placeholder="Notes (what's included, deposit deadline, contact)…"
                    value={v.notes} onChange={(e) => editVenue(v.id, { notes: e.target.value })} />

                  <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                    {!v.chosen ? (
                      <button style={{ ...S.addBtn, flex: 1, marginTop: 0 }} onClick={() => chooseVenue(v.id)}>
                        Choose this venue
                      </button>
                    ) : (
                      <div style={{ flex: 1, padding: 13, borderRadius: 10, background: "#e4eede", color: "#5c7a59", fontSize: 15, fontWeight: 600, textAlign: "center" }}>
                        This is your venue
                      </div>
                    )}
                    <button style={{ ...S.deleteCat, background: "#f7ece8", borderRadius: 8, padding: "0 14px", height: 48 }} onClick={() => deleteVenue(v.id)}>
                      Delete
                    </button>
                  </div>
                  <button style={S.doneBtn} onClick={() => setOpenVenue(null)}>Done</button>
                </div>
              )}
            </div>
          );
        })}

        <button style={S.addCat} onClick={addVenue}>+ Add venue</button>
      </section>
    </>
  );
}

/* ============================================================
   STYLES
   ============================================================ */

const CSS = `
  * { box-sizing: border-box; }
  input { font-family: 'Outfit', sans-serif; outline: none; border: none; background: transparent; -webkit-appearance: none; }
  input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  button { cursor: pointer; font-family: 'Outfit', sans-serif; border: none; }
  @media (max-width: 520px) {
    .stats-grid { grid-template-columns: repeat(2, 1fr) !important; gap: 16px 12px !important; }
  }
`;

const S = {
  page: { fontFamily: "'Outfit', sans-serif", background: "#fbf6f3", minHeight: "100vh", color: "#3a2e2c", maxWidth: 860, margin: "0 auto", position: "relative", overflowX: "hidden" },
  scroll: { padding: "74px 16px 120px", boxSizing: "border-box", width: "100%", minWidth: 0 },

  header: { textAlign: "center", marginBottom: 24 },
  kicker: { letterSpacing: "0.35em", textTransform: "uppercase", fontSize: 11, color: "#b58e87", marginBottom: 6 },
  title: { fontFamily: "'Fraunces', serif", fontSize: "clamp(34px, 9vw, 46px)", fontWeight: 600, margin: 0, fontStyle: "italic", color: "#6b4a45" },

  dashboard: { background: "#fff", borderRadius: 20, padding: 22, marginBottom: 24, boxShadow: "0 10px 40px -20px rgba(150,100,95,0.4)", border: "1px solid #f0e2dd" },
  totalRow: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18, gap: 12, flexWrap: "wrap" },
  totalLabel: { fontFamily: "'Fraunces', serif", fontSize: 20, color: "#6b4a45" },
  totalInputWrap: { display: "flex", alignItems: "baseline", background: "#fbf6f3", borderRadius: 12, padding: "8px 14px", flex: "1 1 auto", justifyContent: "flex-end", maxWidth: 200 },
  dollar: { color: "#b58e87", fontSize: 20, marginRight: 2 },
  totalInput: { fontFamily: "'Fraunces', serif", fontSize: 26, fontWeight: 600, color: "#6b4a45", width: "100%", maxWidth: 140, textAlign: "right" },
  dateInput: { background: "#fbf6f3", borderRadius: 12, padding: "10px 14px", fontSize: 16, color: "#6b4a45", fontWeight: 500 },

  bar: { height: 12, background: "#f0e2dd", borderRadius: 99, overflow: "hidden", marginBottom: 16 },
  barFill: { height: "100%", borderRadius: 99, transition: "width 0.4s ease" },

  stats: { display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12 },
  statBox: { textAlign: "center" },
  statLabel: { fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: "#b58e87", marginBottom: 4 },
  statValue: { fontFamily: "'Fraunces', serif", fontSize: "clamp(18px, 5vw, 22px)", fontWeight: 600 },
  allocNote: { marginTop: 16, textAlign: "center", fontSize: 13, color: "#a8862f" },
  committedBox: { marginTop: 18, background: "#fbf2ef", borderRadius: 12, padding: "14px 16px" },
  committedTop: { display: "flex", justifyContent: "space-between", alignItems: "baseline" },
  committedLabel: { fontFamily: "'Fraunces', serif", fontSize: 16, color: "#6b4a45", fontWeight: 600 },
  committedValue: { fontFamily: "'Fraunces', serif", fontSize: 20, fontWeight: 600, color: "#b07a72" },
  committedHint: { fontSize: 12, color: "#b58e87", marginTop: 2 },
  owedList: { marginTop: 10, display: "flex", flexDirection: "column", gap: 6 },
  owedRow: { display: "flex", justifyContent: "space-between", alignItems: "baseline", fontSize: 14, paddingTop: 6, borderTop: "1px solid #f0ddd6" },
  owedName: { color: "#3a2e2c" },
  owedAmt: { color: "#b07a72", fontWeight: 500 },

  progressRow: { display: "flex", alignItems: "baseline", gap: 8, justifyContent: "center" },
  progressBig: { fontFamily: "'Fraunces', serif", fontSize: 24, fontWeight: 600, color: "#6b4a45" },
  progressSmall: { fontSize: 13, color: "#b58e87" },

  card: { background: "#fff", borderRadius: 16, marginBottom: 12, border: "1px solid #f0e2dd", overflow: "hidden" },
  cardHead: { display: "flex", alignItems: "flex-start", gap: 10, padding: "16px 18px", cursor: "pointer" },
  chevron: { color: "#c98b94", fontSize: 22, lineHeight: 1.2, transition: "transform 0.2s", display: "inline-block", flexShrink: 0 },
  catMain: { flex: 1, minWidth: 0 },
  catName: { fontFamily: "'Fraunces', serif", fontSize: 18, color: "#6b4a45", fontWeight: 600, width: "100%", marginBottom: 6 },
  catNumbers: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  catSpent: { fontWeight: 600, color: "#3a2e2c", fontSize: 15 },
  catOf: { color: "#b58e87", fontSize: 14 },
  diffPill: { fontSize: 12, padding: "3px 10px", borderRadius: 99, fontWeight: 500, whiteSpace: "nowrap" },

  bucketLabel: { fontFamily: "'Fraunces', serif", fontSize: 18, color: "#6b4a45", fontWeight: 600, marginBottom: 4 },
  bucketCount: { fontSize: 13, color: "#b58e87" },

  cardBody: { padding: "4px 18px 18px", borderTop: "1px solid #f7ece8" },
  allocEdit: { display: "flex", alignItems: "center", gap: 12, padding: "14px 0", flexWrap: "wrap" },
  smallLabel: { fontSize: 12, textTransform: "uppercase", letterSpacing: "0.08em", color: "#b58e87" },
  miniInputWrap: { display: "flex", alignItems: "center", background: "#fbf6f3", borderRadius: 8, padding: "6px 10px" },
  miniDollar: { color: "#b58e87", marginRight: 2 },
  miniInput: { width: 90, fontWeight: 600, color: "#6b4a45", fontSize: 15 },
  deleteCat: { marginLeft: "auto", background: "transparent", color: "#c2566b", fontSize: 13 },
  doneBtn: { width: "100%", marginTop: 14, padding: 12, borderRadius: 10, background: "#f4e8e4", color: "#b07a72", fontSize: 14, fontWeight: 600, border: "none", cursor: "pointer" },

  expItem: { background: "#fdfaf8", borderRadius: 10, padding: "10px 12px", marginBottom: 8, border: "1px solid #f4e7e2" },
  expItemTop: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 },
  expDesc: { flex: 1, fontSize: 15, fontWeight: 500, color: "#3a2e2c" },
  expDelete: { width: 26, height: 26, borderRadius: "50%", background: "#f7ece8", color: "#c2566b", fontSize: 17, lineHeight: 1, flexShrink: 0 },
  expItemBottom: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  expAmtWrap: { display: "flex", alignItems: "center", background: "#fff", borderRadius: 8, padding: "7px 10px", border: "1px solid #f0e2dd", flex: "1 1 100px" },
  expAmt: { width: "100%", fontSize: 15, fontWeight: 600, color: "#3a2e2c" },
  expDate: { fontSize: 14, padding: "7px 10px", borderRadius: 8, background: "#fff", color: "#3a2e2c", border: "1px solid #f0e2dd", flex: "1 1 130px" },
  statusToggle: { fontSize: 13, padding: "7px 14px", borderRadius: 99, fontWeight: 500, flexShrink: 0 },
  statusToggleWide: { fontSize: 14, padding: "10px", borderRadius: 10, fontWeight: 500, width: "100%" },

  addBox: { background: "#fbf2ef", borderRadius: 12, padding: 14, marginTop: 10, border: "1px dashed #e3c4bd" },
  addBoxLabel: { fontSize: 12, textTransform: "uppercase", letterSpacing: "0.08em", color: "#b58e87", marginBottom: 10 },
  addDesc: { width: "100%", fontSize: 15, padding: "11px 12px", borderRadius: 10, background: "#fff", color: "#3a2e2c", border: "1px solid #f0e2dd", marginBottom: 8 },
  addRow: { display: "flex", gap: 8, marginBottom: 8 },
  addBtn: { width: "100%", padding: 13, borderRadius: 10, background: "#c98b94", color: "#fff", fontSize: 15, fontWeight: 600, marginTop: 2, transition: "opacity 0.2s" },
  addCat: { width: "100%", padding: 14, borderRadius: 12, background: "transparent", border: "1.5px dashed #d9b8b2", color: "#b58e87", fontSize: 15, marginTop: 4 },

  /* checklist tasks */
  taskItem: { borderBottom: "1px solid #f7ece8", padding: "10px 0" },
  taskTop: { display: "flex", alignItems: "center", gap: 10 },
  check: { width: 24, height: 24, borderRadius: 7, border: "2px solid #d9b8b2", color: "#fff", fontSize: 14, lineHeight: 1, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" },
  taskName: { flex: 1, fontSize: 15, color: "#3a2e2c" },
  taskExpand: { width: 28, height: 28, borderRadius: "50%", background: "#fbf6f3", color: "#b58e87", fontSize: 16, lineHeight: 1, flexShrink: 0 },
  taskDetail: { paddingLeft: 34, marginTop: 8 },
  taskDetailRow: { display: "flex", alignItems: "center", gap: 12, marginBottom: 8, flexWrap: "wrap" },
  taskDate: { fontSize: 14, padding: "6px 10px", borderRadius: 8, background: "#fbf6f3", color: "#3a2e2c" },
  taskDelete: { marginLeft: "auto", background: "transparent", color: "#c2566b", fontSize: 13 },
  taskNote: { width: "100%", fontSize: 14, padding: "9px 11px", borderRadius: 8, background: "#fbf6f3", color: "#3a2e2c" },
  addTaskRow: { display: "flex", gap: 8, alignItems: "center", marginTop: 12 },
  addTaskInput: { flex: 1, fontSize: 15, padding: "11px 12px", borderRadius: 10, background: "#fbf2ef", color: "#3a2e2c", border: "1px dashed #e3c4bd" },
  expAdd: { width: 40, height: 40, borderRadius: "50%", background: "#c98b94", color: "#fff", fontSize: 20, lineHeight: 1, flexShrink: 0, transition: "opacity 0.2s" },

  footer: { textAlign: "center", marginTop: 28, fontSize: 12, color: "#c4aaa4" },

  /* welcome / sign-in */
  welcomePage: { fontFamily: "'Outfit', sans-serif", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: "32px 22px", background: "radial-gradient(120% 80% at 50% 0%, #fbeee9 0%, #fbf6f3 55%, #f6ebe6 100%)", color: "#3a2e2c" },
  welcomeInner: { width: "100%", maxWidth: 420, textAlign: "center" },
  welcomeKicker: { letterSpacing: "0.35em", textTransform: "uppercase", fontSize: 11, color: "#b58e87", marginBottom: 12 },
  welcomeTitle: { fontFamily: "'Fraunces', serif", fontSize: "clamp(48px, 15vw, 68px)", fontWeight: 600, fontStyle: "italic", color: "#6b4a45", margin: "0 0 18px", lineHeight: 1 },
  welcomeTag: { fontSize: 16, color: "#8a6d68", lineHeight: 1.6, margin: "0 auto 36px", maxWidth: 340 },
  googleBtn: { width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 12, background: "#fff", color: "#3a2e2c", fontSize: 16, fontWeight: 500, padding: "15px", borderRadius: 14, border: "1px solid #e9d3cd", boxShadow: "0 10px 30px -16px rgba(150,100,95,0.6)", cursor: "pointer" },
  welcomeGhost: { width: "100%", background: "transparent", color: "#b07a72", fontSize: 14, padding: "14px", marginTop: 6, cursor: "pointer" },
  welcomeFinePrint: { fontSize: 12, color: "#c4aaa4", lineHeight: 1.5, marginTop: 22, maxWidth: 320, marginLeft: "auto", marginRight: "auto" },
  welcomeError: { fontSize: 13, color: "#c2566b", background: "#fcecef", border: "1px solid #f3d2da", borderRadius: 10, padding: "10px 12px", marginTop: 12, lineHeight: 1.45 },

  /* purchase gate (access password) */
  activateInput: { width: "100%", boxSizing: "border-box", background: "#fff", color: "#3a2e2c", fontSize: 16, padding: "15px", borderRadius: 14, border: "1px solid #e9d3cd", outline: "none", textAlign: "center", letterSpacing: 1 },
  activateBtn: { width: "100%", background: "#b07a72", color: "#fff", fontSize: 16, fontWeight: 600, padding: "15px", borderRadius: 14, border: "none", boxShadow: "0 10px 30px -16px rgba(150,100,95,0.6)", cursor: "pointer", marginTop: 12 },

  /* warning modal (local-only) */
  modalOverlay: { position: "fixed", inset: 0, background: "rgba(58,46,44,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 22, zIndex: 50 },
  modalCard: { background: "#fff", borderRadius: 20, padding: "26px 24px", maxWidth: 380, width: "100%", textAlign: "center", boxShadow: "0 24px 60px -20px rgba(80,50,46,0.5)" },
  modalTitle: { fontFamily: "'Fraunces', serif", fontSize: 22, fontWeight: 600, color: "#6b4a45", margin: "0 0 10px" },
  modalBody: { fontSize: 14, color: "#8a6d68", lineHeight: 1.6, margin: "0 0 20px" },
  modalPrimary: { width: "100%", padding: 14, borderRadius: 12, background: "#c98b94", color: "#fff", fontSize: 15, fontWeight: 600, cursor: "pointer", border: "none" },
  modalGhost: { width: "100%", background: "transparent", color: "#b07a72", fontSize: 14, padding: "12px", marginTop: 6, cursor: "pointer", border: "none" },

  /* settings */
  gearBtn: { position: "absolute", top: 20, right: 16, width: 36, height: 36, borderRadius: 12, background: "linear-gradient(135deg,#f9ede9,#f4e0da)", border: "1px solid #eac8bf", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 5, boxShadow: "0 4px 14px -6px rgba(180,110,100,0.45)" },
  appLogoBtn: { position: "absolute", top: 18, left: 16, height: 42, display: "flex", alignItems: "center", background: "none", border: "none", padding: 0, cursor: "pointer", zIndex: 5 },
  appLogoImg: { height: 38, width: "auto", display: "block" },
  settingsHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24, paddingTop: 4 },
  backBtn: { width: 36, height: 36, borderRadius: "50%", background: "#fff", border: "1px solid #f0e2dd", display: "flex", alignItems: "center", justifyContent: "center" },
  settingsTitle: { fontFamily: "'Fraunces', serif", fontSize: 28, fontWeight: 600, fontStyle: "italic", color: "#6b4a45", margin: 0 },
  settingHint: { fontSize: 13, color: "#b58e87", lineHeight: 1.5, margin: "4px 0 0" },
  currencyPreview: { fontSize: 14, color: "#8a6d68", marginTop: 12, fontWeight: 500 },
  settingBtn: { width: "100%", padding: 13, borderRadius: 10, background: "#c98b94", color: "#fff", fontSize: 15, fontWeight: 600, marginTop: 14, cursor: "pointer" },
  settingBtnOutline: { background: "#fff", color: "#b07a72", border: "1.5px solid #e3c4bd" },
  settingBtnDanger: { background: "#c2566b" },
  confirmBox: { marginTop: 14 },
  confirmText: { fontSize: 14, color: "#6b4a45", marginBottom: 10, fontWeight: 500 },
  confirmRow: { display: "flex", gap: 10 },
  settingsFootnote: { textAlign: "center", fontSize: 13, color: "#c4aaa4", marginTop: 8, lineHeight: 1.5 },

  /* seating */
  tableGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 12, marginBottom: 18 },
  table: { background: "#fff", border: "2px solid #e9d3cd", borderRadius: 16, padding: 12, display: "flex", flexDirection: "column", gap: 8, boxShadow: "0 6px 22px -16px rgba(150,100,95,0.5)", cursor: "pointer", transition: "box-shadow 0.15s, border-color 0.15s, background 0.15s" },
  tableTopRow: { display: "flex", alignItems: "center", gap: 6 },
  tableName: { flex: 1, fontFamily: "'Fraunces', serif", fontSize: 15, fontWeight: 600, color: "#6b4a45", minWidth: 0 },
  tableRemove: { width: 22, height: 22, borderRadius: "50%", background: "#f7ece8", color: "#c2566b", fontSize: 14, lineHeight: 1, flexShrink: 0 },
  tableCircle: { width: 64, height: 64, borderRadius: "50%", border: "2px dashed #e3c4bd", display: "flex", alignItems: "center", justifyContent: "center", alignSelf: "center", background: "#fdf7f4" },
  tableCount: { fontFamily: "'Fraunces', serif", fontSize: 18, fontWeight: 600 },
  seatedList: { display: "flex", flexWrap: "wrap", gap: 5, minHeight: 24 },
  seatedChip: { display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, background: "#fbf2ef", color: "#6b4a45", padding: "3px 8px", borderRadius: 99, cursor: "pointer" },
  chipX: { color: "#c2566b", fontSize: 13, marginLeft: 1 },
  seatHint: { fontSize: 12, color: "#c4aaa4", fontStyle: "italic" },
  dot: { width: 7, height: 7, borderRadius: "50%", display: "inline-block", flexShrink: 0 },
  capRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, borderTop: "1px solid #f7ece8", paddingTop: 8 },
  capInput: { width: 50, fontSize: 14, fontWeight: 600, color: "#6b4a45", textAlign: "right", background: "#fbf6f3", borderRadius: 6, padding: "4px 8px" },
  tableAddSelect: { width: "100%", fontSize: 13, fontFamily: "'Outfit', sans-serif", color: "#b07a72", background: "#fbf2ef", border: "1px dashed #e3c4bd", borderRadius: 8, padding: "8px 10px", cursor: "pointer", marginTop: 2 },
  addTable: { border: "1.5px dashed #d9b8b2", borderRadius: 16, background: "transparent", color: "#b58e87", fontSize: 15, minHeight: 120, cursor: "pointer" },
  tray: { background: "#fff", borderRadius: 16, border: "1px solid #f0e2dd", padding: 16, position: "sticky", bottom: 92, boxShadow: "0 -6px 24px -18px rgba(150,100,95,0.5)" },
  trayChips: { display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 },
  traySection: { marginTop: 14 },
  traySectionHead: { fontSize: 12, fontWeight: 600, color: "#b07a72", textTransform: "uppercase", letterSpacing: "0.05em", display: "flex", alignItems: "center", gap: 7 },
  traySectionCount: { background: "#f4e8e4", color: "#b07a72", fontSize: 11, padding: "1px 8px", borderRadius: 99, fontWeight: 600 },
  guestChip: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 14, border: "1.5px solid #ead7d1", borderRadius: 99, padding: "8px 12px", cursor: "pointer", userSelect: "none", transition: "background 0.12s, color 0.12s, border-color 0.12s" },
  seatingBanner: { position: "fixed", left: "50%", transform: "translateX(-50%)", bottom: 92, background: "#6b4a45", color: "#fff", fontSize: 14, padding: "12px 18px", borderRadius: 99, display: "flex", alignItems: "center", gap: 14, zIndex: 50, boxShadow: "0 12px 32px -12px rgba(80,50,45,0.7)", maxWidth: "92%" },
  seatingCancel: { background: "rgba(255,255,255,0.18)", color: "#fff", fontSize: 13, padding: "5px 12px", borderRadius: 99, flexShrink: 0 },

  /* home */
  hero: { textAlign: "center", padding: "16px 0 28px" },
  heroPhotoWrap: { position: "relative", borderRadius: 20, overflow: "hidden", marginBottom: 4, boxShadow: "0 14px 40px -22px rgba(150,100,95,0.7)" },
  heroPhoto: { width: "100%", height: 240, objectFit: "cover", display: "block" },
  heroPhotoRemove: { position: "absolute", top: 12, right: 12, width: 30, height: 30, borderRadius: "50%", background: "rgba(58,46,44,0.55)", color: "#fff", fontSize: 18, lineHeight: 1, backdropFilter: "blur(4px)" },
  galleryHead: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  addPhotoBtn: { fontSize: 13, fontWeight: 500, color: "#fff", background: "#c98b94", padding: "8px 14px", borderRadius: 99, cursor: "pointer" },
  galleryEmpty: { fontSize: 14, color: "#b58e87", lineHeight: 1.5 },
  galleryGrid: { display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 },
  galleryItem: { position: "relative", borderRadius: 12, overflow: "hidden", aspectRatio: "1 / 1" },
  galleryImg: { width: "100%", height: "100%", objectFit: "cover", display: "block" },
  galleryRemove: { position: "absolute", top: 5, right: 5, width: 24, height: 24, borderRadius: "50%", background: "rgba(58,46,44,0.55)", color: "#fff", fontSize: 15, lineHeight: 1 },
  bannerTag: { position: "absolute", bottom: 5, left: 5, fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "#6b4a45", background: "rgba(255,255,255,0.9)", padding: "3px 7px", borderRadius: 6 },
  heroNames: { fontFamily: "'Fraunces', serif", fontSize: "clamp(36px, 11vw, 56px)", fontWeight: 600, fontStyle: "italic", color: "#6b4a45", margin: "8px 0 10px", lineHeight: 1.05 },
  heroDate: { fontSize: 15, color: "#b58e87", marginBottom: 16 },
  countdownPill: { display: "inline-block", background: "linear-gradient(90deg,#d9a7a0,#c98b94)", color: "#fff", fontWeight: 600, fontSize: 15, padding: "9px 22px", borderRadius: 99, boxShadow: "0 8px 24px -10px rgba(201,139,148,0.7)" },
  profileGrid: { display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 12 },
  visionInput: { width: "100%", fontSize: 15, padding: "11px 12px", borderRadius: 10, background: "#fbf6f3", color: "#3a2e2c", border: "1px solid #f0e2dd", marginTop: 5, fontFamily: "'Outfit', sans-serif", resize: "vertical" },
  summaryGrid: { display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 12 },
  summaryCard: { background: "#fff", borderRadius: 16, border: "1px solid #f0e2dd", padding: 18, textAlign: "left", display: "flex", flexDirection: "column", gap: 4, boxShadow: "0 6px 24px -18px rgba(150,100,95,0.5)", cursor: "pointer" },
  summaryTop: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6 },
  summaryLabel: { fontSize: 13, textTransform: "uppercase", letterSpacing: "0.06em", color: "#b58e87", fontWeight: 500 },
  summaryBig: { fontFamily: "'Fraunces', serif", fontSize: 26, fontWeight: 600, color: "#6b4a45" },
  summarySub: { fontSize: 13, color: "#b58e87" },

  /* vendors */
  emptyNote: { textAlign: "center", color: "#b58e87", fontSize: 14, padding: "20px 16px", lineHeight: 1.5 },
  vendorFields: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 12, paddingTop: 14 },
  field: { display: "flex", flexDirection: "column", gap: 5 },
  fieldInput: { width: "100%", minWidth: 0, boxSizing: "border-box", fontSize: 15, padding: "9px 11px", borderRadius: 8, background: "#fbf6f3", color: "#3a2e2c", border: "1px solid #f0e2dd" },
  fieldSelect: { width: "100%", minWidth: 0, boxSizing: "border-box", fontSize: 15, padding: "9px 11px", borderRadius: 8, background: "#fbf6f3", color: "#3a2e2c", border: "1px solid #f0e2dd", fontFamily: "'Outfit', sans-serif" },
  vendorPaidLine: { fontSize: 13, color: "#b58e87", marginTop: 8, textAlign: "center" },
  payLabel: { fontSize: 12, textTransform: "uppercase", letterSpacing: "0.08em", color: "#b58e87", marginTop: 18, marginBottom: 10 },
  payHint: { textTransform: "none", letterSpacing: 0, color: "#c4aaa4", fontStyle: "italic" },
  vendorTag: { fontSize: 12, color: "#b07a72", marginBottom: 6, marginLeft: 2 },

  /* guests */
  guestStats: { display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 18 },
  headcountBox: { background: "#fbf2ef", borderRadius: 12, padding: "14px 16px", display: "flex", alignItems: "center", gap: 12 },
  headcountNum: { fontFamily: "'Fraunces', serif", fontSize: 34, fontWeight: 600, color: "#6b4a45", lineHeight: 1 },
  headcountLabel: { fontSize: 13, color: "#b58e87", lineHeight: 1.4 },
  filterRow: { display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" },
  searchWrap: { display: "flex", alignItems: "center", gap: 8, background: "#fff", border: "1px solid #f0e2dd", borderRadius: 12, padding: "10px 14px", marginBottom: 12 },
  searchIcon: { color: "#c4aaa4", fontSize: 18, lineHeight: 1 },
  searchInput: { flex: 1, fontSize: 15, color: "#3a2e2c" },
  searchClear: { width: 24, height: 24, borderRadius: "50%", background: "#f7ece8", color: "#b07a72", fontSize: 16, lineHeight: 1, flexShrink: 0 },
  filterPill: { fontSize: 13, padding: "7px 14px", borderRadius: 99, fontWeight: 500, border: "1px solid #f0e2dd", transition: "all 0.15s" },
  optList: { marginTop: 10 },
  optRow: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 },
  optInput: { flex: 1, fontSize: 15, padding: "9px 11px", borderRadius: 8, background: "#fbf6f3", color: "#3a2e2c", border: "1px solid #f0e2dd" },

  /* trash delete pattern */
  trashBtn: { background: "none", border: "none", padding: "8px 10px", cursor: "pointer", color: "#c98b94", flexShrink: 0, lineHeight: 1, display: "flex", alignItems: "center" },
  trashConfirm: { background: "#c2566b", color: "#fff", border: "none", borderRadius: 8, padding: "6px 10px", fontSize: 12, cursor: "pointer", fontWeight: 600, whiteSpace: "nowrap" },
  trashCancel: { background: "#f4e8e4", color: "#b58e87", border: "none", borderRadius: 8, padding: "6px 10px", fontSize: 12, cursor: "pointer", whiteSpace: "nowrap" },

  /* venue comparison table */
  cmpRowLabel: { fontSize: 11, textTransform: "uppercase", letterSpacing: "0.07em", color: "#b58e87", padding: "10px 14px", textAlign: "left", whiteSpace: "nowrap", borderBottom: "1px solid #f7ece8", background: "#fdf9f8", fontWeight: 600 },
  cmpColHead: { padding: "14px 12px", textAlign: "center", borderBottom: "2px solid #f0e2dd", borderLeft: "1px solid #f7ece8" },
  cmpCell: { padding: "10px 12px", textAlign: "center", fontSize: 13, borderBottom: "1px solid #f7ece8", borderLeft: "1px solid #f7ece8", verticalAlign: "top", lineHeight: 1.5 },

  /* help button */
  helpBtn: { position: "absolute", top: 20, right: 62, width: 36, height: 36, borderRadius: 12, background: "linear-gradient(135deg,#f9ede9,#f4e0da)", border: "1px solid #eac8bf", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 5, boxShadow: "0 4px 14px -6px rgba(180,110,100,0.45)" },

  /* guide modal */
  guideOverlay: { position: "fixed", inset: 0, background: "rgba(58,46,44,0.5)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, zIndex: 100 },
  guideCard: { background: "#fff", borderRadius: 24, padding: "32px 26px 26px", maxWidth: 380, width: "100%", textAlign: "center", boxShadow: "0 28px 60px -20px rgba(80,50,46,0.55)", position: "relative" },
  guideClose: { position: "absolute", top: 14, right: 16, width: 30, height: 30, borderRadius: "50%", background: "#f7ece8", color: "#b07a72", fontSize: 20, lineHeight: 1, border: "none", cursor: "pointer" },
  guideEmoji: { fontSize: 48, marginBottom: 14, lineHeight: 1 },
  guideTitle: { fontFamily: "'Fraunces', serif", fontSize: 24, fontWeight: 600, fontStyle: "italic", color: "#6b4a45", margin: "0 0 12px" },
  guideBody: { fontSize: 15, color: "#8a6d68", lineHeight: 1.65, margin: "0 0 24px" },
  guideDots: { display: "flex", justifyContent: "center", gap: 6, marginBottom: 22 },
  guideDot: { width: 8, height: 8, borderRadius: "50%", border: "none", cursor: "pointer", padding: 0, transition: "background 0.2s" },
  guideBtnRow: { display: "flex", gap: 10 },
  guideBack: { flex: 1, padding: 13, borderRadius: 12, background: "#fff", color: "#b07a72", fontSize: 15, fontWeight: 600, border: "1.5px solid #e3c4bd", cursor: "pointer" },
  guideNext: { flex: 2, padding: 13, borderRadius: 12, background: "linear-gradient(90deg,#d9a7a0,#c98b94)", color: "#fff", fontSize: 15, fontWeight: 600, border: "none", cursor: "pointer" },
  setupInput: { width: "100%", fontSize: 16, padding: "13px 14px", borderRadius: 12, background: "#fbf6f3", color: "#3a2e2c", border: "1px solid #f0e2dd", fontFamily: "'Outfit', sans-serif" },

  /* bottom nav */
  nav: { position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)", width: "100%", maxWidth: 860, background: "rgba(255,255,255,0.95)", backdropFilter: "blur(10px)", borderTop: "1px solid #f0e2dd", display: "flex", justifyContent: "space-around", padding: "10px 0 14px", zIndex: 10 },
  navBtn: { background: "transparent", display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: "4px 4px", flex: 1, transition: "color 0.2s" },
  navIcon: { fontSize: 16, width: 38, height: 26, borderRadius: 99, display: "flex", alignItems: "center", justifyContent: "center", transition: "background 0.2s" },
  navLabel: { fontSize: 11, fontWeight: 500 },
};
