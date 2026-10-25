// iPhone app only: push alerts through OneSignal.
// On the web this whole file does nothing.
import { CONFIG, IS_NATIVE } from "./config.js";

let ready = null;
let started = false;
let onOpenIncident = null;

/** Resolves with the OneSignal plugin once the native side is ready, or null. */
function plugin() {
  if (!IS_NATIVE || !CONFIG.ONESIGNAL_APP_ID) return Promise.resolve(null);
  if (!ready) {
    ready = new Promise((resolve) => {
      if (window.OneSignal) return resolve(window.OneSignal);
      const done = () => resolve(window.OneSignal || null);
      document.addEventListener("deviceready", done, { once: true });
      setTimeout(done, 4000);
    });
  }
  return ready;
}

/** Ties this phone to the signed-in person so alerts reach them. */
export async function startPush(userId, openIncident) {
  onOpenIncident = openIncident;
  const O = await plugin();
  if (!O) return;
  try {
    if (!started) {
      O.initialize(CONFIG.ONESIGNAL_APP_ID);
      O.Notifications.addEventListener("click", (e) => {
        const id = e?.notification?.additionalData?.incident_id;
        if (id && onOpenIncident) onOpenIncident(id);
      });
      started = true;
    }
    O.login(userId);
  } catch (e) { console.warn("push start failed", e); }
}

export async function stopPush() {
  const O = await plugin();
  try { O?.logout(); } catch { /* ignore */ }
}

/** "on", "off" (said no, has to use Settings), "ask" (not asked yet), or "none" (web). */
export async function pushState() {
  const O = await plugin();
  if (!O) return "none";
  try {
    if (await O.Notifications.getPermissionAsync()) return "on";
    return (await O.Notifications.canRequestPermission()) ? "ask" : "off";
  } catch { return "none"; }
}

/** Shows the iPhone permission prompt. If they said no before, opens Settings instead. */
export async function askForPush() {
  const O = await plugin();
  if (!O) return false;
  try { return await O.Notifications.requestPermission(true); } catch { return false; }
}
