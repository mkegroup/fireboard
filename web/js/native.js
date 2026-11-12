// Call alerts.
//  * iPhone app: straight from Apple (no OneSignal, no Firebase).
//  * Browsers (Android phones, computers): the Web Push standard, through sw.js.
// The same functions handle both, so screens don't need to care which.
import { IS_NATIVE, CONFIG } from "./config.js";

let PN = null;
let listening = false;
let token = null;
let hooks = {};

/** Native calls should answer fast. Never let a stuck call hold up the screen. */
const quick = (p, ms = 3000) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error("timeout")), ms))]);

function plugin() {
  if (!IS_NATIVE) return null;
  if (!PN) {
    try { PN = window.Capacitor?.registerPlugin?.("PushNotifications") || null; } catch { PN = null; }
  }
  return PN;
}

/**
 * Ties this phone to the signed-in person so alerts reach them.
 * save(token) and remove(token) store the Apple token on the server.
 */
export async function startPush({ save, remove, saveWeb, removeWeb, openIncident, openChat, openAdmin }) {
  hooks = { save, remove, saveWeb, removeWeb, openIncident, openChat, openAdmin };
  const P = plugin();
  if (!P) {
    // Browser: if alerts were allowed before, make sure the server has this browser.
    if (webOk() && Notification.permission === "granted") {
      try { const sub = await webSubscription(true); if (sub) await hooks.saveWeb?.(sub.toJSON()); } catch (e) { console.warn("web alerts", e); }
    }
    return;
  }
  try {
    if (!listening) {
      listening = true;
      await P.addListener("registration", async (t) => {
        token = t?.value || null;
        if (token) { try { await hooks.save?.(token); } catch (e) { console.warn("could not save alert token", e); } }
      });
      await P.addListener("registrationError", (e) => console.warn("alert registration failed", e));
      await P.addListener("pushNotificationActionPerformed", (a) => {
        const d = a?.notification?.data || {};
        if (d.kind === "admin") hooks.openAdmin?.();
        else if (d.kind === "chat") hooks.openChat?.(d.chat === "station" ? null : d.incident_id);
        else if (d.incident_id) hooks.openIncident?.(d.incident_id);
      });
    }
    const perm = await quick(P.checkPermissions());
    if (perm.receive === "granted") await P.register();
  } catch (e) { console.warn("push start failed", e); }
}

/** Call before signing out so this phone stops getting that person's alerts. */
export async function stopPush() {
  if (!IS_NATIVE) {
    if (!webOk()) return;
    try {
      const sub = await webSubscription(false);
      if (sub) { await hooks.removeWeb?.(sub.endpoint).catch(() => {}); await sub.unsubscribe(); }
    } catch { /* signing out anyway */ }
    return;
  }
  if (!token || !hooks.remove) return;
  try { await hooks.remove(token); } catch { /* signing out anyway */ }
  token = null;
}

/** "on", "off" (said no, has to use Settings), "ask" (not asked yet), or "none" (can't on this device). */
export async function pushState() {
  const P = plugin();
  if (!P) {
    if (!webOk()) return "none";
    if (Notification.permission === "denied") return "off";
    if (Notification.permission === "granted") {
      try { return (await webSubscription(false)) ? "on" : "ask"; } catch { return "ask"; }
    }
    return "ask";
  }
  try {
    const p = await quick(P.checkPermissions());
    if (p.receive === "granted") return "on";
    if (p.receive === "denied") return "off";
    return "ask";
  } catch { return "none"; }
}

/** Shows the permission prompt. On iPhone, if they said no before, opens Settings instead. */
export async function askForPush() {
  const P = plugin();
  if (!P) {
    if (!webOk()) return false;
    try {
      const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      if (perm !== "granted") return false;
      const sub = await webSubscription(true);
      if (!sub) return false;
      await hooks.saveWeb?.(sub.toJSON());
      return true;
    } catch (e) { console.warn("web alerts", e); return false; }
  }
  try {
    const before = await P.checkPermissions();
    if (before.receive === "denied") { window.location.href = "app-settings:"; return false; }
    const p = await P.requestPermissions();
    if (p.receive === "granted") { await P.register(); return true; }
    return false;
  } catch { return false; }
}

// ---------------- browsers ----------------
/** Can this browser get call alerts? Android Chrome, Firefox, Edge, desktop browsers. Not iPhone Safari. */
export function webOk() {
  return !IS_NATIVE && !!CONFIG.WEB_PUSH_KEY && typeof window !== "undefined" && window.isSecureContext
    && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function keyBytes(b64) {
  const s = atob((b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/** This browser's alert subscription. With create, makes one if there isn't one. */
async function webSubscription(create) {
  const reg = await quick(navigator.serviceWorker.ready, 8000);
  let sub = await reg.pushManager.getSubscription();
  if (!sub && create) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(CONFIG.WEB_PUSH_KEY) });
  }
  return sub;
}

// ---------------- keeping the screen in place ----------------
// iOS can leave the page shifted up after the keyboard closes, after a sheet
// closes, or when you come back from Maps or another app. That's what pushes
// the buttons up the screen and lets you scroll into empty space.
// This snaps the page back inside its real bounds.
export function settleViewport() {
  const typing = () => {
    const a = document.activeElement;
    return a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT" || a.isContentEditable);
  };
  const settle = () => {
    if (typing()) return;
    const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const vv = window.visualViewport;
    if (window.scrollY > max || (vv && vv.offsetTop > 0.5)) window.scrollTo(window.scrollX, Math.min(window.scrollY, max));
  };
  let t;
  const later = (ms = 120) => { clearTimeout(t); t = setTimeout(settle, ms); };
  document.addEventListener("focusout", () => later(150));
  window.visualViewport?.addEventListener("resize", () => later(100));
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { later(50); later(400); } });
  window.addEventListener("pageshow", () => later(50));
  ["fullscreenchange", "webkitfullscreenchange", "orientationchange"].forEach((ev) => document.addEventListener(ev, () => { later(80); later(500); }));
  window.addEventListener("hashchange", () => later(60));
  if (IS_NATIVE) {
    const K = window.Capacitor?.Plugins?.Keyboard;
    K?.setAccessoryBarVisible?.({ isVisible: true }).catch?.(() => {});
    K?.addListener?.("keyboardDidHide", () => later(30));
    window.Capacitor?.Plugins?.App?.addListener?.("resume", () => later(80));
  }
}
