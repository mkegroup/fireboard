// Maps: MapTiler streets and satellite in the app, plus one-tap directions
// in Apple Maps or Google Maps. Needs MAPTILER_KEY in config.js (filled in
// by the deploy from the GitHub variable of the same name).
import { CONFIG } from "./config.js";
import { getLang } from "./i18n.js";

export const hasMapKey = () => !!(CONFIG.MAPTILER_KEY || "").trim();

const ATTR = '<a href="https://www.maptiler.com/copyright/" target="_blank" rel="noopener">&copy; MapTiler</a> <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">&copy; OpenStreetMap contributors</a>';

/** The map styles people can switch between. */
export function baseLayers(L) {
  const k = encodeURIComponent((CONFIG.MAPTILER_KEY || "").trim());
  if (!k) {
    // Only until the MapTiler key is set. Fine for testing, not for paying customers.
    return { Streets: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }) };
  }
  const opts = { tileSize: 512, zoomOffset: -1, maxZoom: 20, minZoom: 1, attribution: ATTR, crossOrigin: true };
  return {
    Streets: L.tileLayer(`https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key=${k}`, opts),
    Satellite: L.tileLayer(`https://api.maptiler.com/maps/hybrid/{z}/{x}/{y}.jpg?key=${k}`, opts),
  };
}

/** Address to [lat, lng], or null. Remembered for the session so it's looked up once. */
export async function geocode(address) {
  const a = (address || "").trim();
  if (!a || !hasMapKey()) return null;
  const ck = `fgb_geo_${a.toLowerCase()}`;
  try { const hit = sessionStorage.getItem(ck); if (hit) return JSON.parse(hit); } catch { /* private mode */ }
  try {
    const url = `https://api.maptiler.com/geocoding/${encodeURIComponent(a)}.json?key=${encodeURIComponent(CONFIG.MAPTILER_KEY.trim())}&limit=1&proximity=ip&language=${getLang()}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const f = (await res.json())?.features?.[0];
    if (!f?.center || (f.relevance ?? 1) < 0.5) return null;
    const pt = [f.center[1], f.center[0]];
    try { sessionStorage.setItem(ck, JSON.stringify(pt)); } catch { /* private mode */ }
    return pt;
  } catch {
    return null;
  }
}

/** The directions link that suits this phone: Apple Maps on iPhone and Mac, Google Maps elsewhere. */
export function bestDirections(inc) {
  const d = directions(inc);
  if (!d) return null;
  return /iphone|ipad|ipod|macintosh/i.test(navigator.userAgent) ? d.apple : d.google;
}

/** Links that open turn-by-turn directions to the incident. */
export function directions(inc) {
  const hasPt = typeof inc?.lat === "number" && typeof inc?.lng === "number";
  const dest = hasPt ? `${inc.lat},${inc.lng}` : (inc?.address || "").trim();
  if (!dest) return null;
  const d = encodeURIComponent(dest);
  return {
    apple: `https://maps.apple.com/?daddr=${d}&dirflg=d`,
    google: `https://www.google.com/maps/dir/?api=1&destination=${d}&travelmode=driving`,
  };
}
