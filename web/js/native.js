// iPhone app only: push alerts straight from Apple (no OneSignal, no Firebase).
// On the web this whole file does nothing.
import { IS_NATIVE } from "./config.js";

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
export async function startPush({ save, remove, openIncident, openChat }) {
  hooks = { save, remove, openIncident, openChat };
  const P = plugin();
  if (!P) return;
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
        if (d.kind === "chat") hooks.openChat?.(d.chat === "station" ? null : d.incident_id);
        else if (d.incident_id) hooks.openIncident?.(d.incident_id);
      });
    }
    const perm = await quick(P.checkPermissions());
    if (perm.receive === "granted") await P.register();
  } catch (e) { console.warn("push start failed", e); }
}

/** Call before signing out so this phone stops getting that person's alerts. */
export async function stopPush() {
  if (!token || !hooks.remove) return;
  try { await hooks.remove(token); } catch { /* signing out anyway */ }
  token = null;
}

/** "on", "off" (said no, has to use Settings), "ask" (not asked yet), or "none" (web). */
export async function pushState() {
  const P = plugin();
  if (!P) return "none";
  try {
    const p = await quick(P.checkPermissions());
    if (p.receive === "granted") return "on";
    if (p.receive === "denied") return "off";
    return "ask";
  } catch { return "none"; }
}

/** Shows the iPhone permission prompt. If they said no before, opens Settings instead. */
export async function askForPush() {
  const P = plugin();
  if (!P) return false;
  try {
    const before = await P.checkPermissions();
    if (before.receive === "denied") { window.location.href = "app-settings:"; return false; }
    const p = await P.requestPermissions();
    if (p.receive === "granted") { await P.register(); return true; }
    return false;
  } catch { return false; }
}
