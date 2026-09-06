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

// Common wedding costs offered as one-tap additions on the Budget page. The
// preset categories are included so they can be added back if deleted; anything
// already in the plan (matched by name) is filtered out of the suggestions.
const SUGGESTED_CATEGORIES = [
  ...PRESET_CATEGORIES.map((c) => c.name),
  "Ceremony & Celebrant",
  "Cake & Desserts",
  "Hair & Makeup",
  "Rings",
  "Transport",
  "Accommodation",
  "Wedding Planner",
  "Photo Booth",
  "Bridal Party",
  "Gifts & Favours",
  "Marriage Licence",
  "Honeymoon",
  "Tips & Gratuities",
  "Contingency",
];

/* ---------- the sync reminder's dismissal ---------- */

// When they last closed the sync line. Per device, like the panel state — it's
// a preference about this screen, not part of the plan.
const SYNC_HUSH_KEY = "planourdays-sync-hushed";
const SYNC_HUSH_DAYS = 30;

// The reconnect prompt can be put away too, but only for a day: syncing is
// actually broken, and the header badge stays red the whole time.
const RECONNECT_HUSH_KEY = "planourdays-reconnect-hushed";
const RECONNECT_HUSH_HOURS = 24;

function reconnectHushedUntil() {
  try {
    const t = Number(window.localStorage.getItem(RECONNECT_HUSH_KEY)) || 0;
    return t + RECONNECT_HUSH_HOURS * 3600000;
  } catch {
    return 0;
  }
}

function hushReconnect() {
  try { window.localStorage.setItem(RECONNECT_HUSH_KEY, String(Date.now())); } catch {}
}

function syncHushedUntil() {
  try {
    const t = Number(window.localStorage.getItem(SYNC_HUSH_KEY)) || 0;
    return t + SYNC_HUSH_DAYS * 86400000;
  } catch {
    return 0;
  }
}

function hushSync() {
  try { window.localStorage.setItem(SYNC_HUSH_KEY, String(Date.now())); } catch {}
}

/* ---------- Home section open/closed, remembered per device ---------- */

// Which Home sections the couple has folded away. Kept in localStorage rather
// than the plan, so it's a per-device preference and never syncs or conflicts.
const PANEL_KEY = "planourdays-home-panels";

function panelOpen(name) {
  try {
    const saved = JSON.parse(window.localStorage.getItem(PANEL_KEY));
    return saved?.[name] !== false; // open unless they closed it
  } catch {
    return true;
  }
}

function savePanel(name, open) {
  try {
    const saved = JSON.parse(window.localStorage.getItem(PANEL_KEY)) || {};
    saved[name] = open;
    window.localStorage.setItem(PANEL_KEY, JSON.stringify(saved));
  } catch {
    // Storage blocked — the section still opens and closes, it just won't stick.
  }
}

// The printed plan is laid out at this fixed width (see .pod-pdf in the export
// stylesheet); the on-screen preview scales down to fit the phone.
const PDF_PAGE_WIDTH = 760;

// Ready-made colours for the style board: wedding palettes across the spectrum,
// then neutrals. Anything else goes in by hex or the phone's colour wheel.
const PICKER_COLORS = [
  "#f3d9d3", "#e0aeb0", "#c98b94", "#b0454f",
  "#c47a5a", "#d98d6a", "#ecd9b0", "#d4a843",
  "#a8bfa3", "#8ba888", "#5f7a5b", "#7f9d9b",
  "#9fb4c7", "#3f5670", "#c4a3c8", "#8b6a86",
  "#7d3b46", "#f6efe6", "#f2e7dd", "#e2d3c2",
  "#b9a79b", "#8a7d75", "#4a4442", "#2b2523",
];

