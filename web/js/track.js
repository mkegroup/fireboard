// When someone arrives from one of our emails (the link carries fgb_ref), note what they do here so the team knows
// who's really interested: opened the demo, ran a PAR, started signing up. Nothing is sent for anyone else.
const KEY = "fgb_ref";
const URL_ = "https://t.mkegroup.ca/e";
let ref = null;
const sent = new Set();

export function initTrack(params) {
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
  if (!ref || sent.has(ev)) return;
  sent.add(ev);
  const body = JSON.stringify({ ref, ev, detail: String(detail || "").slice(0, 160) });
  try {
    if (navigator.sendBeacon) navigator.sendBeacon(URL_, new Blob([body], { type: "text/plain" }));
    else fetch(URL_, { method: "POST", body, mode: "no-cors", keepalive: true });
  } catch { /* never get in the way */ }
}
