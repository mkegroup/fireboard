// Maps. With a Google Maps key the board uses Google Maps (map and satellite)
// and Google's address lookup for the incident pin. Without a key it falls
// back to a basic OpenStreetMap so nothing breaks while setting up.
// Directions always open in Apple Maps or Google Maps.
//
// The board talks to one small interface so it doesn't care which is used:
//   setView([lat, lng], zoom)   fit([[lat, lng], ...])   upsert(id, marker)
//   remove(id)   ids()   focus(id, zoom)   resize()   destroy()
// A marker is { pt: [lat, lng], color, label, kind: "person" | "incident", popup }.
import { CONFIG } from "./config.js";
import { getLang } from "./i18n.js";
import { esc } from "./util.js";

const key = () => (CONFIG.GOOGLE_MAPS_KEY || "").trim();
export const hasMapKey = () => !!key();

/** Turns "var(--st-in)" into the colour it stands for. */
function realColor(c) {
  const m = /^var\((--[\w-]+)\)$/.exec(c || "");
  if (!m) return c || "#9aa3b0";
  return getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim() || "#9aa3b0";
}

const FLAME = '<path d="M12 22c4 0 7-3 7-7 0-4-3-6-4-10-2 2-3 4-3 6-1-1-2-2-2-4-3 3-5 5-5 8 0 4 3 7 7 7z" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>';

// ---------------- Google Maps ----------------
let googleLoading = null;
function loadGoogle() {
  if (window.google?.maps?.Map) return Promise.resolve(window.google.maps);
  if (googleLoading) return googleLoading;
  googleLoading = new Promise((resolve, reject) => {
    const cb = `__fgbMaps${Date.now()}`;
    const timer = setTimeout(() => { googleLoading = null; reject(new Error("Google Maps took too long to load")); }, 15000);
    window[cb] = () => { clearTimeout(timer); delete window[cb]; resolve(window.google.maps); };
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key())}&v=weekly&language=${getLang()}&callback=${cb}`;
    s.async = true;
    s.onerror = () => { clearTimeout(timer); googleLoading = null; reject(new Error("Google Maps could not load")); };
    document.head.appendChild(s);
  });
  return googleLoading;
}

function pinSvg(m) {
  const fill = m.kind === "incident" ? realColor("var(--red)") : realColor(m.color);
  const size = m.kind === "incident" ? 40 : 34;
  const r = size / 2 - 2;
  const inner = m.kind === "incident"
    ? `<g transform="translate(${size / 2 - 9} ${size / 2 - 10}) scale(0.75)">${FLAME}</g>`
    : `<text x="50%" y="50%" dy=".35em" text-anchor="middle" font-family="Arial, sans-serif" font-weight="700" font-size="13" fill="#10131a">${esc(m.label || "")}</text>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="${fill}" stroke="#fff" stroke-width="${m.kind === "incident" ? 3 : 2}"/>${inner}</svg>`;
  return { url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`, size };
}

async function googleMap(el) {
  const g = await loadGoogle();
  let saved = "roadmap";
  try { saved = localStorage.getItem("fgb_map_type") === "hybrid" ? "hybrid" : "roadmap"; } catch { /* private mode */ }
  const map = new g.Map(el, {
    center: { lat: 45.5, lng: -77.5 },
    zoom: 13,
    mapTypeId: saved,
    mapTypeControl: true,
    mapTypeControlOptions: { mapTypeIds: ["roadmap", "hybrid"], style: g.MapTypeControlStyle.HORIZONTAL_BAR, position: g.ControlPosition.TOP_RIGHT },
    streetViewControl: false,
    fullscreenControl: true,
    gestureHandling: "greedy",
    clickableIcons: false,
  });
  map.addListener("maptypeid_changed", () => { try { localStorage.setItem("fgb_map_type", map.getMapTypeId()); } catch { /* private mode */ } });
  const markers = new Map();
  const info = new g.InfoWindow();
  return {
    setView(pt, zoom) { map.setCenter({ lat: pt[0], lng: pt[1] }); map.setZoom(zoom); },
    fit(pts, maxZoom = 17) {
      if (!pts.length) return;
      if (pts.length === 1) return this.setView(pts[0], 16);
      const b = new g.LatLngBounds();
      pts.forEach((p) => b.extend({ lat: p[0], lng: p[1] }));
      map.fitBounds(b, 40);
      g.event.addListenerOnce(map, "idle", () => { if (map.getZoom() > maxZoom) map.setZoom(maxZoom); });
    },
    upsert(id, m) {
      const pin = pinSvg(m);
      const icon = { url: pin.url, scaledSize: new g.Size(pin.size, pin.size), anchor: new g.Point(pin.size / 2, pin.size / 2) };
      let mk = markers.get(id);
      if (!mk) {
        mk = new g.Marker({ map, position: { lat: m.pt[0], lng: m.pt[1] }, icon, zIndex: m.kind === "incident" ? 1000 : 10 });
        mk.addListener("click", () => { info.setContent(mk.__popup || ""); info.open({ anchor: mk, map }); });
        markers.set(id, mk);
      } else {
        mk.setPosition({ lat: m.pt[0], lng: m.pt[1] });
        mk.setIcon(icon);
      }
      mk.__popup = `<div style="color:#111;font:14px/1.35 Arial,sans-serif">${m.popup || ""}</div>`;
    },
    remove(id) { const mk = markers.get(id); if (mk) { mk.setMap(null); markers.delete(id); } },
    ids() { return [...markers.keys()]; },
    focus(id, zoom = 18) {
      const mk = markers.get(id);
      if (!mk) return;
      map.setCenter(mk.getPosition());
      map.setZoom(zoom);
      info.setContent(mk.__popup || "");
      info.open({ anchor: mk, map });
    },
    resize() { /* Google Maps resizes itself */ },
    destroy() { markers.forEach((mk) => mk.setMap(null)); markers.clear(); info.close(); el.innerHTML = ""; },
  };
}

