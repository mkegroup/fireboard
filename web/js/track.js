// When someone arrives from one of our emails (the link carries fgb_ref), note what they do here so the team knows
// who's really interested: opened the demo, ran a PAR, started signing up. Nothing is sent for anyone else.
import { CONFIG, IS_NATIVE } from "./config.js";
const KEY = "fgb_ref";
const URL_ = "https://t.mkegroup.ca/e";
let ref = null;
const sent = new Set();

// Meta pixel (website only, never in the iPhone app): lets ads learn who actually starts a trial.
// Off until CONFIG.META_PIXEL_ID is set.
const PIXEL = { demo: ["ViewContent", { content_name: "demo" }], plan: ["ViewContent", { content_name: "plans" }],
  email: ["Lead", {}], dept: ["CompleteRegistration", { content_name: "department", status: "trial" }] };
function initPixel() {
  const id = CONFIG.META_PIXEL_ID;
  if (!id || IS_NATIVE || window.fbq) return;
  const f = window.fbq = function () { f.callMethod ? f.callMethod.apply(f, arguments) : f.queue.push(arguments); };
  f.push = f; f.loaded = true; f.version = "2.0"; f.queue = []; window._fbq = f;
  const sc = document.createElement("script"); sc.async = true; sc.src = "https://connect.facebook.net/en_US/fbevents.js";
  document.head.appendChild(sc);
  f("init", id); f("track", "PageView");
}
function pixel(ev) {
  const m = PIXEL[ev];
  if (!m || !window.fbq) return;
  try { window.fbq("track", m[0], m[1]); if (ev === "dept") window.fbq("track", "StartTrial", { value: 0, currency: "CAD" }); } catch { /* ignore */ }
}

export function initTrack(params) {
  try { initPixel(); } catch { /* never block the app */ }
  try {
    const r = params.get("fgb_ref") || params.get("r");
    if (r && /^[\w-]{6,40}$/.test(r)) {
      localStorage.setItem(KEY, r);
      params.delete("fgb_ref"); params.delete("r");
      const q = params.toString();
      history.replaceState(null, "", location.pathname + (q ? "?" + q : "") + location.hash);
      ref = r;
      track("visit", "from email");
      return;
    }
    ref = localStorage.getItem(KEY);
    if (ref) track("return", "came back");
  } catch { /* private mode: no tracking */ }
}

export function track(ev, detail = "") {
  if (sent.has(ev)) return;
  pixel(ev);
  if (!ref) return;
  sent.add(ev);
  const body = JSON.stringify({ ref, ev, detail: String(detail || "").slice(0, 160) });
  try {
    if (navigator.sendBeacon) navigator.sendBeacon(URL_, new Blob([body], { type: "text/plain" }));
    else fetch(URL_, { method: "POST", body, mode: "no-cors", keepalive: true });
  } catch { /* never get in the way */ }
}