// A soft starting palette for the style board — there to be changed, but it
// means the section looks like something the moment it's opened.
const DEFAULT_PALETTE = ["#e8d3cc", "#c98b94", "#8ba888", "#f2e7dd"];
const MAX_PALETTE = 8;

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
    styleWords: "",
    palette: [...DEFAULT_PALETTE],
    photos: [],
    currency: "AUD",
    tables: [],
    total: DEFAULT_TOTAL,
    categories: PRESET_CATEGORIES.map((c, i) => ({
      id: c.id,
      name: c.name,
      allocated: Math.round(DEFAULT_TOTAL * c.pct),
      expenses: [],
      color: CAT_COLORS[i % CAT_COLORS.length],
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

// Money that has actually left the account. "Spent" means spent: an expense
// still marked Upcoming is a plan, not a payment, and belongs in `catUpcoming`.
const catSpent = (cat) =>
  cat.expenses.reduce((s, e) => s + (e.paid ? Number(e.amount) || 0 : 0), 0);

const catUpcoming = (cat) =>
  cat.expenses.reduce((s, e) => s + (e.paid ? 0 : Number(e.amount) || 0), 0);

/* ---------- category colours ---------- */

// Soft, distinguishable shades in the app's palette. A colour is stored on the
// category itself, not derived from its position, so dragging categories into a
// new order never repaints the chart.
const CAT_COLORS = [
  "#c98b94", // rose
  "#8ba888", // sage
  "#d9a7a0", // blush
  "#9fb4c7", // dusty blue
  "#e0b978", // gold
  "#b58e87", // mauve
  "#c4a3c8", // lilac
  "#d98d6a", // terracotta
  "#7f9d9b", // teal
  "#b0c49a", // moss
];

// The palette colour used least by the categories so far, so the first ten are
// always distinct and later ones repeat as evenly as possible.
function nextCatColor(categories = []) {
  const used = new Map(CAT_COLORS.map((c) => [c, 0]));
  for (const c of categories) if (used.has(c.color)) used.set(c.color, used.get(c.color) + 1);
  let best = CAT_COLORS[0];
  for (const c of CAT_COLORS) if (used.get(c) < used.get(best)) best = c;
  return best;
}

// Plans saved before categories had colours get one on load.
function withCatColors(categories) {
  const out = [];
  for (const c of categories || []) out.push(c.color ? c : { ...c, color: nextCatColor(out) });
  return out;
}

// Merge any missing top-level keys so old saved data still works.
function hydrate(loaded) {
  const base = makeInitialState();
  if (!loaded) return base;
  return {
    ...base,
    ...loaded,
    updatedAt: loaded.updatedAt || base.updatedAt,
    rev: loaded.rev || base.rev,
    categories: withCatColors(loaded.categories || base.categories),
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
const STATE_ARRAY_FIELDS = ["categories", "checklist", "vendors", "guests", "venues", "tables", "mealOptions", "groupOptions", "palette"];

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
// A guest is on the real (invited) list unless explicitly staged as "planning".
// Guests saved before the planning feature have no stage, so they count as invited.
const isInvited = (g) => (g.stage || "invited") === "invited";

// How many chairs one guest needs — themselves plus anyone they bring.
const partySize = (g) => Math.max(1, Number(g?.party) || 1);

function headcount(guests) {
  return guests
    .filter((g) => isInvited(g) && g.rsvp === "Yes")
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

// Only a booked vendor counts toward the budget. Quotes you're still weighing
// up ("Researching"/"Contacted") would otherwise stack up — three photographer
// quotes would read as three photographers to pay for.
const countsInBudget = (v) => v.status === "Booked";

// What a vendor has been paid so far, and what's still owed on their contract.
function vendorMoney(state, v) {
  const paid = vendorExpenses(state, v.id).reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const contracted = Number(v.contracted) || 0;
  return { ...v, paid, contracted, owed: Math.max(0, contracted - paid), counted: countsInBudget(v) };
}

// Vendors filed under a budget category. Lets the Budget page show the vendors
// behind a category instead of only counting logged expenses.
function categoryVendors(state, catId) {
  return (state.vendors || [])
    .filter((v) => v.categoryId === catId)
    .map((v) => vendorMoney(state, v));
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

// A coloured dot + label — the same shape whether the status comes from the
// sync state machine or from a plain local-only save.
function StatusDot({ tone, children }) {
  const color = SAVE_TONE_COLOR[tone] || "#7a655f";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, flex: "none" }} />
      <span>{children}</span>
    </span>
  );
}

function SaveIndicator({ saveState }) {
  const { label, tone } = saveStateLabel(saveState);
  return <StatusDot tone={tone}>{label}</StatusDot>;
}

// Shown when the Google session lapsed mid-use (NEEDS_RECONNECT). The
// user's edits are safe locally; this offers a one-tap re-consent that
// resumes syncing. Dismissing it just leaves them in local-safe mode.
function ReconnectBanner({ busy, onReconnect, onDismiss }) {
  return (
    <div
      style={{
        position: "relative",
        display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
        background: "#fbecd8", border: "1px solid #f0d9b3", borderRadius: 14,
        color: "#7a5a1e", margin: "70px 16px 0", padding: "12px 34px 12px 14px", fontSize: 14,
      }}
    >
      <span style={{ flex: 1, minWidth: 160 }}>
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
      {/* Put it away for a day if they can't deal with it now — the header
          badge stays red so the problem is never actually hidden. */}
      <button
        onClick={onDismiss}
        aria-label="Hide until tomorrow"
        style={{
          position: "absolute", top: 6, right: 8, background: "none", border: "none",
          color: "#b09159", fontSize: 17, lineHeight: 1, padding: 4, cursor: "pointer",
        }}
      >
        ×
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

function SetupWizard({ onFinish, onSkipAll, onClose }) {
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
        <button style={S.guideClose} onClick={onClose} aria-label="Close setup">×</button>
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
              <input type="number" inputMode="numeric" className="big-number-md" style={{ ...S.setupInput, background: "transparent", border: "none", padding: 0, fontSize: 22, fontWeight: 600 }}
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

/* ============================================================
   HELP — the manual behind the "?"
   ------------------------------------------------------------
   The tour introduces the app; this explains it. Written for
   someone who has never planned a wedding and doesn't know what
   "allocated" or "contracted total" mean.
   ============================================================ */

const HELP_TOPICS = [
  {
    id: "saving",
    emoji: "☁️",
    title: "How your plan is saved",
    body: [
      "There's no save button — everything you type is kept the moment you type it.",
      "The line under the logo tells you where things stand. A green dot means your plan is safe on this device. Amber means you're offline and it'll sync when you're back. Red means something needs your attention.",
      "That line has an × if you'd rather not see it. Sync then lives as the small cloud button next to this one, and the reminder comes back by itself in a month. Anything actually wrong will always show, whether you've hidden it or not.",
      "Signing in with Google keeps a copy in your own private Google Drive folder, so you can plan on your phone and finish on your laptop. You approve it once — after that it saves on its own, with no pop-ups.",
      "Without signing in, your plan lives in this browser on this device only. Clearing your browser data would erase it, so either sign in or export a backup from Settings now and then.",
    ],
  },
  {
    id: "home",
    emoji: "🏠",
    title: "Home",
    body: [
      "The top is your day at a glance: your names, the date, your venue and the countdown. Tap the countdown to set or change the date.",
      "Next up lists the soonest things with a date on them — checklist tasks you haven't ticked and vendor balances that are due. Red means overdue, amber means within a fortnight. Tap any row to jump straight to it.",
      "The four cards are a summary of your budget, checklist, guests and vendors. Tap one to open that page.",
      "Our details holds your names, date and venue. Our style holds your colours, the words for your day and your photos.",
    ],
  },
  {
    id: "budget",
    emoji: "💰",
    title: "Budget — the three words to know",
    body: [
      "Total budget is what you can spend altogether. Allocated is what you've set aside for each part — venue, catering, flowers — and those should add up to roughly your total.",
      "Spent is money that has actually left your account. Upcoming is money you've written down but not paid yet. Remaining is what isn't spoken for. The three add up to your total budget.",
      "To record money, open a category and fill in Add an expense: what it was for, how much, the date, and whether it's Paid or Upcoming.",
      "The donut shows where your money is going, category by category. The Spent / Planned switch above it flips between what you've actually paid and how you've divided the budget up.",
      "Each category has a coloured dot that matches its slice, and a small bar showing how full it is — solid for paid, faded for promised.",
      "At the bottom, Suggested categories are common wedding costs. Tap one to add it. Deleting a category warns you first, because it also deletes the payments inside it.",
    ],
  },
  {
    id: "vendors",
    emoji: "🤝",
    title: "Vendors, and one-off purchases",
    body: [
      "A vendor is someone you're hiring where money is owed over time — a photographer, a caterer, a band.",
      "Contracted total is the full agreed price. Balance due is the date the rest has to be paid, and it shows up in Next up on Home when it's close.",
      "Status matters: only vendors marked Booked count toward your budget. That way you can keep three photographer quotes side by side without your budget thinking you've hired all three.",
      "Payments logged inside a vendor appear in that vendor's budget category automatically, and reduce what they're still owed.",
      "A one-off purchase you've already paid for — a dress, the rings, stamps, candles — isn't a vendor. There's no balance and no due date. Put it straight into Budget: open the right category and add it as an expense.",
    ],
  },
  {
    id: "venues",
    emoji: "🏛️",
    title: "Venues",
    body: [
      "Add the places you're considering and compare them side by side — price, how many people they hold, whether catering is included, and your own pros and cons.",
      "Star a venue to add it to the comparison table at the top.",
      "When you've decided, tap Choose this venue. Its name appears on your Home page, and it's added to your Vendors as Booked, with its price logged as an upcoming payment under Venue & Rentals.",
      "That's why your budget jumps when you choose a venue — it's the money you've now committed. Mark payments as Paid as you actually make them.",
      "Changed your mind? Undo removes it again, along with what it added.",
    ],
  },
  {
    id: "checklist",
    emoji: "📋",
    title: "Checklist",
    body: [
      "Tasks are grouped by how far out they are, from twelve months before down to after the wedding.",
      "Tick things off as you go. Add your own tasks to any section, or add whole sections of your own.",
      "Tap ⋯ on a task to give it a due date and a note. Anything with a due date appears in Next up on your Home page, so you don't have to go looking for it.",
    ],
  },
  {
    id: "guests",
    emoji: "💗",
    title: "Guests",
    body: [
      "The Planning list is for people you're still deciding about. The Invited list is the real one — only those count toward your numbers.",
      "Each guest has an RSVP: Invited (waiting to hear), Yes, No or Maybe.",
      "Party size is that guest plus anyone they bring. A guest with a partner is a party of 2. The big number at the top counts people, not names — that's the figure your caterer wants.",
      "You can also record meal choices and put guests into groups, like the bride's family or work friends. The search box looks through names, groups and notes.",
    ],
  },
  {
    id: "seating",
    emoji: "✦",
    title: "Seating",
    body: [
      "Add round tables (8 seats) or long tables (20), and change the seat count on any of them.",
      "To seat someone, tap a guest at the bottom and then tap a table — or use the Add guest dropdown on the table itself. Tap a seated name to take them off again.",
      "Seats count people. A guest with a +1 takes two chairs, so a table showing 5/8 has five people at it, not five names. The count turns red if a table is over its seats.",
    ],
  },
  {
    id: "style",
    emoji: "🎨",
    title: "Our style",
    body: [
      "This is the look of your day, and it's the page worth handing to a florist or stylist.",
      "Your colours are shown with their codes underneath — things like #C98B94. A supplier can match a colour exactly from that code, which they can't do from a printed picture.",
      "Style words are three or four words for the feel of the day. Our vision is a sentence or two about what you're picturing.",
      "Tap the card to edit any of it, then tap Done. The first photo you add becomes the banner at the top of Home; everything after it is inspiration.",
      "All of it prints in your PDF.",
    ],
  },
  {
    id: "pdf",
    emoji: "📄",
    title: "Printing and backups",
    body: [
      "Settings → Preview & download PDF turns your whole plan into a document: budget, your style colours with their codes, checklist, vendors with what's still owed and when, guests and seating plan.",
      "You see exactly what will be saved before you save it.",
      "Export a backup file keeps a copy of everything on your device — worth doing now and then if you haven't signed in with Google. Restore from one puts it all back.",
      "Currency is in Settings too, and changes every amount in the app.",
    ],
  },
];

function HelpSheet({ onClose, onTour }) {
  const [open, setOpen] = useState(null);

  return (
    <div style={S.guideOverlay} onClick={onClose}>
      <div style={S.helpCard} onClick={(e) => e.stopPropagation()}>
        <div style={S.helpHead}>
          <div>
            <div style={S.helpTitle}>How this works</div>
            <div style={S.helpSub}>Tap any topic to read more.</div>
          </div>
          <button style={S.pdfClose} onClick={onClose} aria-label="Close help">×</button>
        </div>

        <div style={S.helpScroll}>
          {HELP_TOPICS.map((t) => {
            const isOpen = open === t.id;
            return (
              <div key={t.id} style={S.helpTopic}>
                <button style={S.helpTopicHead} onClick={() => setOpen(isOpen ? null : t.id)}>
                  <span style={S.helpEmoji}>{t.emoji}</span>
                  <span style={S.helpTopicTitle}>{t.title}</span>
                  <span style={{ ...S.chevron, transform: isOpen ? "rotate(90deg)" : "none" }}>›</span>
                </button>
                {isOpen && (
                  <div style={S.helpBody}>
                    {t.body.map((p, i) => <p key={i} style={S.helpPara}>{p}</p>)}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div style={S.helpFoot}>
          <button style={{ ...S.settingBtn, ...S.settingBtnOutline, flex: 1 }} onClick={onTour}>
            Replay the tour
          </button>
          <button style={{ ...S.settingBtn, flex: 1 }} onClick={onClose}>Done</button>
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
  // From the footer save-status: open Settings and scroll to the Sync panel,
  // so tapping "Up to date" / "reconnect" lands on the sync details + controls.
  const goToSyncSettings = () => {
    goTab("settings");
    // Wait for the Settings view to mount, then scroll the Sync panel into
    // view. Poll a few times since the exact commit timing varies.
    let tries = 0;
    const tryScroll = () => {
      const el = document.getElementById("sync-panel");
      if (el) { el.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
      if (tries++ < 12) setTimeout(tryScroll, 40);
    };
    setTimeout(tryScroll, 40);
  };
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
  // "?" opens the manual; the tour stays for first run and can be replayed.
  const [showHelp, setShowHelp] = useState(false);
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
  // Brief "Saved on this device" pill for local-only users, with a nudge to
  // turn on sync. Auto-hides; never overlaps the logo or the header buttons.
  // The sync reminder can be closed; it comes back on its own after a month.
  const [syncHushedAt, setSyncHushedAt] = useState(() => syncHushedUntil());
  const dismissSyncLine = () => { hushSync(); setSyncHushedAt(syncHushedUntil()); };
  // Briefly true right after a local save, so the status line can confirm it.
  const [justSaved, setJustSaved] = useState(false);
  const flashTimer = useRef(null);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);
  const [reconnectHushedAt, setReconnectHushedAt] = useState(() => reconnectHushedUntil());
  const dismissReconnect = () => { hushReconnect(); setReconnectHushedAt(reconnectHushedUntil()); };

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
    const savedOk = storage.save(state);
    setStorageOk(savedOk); // no-op re-render unless it changed

    if (!didMount.current) { didMount.current = true; return; }
    if (!connected) {
      // A local save is instant, so a permanently green dot tells you nothing.
      // Flash "Saved just now" once they stop typing, then settle back.
      if (savedOk) {
        if (flashTimer.current) clearTimeout(flashTimer.current);
        setJustSaved(true);
        flashTimer.current = setTimeout(() => setJustSaved(false), 1800);
      }
      return; // local-only intent never pushes
    }

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

  // What the reminder is currently saying, and whether it's a warning or just a
  // nudge. Warnings — the plan isn't safe, or sync has broken — ignore a
  // dismissal, because that's the difference between reminding and hiding.
  const syncBadge = intent === "sync"
    ? saveStateLabel({
        ...(syncState === NEEDS_RECONNECT ? { ...saveState, inFlight: false, health: "error" } : saveState),
        storageError: !storageOk,
      })
    : !storageOk
      ? saveStateLabel({ storageError: true })
      : { label: justSaved ? "Saved just now" : "Saved on this device", tone: "ok" };
  const syncUrgent = syncBadge.tone === "error" || !storageOk || syncState === NEEDS_RECONNECT;
  // A lapsed session gets the banner, which says the same thing with a button
  // to fix it — so the status line stands down rather than saying it twice.
  const needsReconnect = syncState === NEEDS_RECONNECT;
  const showReconnect = needsReconnect && Date.now() > reconnectHushedAt;
  const showSyncLine = needsReconnect ? false : (syncUrgent || Date.now() > syncHushedAt);

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
          {/* With the reminder closed, sync lives here: out of the way, always
              reachable, and still showing its state through the dot. */}
          {!showSyncLine && (
            <button style={S.syncBadge} onClick={goToSyncSettings} aria-label={`Sync — ${syncBadge.label}`}
              title={syncBadge.label}>
              <Icon name="cloud" size={19} color="#b07a72" />
              <span style={{ ...S.syncBadgeDot, background: SAVE_TONE_COLOR[syncBadge.tone] || "#7a655f" }} />
            </button>
          )}
          <button style={S.helpBtn} onClick={() => setShowHelp(true)} aria-label="Help">
            <span style={{ fontSize: 15, fontWeight: 700, color: "#b07a72", lineHeight: 1 }}>?</span>
          </button>
          <button style={S.gearBtn} onClick={() => goTab("settings")} aria-label="Settings">
            <Icon name="gear" size={22} color="#b07a72" />
          </button>
        </>
      )}

      {showSetup && <SetupWizard onFinish={finishSetup}
        onSkipAll={() => { localStorage.setItem(SETUP_KEY, "1"); setShowSetup(false); setShowGuide(true); }}
        onClose={() => { localStorage.setItem(SETUP_KEY, "1"); localStorage.setItem(GUIDE_KEY, "1"); setShowSetup(false); setShowGuide(false); }} />}
      {showGuide && <GuideModal onClose={closeGuide} />}
      {showHelp && (
        <HelpSheet onClose={() => setShowHelp(false)}
          onTour={() => { setShowHelp(false); setShowGuide(true); }} />
      )}

      {showReconnect && (
        <ReconnectBanner busy={reconnecting} onReconnect={handleReconnect} onDismiss={dismissReconnect} />
      )}

      <div style={S.scroll}>
        {/* Sync status sits above the content, under the logo row. It can be
            closed — then it lives as the badge in the header — but anything
            actually wrong ignores that and shows anyway. */}
        {showSyncLine && (
          <div style={S.syncLine}>
            {(() => {
              const content =
                intent === "sync" ? (
                  <SaveIndicator
                    saveState={{
                      ...(syncState === NEEDS_RECONNECT ? { ...saveState, inFlight: false, health: "error" } : saveState),
                      storageError: !storageOk,
                    }}
                  />
                ) : !storageOk ? (
                  <SaveIndicator saveState={{ storageError: true }} />
                ) : PERSISTS ? (
                  // Local-only: green either way, but it says so out loud for a
                  // moment after each edit so you can see it land.
                  <StatusDot tone="ok">
                    {justSaved ? "Saved just now" : "Saved on this device · sign in to sync across devices"}
                  </StatusDot>
                ) : null;
              // Preview mode: nothing actionable, leave as plain text.
              if (content === null) return "Preview mode · data won't persist here, but saving works in the deployed app";
              // Already in Settings: no point navigating there again.
              if (tab === "settings") return content;
              return (
                <>
                  <button style={S.footerBtn} onClick={goToSyncSettings} aria-label="View sync details in settings">
                    {content}
                    <span style={S.footerChevron}>›</span>
                  </button>
                  {!syncUrgent && (
                    <button style={S.syncClose} onClick={dismissSyncLine}
                      aria-label="Hide this reminder">×</button>
                  )}
                </>
              );
            })()}
          </div>
        )}

        {tab === "home" && <HomeView state={state} update={update} go={goTab} />}
        {tab === "budget" && <BudgetView state={state} update={update} go={goTab} />}
        {tab === "checklist" && <ChecklistView state={state} update={update} />}
        {tab === "vendors" && <VendorsView state={state} update={update} />}
        {tab === "guests" && <GuestsView state={state} update={update} />}
        {tab === "seating" && <SeatingView state={state} update={update} />}
        {tab === "venues" && <VenueComparisonView state={state} update={update} />}
        {tab === "settings" && <SettingsView state={state} update={update} setState={setStateStamped} go={goTab} connected={connected} onSignOut={handleSignOut}
          sync={{ intent, syncState, saveState, lastSync, busy: reconnecting, onSwitchToLocal: switchToLocal, onSwitchToSync: switchToSync, onReconnect: handleReconnect }} />}
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
    cloud: <><path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97 6 6 0 0 0-11.66-1.2A4 4 0 0 0 6.5 19h11Z" /></>,
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

// Short "12 Jun 2027" for a yyyy-mm-dd string; "" if it isn't a real date.
function shortDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d)) return "";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

// How a balance due date should read and colour: overdue, due soon (within a
// fortnight), or simply scheduled.
function dueTone(dateStr) {
  const days = daysUntil(dateStr);
  if (days === null) return null;
  if (days < 0) return { tone: "error", label: `Overdue — was due ${shortDate(dateStr)}` };
  if (days === 0) return { tone: "error", label: "Balance due today" };
  if (days <= 14) return { tone: "warn", label: `Balance due in ${days} day${days > 1 ? "s" : ""}` };
  return { tone: "ok", label: `Balance due ${shortDate(dateStr)}` };
}

// "overdue by 3 days" / "today" / "in 9 days" / "2 Mar 2027" — how far off a
// dated thing is, in the fewest words.
function whenLabel(dateStr) {
  const days = daysUntil(dateStr);
  if (days === null) return "";
  if (days < 0) return `overdue by ${-days} day${days === -1 ? "" : "s"}`;
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days <= 30) return `in ${days} days`;
  return shortDate(dateStr);
}

// The dated things a couple actually has to act on, soonest first: vendor
// balances still owed, and checklist tasks that aren't ticked off.
function upcomingItems(state, limit = 3) {
  const items = [];

  for (const v of state.vendors || []) {
    // Only vendors you've actually booked — same rule as the budget, so a
    // quote you're still weighing up doesn't chase you on the home page.
    if (!v.dueDate || !countsInBudget(v)) continue;
    const paid = vendorExpenses(state, v.id).reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const owed = Math.max(0, (Number(v.contracted) || 0) - paid);
    if (owed <= 0) continue;
    items.push({
      key: `v-${v.id}`,
      tab: "vendors",
      title: `${v.name || "Vendor"} — ${fmt(owed)} due`,
      date: v.dueDate,
    });
  }

  for (const b of state.checklist || []) {
    for (const t of b.tasks || []) {
      if (t.done || !t.due) continue;
      items.push({ key: `t-${t.id}`, tab: "checklist", title: t.name, date: t.due });
    }
  }

  return items
    .map((it) => ({ ...it, days: daysUntil(it.date) }))
    .filter((it) => it.days !== null)
    .sort((a, b) => a.days - b.days)
    .slice(0, limit);
}

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
  // Make a photo the cover/banner by moving it to the front of the list.
  const setCover = (id) =>
    update((s) => {
      const arr = s.photos || [];
      const i = arr.findIndex((p) => p.id === id);
      if (i > 0) { const [p] = arr.splice(i, 1); arr.unshift(p); }
      return s;
    });

  // Banner reposition: drag the cover photo to choose which part shows in the
  // fixed-height banner (object-fit: cover crops, object-position picks the
  // focal point). Live drag stays in local state; we commit on release.
  const cover = photos[0];
  const [reframing, setReframing] = useState(false);
  // The banner is clean by default; tapping it reveals the Reframe/remove
  // controls so they're out of the way until wanted.
  const [controlsShown, setControlsShown] = useState(false);
  const [draftPos, setDraftPos] = useState({ x: 50, y: 50 });
  const reframeRef = useRef(null);
  const posRef = useRef({ x: 50, y: 50 });
  const coverPos = reframing ? draftPos : (cover && cover.pos) || { x: 50, y: 50 };

  const startReframe = () => {
    const p = (cover && cover.pos) || { x: 50, y: 50 };
    posRef.current = p;
    setDraftPos(p);
    setControlsShown(false);
    setReframing(true);
  };
  const commitReframe = () =>
    update((s) => { if (s.photos && s.photos[0]) s.photos[0].pos = posRef.current; return s; });
  const endReframe = () => { commitReframe(); setReframing(false); };
  const onReframeDown = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    reframeRef.current = { sx: e.clientX, sy: e.clientY, bx: draftPos.x, by: draftPos.y, w: rect.width, h: rect.height };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
  };
  const onReframeMove = (e) => {
    const r = reframeRef.current;
    if (!r) return;
    e.preventDefault();
    // Dragging the photo down should reveal more of its top, so subtract.
    const nx = Math.min(100, Math.max(0, r.bx - ((e.clientX - r.sx) / r.w) * 100));
    const ny = Math.min(100, Math.max(0, r.by - ((e.clientY - r.sy) / r.h) * 100));
    posRef.current = { x: nx, y: ny };
    setDraftPos(posRef.current);
  };
  const onReframeUp = () => { if (reframeRef.current) { reframeRef.current = null; commitReframe(); } };

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

  // Fraunces' italic ampersand is a curly swash, so the "&" is set upright —
  // same typeface, same weight, just not the italic swash form.
  const names = state.partner1 && state.partner2
    ? <>{state.partner1} <span style={S.heroAmp}>&</span> {state.partner2}</>
    : (state.partner1 || state.partner2 || "Your Wedding");

  const dateLabel = state.weddingDate
    ? new Date(state.weddingDate + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" })
    : "";

  // Names, date and venue get filled once, so they fold away — unless the plan
  // is still blank, in which case there's nothing else to do first.
  // Both sections start open; closing one is remembered on this device.
  const [showDetails, setShowDetails] = useState(() => panelOpen("details"));
  const toggleDetails = () => setShowDetails((v) => { savePanel("details", !v); return !v; });
  const upcoming = upcomingItems(state, 3);

  // Style board: colours, words and the photos, folded away by default so it
  // lives on Home without crowding the dashboard.
  // The board rests as a finished card and opens for editing on a tap, so it
  // never looks like a form until you actually want to change something.
  const [styleEditing, setStyleEditing] = useState(false);
  const palette = state.palette || [];

  // Which swatch the colour picker is open for: an index, "new", or null.
  const [pickerFor, setPickerFor] = useState(null);
  const [hexDraft, setHexDraft] = useState("");

  const setColor = (i, value) =>
    update((s) => { const p = [...(s.palette || [])]; p[i] = value; s.palette = p; return s; });
  const removeColor = (i) =>
    update((s) => { s.palette = (s.palette || []).filter((_, x) => x !== i); return s; });

  // One path for every way of choosing: preset, hex box, or the phone's wheel.
  const applyColor = (value) => {
    if (pickerFor === "new") {
      // Adding it once, then staying on that swatch: picking a second colour
      // changes your mind rather than adding another.
      const added = palette.length;
      update((s) => { s.palette = [...(s.palette || []), value]; return s; });
      setPickerFor(added);
    } else if (typeof pickerFor === "number") {
      setColor(pickerFor, value);
    }
  };
  const openPicker = (target) => {
    setPickerFor(target);
    setHexDraft(typeof target === "number" ? (palette[target] || "") : "");
  };
  // Accepts "c98b94" or "#c98b94"; anything else is left alone as they type.
  const onHexChange = (raw) => {
    setHexDraft(raw);
    const hex = raw.trim().replace(/^#/, "");
    if (/^[0-9a-f]{6}$/i.test(hex)) applyColor(`#${hex.toLowerCase()}`);
  };

  // The Venue box is filled by choosing a venue on the Venues tab, so tapping it
  // takes you there rather than editing the name in two places.
  const venues = state.venues || [];
  const chosenVenue = venues.find((v) => v.chosen);
  const venueValue = state.venue || chosenVenue?.name || "";

  return (
    <>
      {/* hero photo */}
      {photos.length > 0 && (
        <div style={S.heroPhotoWrap}>
          <img
            src={cover.src}
            alt="The couple"
            style={{ ...S.heroPhoto, objectPosition: `${coverPos.x}% ${coverPos.y}%`, cursor: reframing ? "grab" : "pointer", touchAction: reframing ? "none" : "auto" }}
            onClick={reframing ? undefined : () => setControlsShown((v) => !v)}
            onPointerDown={reframing ? onReframeDown : undefined}
            onPointerMove={reframing ? onReframeMove : undefined}
            onPointerUp={reframing ? onReframeUp : undefined}
            onPointerCancel={reframing ? onReframeUp : undefined}
          />
          {reframing ? (
            <>
              <div style={S.reframeHint}>Drag the photo to reposition</div>
              <button style={S.reframeDone} onClick={endReframe}>Done</button>
            </>
          ) : controlsShown ? (
            <>
              <button style={S.reframeBtn} onClick={startReframe}>Reframe</button>
              <button style={S.heroPhotoRemove} onClick={() => removePhoto(cover.id)}>×</button>
            </>
          ) : null}
        </div>
      )}

      {/* hero */}
      <div style={S.hero}>
        <div style={S.kicker}>We're getting married</div>
        <h1 style={S.heroNames}>{names}</h1>
        {dateLabel && <div style={{ ...S.heroDate, marginBottom: venueValue ? 2 : S.heroDate.marginBottom }}>{dateLabel}</div>}
        {/* Reads as part of the invitation, not a control — no label, no link. */}
        {venueValue && <div style={S.heroVenue}>at {venueValue}</div>}
        <button style={{ ...S.countdownPill, border: "none", cursor: "pointer" }} onClick={openDatePicker}>
          {countdown}
        </button>
      </div>

      {/* what needs doing next */}
      <section style={S.nextUp}>
        <div style={S.nextUpHead}>Next up</div>
        {upcoming.length === 0 ? (
          <div style={S.nextUpEmpty}>
            Nothing dated yet. Add a due date to a checklist task, or a balance due date to a
            booked vendor, and whatever's soonest shows up here.
          </div>
        ) : (
          upcoming.map((it) => {
            const color = it.days < 0 ? "#b0524a" : it.days <= 14 ? "#b8862f" : "#8a6d68";
            return (
              <button key={it.key} style={S.nextUpRow} onClick={() => go(it.tab)}>
                <span style={{ ...S.nextUpDot, background: color }} />
                <span style={S.nextUpTitle}>{it.title}</span>
                <span style={{ ...S.nextUpWhen, color }}>{whenLabel(it.date)}</span>
                <span style={S.footerChevron}>›</span>
              </button>
            );
          })
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
      {/* our details — filled once, so it folds away */}
      <section style={S.dashboard}>
        <button style={S.detailsHead} onClick={toggleDetails}>
          <span style={S.smallLabel}>Our details</span>
          <span style={{ ...S.chevron, transform: showDetails ? "rotate(90deg)" : "none" }}>›</span>
        </button>
        {showDetails && (
          <div>

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
            <button style={S.venueLink} onClick={() => go("venues")}>
              <span style={venueValue ? undefined : S.venueLinkEmpty}>
                {venueValue || "Choose a venue"}
              </span>
              <span style={S.venueLinkChevron}>›</span>
            </button>
          </Field>
        </div>
                </div>
        )}
      </section>

      {/* our style — a finished board at rest; tap it to get the controls,
          Done to put them away again */}
      <section style={{ ...S.dashboard, cursor: styleEditing ? "default" : "pointer" }}
        onClick={styleEditing ? undefined : () => setStyleEditing(true)}>
        <div style={S.styleHead}>
          <span style={S.smallLabel}>Our style</span>
          {!styleEditing && <span style={S.styleEditHint}>Tap to edit ›</span>}
        </div>

        {styleEditing && (
          <div style={S.styleNote}>Everything here is yours to change — tap Done when you're happy.</div>
        )}

        {/* ---- colours ---- */}
        {styleEditing && (
          <>
            <label style={{ ...S.smallLabel, display: "block", marginTop: 16 }}>Our colours</label>
            <div style={S.fieldHint}>Tap a colour to change it, or + to add one. The codes are what you give a florist or stylist.</div>
          </>
        )}
        {(palette.length > 0 || styleEditing) && (
          <div style={{ ...S.paletteRow, marginTop: styleEditing ? 10 : 4 }}>
            {palette.map((c, i) => (
              <span key={i} style={S.swatchWrap}>
                <button aria-label={`Colour ${i + 1}`}
                  onClick={(e) => {
                    // From the card, one tap opens the board *and* this colour's
                    // picker — a disabled swatch just swallowed the tap.
                    if (!styleEditing) { e.stopPropagation(); setStyleEditing(true); openPicker(i); return; }
                    openPicker(pickerFor === i ? null : i);
                  }}
                  style={{ ...S.swatch, background: c, cursor: "pointer",
                    ...(pickerFor === i ? S.swatchActive : null) }} />
                <span style={S.swatchHex}>{c.toUpperCase()}</span>
                {styleEditing && (
                  <button style={S.swatchRemove} aria-label="Remove colour"
                    onClick={() => { removeColor(i); setPickerFor(null); }}>×</button>
                )}
              </span>
            ))}
            {styleEditing && palette.length < MAX_PALETTE && (
              <button style={{ ...S.swatchAdd, ...(pickerFor === "new" ? S.swatchActive : null) }}
                onClick={() => openPicker(pickerFor === "new" ? null : "new")} aria-label="Add a colour">+</button>
            )}
          </div>
        )}

        {styleEditing && pickerFor !== null && (
          <div style={S.picker}>
            <div style={S.pickerGrid}>
              {PICKER_COLORS.map((c) => (
                <button key={c} aria-label={c} onClick={() => applyColor(c)}
                  style={{ ...S.pickerSwatch, background: c }} />
              ))}
            </div>
            <div style={S.pickerRow}>
              <input style={{ ...S.fieldInput, flex: 1 }} placeholder="#c98b94" maxLength={7}
                value={hexDraft} onChange={(e) => onHexChange(e.target.value)} aria-label="Colour code" />
              <label style={S.pickerMore}>
                More
                <input type="color" style={{ position: "absolute", opacity: 0, width: 1, height: 1 }}
                  value={typeof pickerFor === "number" ? (palette[pickerFor] || "#c98b94") : "#c98b94"}
                  onChange={(e) => { applyColor(e.target.value); setHexDraft(e.target.value); }} />
              </label>
              <button style={S.pickerDone} onClick={() => setPickerFor(null)}>Done</button>
            </div>
            <div style={S.pickerHint}>Tap a colour, or paste a code your florist gave you.</div>
          </div>
        )}

        {/* ---- words ---- */}
        {styleEditing ? (
          <>
            <label style={{ ...S.smallLabel, display: "block", marginTop: 18 }}>Style words</label>
            <div style={S.fieldHint}>Three or four words for the feel of the day — garden, candlelit, relaxed.</div>
            <input style={S.styleWordsInput} placeholder="garden, candlelit, relaxed…"
              value={state.styleWords || ""} onChange={(e) => set({ styleWords: e.target.value })}
              aria-label="Style words" />

            <label style={{ ...S.smallLabel, display: "block", marginTop: 18 }}>Our vision</label>
            <div style={S.fieldHint}>A sentence or two about the day you're picturing.</div>
            <textarea style={S.styleVisionInput} rows={3}
              placeholder="A long table under the trees, lots of candles, nothing stiff…"
              value={state.vision} onChange={(e) => set({ vision: e.target.value })}
              aria-label="Our vision" />
          </>
        ) : (
          <>
            {state.styleWords && <div style={S.styleWordsView}>{state.styleWords}</div>}
            {state.vision && <div style={S.styleVisionView}>{state.vision}</div>}
          </>
        )}

        {/* ---- inspo photos ---- */}
        {styleEditing && (
          <>
            <div style={{ ...S.galleryHead, marginTop: 18 }}>
              <label style={S.smallLabel}>Inspo photos</label>
              <label style={S.addPhotoBtn} onClick={(e) => e.stopPropagation()}>
                + Add photos
                <input type="file" accept="image/*" multiple style={{ display: "none" }}
                  onChange={(e) => { addPhotos(e.target.files); e.target.value = ""; }} />
              </label>
            </div>
            <div style={S.fieldHint}>The first photo becomes your banner at the top of this page. Everything after it is inspiration.</div>
          </>
        )}
        {photos.length === 0 ? (
          styleEditing && <div style={S.galleryEmpty}>No photos yet — add a favourite of the two of you, then anything that captures the look you're after.</div>
        ) : (
          <div style={{ ...S.galleryGrid, marginTop: styleEditing ? 10 : 14 }}>
            {photos.map((p, i) => (
              <div key={p.id} style={S.galleryItem}>
                <img src={p.src} alt="" style={S.galleryImg} />
                {i === 0 ? (
                  <span style={S.bannerTag}>★ Banner</span>
                ) : styleEditing ? (
                  <button style={S.setCoverBtn} onClick={() => setCover(p.id)} aria-label="Set as banner photo">☆ Banner</button>
                ) : null}
                {styleEditing && <button style={S.galleryRemove} onClick={() => removePhoto(p.id)}>×</button>}
              </div>
            ))}
          </div>
        )}

        {/* nothing set yet: say what this is for rather than showing a blank card */}
        {!styleEditing && palette.length === 0 && !state.styleWords && !state.vision && photos.length === 0 && (
          <div style={S.styleEmpty}>Your colours, the feel of the day, and photos that capture it — tap to start.</div>
        )}

        {styleEditing && (
          <button style={S.doneBtn} onClick={(e) => { e.stopPropagation(); setStyleEditing(false); setPickerFor(null); }}>
            Done
          </button>
        )}
      </section>

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


/* ============================================================
   BUDGET DONUT — spending by category
   ------------------------------------------------------------
   Plain SVG (no chart library): each slice is a circle with a
   dash pattern, rotated to start where the last one ended.
   ============================================================ */

const DONUT = { size: 190, stroke: 26 };

function BudgetDonut({ slices, value, total, overBudget, verb }) {
  const r = (DONUT.size - DONUT.stroke) / 2;
  const circ = 2 * Math.PI * r;
  const pct = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0;

  // Slices are drawn against the total budget, so the ring stays part-empty
  // until the budget is fully spent — the gap *is* the money left. Once over
  // budget the ring is full, so scale by what was actually spent instead of
  // letting slices wrap over each other.
  const sum = slices.reduce((s, x) => s + x.value, 0) || 1;
  const scale = overBudget ? sum : (total > 0 ? total : sum);
  let offset = 0;

  return (
    <div style={S.donutWrap}>
      <svg width={DONUT.size} height={DONUT.size} viewBox={`0 0 ${DONUT.size} ${DONUT.size}`} style={S.donutSvg}>
        <g transform={`rotate(-90 ${DONUT.size / 2} ${DONUT.size / 2})`}>
          <circle cx={DONUT.size / 2} cy={DONUT.size / 2} r={r} fill="none"
            stroke="#f4e8e4" strokeWidth={DONUT.stroke} />
          {slices.map((sl) => {
            const len = (sl.value / scale) * circ;
            const dash = `${Math.max(0, len - 1.5)} ${circ - Math.max(0, len - 1.5)}`;
            const el = (
              <circle key={sl.id} cx={DONUT.size / 2} cy={DONUT.size / 2} r={r} fill="none"
                stroke={sl.color} strokeWidth={DONUT.stroke}
                strokeDasharray={dash} strokeDashoffset={-offset} />
            );
            offset += len;
            return el;
          })}
          {/* Over budget: a red outline round the full ring, so the category
              colours still match their dots in the list below. */}
          {overBudget && (
            <circle cx={DONUT.size / 2} cy={DONUT.size / 2} r={r + DONUT.stroke / 2 - 1} fill="none"
              stroke="#c2566b" strokeWidth={2} />
          )}
        </g>
      </svg>
      <div style={S.donutCentre}>
        <div style={{ ...S.donutBig, color: overBudget ? "#c2566b" : "#6b4a45" }}>{fmt(value)}</div>
        <div style={S.donutSub}>of {fmt(total)}</div>
        <div style={{ ...S.donutPct, color: overBudget ? "#c2566b" : "#8a6d68" }}>
          {overBudget ? `${fmt(value - total)} over` : `${pct}% ${verb}`}
        </div>
      </div>
    </div>
  );
}

function BudgetView({ state, update, go }) {
  const [openCat, setOpenCat] = useState(null);
  const [confirmDeleteCat, setConfirmDeleteCat] = useState(null);

  const totalAllocated = state.categories.reduce((s, c) => s + (Number(c.allocated) || 0), 0);
  const totalSpent = state.categories.reduce((s, c) => s + catSpent(c), 0);
  const upcoming = state.categories.reduce((s, c) => s + catUpcoming(c), 0);
  // Spent + Upcoming + Remaining = the whole budget, so the four figures add up
  // and "Remaining" is money that isn't spoken for yet.
  const remaining = state.total - totalSpent - upcoming;
  const overBudget = totalSpent + upcoming > state.total;

  // What's contractually committed to vendors but not yet paid:
  // for each vendor, max(0, contracted - payments logged so far).
  const vendorsOwed = (state.vendors || [])
    .filter(countsInBudget) // shortlisted quotes must not inflate the total
    .map((v) => vendorMoney(state, v))
    .filter((v) => v.owed > 0);
  const totalCommitted = vendorsOwed.reduce((s, v) => s + v.owed, 0);

  // The donut shows either what's been spent or how the budget is divided up.
  // Until they choose, it picks the one that has something to show: a plan with
  // no spending yet is far more useful as its allocations.
  const [donutChoice, setDonutChoice] = useState(null);
  const donutMode = donutChoice || (totalSpent > 0 ? "spent" : "planned");
  const showingSpent = donutMode === "spent";

  // Biggest first, and once past 8 the tail is grouped into "Other" — beyond
  // that the colours stop being tellable apart.
  const MAX_SLICES = 8;
  const ranked = state.categories
    .map((c) => ({
      id: c.id,
      name: c.name,
      color: c.color || CAT_COLORS[0],
      value: showingSpent ? catSpent(c) : (Number(c.allocated) || 0),
    }))
    .filter((c) => c.value > 0)
    .sort((a, b) => b.value - a.value);
  const donutSlices = ranked.length > MAX_SLICES
    ? [
        ...ranked.slice(0, MAX_SLICES - 1),
        {
          id: "__other",
          name: "Other",
          color: "#cbb7b2",
          value: ranked.slice(MAX_SLICES - 1).reduce((s, c) => s + c.value, 0),
        },
      ]
    : ranked;

  const donutValue = showingSpent ? totalSpent : totalAllocated;
  const donutOver = state.total > 0 && donutValue > state.total;

  const setTotal = (v) => update((s) => { s.total = Math.max(0, Number(v) || 0); return s; });
  const addCategory = () => update((s) => { s.categories.push({ id: uid(), name: "New Category", allocated: 0, expenses: [], color: nextCatColor(s.categories) }); return s; });
  const addNamedCategory = (name) => update((s) => { s.categories.push({ id: uid(), name, allocated: 0, expenses: [], color: nextCatColor(s.categories) }); return s; });
  // Anything they already have — however it got there — drops off the list.
  const suggestions = SUGGESTED_CATEGORIES.filter(
    (n) => !state.categories.some((c) => (c.name || "").trim().toLowerCase() === n.toLowerCase())
  );
  const editCategory = (id, patch) => update((s) => { const c = s.categories.find((x) => x.id === id); if (c) Object.assign(c, patch); return s; });
  const deleteCategory = (id) => update((s) => {
    s.categories = s.categories.filter((x) => x.id !== id);
    // Vendors filed under it would otherwise keep a dead categoryId: the picker
    // then shows the first category while the vendor is really linked to none.
    const fallback = s.categories[0]?.id || "";
    for (const v of s.vendors) if (v.categoryId === id) v.categoryId = fallback;
    return s;
  });
  const reorderCategory = (from, to) => update((s) => {
    const n = s.categories.length;
    if (from === to || from < 0 || to < 0 || from >= n || to >= n) return s;
    const [m] = s.categories.splice(from, 1);
    s.categories.splice(to, 0, m);
    return s;
  });
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
            <input type="number" inputMode="numeric" className="big-number-lg" value={state.total === 0 ? "" : state.total}
              placeholder="0" onChange={(e) => setTotal(e.target.value)} style={S.totalInput} />
          </div>
        </div>

        <div style={S.donutToggle}>
          {[["spent", "Spent"], ["planned", "Planned"]].map(([mode, label]) => (
            <button key={mode} onClick={() => setDonutChoice(mode)}
              style={{ ...S.donutToggleBtn, ...(donutMode === mode ? S.donutToggleOn : null) }}>
              {label}
            </button>
          ))}
        </div>

        {donutSlices.length > 0 ? (
          <>
            <BudgetDonut slices={donutSlices} value={donutValue} total={state.total}
              overBudget={donutOver} verb={showingSpent ? "spent" : "allocated"} />
            <div style={S.donutLegend}>
              {donutSlices.map((sl) => (
                <span key={sl.id} style={S.donutLegendItem}>
                  <span style={{ ...S.donutDot, background: sl.color }} />
                  {sl.name} <span style={S.donutLegendAmt}>{fmt(sl.value)}</span>
                </span>
              ))}
            </div>
          </>
        ) : (
          <div style={S.donutEmpty}>
            <div style={S.donutEmptyRing} />
            <div style={S.donutEmptyText}>
              {showingSpent
                ? "Nothing spent yet — log a payment in a category below and it'll appear here in colour."
                : "No amounts set aside yet — give a category an allocation below and it'll appear here in colour."}
            </div>
          </div>
        )}

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
            <div style={S.committedHint}>Contracted amounts you haven't paid yet — booked vendors only</div>
            <div style={S.owedList}>
              {vendorsOwed.map((v, i) => {
                const d = dueTone(v.dueDate);
                return (
                  <div key={i} style={S.owedRow}>
                    <span style={S.owedName}>
                      {v.name || "Vendor"}
                      {d && <span style={{ ...S.owedDue, color: SAVE_TONE_COLOR[d.tone] }}>{d.label}</span>}
                    </span>
                    <span style={S.owedAmt}>{fmt(v.owed)} owing</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>

      <section>
        <DragSort ids={state.categories.map((c) => c.id)} onReorder={reorderCategory}>
          {({ handleProps, dragId }) => state.categories.map((cat) => {
          const spent = catSpent(cat);
          const catUp = catUpcoming(cat);
          // "Left" counts what's promised as well as what's paid — otherwise a
          // category with a big unpaid invoice looks like it has room.
          const diff = cat.allocated - spent - catUp;
          const isOpen = openCat === cat.id;
          const dragging = dragId === String(cat.id);
          // Vendors filed here. Their contracted totals aren't spending, so they
          // don't move the numbers — but the category must still show them, or a
          // vendor you assigned here looks like it went nowhere.
          const catVendors = categoryVendors(state, cat.id);
          const catOwed = catVendors.reduce((s, v) => s + (v.counted ? v.owed : 0), 0);
          const catConsidering = catVendors.filter((v) => !v.counted).length;
          return (
            <div key={cat.id} data-drag-id={cat.id} style={{ ...S.card, ...(dragging ? S.dragLifted : null) }}>
              <div style={{ ...S.cardHead, display: "flex", alignItems: "center" }}>
                <span {...handleProps(cat.id)} aria-label="Drag to reorder category" style={S.dragHandle}>⠿</span>
                <div style={{ display: "flex", alignItems: "center", flex: 1, cursor: "pointer" }} onClick={() => { setOpenCat(isOpen ? null : cat.id); setConfirmDeleteCat(null); }}>
                <span style={{ ...S.chevron, transform: isOpen ? "rotate(90deg)" : "none" }}>›</span>
                <div style={S.catMain}>
                  <div style={S.catName}>
                    {/* Same colour as this category's slice in the donut. */}
                    <span style={{ ...S.catDot, background: cat.color || CAT_COLORS[0] }} />
                    {cat.name}
                  </div>
                  <div style={S.catNumbers}>
                    <span style={S.catSpent}>{fmt(spent)}</span>
                    <span style={S.catOf}>of {fmt(cat.allocated)}</span>
                    {catUp > 0 && <span style={S.catUpcoming}>+{fmt(catUp)} upcoming</span>}
                    <span style={{ ...S.diffPill, background: diff < 0 ? "#f7dde2" : "#e4eede", color: diff < 0 ? "#c2566b" : "#5c7a59" }}>
                      {diff < 0 ? `${fmt(-diff)} over` : `${fmt(diff)} left`}
                    </span>
                  </div>
                  {/* How full this category is: spent against its allocation,
                      in its own colour so it ties back to the donut. */}
                  {(cat.allocated > 0 || spent > 0 || catUp > 0) && (() => {
                    // Solid = paid, faded = promised but not paid yet.
                    const base = cat.allocated > 0 ? cat.allocated : spent + catUp;
                    const pct = (n) => (base > 0 ? Math.min(100, (n / base) * 100) : 0);
                    const color = diff < 0 ? "#c2566b" : (cat.color || CAT_COLORS[0]);
                    return (
                      <div style={S.catBar}>
                        <div style={{ ...S.catBarFill, width: `${pct(spent)}%`, background: color }} />
                        <div style={{ ...S.catBarFill, width: `${pct(catUp)}%`, background: color, opacity: 0.35 }} />
                      </div>
                    );
                  })()}
                  {catVendors.length > 0 && (
                    <div style={S.catVendorHint}>
                      {catVendors.length} vendor{catVendors.length > 1 ? "s" : ""}
                      {catOwed > 0 ? ` · ${fmt(catOwed)} still to pay` : ""}
                      {catConsidering > 0 ? ` · ${catConsidering} being considered` : ""}
                    </div>
                  )}
                </div>
                </div>
                <button onClick={(e) => { e.stopPropagation(); setConfirmDeleteCat(cat.id); }}
                  style={S.trashBtn}><Icon name="trash" size={18} color="#c98b94" /></button>
              </div>

              {/* Deleting a category also deletes the payments logged in it, so
                  say exactly what's about to be lost before it happens. */}
              {confirmDeleteCat === cat.id && (
                <div style={S.deleteWarn}>
                  <div style={S.deleteWarnText}>
                    Delete <strong>{cat.name}</strong>?
                    {cat.expenses.length > 0 && (
                      <> This also deletes {cat.expenses.length} payment{cat.expenses.length > 1 ? "s" : ""} worth {fmt(spent)}.</>
                    )}
                    {catVendors.length > 0 && (
                      <> {catVendors.length} vendor{catVendors.length > 1 ? "s" : ""} will move to {state.categories.find((c) => c.id !== cat.id)?.name || "no category"}.</>
                    )}
                    {cat.expenses.length === 0 && catVendors.length === 0 && <> Nothing is logged in it.</>}
                  </div>
                  <div style={S.deleteWarnBtns}>
                    <button onClick={() => { deleteCategory(cat.id); setConfirmDeleteCat(null); }}
                      style={S.trashConfirm}>Delete</button>
                    <button onClick={() => setConfirmDeleteCat(null)} style={S.trashCancel}>Cancel</button>
                  </div>
                </div>
              )}

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
                    <button style={S.deleteCat} onClick={() => setConfirmDeleteCat(cat.id)}>Delete</button>
                  </div>
                  {catVendors.length > 0 && (
                    <div style={S.catVendorBox}>
                      <label style={S.smallLabel}>Vendors in this category</label>
                      {catVendors.map((v) => (
                        <button key={v.id} style={S.catVendorRow} onClick={() => go("vendors")}>
                          <span style={{ ...S.catVendorName, ...(v.counted ? null : S.catVendorMuted) }}>
                            {v.name || "Vendor"}
                          </span>
                          <span style={{ ...S.catVendorAmt, ...(v.counted ? null : S.catVendorMuted) }}>
                            {!v.counted ? `${v.status} · not counted`
                              : v.contracted === 0 ? "No total set"
                              : v.owed > 0 ? `${fmt(v.owed)} owing${v.dueDate ? ` · due ${shortDate(v.dueDate)}` : ""}`
                              : "Paid in full"}
                          </span>
                          <span style={S.footerChevron}>›</span>
                        </button>
                      ))}
                      <div style={S.catVendorHelp}>
                        Only vendors marked <strong>Booked</strong> count toward your budget. Contracted totals aren't
                        spending either — log a payment below to add it to this category.
                      </div>
                    </div>
                  )}
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
        </DragSort>
        <button style={S.addCat} onClick={addCategory}>+ Add category</button>

        {suggestions.length > 0 && (
          <div style={S.suggestBox}>
            <label style={S.smallLabel}>Suggested categories</label>
            <div style={S.suggestHint}>Common wedding costs — tap one to add it.</div>
            <div style={S.suggestWrap}>
              {suggestions.map((name) => (
                <button key={name} style={S.suggestChip} onClick={() => addNamedCategory(name)}>
                  + {name}
                </button>
              ))}
            </div>
          </div>
        )}
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

// Touch/mouse drag-to-reorder for a vertical list. Each row must carry
// data-drag-id="<id>"; drag starts from a handle spread with handleProps(id).
// While a row is held, we compare the finger's Y against the midpoints of the
// neighbours above/below and shift the row one slot at a time — which avoids
// the flicker you'd get from naive hover-swapping.
function DragSort({ ids, onReorder, style, children }) {
  const [dragId, setDragId] = useState(null);
  const ref = useRef(null);
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;
  const dragIdRef = useRef(null);

  useEffect(() => {
    if (dragId == null) return;
    const move = (e) => {
      const held = dragIdRef.current;
      if (held == null || !ref.current) return;
      e.preventDefault();
      const rows = Array.from(ref.current.querySelectorAll("[data-drag-id]"))
        .filter((el) => el.parentElement === ref.current);
      const idx = rows.findIndex((el) => el.getAttribute("data-drag-id") === held);
      if (idx === -1) return;
      const y = e.clientY;
      const prev = rows[idx - 1];
      const next = rows[idx + 1];
      if (prev) {
        const r = prev.getBoundingClientRect();
        if (y < r.top + r.height / 2) { onReorderRef.current(idx, idx - 1); return; }
      }
      if (next) {
        const r = next.getBoundingClientRect();
        if (y > r.top + r.height / 2) { onReorderRef.current(idx, idx + 1); return; }
      }
    };
    const end = () => { dragIdRef.current = null; setDragId(null); };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [dragId]);

  const handleProps = (id) => ({
    onPointerDown: (e) => {
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      dragIdRef.current = String(id);
      setDragId(String(id));
    },
  });

  return (
    <div ref={ref} style={style}>
      {children({ handleProps, dragId })}
    </div>
  );
}

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
  const reorderBucket = (from, to) => update((s) => {
    const n = s.checklist.length;
    if (from === to || from < 0 || to < 0 || from >= n || to >= n) return s;
    const [m] = s.checklist.splice(from, 1);
    s.checklist.splice(to, 0, m);
    return s;
  });
  const reorderTask = (bid, from, to) => update((s) => {
    const b = s.checklist.find((x) => x.id === bid);
    if (!b) return s;
    const n = b.tasks.length;
    if (from === to || from < 0 || to < 0 || from >= n || to >= n) return s;
    const [m] = b.tasks.splice(from, 1);
    b.tasks.splice(to, 0, m);
    return s;
  });

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
        <DragSort ids={state.checklist.map((b) => b.id)} onReorder={reorderBucket}>
          {({ handleProps, dragId }) => state.checklist.map((bucket) => {
          const bDone = bucket.tasks.filter((t) => t.done).length;
          const isOpen = openBucket === bucket.id;
          const dragging = dragId === String(bucket.id);
          return (
            <div key={bucket.id} data-drag-id={bucket.id} style={{ ...S.card, ...(dragging ? S.dragLifted : null) }}>
              <div style={{ ...S.cardHead, display: "flex", alignItems: "center" }}>
                <span {...handleProps(bucket.id)} aria-label="Drag to reorder section" style={S.dragHandle}>⠿</span>
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
                  <DragSort ids={bucket.tasks.map((t) => t.id)} onReorder={(from, to) => reorderTask(bucket.id, from, to)}>
                    {({ handleProps: taskHandle, dragId: taskDragId }) => bucket.tasks.map((t) => {
                    const open = expanded === t.id;
                    const tDragging = taskDragId === String(t.id);
                    return (
                      <div key={t.id} data-drag-id={t.id} style={{ ...S.taskItem, ...(tDragging ? S.dragLifted : null) }}>
                        <div style={S.taskTop}>
                          <button style={{ ...S.check, background: t.done ? "#c98b94" : "#fff", borderColor: t.done ? "#c98b94" : "#d9b8b2" }}
                            onClick={() => toggleTask(bucket.id, t.id)}>
                            {t.done ? "✓" : ""}
                          </button>
                          <input style={{ ...S.taskName, textDecoration: t.done ? "line-through" : "none", color: t.done ? "#b9a39e" : "#3a2e2c" }}
                            value={t.name} onChange={(e) => editTask(bucket.id, t.id, { name: e.target.value })} />
                          <span {...taskHandle(t.id)} aria-label="Drag to reorder task" style={S.dragHandle}>⠿</span>
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
                  </DragSort>
                  <AddTask onAdd={(name) => addTask(bucket.id, name)} />
                  <button style={S.doneBtn} onClick={() => setOpenBucket(null)}>Done</button>
                </div>
              )}
            </div>
          );
        })}
        </DragSort>
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
  // Which vendor is naming a brand-new budget category, and the name so far.
  const [newCatFor, setNewCatFor] = useState(null);
  const [newCatName, setNewCatName] = useState("");

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
        dueDate: "", // when the remaining balance has to be paid
      };
      s.vendors.push(v);
      return s;
    });

  const editVendor = (id, patch) =>
    update((s) => { const v = s.vendors.find((x) => x.id === id); if (v) Object.assign(v, patch); return s; });

  // Create a budget category from here and file the vendor under it. It's the
  // same categories list the Budget page renders, so both stay in step.
  const addCategoryFor = (vendorId, name) => {
    const clean = name.trim();
    if (!clean) return;
    update((s) => {
      const id = uid();
      s.categories.push({ id, name: clean, allocated: 0, expenses: [], color: nextCatColor(s.categories) });
      const v = s.vendors.find((x) => x.id === vendorId);
      if (v) v.categoryId = id;
      return s;
    });
    setNewCatFor(null);
    setNewCatName("");
  };

  const deleteVendor = (id) =>
    update((s) => {
      // Unlink this vendor from any expenses, but keep the expenses themselves.
      for (const c of s.categories) for (const e of c.expenses) if (e.vendorId === id) delete e.vendorId;
      s.vendors = s.vendors.filter((x) => x.id !== id);
      return s;
    });

  const reorderVendor = (from, to) => update((s) => {
    const n = s.vendors.length;
    if (from === to || from < 0 || to < 0 || from >= n || to >= n) return s;
    const [m] = s.vendors.splice(from, 1);
    s.vendors.splice(to, 0, m);
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

        <DragSort ids={shownVendors.map((v) => v.id)} onReorder={reorderVendor}>
          {({ handleProps, dragId }) => shownVendors.map((vendor) => {
          const cat = state.categories.find((c) => c.id === vendor.categoryId);
          const payments = vendorExpenses(state, vendor.id);
          const paid = payments.reduce((s, e) => s + (Number(e.amount) || 0), 0);
          const isOpen = openVendor === vendor.id;
          const dragging = dragId === String(vendor.id);
          const statusColor =
            vendor.status === "Booked" ? { bg: "#e4eede", fg: "#5c7a59" }
            : vendor.status === "Contacted" ? { bg: "#faf0d8", fg: "#a8862f" }
            : { bg: "#f4e8e4", fg: "#b07a72" };

          return (
            <div key={vendor.id} data-drag-id={vendor.id} style={{ ...S.card, ...(dragging ? S.dragLifted : null) }}>
              <div style={{ ...S.cardHead, display: "flex", alignItems: "center" }}>
                {!q && <span {...handleProps(vendor.id)} aria-label="Drag to reorder vendor" style={S.dragHandle}>⠿</span>}
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
                    {/* Only worth showing while money is still owed on it. */}
                    {vendor.dueDate && paid < (Number(vendor.contracted) || 0) && (() => {
                      const d = dueTone(vendor.dueDate);
                      return d ? <div style={{ ...S.dueLine, color: SAVE_TONE_COLOR[d.tone] }}>{d.label}</div> : null;
                    })()}
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
                      {/* Never show a category this vendor isn't actually filed
                          under: an unknown id reads as "not linked yet". */}
                      <select style={S.fieldSelect} value={cat ? vendor.categoryId : ""}
                        onChange={(e) => {
                          if (e.target.value === "__new") { setNewCatFor(vendor.id); setNewCatName(""); return; }
                          editVendor(vendor.id, { categoryId: e.target.value });
                        }}>
                        {!cat && <option value="">Not linked yet — pick one</option>}
                        {state.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        <option value="__new">+ New category…</option>
                      </select>
                      {newCatFor === vendor.id && (
                        <div style={S.newCatRow}>
                          <input style={{ ...S.fieldInput, flex: 1 }} autoFocus placeholder="Category name"
                            value={newCatName}
                            onChange={(e) => setNewCatName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") addCategoryFor(vendor.id, newCatName); }} />
                          <button style={S.newCatAdd} onClick={() => addCategoryFor(vendor.id, newCatName)}>Add</button>
                          <button style={S.newCatCancel} onClick={() => { setNewCatFor(null); setNewCatName(""); }}>×</button>
                        </div>
                      )}
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
                    <Field label="Balance due">
                      <input type="date" style={S.fieldInput} value={vendor.dueDate || ""}
                        onChange={(e) => editVendor(vendor.id, { dueDate: e.target.value })} />
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
        </DragSort>

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

const PLAN_LABEL = { want: "Want to invite", notsure: "Not sure" };

function GuestsView({ state, update }) {
  const [openGuest, setOpenGuest] = useState(null);
  // Which stage is being viewed: "invited" (the real list) or "planning" (brainstorm).
  const [view, setView] = useState("invited");
  const [filter, setFilter] = useState("All");
  const [query, setQuery] = useState("");
  const [managing, setManaging] = useState(false);
  // Groups start collapsed; a group is expanded only after the user taps it.
  const [collapsedGroups, setCollapsedGroups] = useState({});
  const toggleGroup = (grp) => setCollapsedGroups((prev) => ({ ...prev, [grp]: !(prev[grp] ?? true) }));
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

  const allGuests = state.guests;
  const invitedGuests = allGuests.filter(isInvited);
  const planningGuests = allGuests.filter((g) => !isInvited(g));
  // Group picker offers every group already in use (across both stages), not
  // just the tracked options — so moving a guest reuses the existing group
  // instead of spawning a near-duplicate.
  const groupChoices = [...new Set([
    ...(state.groupOptions || []),
    ...allGuests.map((g) => (g.group || "").trim()).filter(Boolean),
  ])];
  // The list shown depends on the current stage tab.
  const guests = view === "invited" ? invitedGuests : planningGuests;

  const counts = {
    invited: invitedGuests.length,
    yes: invitedGuests.filter((g) => g.rsvp === "Yes").length,
    no: invitedGuests.filter((g) => g.rsvp === "No").length,
    waiting: invitedGuests.filter((g) => g.rsvp === "Invited" || g.rsvp === "Maybe").length,
  };
  const heads = headcount(allGuests);
  const planCounts = {
    total: planningGuests.length,
    want: planningGuests.filter((g) => (g.planStatus || "want") === "want").length,
    notsure: planningGuests.filter((g) => (g.planStatus || "want") === "notsure").length,
  };

  const byStatus = filter === "All"
    ? guests
    : view === "invited"
      ? guests.filter((g) => g.rsvp === filter)
      : guests.filter((g) => PLAN_LABEL[g.planStatus || "want"] === filter);
  const q = query.trim().toLowerCase();
  const shown = !q
    ? byStatus
    : byStatus.filter((g) =>
        [g.name, g.group, g.notes].some((f) => (f || "").toLowerCase().includes(q))
      );

  const addGuestToGroup = (grp) => {
    const group = grp || "";
    const id = uid();
    update((s) => {
      // New guests join whichever stage is currently being viewed.
      s.guests.push({ id, name: "", rsvp: "Invited", party: 1, meal: "", group, notes: "", stage: view, planStatus: "want" });
      return s;
    });
    // Make sure the target group is expanded and jump straight into the
    // new guest's info form. Clear search/filter so the guest is visible.
    setCollapsedGroups((prev) => ({ ...prev, [group]: false }));
    setFilter("All");
    setQuery("");
    setOpenGuest(id);
  };
  const addGuest = () => addGuestToGroup("");
  const editGuest = (id, patch) =>
    update((s) => { const g = s.guests.find((x) => x.id === id); if (g) Object.assign(g, patch); return s; });
  const deleteGuest = (id) =>
    update((s) => { s.guests = s.guests.filter((x) => x.id !== id); return s; });
  // Move a guest from the planning list onto the real (invited) list.
  const inviteGuest = (id) =>
    update((s) => { const g = s.guests.find((x) => x.id === id); if (g) { g.stage = "invited"; if (!g.rsvp) g.rsvp = "Invited"; } return s; });
  // Move a guest back to the planning list.
  const moveToPlanning = (id) =>
    update((s) => { const g = s.guests.find((x) => x.id === id); if (g) { g.stage = "planning"; if (!g.planStatus) g.planStatus = "want"; } return s; });

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

      {/* Stage toggle: brainstorm in Planning, then move people to Invited */}
      <div style={S.stageToggle}>
        <button onClick={() => { setView("planning"); setFilter("All"); setOpenGuest(null); }}
          style={{ ...S.stageTab, ...(view === "planning" ? S.stageTabActive : null) }}>
          Planning{planCounts.total > 0 ? ` (${planCounts.total})` : ""}
        </button>
        <button onClick={() => { setView("invited"); setFilter("All"); setOpenGuest(null); }}
          style={{ ...S.stageTab, ...(view === "invited" ? S.stageTabActive : null) }}>
          Invited{counts.invited > 0 ? ` (${counts.invited})` : ""}
        </button>
      </div>

      <section style={S.dashboard}>
        {view === "invited" ? (
          <>
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
          </>
        ) : (
          <>
            <div style={S.guestStats}>
              <GuestStat n={planCounts.total} label="On your list" accent="#8a6d68" />
              <GuestStat n={planCounts.want} label="Want to invite" accent="#5c7a59" />
              <GuestStat n={planCounts.notsure} label="Not sure" accent="#a8862f" />
            </div>
            <div style={S.headcountBox}>
              <span style={S.headcountLabel}>Your planning list — brainstorm freely. These aren't invited yet and don't count toward your headcount.</span>
            </div>
          </>
        )}
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
        {(view === "invited" ? ["All", "Invited", "Yes", "Maybe", "No"] : ["All", "Want to invite", "Not sure"]).map((f) => (
          <button key={f} onClick={() => setFilter(f)}
            style={{ ...S.filterPill, background: filter === f ? "#c98b94" : "#fff", color: filter === f ? "#fff" : "#b58e87", borderColor: filter === f ? "#c98b94" : "#f0e2dd" }}>
            {f}
          </button>
        ))}
        <button onClick={() => setManaging((m) => !m)}
          style={{ ...S.filterPill, marginLeft: "auto", background: managing ? "#6b4a45" : "#fff", color: managing ? "#fff" : "#b58e87", borderColor: managing ? "#6b4a45" : "#f0e2dd" }}>
          {managing ? "Done" : (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <Icon name="gear" size={13} color="#b58e87" /> Options
            </span>
          )}
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
          <div style={S.emptyNote}>
            {view === "planning"
              ? "Nothing here yet. Brainstorm everyone you might invite — you can move them to your guest list later."
              : "No invited guests yet. Add people here, or move them over from your Planning list."}
          </div>
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
            // Default collapsed; expand on tap, and always expand while searching.
            const isCollapsed = q ? false : (collapsedGroups[grp] ?? true);
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
                    {view === "invited" && yesCount > 0 ? `${yesCount} coming · ` : ""}{members.length} guest{members.length !== 1 ? "s" : ""}
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
                              {view === "invited" ? (
                                <span style={{ ...S.diffPill, background: c.bg, color: c.fg, fontSize: 11, flexShrink: 0 }}>{g.rsvp}</span>
                              ) : (
                                <span style={{ ...S.diffPill, ...((g.planStatus || "want") === "notsure" ? { background: "#faf0d8", color: "#a8862f" } : { background: "#e4eede", color: "#5c7a59" }), fontSize: 11, flexShrink: 0 }}>
                                  {PLAN_LABEL[g.planStatus || "want"]}
                                </span>
                              )}
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
                                {view === "invited" ? (
                                  <Field label="RSVP">
                                    <select style={S.fieldSelect} value={g.rsvp} onChange={(e) => editGuest(g.id, { rsvp: e.target.value })}>
                                      {RSVP_STATUSES.map((st) => <option key={st} value={st}>{st}</option>)}
                                    </select>
                                  </Field>
                                ) : (
                                  <Field label="Plan status">
                                    <select style={S.fieldSelect} value={g.planStatus || "want"} onChange={(e) => editGuest(g.id, { planStatus: e.target.value })}>
                                      <option value="want">Want to invite</option>
                                      <option value="notsure">Not sure</option>
                                    </select>
                                  </Field>
                                )}
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
                                    {groupChoices.map((gr) => <option key={gr} value={gr}>{gr}</option>)}
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
                              {view === "planning" ? (
                                <button style={S.inviteBtn} onClick={() => { inviteGuest(g.id); setOpenGuest(null); }}>
                                  Invite → move to guest list
                                </button>
                              ) : (
                                <button style={S.moveBackBtn} onClick={() => { moveToPlanning(g.id); setOpenGuest(null); }}>
                                  ↩ Move back to planning
                                </button>
                              )}
                              <button style={{ ...S.deleteCat, marginTop: 12, display: "block" }} onClick={() => deleteGuest(g.id)}>
                                Remove guest
                              </button>
                              <button style={S.doneBtn} onClick={() => setOpenGuest(null)}>Done</button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    <div style={{ display: "flex", alignItems: "center", borderTop: "1px solid #f7ece8" }}>
                      {grp !== "" && (
                        <button onClick={() => addGuestToGroup(grp)}
                          style={{ flex: 1, textAlign: "left", background: "none", border: "none", padding: "12px 14px", color: "#b07a72", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "'Fraunces', serif" }}>
                          + Add guest to {label}
                        </button>
                      )}
                      <button onClick={() => toggleGroup(grp)}
                        style={{ marginLeft: "auto", background: "none", border: "none", padding: "12px 14px", color: "#b58e87", fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", gap: 5 }}>
                        Collapse <span style={{ fontSize: 11 }}>▲</span>
                      </button>
                    </div>
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
   We build a print-optimized HTML document for the whole plan,
   render it in an offscreen iframe, and use html2pdf.js (loaded on
   demand) to rasterize it into a real .pdf that downloads straight
   to the device — identical on desktop, iPhone and Android, with no
   browser print dialog to navigate.
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
  const totalUpcoming = state.categories.reduce((s, c) => s + catUpcoming(c), 0);
  const remaining = state.total - totalSpent - totalUpcoming;
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
      const owed = Math.max(0, (Number(v.contracted) || 0) - paid);
      // What's still owed and when — the reason to print this page at all.
      const due = v.dueDate
        ? `<div class="sub">${owed > 0 ? `${esc(fmt(owed))} due ` : "Balance was due "}${esc(shortDate(v.dueDate))}</div>`
        : "";
      return `<tr><td><strong>${esc(v.name)}</strong>${v.type ? `<div class="muted">${esc(v.type)}</div>` : ""}${contact ? `<div class="sub">${contact}</div>` : ""}</td><td>${esc(v.status)}${due}</td><td class="num">${esc(fmt(paid))}${v.contracted > 0 ? ` <span class="muted">/ ${esc(fmt(v.contracted))}</span>` : ""}</td></tr>`;
    })
    .join("");

  // ---- Guests ----
  const heads = headcount(state.guests);
  const guestRows = (state.guests || [])
    .filter(isInvited)
    .map(
      (g) =>
        `<tr><td>${esc(g.name) || "Guest"}${Number(g.party) > 1 ? ` <span class="muted">+${g.party - 1}</span>` : ""}</td><td>${esc(g.rsvp)}</td><td>${esc(g.group) || "—"}</td><td>${esc(g.meal) || "—"}</td></tr>`
    )
    .join("");

  // ---- Seating ----
  const guestAt = (id) => (state.guests || []).find((g) => g.id === id);
  const seatingHtml = (state.tables || [])
    .map((t) => {
      const ids = t.seated || [];
      // Chairs used, so a "+1" counts twice — same rule as the Seating tab.
      const used = ids.reduce((n, gid) => n + partySize(guestAt(gid)), 0);
      const seated = ids
        .map((gid) => {
          const g = guestAt(gid);
          const extra = partySize(g) > 1 ? ` <span class="muted">+${partySize(g) - 1}</span>` : "";
          return `<li>${esc(g?.name || "Unnamed")}${extra}</li>`;
        })
        .join("");
      return `<div class="block"><h3>${esc(t.name)} <span class="muted">(${used}/${t.capacity})</span></h3><ul>${seated || '<li class="muted">Empty</li>'}</ul></div>`;
    })
    .join("");

  const section = (title, body, show = true) =>
    show ? `<section><h2>${title}</h2>${body}</section>` : "";

  // ---- Style ----
  // The page a couple hands their florist or stylist: the colours and the words
  // for the day. Hex codes are printed so a supplier can match them exactly.
  const palette = (state.palette || []).filter((c) => /^#[0-9a-f]{6}$/i.test(c));
  const swatches = palette
    .map((c) => `<div class="sw"><div class="chip" style="background:${esc(c)}"></div><div class="hex">${esc(c.toUpperCase())}</div></div>`)
    .join("");
  const styleWords = (state.styleWords || "").trim();
  const styleHtml = `
    ${styleWords ? `<div class="words">${esc(styleWords)}</div>` : ""}
    ${swatches ? `<div class="palette">${swatches}</div>` : ""}`;

  // Everything lives inside a single .pod-pdf root with its styles scoped to
  // that class. That way the styling travels *with* the node — it survives
  // being cloned into the PDF renderer, and it can't leak into the live app
  // when we show it in the preview modal.
  return `<div class="pod-pdf">
<style>
  .pod-pdf * { box-sizing: border-box; }
  .pod-pdf { font-family: Georgia, 'Times New Roman', serif; color: #3a2e2c; line-height: 1.45; background: #ffffff; width: 760px; margin: 0 auto; padding: 34px 40px; }
  .pod-pdf .cover { text-align: center; padding: 6px 0 26px; border-bottom: 2px solid #e9d3cd; margin-bottom: 28px; }
  .pod-pdf .kicker { text-transform: uppercase; letter-spacing: 0.18em; font-size: 12px; color: #b07a72; }
  .pod-pdf h1 { font-size: 34px; margin: 8px 0 6px; font-weight: 600; }
  .pod-pdf .cover .date { font-size: 16px; color: #6b4a45; }
  .pod-pdf .cover .venue { font-size: 14px; color: #8a6d68; margin-top: 4px; }
  .pod-pdf .vision { font-style: italic; color: #6b4a45; max-width: 460px; margin: 14px auto 0; }
  .pod-pdf section { margin-bottom: 26px; page-break-inside: avoid; }
  .pod-pdf .words { font-size: 15px; font-style: italic; color: #6b4a45; margin-bottom: 14px; }
  .pod-pdf .palette { display: flex; flex-wrap: wrap; gap: 14px; }
  .pod-pdf .sw { text-align: center; }
  .pod-pdf .chip { width: 74px; height: 52px; border-radius: 8px; border: 1px solid rgba(107,74,69,0.18); }
  .pod-pdf .hex { font-size: 11px; color: #8a6d68; margin-top: 5px; letter-spacing: 0.04em; }
  .pod-pdf h2 { font-size: 19px; color: #b07a72; border-bottom: 1px solid #f0e2dd; padding-bottom: 5px; margin: 0 0 12px; }
  .pod-pdf h3 { font-size: 14px; margin: 0 0 6px; }
  .pod-pdf table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .pod-pdf td, .pod-pdf th { text-align: left; padding: 7px 6px; border-bottom: 1px solid #f2e6e2; vertical-align: top; }
  .pod-pdf th { color: #b58e87; text-transform: uppercase; letter-spacing: 0.06em; font-size: 11px; }
  .pod-pdf .num { text-align: right; white-space: nowrap; }
  .pod-pdf .muted { color: #a98e88; font-weight: normal; }
  .pod-pdf .sub { font-size: 12px; color: #8a6d68; margin-top: 2px; }
  .pod-pdf .note { font-size: 12px; color: #8a6d68; margin-left: 18px; }
  .pod-pdf .block { margin-bottom: 14px; page-break-inside: avoid; }
  .pod-pdf ul { margin: 0; padding-left: 20px; font-size: 13px; }
  .pod-pdf li { margin: 2px 0; }
  .pod-pdf li.done { color: #9c8f8b; }
  .pod-pdf .summary { display: flex; gap: 10px; margin-bottom: 14px; }
  .pod-pdf .stat { flex: 1; border: 1px solid #f0e2dd; border-radius: 8px; padding: 10px; text-align: center; }
  .pod-pdf .stat .big { font-size: 18px; font-weight: 600; }
  .pod-pdf .stat .lbl { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #b58e87; }
  .pod-pdf .foot { text-align: center; font-size: 11px; color: #b58e87; margin-top: 30px; }
</style>
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
      <div class="stat"><div class="big">${esc(fmt(totalUpcoming))}</div><div class="lbl">Upcoming</div></div>
      <div class="stat"><div class="big">${esc(fmt(remaining))}</div><div class="lbl">Remaining</div></div>
    </div>
    <table><thead><tr><th>Category</th><th class="num">Spent</th><th class="num">Allocated</th></tr></thead><tbody>${budgetRows}</tbody></table>`
  )}

  ${section("Our style", styleHtml, !!(styleWords || swatches))}

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
</div>`;
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

  // PDF export is a two-step flow: open a preview of the styled plan, then
  // let the user save it. The preview node itself is what gets turned into
  // the PDF, so what they see is exactly what they save.
  const [showPdfPreview, setShowPdfPreview] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const previewRef = useRef(null);

  // Fit the fixed-width page into whatever room the modal has.
  const pdfScrollRef = useRef(null);
  const pdfScaleRef = useRef(null);
  const [pdfScale, setPdfScale] = useState(1);
  const [pdfHeight, setPdfHeight] = useState(0);
  useEffect(() => {
    if (!showPdfPreview) return;
    const fit = () => {
      const box = pdfScrollRef.current;
      const page = previewRef.current?.querySelector(".pod-pdf");
      if (!box) return;
      const room = box.clientWidth;
      setPdfScale(Math.min(1, room / PDF_PAGE_WIDTH));
      if (page) setPdfHeight(page.offsetHeight);
    };
    // One frame later, so the preview HTML has laid out and has a height.
    const id = setTimeout(fit, 0);
    window.addEventListener("resize", fit);
    return () => { clearTimeout(id); window.removeEventListener("resize", fit); };
  }, [showPdfPreview, state]);

  const savePDF = async () => {
    const node = previewRef.current?.querySelector(".pod-pdf");
    if (!node || pdfBusy) return;
    setPdfBusy(true);
    // The preview is scaled down to fit the screen; the saved file must not be.
    // Drop the scale for the capture, then put it back.
    const scaler = pdfScaleRef.current;
    const savedTransform = scaler ? scaler.style.transform : "";
    if (scaler) {
      scaler.style.transform = "none";
      // A timer, not requestAnimationFrame: rAF never fires while the tab is in
      // the background, which would leave the save hanging on "Saving…".
      await new Promise((r) => setTimeout(r, 60));
    }
    try {
      const base =
        (state.partner1 && state.partner2
          ? `${state.partner1}-and-${state.partner2}`
          : state.partner1 || state.partner2 || "our")
          .replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "our";
      const stamp = new Date().toISOString().slice(0, 10);

      // Loaded on demand so the PDF library isn't in the app's initial download.
      const mod = await import("html2pdf.js");
      const html2pdf = mod.default || mod;
      await html2pdf()
        .set({
          margin: [10, 10, 12, 10],
          filename: `${base}-wedding-plan-${stamp}.pdf`,
          image: { type: "jpeg", quality: 0.98 },
          html2canvas: { scale: 2, backgroundColor: "#ffffff", useCORS: true },
          jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
          pagebreak: { mode: ["css", "avoid-all"] },
        })
        .from(node)
        .save();
      setShowPdfPreview(false);
    } catch (e) {
      alert("Sorry — something went wrong creating the PDF. Please try again.");
    } finally {
      if (scaler) scaler.style.transform = savedTransform;
      setPdfBusy(false);
    }
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
        <p style={S.settingHint}>Preview your whole plan — couple details, budget, checklist, vendors, guests and seating — then download it as a PDF straight to your device (your Files or Downloads), on phone or computer.</p>
        <button style={S.settingBtn} onClick={() => setShowPdfPreview(true)}>Preview &amp; download PDF</button>
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
      {sync && <div id="sync-panel"><SyncPanel sync={sync} /></div>}

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

      {/* PDF preview — shows the styled plan exactly as it will be saved. */}
      {showPdfPreview && (
        <div style={S.pdfOverlay} onClick={() => !pdfBusy && setShowPdfPreview(false)}>
          <div style={S.pdfCard} onClick={(e) => e.stopPropagation()}>
            <div style={S.pdfHead}>
              <div>
                <div style={S.pdfHeadTitle}>Your plan PDF</div>
                <div style={S.pdfHeadHint}>This is exactly what will be saved.</div>
              </div>
              <button style={S.pdfClose} onClick={() => !pdfBusy && setShowPdfPreview(false)} aria-label="Close preview">×</button>
            </div>
            {/* The plan is laid out at a fixed page width, so on a phone it's
                scaled down to fit rather than needing a sideways drag. The node
                itself keeps its real size — savePDF renders that, not this. */}
            <div style={S.pdfScroll} ref={pdfScrollRef}>
              <div style={{ width: PDF_PAGE_WIDTH * pdfScale, height: pdfHeight ? pdfHeight * pdfScale : undefined, overflow: "hidden" }}>
                <div ref={pdfScaleRef} style={{ transform: `scale(${pdfScale})`, transformOrigin: "top left", width: PDF_PAGE_WIDTH }}>
                  <div ref={previewRef} dangerouslySetInnerHTML={{ __html: buildPlannerHtml(state) }} />
                </div>
              </div>
            </div>
            <div style={S.pdfActions}>
              <button style={{ ...S.settingBtn, ...S.settingBtnOutline, flex: 1 }} disabled={pdfBusy}
                onClick={() => setShowPdfPreview(false)}>Close</button>
              <button style={{ ...S.settingBtn, flex: 1 }} disabled={pdfBusy} onClick={savePDF}>
                {pdfBusy ? "Saving…" : "Save to my device"}
              </button>
            </div>
          </div>
        </div>
      )}
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
  // Only invited guests are seated; planning-list guests aren't real yet.
  const guests = (state.guests || []).filter(isInvited);

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
  // Seats a table actually uses: every guest counts for their whole party, so a
  // "+1" takes two chairs. Capacity is about chairs, not names on a list.
  const seatsUsed = (t) =>
    (t.seated || []).reduce((n, gid) => n + partySize(guestById(gid)), 0);
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
          // Chairs, not guest records: a guest bringing a +1 needs two seats.
          const over = seatsUsed(t);
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
                      {g.name || "Unnamed"}{partySize(g) > 1 ? ` +${partySize(g) - 1}` : ""} <span style={S.chipX}>×</span>
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

/* Choosing a venue: tick the venue, fill state.venue, and keep the auto-created
   Venue vendor + budget expense in sync. Mutates and returns s. */
function applyChooseVenue(s, id) {
  const v = s.venues.find((x) => x.id === id);
  if (!v) return s;

  // Unmark all venues
  for (const x of s.venues) x.chosen = false;
  v.chosen = true;
  s.venue = v.name;

  // Remove any previously auto-created venue vendor + its expenses
  const old = s.vendors.find((x) => x.fromVenue);
  // Re-confirming the same venue shouldn't wipe the balance due date they set
  // on it; switching to a different venue should.
  const keptDue = old && old.name === v.name ? old.dueDate || "" : "";
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
    dueDate: keptDue, // when the venue's remaining balance is due
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
}

/* Undo the above: untick every venue and remove the auto-created vendor/expense. */
function applyUnchooseVenue(s) {
  for (const v of s.venues || []) v.chosen = false;
  s.venue = "";
  const old = s.vendors.find((x) => x.fromVenue);
  if (old) {
    for (const c of s.categories)
      c.expenses = c.expenses.filter((e) => e.vendorId !== old.id);
    s.vendors = s.vendors.filter((x) => x.id !== old.id);
  }
  return s;
}

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

  const chooseVenue = (id) => update((s) => applyChooseVenue(s, id));

  const unchoose = () => update((s) => applyUnchooseVenue(s));

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

  // Set apart from the donut legend above it, so the two don't read as one block.
  stats: { display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginTop: 22 },
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

  syncLine: { display: "flex", alignItems: "center", justifyContent: "center", gap: 6, marginBottom: 16, fontSize: 12, color: "#c4aaa4", textAlign: "center" },
  helpCard: { background: "#fdf8f5", borderRadius: 20, width: "100%", maxWidth: 560, maxHeight: "86vh", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 30px 80px -30px rgba(80,50,45,0.6)" },
  helpHead: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, padding: "18px 18px 12px", borderBottom: "1px solid #f0e2dd" },
  helpTitle: { fontFamily: "'Fraunces', serif", fontSize: 21, fontWeight: 600, color: "#6b4a45" },
  helpSub: { fontSize: 12.5, color: "#b58e87", marginTop: 3 },
  helpScroll: { overflowY: "auto", padding: "8px 14px 4px", flex: 1 },
  helpTopic: { background: "#fff", border: "1px solid #f0e2dd", borderRadius: 14, marginBottom: 8, overflow: "hidden" },
  helpTopicHead: { display: "flex", alignItems: "center", gap: 10, width: "100%", background: "none", border: "none", padding: "13px 14px", cursor: "pointer", textAlign: "left", fontFamily: "inherit" },
  helpEmoji: { fontSize: 17, flexShrink: 0 },
  helpTopicTitle: { flex: 1, minWidth: 0, fontSize: 15, fontWeight: 600, color: "#6b4a45" },
  helpBody: { padding: "0 14px 12px" },
  helpPara: { fontSize: 14, lineHeight: 1.6, color: "#7a655f", margin: "0 0 10px" },
  helpFoot: { display: "flex", gap: 10, padding: 14, borderTop: "1px solid #f0e2dd" },
  syncClose: { background: "none", border: "none", color: "#c4aaa4", fontSize: 16, lineHeight: 1, padding: "2px 4px", cursor: "pointer", flexShrink: 0 },
  // Sits with the ? and gear so a dismissed reminder still has a home.
  syncBadge: { position: "absolute", top: 20, right: 108, width: 36, height: 36, borderRadius: 12, background: "linear-gradient(135deg,#f9ede9,#f4e0da)", border: "1px solid #eac8bf", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 5, boxShadow: "0 4px 14px -6px rgba(180,110,100,0.45)", cursor: "pointer" },
  syncBadgeDot: { position: "absolute", top: 5, right: 5, width: 8, height: 8, borderRadius: "50%", border: "1.5px solid #fdf6f3" },
  catVendorHint: { fontSize: 12, color: "#b58e87", marginTop: 4 },
  catVendorBox: { background: "#fbf6f3", border: "1px solid #f0e2dd", borderRadius: 12, padding: "12px 12px 10px", marginTop: 14, display: "flex", flexDirection: "column", gap: 2 },
  catVendorRow: { display: "flex", alignItems: "center", gap: 8, width: "100%", background: "none", border: "none", padding: "8px 2px", fontSize: 14, fontFamily: "inherit", color: "#3a2e2c", cursor: "pointer", textAlign: "left" },
  catVendorName: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  catVendorAmt: { fontSize: 13, color: "#b07a72", whiteSpace: "nowrap" },
  catVendorHelp: { fontSize: 11, color: "#c4aaa4", marginTop: 4, lineHeight: 1.4 },
  catVendorMuted: { color: "#c4aaa4" },
  deleteWarn: { background: "#fdf0f2", borderTop: "1px solid #f6dde2", padding: "12px 14px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" },
  deleteWarnText: { flex: 1, minWidth: 180, fontSize: 13, color: "#9c5560", lineHeight: 1.45 },
  deleteWarnBtns: { display: "flex", gap: 6, flexShrink: 0 },
  donutWrap: { position: "relative", width: DONUT.size, height: DONUT.size, margin: "6px auto 2px", maxWidth: "100%" },
  donutSvg: { display: "block", width: "100%", height: "auto" },
  donutCentre: { position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", pointerEvents: "none" },
  donutBig: { fontFamily: "'Fraunces', serif", fontSize: 26, fontWeight: 600 },
  donutSub: { fontSize: 12, color: "#b58e87", marginTop: 1 },
  donutPct: { fontSize: 12, fontWeight: 600, marginTop: 5 },
  donutLegend: { display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "6px 14px", marginTop: 12 },
  donutLegendItem: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "#8a6d68" },
  donutLegendAmt: { color: "#b58e87" },
  donutDot: { width: 9, height: 9, borderRadius: "50%", flex: "none" },
  donutEmpty: { display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "10px 0 2px" },
  donutEmptyRing: { width: 120, height: 120, borderRadius: "50%", border: "22px solid #f4e8e4", boxSizing: "border-box" },
  donutEmptyText: { fontSize: 13, color: "#b58e87", textAlign: "center", maxWidth: 300, lineHeight: 1.45 },
  nextUp: { background: "#fff", borderRadius: 16, padding: "14px 14px 8px", marginBottom: 14, boxShadow: "0 10px 30px -22px rgba(107,74,69,0.6)" },
  nextUpHead: { fontSize: 12, textTransform: "uppercase", letterSpacing: "0.08em", color: "#b58e87", marginBottom: 4 },
  nextUpRow: { display: "flex", alignItems: "center", gap: 9, width: "100%", background: "none", border: "none", padding: "9px 0", fontSize: 14, fontFamily: "inherit", color: "#3a2e2c", textAlign: "left", cursor: "pointer" },
  nextUpDot: { width: 8, height: 8, borderRadius: "50%", flex: "none" },
  nextUpEmpty: { fontSize: 13, color: "#b58e87", lineHeight: 1.5, padding: "4px 0 8px" },
  // Wraps rather than truncating: the amount matters as much as the name.
  nextUpTitle: { flex: 1, minWidth: 0, lineHeight: 1.35 },
  nextUpWhen: { fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" },
  // Arch-topped swatches — the shape wedding stationery uses — with the code
  // sitting quietly underneath rather than printed across the colour.
  // A grid, not wrapping flex: flex stretches whatever is on the last row, so a
  // row of two came out wider than a row of three. Equal tracks keep every
  // swatch the same size however they wrap.
  paletteRow: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(72px, 1fr))", gap: 10 },
  swatchWrap: { position: "relative", display: "flex", flexDirection: "column", alignItems: "center" },
  swatch: { width: "100%", height: 92, padding: 0, border: "1px solid rgba(107,74,69,0.12)", borderRadius: "999px 999px 10px 10px" },
  swatchHex: { fontSize: 10, letterSpacing: "0.09em", color: "#b58e87", marginTop: 7, fontFamily: "'Outfit', sans-serif" },
  swatchActive: { outline: "2px solid #c98b94", outlineOffset: 2 },
  styleHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 },
  styleEditHint: { fontSize: 12, color: "#c98b94", fontWeight: 600 },
  styleNote: { fontSize: 12, color: "#b58e87", marginTop: 6 },
  fieldHint: { fontSize: 12, color: "#c4aaa4", lineHeight: 1.45, marginTop: 3 },
  styleEmpty: { fontSize: 13, color: "#b58e87", lineHeight: 1.5, marginTop: 10 },
  // Serif for both, generous line-height: meant to be read, not filled in.
  styleWordsView: { fontFamily: "'Fraunces', serif", fontStyle: "italic", fontSize: 21, lineHeight: 1.35, color: "#6b4a45", marginTop: 18 },
  styleVisionView: { fontFamily: "'Fraunces', serif", fontSize: 15, lineHeight: 1.7, color: "#8a6d68", marginTop: 10 },
  styleWordsInput: { width: "100%", boxSizing: "border-box", marginTop: 8, background: "#fbf6f3", border: "1px solid #f0e2dd", borderRadius: 10, padding: "10px 12px", fontFamily: "'Fraunces', serif", fontStyle: "italic", fontSize: 19, color: "#6b4a45", outline: "none" },
  styleVisionInput: { width: "100%", boxSizing: "border-box", marginTop: 8, background: "#fbf6f3", border: "1px solid #f0e2dd", borderRadius: 10, padding: "10px 12px", fontFamily: "'Fraunces', serif", fontSize: 15, lineHeight: 1.7, color: "#6b4a45", resize: "vertical", outline: "none" },
  picker: { background: "#fbf6f3", border: "1px solid #f0e2dd", borderRadius: 14, padding: 12, marginTop: 12 },
  pickerGrid: { display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 7 },
  pickerSwatch: { width: "100%", aspectRatio: "1", border: "1px solid rgba(107,74,69,0.14)", borderRadius: 8, cursor: "pointer", padding: 0 },
  pickerRow: { display: "flex", alignItems: "center", gap: 8, marginTop: 12 },
  pickerMore: { position: "relative", background: "#fff", border: "1px solid #f0e2dd", borderRadius: 8, padding: "9px 14px", fontSize: 14, color: "#b07a72", cursor: "pointer", flexShrink: 0 },
  pickerDone: { background: "#c98b94", color: "#fff", border: "none", borderRadius: 8, padding: "10px 16px", fontSize: 14, fontWeight: 600, cursor: "pointer", flexShrink: 0 },
  pickerHint: { fontSize: 11, color: "#c4aaa4", marginTop: 8 },
  swatchRemove: { position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: "50%", background: "#fff", border: "1px solid #f0e2dd", color: "#b07a72", fontSize: 13, lineHeight: 1, cursor: "pointer", padding: 0 },
  swatchAdd: { width: "100%", height: 92, borderRadius: "999px 999px 10px 10px", border: "1.5px dashed #d9b8b2", background: "transparent", color: "#b58e87", fontSize: 22, lineHeight: 1, cursor: "pointer", alignSelf: "start" },
  detailsHead: { display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", background: "none", border: "none", padding: 0, cursor: "pointer" },
  donutToggle: { display: "flex", justifyContent: "center", gap: 4, background: "#fbf6f3", border: "1px solid #f0e2dd", borderRadius: 99, padding: 3, width: "fit-content", margin: "4px auto 0" },
  donutToggleBtn: { background: "none", border: "none", borderRadius: 99, padding: "6px 16px", fontSize: 13, fontFamily: "inherit", color: "#b58e87", cursor: "pointer" },
  donutToggleOn: { background: "#fff", color: "#6b4a45", fontWeight: 600, boxShadow: "0 2px 8px -4px rgba(107,74,69,0.45)" },
  catBar: { height: 5, borderRadius: 99, background: "#f4e8e4", overflow: "hidden", marginTop: 8, display: "flex" },
  catBarFill: { height: "100%" },
  catUpcoming: { fontSize: 12, color: "#a8862f" },
  catDot: { display: "inline-block", width: 9, height: 9, borderRadius: "50%", marginRight: 8, verticalAlign: "middle", flex: "none" },
  dueLine: { fontSize: 12, marginTop: 4, fontWeight: 600 },
  owedDue: { display: "block", fontSize: 11, marginTop: 2, fontWeight: 600 },
  suggestBox: { marginTop: 18 },
  suggestHint: { fontSize: 12, color: "#c4aaa4", margin: "2px 0 10px" },
  suggestWrap: { display: "flex", flexWrap: "wrap", gap: 8 },
  suggestChip: { background: "#fff", border: "1px solid #f0e2dd", borderRadius: 99, padding: "8px 13px", fontSize: 13, fontFamily: "inherit", color: "#8a6d68", cursor: "pointer" },
  newCatRow: { display: "flex", alignItems: "center", gap: 6, marginTop: 6 },
  newCatAdd: { background: "#c98b94", color: "#fff", border: "none", borderRadius: 8, padding: "9px 14px", fontSize: 14, fontWeight: 600, cursor: "pointer", flexShrink: 0 },
  newCatCancel: { background: "#f7ece8", color: "#b07a72", border: "none", borderRadius: 8, width: 34, height: 34, fontSize: 18, lineHeight: 1, cursor: "pointer", flexShrink: 0 },
  footerBtn: { background: "none", border: "none", padding: 0, margin: 0, fontSize: 12, fontFamily: "inherit", color: "inherit", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 },
  footerChevron: { color: "#c4aaa4", fontSize: 14, lineHeight: 1 },

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
  // Capped so the wordmark can never slide under the header buttons on a
  // narrow phone; it scales down instead.
  appLogoBtn: { position: "absolute", top: 18, left: 16, height: 42, maxWidth: "calc(100% - 168px)", display: "flex", alignItems: "center", background: "none", border: "none", padding: 0, cursor: "pointer", zIndex: 5 },
  appLogoImg: { maxHeight: 38, maxWidth: "100%", width: "auto", height: "auto", display: "block" },
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

  /* PDF preview modal */
  pdfOverlay: { position: "fixed", inset: 0, background: "rgba(58,46,44,0.5)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 120 },
  pdfCard: { background: "#fff", borderRadius: 18, width: "100%", maxWidth: 720, maxHeight: "92vh", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 24px 60px -20px rgba(80,50,46,0.5)" },
  pdfHead: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 18px", borderBottom: "1px solid #f0e2dd" },
  pdfHeadTitle: { fontFamily: "'Fraunces', serif", fontSize: 18, fontWeight: 600, color: "#6b4a45" },
  pdfHeadHint: { fontSize: 12, color: "#b58e87", marginTop: 2 },
  pdfClose: { width: 34, height: 34, borderRadius: "50%", border: "none", background: "#f6ece8", color: "#b07a72", fontSize: 20, lineHeight: 1, cursor: "pointer", flexShrink: 0 },
  pdfScroll: { flex: 1, overflow: "auto", background: "#efe4df", padding: 14, WebkitOverflowScrolling: "touch" },
  pdfActions: { display: "flex", gap: 10, padding: "14px 18px", borderTop: "1px solid #f0e2dd" },
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
  // left/right + margin auto (not left:50%) so the pill can use the full width
  // and stays on one line on a phone.
  seatingBanner: { position: "fixed", left: "50%", transform: "translateX(-50%)", bottom: 92, background: "#6b4a45", color: "#fff", fontSize: 14, padding: "12px 18px", borderRadius: 99, display: "flex", alignItems: "center", gap: 14, zIndex: 50, boxShadow: "0 12px 32px -12px rgba(80,50,45,0.7)", maxWidth: "92%" },
  seatingCancel: { background: "rgba(255,255,255,0.18)", color: "#fff", fontSize: 13, padding: "5px 12px", borderRadius: 99, flexShrink: 0 },

  /* home */
  hero: { textAlign: "center", padding: "16px 0 28px" },
  heroPhotoWrap: { position: "relative", borderRadius: 20, overflow: "hidden", marginBottom: 4, boxShadow: "0 14px 40px -22px rgba(150,100,95,0.7)" },
  heroPhoto: { width: "100%", height: 240, objectFit: "cover", display: "block" },
  heroPhotoRemove: { position: "absolute", top: 12, right: 12, width: 30, height: 30, borderRadius: "50%", background: "rgba(58,46,44,0.55)", color: "#fff", fontSize: 18, lineHeight: 1, backdropFilter: "blur(4px)" },
  reframeBtn: { position: "absolute", bottom: 12, left: 12, background: "rgba(58,46,44,0.55)", color: "#fff", border: "none", borderRadius: 999, padding: "7px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", backdropFilter: "blur(4px)" },
  reframeDone: { position: "absolute", bottom: 12, right: 12, background: "#c98b94", color: "#fff", border: "none", borderRadius: 999, padding: "8px 20px", fontSize: 13, fontWeight: 600, cursor: "pointer" },
  reframeHint: { position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)", background: "rgba(58,46,44,0.6)", color: "#fff", fontSize: 12, padding: "6px 12px", borderRadius: 999, backdropFilter: "blur(4px)", pointerEvents: "none", whiteSpace: "nowrap" },
  galleryHead: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  addPhotoBtn: { fontSize: 13, fontWeight: 500, color: "#fff", background: "#c98b94", padding: "8px 14px", borderRadius: 99, cursor: "pointer" },
  galleryEmpty: { fontSize: 14, color: "#b58e87", lineHeight: 1.5 },
  galleryGrid: { display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 },
  galleryItem: { position: "relative", borderRadius: 12, overflow: "hidden", aspectRatio: "1 / 1" },
  galleryImg: { width: "100%", height: "100%", objectFit: "cover", display: "block" },
  galleryRemove: { position: "absolute", top: 5, right: 5, width: 24, height: 24, borderRadius: "50%", background: "rgba(58,46,44,0.55)", color: "#fff", fontSize: 15, lineHeight: 1 },
  bannerTag: { position: "absolute", bottom: 5, left: 5, fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "#6b4a45", background: "rgba(255,255,255,0.9)", padding: "3px 7px", borderRadius: 6 },
  setCoverBtn: { position: "absolute", bottom: 5, left: 5, fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "#fff", background: "rgba(58,46,44,0.6)", border: "none", padding: "3px 7px", borderRadius: 6, cursor: "pointer" },
  // Smaller than the names, nudged up so it sits optically between them
  // rather than low on the baseline.
  heroAmp: { fontStyle: "normal", fontSize: "0.6em", verticalAlign: "0.06em", margin: "0 0.02em" },
  heroNames: { fontFamily: "'Fraunces', serif", fontSize: "clamp(36px, 11vw, 56px)", fontWeight: 600, fontStyle: "italic", color: "#6b4a45", margin: "8px 0 10px", lineHeight: 1.05 },
  heroDate: { fontSize: 15, color: "#b58e87", marginBottom: 16 },
  heroVenue: { fontSize: 15, color: "#b58e87", marginBottom: 16 },
  countdownPill: { display: "inline-block", background: "linear-gradient(90deg,#d9a7a0,#c98b94)", color: "#fff", fontWeight: 600, fontSize: 15, padding: "9px 22px", borderRadius: 99, boxShadow: "0 8px 24px -10px rgba(201,139,148,0.7)" },
  profileGrid: { display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 12 },
  visionInput: { width: "100%", fontSize: 15, padding: "11px 12px", borderRadius: 10, background: "#fbf6f3", color: "#3a2e2c", border: "1px solid #f0e2dd", marginTop: 5, fontFamily: "'Outfit', sans-serif", resize: "vertical" },
  // Same 24px gap the white sections leave below themselves, so the cards don't
  // sit flush against "Our details".
  summaryGrid: { display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 12, marginBottom: 24 },
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
  venueLink: { width: "100%", minWidth: 0, boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, textAlign: "left", fontSize: 15, padding: "9px 11px", borderRadius: 8, background: "#fbf6f3", color: "#3a2e2c", border: "1px solid #f0e2dd", cursor: "pointer" },
  venueLinkEmpty: { color: "#b58e87" },
  venueLinkChevron: { color: "#c98b94", fontSize: 20, lineHeight: 1, flexShrink: 0 },
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
  dragHandle: { flexShrink: 0, padding: "6px 8px", color: "#d3b8b2", fontSize: 16, lineHeight: 1, cursor: "grab", touchAction: "none", userSelect: "none", alignSelf: "center" },
  dragLifted: { boxShadow: "0 10px 26px -8px rgba(120,70,60,0.45)", transform: "scale(1.015)", position: "relative", zIndex: 20, background: "#fff" },
  stageToggle: { display: "flex", gap: 6, marginBottom: 14, background: "#f6e9e4", borderRadius: 14, padding: 4 },
  stageTab: { flex: 1, textAlign: "center", padding: "10px 12px", borderRadius: 10, border: "none", background: "transparent", color: "#b58e87", fontSize: 15, fontWeight: 600, cursor: "pointer", fontFamily: "'Fraunces', serif" },
  stageTabActive: { background: "#fff", color: "#6b4a45", boxShadow: "0 2px 8px -4px rgba(120,70,60,0.4)" },
  inviteBtn: { marginTop: 14, width: "100%", background: "#c98b94", color: "#fff", border: "none", borderRadius: 12, padding: "13px", fontSize: 15, fontWeight: 600, cursor: "pointer", fontFamily: "'Fraunces', serif" },
  moveBackBtn: { marginTop: 14, width: "100%", background: "transparent", color: "#b58e87", border: "1px solid #f0e2dd", borderRadius: 12, padding: "12px", fontSize: 14, cursor: "pointer" },
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