// ---------------- fallback: Leaflet + OpenStreetMap ----------------
function leafletMap(el) {
  const L = window.L;
  if (!L) throw new Error("Map could not load.");
  const map = L.map(el, { zoomControl: true, attributionControl: true }).setView([45.5, -77.5], 13);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
  setTimeout(() => map.invalidateSize(), 60);
  const markers = new Map();
  const iconFor = (m) => m.kind === "incident"
    ? L.divIcon({ html: `<div class="map-pin inc"><svg class="icon sm" viewBox="0 0 24 24" aria-hidden="true">${FLAME}</svg></div>`, className: "", iconSize: [38, 38], iconAnchor: [19, 19] })
    : L.divIcon({ html: `<div class="map-pin" style="background:${m.color}">${esc(m.label || "")}</div>`, className: "", iconSize: [34, 34], iconAnchor: [17, 17] });
  return {
    setView(pt, zoom) { map.setView(pt, zoom); },
    fit(pts, maxZoom = 17) {
      if (!pts.length) return;
      if (pts.length === 1) map.setView(pts[0], 16);
      else map.fitBounds(pts, { padding: [40, 40], maxZoom });
    },
    upsert(id, m) {
      const mk = markers.get(id);
      if (mk) mk.setLatLng(m.pt).setIcon(iconFor(m)).setPopupContent(m.popup || "");
      else markers.set(id, L.marker(m.pt, { icon: iconFor(m), zIndexOffset: m.kind === "incident" ? 1000 : 0 }).addTo(map).bindPopup(m.popup || ""));
    },
    remove(id) { const mk = markers.get(id); if (mk) { map.removeLayer(mk); markers.delete(id); } },
    ids() { return [...markers.keys()]; },
    focus(id, zoom = 18) { const mk = markers.get(id); if (mk) { map.setView(mk.getLatLng(), zoom); mk.openPopup(); } },
    resize() { map.invalidateSize(); },
    destroy() { map.remove(); },
  };
}

/** Builds the map in `el`. Google Maps when there's a key, else the fallback. */
export async function createMap(el) {
  if (hasMapKey()) {
    try { return await googleMap(el); } catch (e) { console.warn("google maps failed, using fallback", e); }
  }
  return leafletMap(el);
}

// ---------------- address lookup ----------------
/** Address to [lat, lng], or null. Remembered for the session so it's looked up once. */
export async function geocode(address) {
  const a = (address || "").trim();
  if (!a || !hasMapKey()) return null;
  const ck = `fgb_geo_${a.toLowerCase()}`;
  try { const hit = sessionStorage.getItem(ck); if (hit) return JSON.parse(hit); } catch { /* private mode */ }
  try {
    const g = await loadGoogle();
    const { results } = await new g.Geocoder().geocode({ address: a });
    const loc = results?.[0]?.geometry?.location;
    if (!loc) return null;
    const pt = [loc.lat(), loc.lng()];
    try { sessionStorage.setItem(ck, JSON.stringify(pt)); } catch { /* private mode */ }
    return pt;
  } catch {
    return null;
  }
}

// ---------------- directions ----------------
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
