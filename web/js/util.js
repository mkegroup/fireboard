// Small shared helpers. Everything user-provided goes through esc() before it
// touches innerHTML.

export function esc(v) {
  if (v === null || v === undefined) return "";
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function initials(name) {
  return String(name || "?")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map((w) => w[0].toUpperCase()).join("") || "?";
}

const AVATAR = ["#4C8DFF", "#3DD68C", "#F2B233", "#A78BFA", "#2EC4D6", "#F06292", "#FF8A3D", "#7C9CBF"];
export function colorFor(s) {
  let h = 0;
  for (const c of String(s || "")) h = (h * 31 + c.charCodeAt(0)) | 0;
  return AVATAR[Math.abs(h) % AVATAR.length];
}

export function clock(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function dateLabel(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

export function dateTime(ts) {
  if (!ts) return "";
  return `${dateLabel(ts)}, ${clock(ts)}`;
}

/** "12m", "1h 04m" */
export function elapsed(from, to = Date.now()) {
  const s = Math.max(0, Math.floor((new Date(to) - new Date(from)) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m`;
}

/** "02:15" for a countdown / stopwatch */
export function stopwatch(from, to = Date.now()) {
  const s = Math.max(0, Math.floor((new Date(to) - new Date(from)) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function ago(ts) {
  if (!ts) return "";
  const s = Math.floor((Date.now() - new Date(ts)) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return dateLabel(ts);
}

export function daysUntil(ts) {
  return Math.ceil((new Date(ts) - Date.now()) / 86400000);
}

export function todayISO() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** Reads a <form> into a plain object. Checkboxes become booleans. */
export function formData(form) {
  const o = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === "checkbox") o[el.name] = el.checked;
    else if (el.type === "radio") { if (el.checked) o[el.name] = el.value; }
    else o[el.name] = el.value.trim();
  }
  return o;
}

export function download(filename, text, type = "text/plain") {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function csv(rows) {
  const cell = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    // Guard against spreadsheet formula injection.
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return rows.map((r) => r.map(cell).join(",")).join("\n");
}

export function slug(s) {
  return String(s || "export").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "export";
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

export function vibrate(pattern) {
  try { navigator.vibrate?.(pattern); } catch { /* not supported */ }
}

export function friendlyError(e) {
  const m = String(e?.message || e || "Something went wrong");
  if (/invalid login credentials/i.test(m)) return "Email or password is wrong.";
  if (/user already registered/i.test(m)) return "There is already an account with that email. Sign in instead.";
  if (/password should be at least/i.test(m)) return "Password needs at least 8 characters.";
  if (/email not confirmed/i.test(m)) return "Confirm your email first. Check your inbox for the link.";
  if (/invalid invite code/i.test(m)) return "That invite code was not found. Check it with your chief.";
  if (/too many invite attempts/i.test(m)) return "Too many wrong codes. Wait an hour, or ask your chief to send the invite link.";
  if (/removed from this department/i.test(m)) return "An officer removed you from this department. Ask them to let you back in.";
  if (/token has expired|otp.*(expired|invalid)|invalid.*otp/i.test(m)) return "That code didn't work. Check it, or get a new one.";
  if (/only request this after|security purposes/i.test(m)) return "Wait a moment before asking for another code.";
  if (/signups not allowed/i.test(m)) return "New accounts are turned off right now. Contact support.";
  if (/origin not allowed/i.test(m)) return "Open the app from its normal address and try again.";
  if (/subscription inactive|row-level security/i.test(m)) return "Your department's plan is inactive, so changes are locked.";
  if (/failed to fetch|network/i.test(m)) return "No connection. Check your signal and try again.";
  if (/rate limit/i.test(m)) return "Too many attempts. Wait a minute and try again.";
  if (/duplicate key/i.test(m)) return "That already exists.";
  return m.replace(/^[A-Z_]+:\s*/, "");
}

// ---------------- display theme ----------------
// "auto" follows the phone, "dark" is the default look, "sun" is high contrast for daylight.
export function getTheme() {
  try { return localStorage.getItem("fgb_theme") || "dark"; } catch { return "dark"; }
}
export function applyTheme(choice = getTheme()) {
  const sun = choice === "sun" || (choice === "auto" && window.matchMedia?.("(prefers-color-scheme: light)").matches);
  document.documentElement.dataset.theme = sun ? "sun" : "dark";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", sun ? "#f3f4f6" : "#14171c");
}
export function setTheme(choice) {
  try { localStorage.setItem("fgb_theme", choice); } catch { /* private mode */ }
  applyTheme(choice);
}
window.matchMedia?.("(prefers-color-scheme: light)").addEventListener?.("change", () => applyTheme());

// ---------------- alert sounds ----------------
// iPhones ignore vibration, so PAR and Missing alerts also play a tone.
// Browsers only allow sound after the user has touched the page once.
let audioCtx = null;
function ctx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtx = new AC();
  }
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  return audioCtx;
}
["pointerdown", "keydown"].forEach((ev) => window.addEventListener(ev, () => ctx(), { once: true, capture: true }));

export function soundOn() {
  try { return localStorage.getItem("fgb_sound") !== "off"; } catch { return true; }
}
export function setSound(on) {
  try { localStorage.setItem("fgb_sound", on ? "on" : "off"); } catch { /* private mode */ }
}

/** kind: "par" (three short beeps) or "missing" (two-tone alarm). */
export function alertTone(kind = "par") {
  if (!soundOn()) return;
  const c = ctx();
  if (!c) return;
  const notes = kind === "missing"
    ? [[960, 0, 0.32], [640, 0.34, 0.32], [960, 0.68, 0.32], [640, 1.02, 0.32], [960, 1.36, 0.32], [640, 1.7, 0.32]]
    : [[1046, 0, 0.14], [1046, 0.22, 0.14], [1318, 0.44, 0.3]];
  const t0 = c.currentTime + 0.02;
  for (const [freq, at, dur] of notes) {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = "square";
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0 + at);
    g.gain.exponentialRampToValueAtTime(0.25, t0 + at + 0.02);
    g.gain.setValueAtTime(0.25, t0 + at + dur - 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
    o.connect(g).connect(c.destination);
    o.start(t0 + at);
    o.stop(t0 + at + dur + 0.02);
  }
}

// ---------------- keep screen on ----------------
/** Keeps the screen awake while the board is open. Returns a release function. */
export function keepAwake() {
  let lock = null;
  let on = true;
  const grab = async () => {
    if (!on || !("wakeLock" in navigator) || document.visibilityState !== "visible") return;
    try { lock = await navigator.wakeLock.request("screen"); } catch { /* battery saver or unsupported */ }
  };
  const onVis = () => { if (document.visibilityState === "visible") grab(); };
  document.addEventListener("visibilitychange", onVis);
  grab();
  return () => {
    on = false;
    document.removeEventListener("visibilitychange", onVis);
    lock?.release?.().catch?.(() => {});
  };
}

/** Parses pasted roster text. One person per line: Name, Rank, Crew, Phone (only name needed). */
export function parseRoster(text, ranks = [], crews = []) {
  const lower = (a) => Object.fromEntries(a.map((x) => [x.toLowerCase(), x]));
  const R = lower(ranks);
  const C = lower(crews);
  const seen = new Set();
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const parts = raw.split(/\t|,|;/).map((s) => s.trim()).filter(Boolean);
    if (!parts.length) continue;
    const [name, ...rest] = parts;
    if (/^name$/i.test(name)) continue; // header row
    const person = { name: name.slice(0, 80) };
    for (const v of rest) {
      const k = v.toLowerCase();
      if (!person.rank && R[k]) person.rank = R[k];
      else if (!person.crew && C[k]) person.crew = C[k];
      else if (!person.phone && /^[+()\d\s.-]{7,}$/.test(v)) person.phone = v;
      else if (!person.rank && /chief|captain|lieutenant|firefighter|officer|driver|medic|probat/i.test(v)) person.rank = v.slice(0, 40);
    }
    const key = person.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(person);
  }
  return out;
}
