// Reads a dispatch page (email, text message, CAD message) and pulls out
// the call type, address, units and notes. Pages come in every shape:
//   "CALL: STRUCTURE FIRE ADDR: 142 MILL ST CITY: COMBERMERE UNITS: E1,T2"
//   "Structure Fire - 142 Mill Street, Combermere. Units E1 T2"
//   forwarded Gmail messages with headers and signatures
// so this works from labels first, then falls back to spotting a street address.

export type ParsedPage = {
  name: string;
  address: string | null;
  callType: string | null;
  units: string[];
  notes: string;
  lat: number | null;
  lng: number | null;
};

// The app's call types, with words dispatchers use for each.
const TYPES: [string, RegExp][] = [
  ["MVC", /\b(mvc|mva|m\.v\.c|collision|crash|accident|vehicle (?:accident|collision)|rollover|pin ?in|entrapment|extrication|accidente|choque|collision routi[eè]re|accident routier)\b/i],
  ["Vehicle fire", /\b(vehicle fire|car fire|truck fire|auto fire|veh(?:icle)? fire|incendie (?:de )?v[ée]hicule|incendio (?:de )?veh[ií]culo)\b/i],
  ["Grass / brush", /\b(grass|brush|bush|wildland|forest|field|woods|outdoor fire|open air burn|controlled burn|feu de (?:broussailles|for[eê]t|herbe)|incendio forestal|pasto)\b/i],
  ["Hazmat", /\b(hazmat|haz-mat|hazardous|gas leak|natural gas|propane|spill|fuel leak|odou?r of gas|smell of gas|fuite de gaz|mati[eè]res dangereuses|fuga de gas)\b/i],
  ["Alarm", /\b(alarm|smoke detector|co detector|carbon monoxide|co alarm|fire alarm|alarme|alarma)\b/i],
  ["Rescue", /\b(rescue|water rescue|ice rescue|rope|confined space|trench|missing person|search|sauvetage|rescate)\b/i],
  ["Medical assist", /\b(medical|cardiac|vsa|cpr|unconscious|breathing|difficulty breathing|chest pain|fall|lift assist|tiered|ems|overdose|seizure|stroke|m[ée]dical|m[ée]dico|paro card[ií]aco)\b/i],
  ["Structure", /\b(structure|structural|house fire|building fire|residential fire|commercial fire|working fire|chimney|kitchen fire|basement fire|barn fire|garage fire|apartment fire|fire in (?:a |the )?(?:house|building|home)|incendie de (?:b[aâ]timent|maison|structure)|incendio estructural)\b/i],
];

const LABELS: Record<string, string[]> = {
  type: ["call type", "calltype", "call", "nature", "nature of call", "incident type", "event type", "type", "problem", "complaint", "tipo", "nature de l'appel"],
  address: ["address", "addr", "location", "loc", "incident address", "respond to", "dispatch address", "adresse", "lieu", "direcci[oó]n", "ubicaci[oó]n"],
  city: ["city", "town", "municipality", "muni", "twp", "township", "community", "ville", "municipalit[eé]", "ciudad"],
  cross: ["cross streets?", "cross st", "x-?streets?", "x-?st", "xst", "intersection", "between"],
  units: ["units?", "apparatus", "assigned units?", "resources", "responding units?", "unit\\(s\\)", "unit[eé]s", "unidades"],
  notes: ["comments?", "narrative", "remarks", "notes?", "info", "details", "commentaires", "notas"],
  name: ["subject", "title", "incident name"],
  // Not used, but they end the field before them.
  ref: ["incident ?(?:#|no\\.?|number)", "event ?(?:#|no\\.?|number)", "case ?(?:#|no\\.?)", "time", "date", "dispatched", "priority", "map", "grid", "zone", "box", "lat", "lon", "long", "latitude", "longitude", "caller", "phone", "agency", "district", "station"],
};

const STREET = "(?:st|street|rd|road|ave|av|avenue|dr|drive|ln|lane|cres|crescent|crt|court|ct|blvd|boulevard|hwy|highway|way|pl|place|line|sideroad|side ?rd|conc|concession|trail|trl|pkwy|parkway|cir|circle|terr|terrace|ter|row|gate|grove|hts|heights|pt|point|loop|path|sq|square|cove|cv|rang|chemin|ch|rue|boul|calle|camino|route|rte)";
const ADDRESS_RE = new RegExp(
  `\\b(\\d{1,6}[a-z]?(?:-\\d{1,6})?[ \\t]+(?:[nsew]\\.?[ \\t]+)?(?:[a-z0-9.'’\\-]+[ \\t]+){0,4}?${STREET}\\b\\.?(?:[ \\t]+(?:[nsew]|north|south|east|west)\\b)?(?:[ \\t]*,?[ \\t]*(?:unit|apt|suite|#)[ \\t]*[\\w-]+)?)`,
  "i",
);
const ROAD_RE = /\b((?:hwy|highway|county (?:rd|road)|cty rd|cr|route|rte|regional (?:rd|road)|rr)[ \t]*#?[ \t]*\d+[a-z]?(?:[ \t]*(?:@|at|&|and|near|x)[ \t]+[a-z0-9 .'’-]{2,40})?)/i;
const COORDS_RE = /(-?\d{1,2}\.\d{3,})\s*[,/ ]\s*(-?\d{1,3}\.\d{3,})/;

/** Removes HTML, forwarded-message headers, quoted replies and common footers. */
export function cleanText(raw: string): string {
  let s = raw ?? "";
  if (/<(?:html|body|div|p|br|table)\b/i.test(s)) {
    s = s.replace(/<(?:br|\/p|\/div|\/tr|\/li|\/h\d)[^>]*>/gi, "\n").replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }
  const out: string[] = [];
  for (let line of s.split(/\r?\n/)) {
    line = line.replace(/\s+/g, " ").trim();
    if (!line) { if (out.length && out[out.length - 1] !== "") out.push(""); continue; }
    if (/^-{2,}\s*(forwarded|original) message\s*-{2,}$/i.test(line)) continue;
    if (/^begin forwarded message:?$/i.test(line)) continue;
    if (/^(from|sent|to|cc|date|de|envoy[ée]|[àa]|objet|para|enviado):\s/i.test(line) && !/^date:\s*\d{1,2}[/-]\d{1,2}/i.test(line)) continue;
    if (/^>+/.test(line)) continue;
    if (/^(sent from my|get outlook for|this (?:e-?mail|message) (?:and any|is intended|may contain)|confidential(?:ity)? notice|disclaimer:|unsubscribe|--$)/i.test(line)) break;
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** "Fwd: RE: Page: Structure Fire" -> "Structure Fire" */
export function cleanSubject(subject: string): string {
  return (subject ?? "").replace(/^\s*((re|fw|fwd|tr|rv)\s*:\s*)+/i, "").replace(/\s+/g, " ").trim();
}

function labelRegex(): RegExp {
  const all = Object.values(LABELS).flat().sort((a, b) => b.length - a.length);
  // A label is a word at the start of the text, a line, or after a separator, followed by : or #
  return new RegExp(`(?:^|[\\n|;,]\\s*|\\s{2,}|\\s(?=[A-Z]{2,}\\s*:))(${all.join("|")})\\s*[:#=]\\s*`, "gi");
}

function labelKind(label: string): string | null {
  for (const [kind, list] of Object.entries(LABELS)) {
    for (const l of list) if (new RegExp(`^${l}$`, "i").test(label.trim())) return kind;
  }
  return null;
}

/** Finds "LABEL: value" pairs. A value runs until the next label or the end of the line. */
export function labelled(text: string): Record<string, string> {
  const found: Record<string, string> = {};
  const re = labelRegex();
  const hits: { kind: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const kind = labelKind(m[1]);
    if (kind) hits.push({ kind, start: m.index, end: m.index + m[0].length });
    if (m[0].length === 0) re.lastIndex++;
  }
  hits.forEach((h, i) => {
    const stop = i + 1 < hits.length ? hits[i + 1].start : text.length;
    let v = text.slice(h.end, stop);
    // Notes can run across lines. Everything else stops at the end of its line.
    if (h.kind !== "notes") v = v.split("\n")[0];
    v = v.replace(/\s+/g, " ").replace(/^[\s,;:|-]+|[\s,;|-]+$/g, "").trim();
    if (v && !found[h.kind]) found[h.kind] = v;
  });
  return found;
}

/** Maps what dispatch called it to one of the app's call types. */
export function callTypeFor(text: string): string | null {
  for (const [type, re] of TYPES) if (re.test(text)) return type;
  return null;
}

/** "E1, T-2 RESCUE3" -> ["E1", "T2", "RESCUE3"] */
export function unitList(text: string): string[] {
  return [...new Set((text.toUpperCase().match(/\b[A-Z]{1,8}[ -]?\d{1,4}\b/g) ?? []).map((u) => u.replace(/[ -]/g, "")))].slice(0, 20);
}

function title(s: string): string {
  if (s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/(^|[\s/(-])([a-zà-ÿ])/g, (_, a, b) => a + b.toUpperCase())
    .replace(/\b(Mvc|Mva|Co|Ems|Vsa|Cpr|Hazmat)\b/g, (w) => w.toUpperCase());
}

export function parsePage(rawText: string, subject = ""): ParsedPage {
  const text = cleanText(rawText);
  const subj = cleanSubject(subject);
  const lab = { ...labelled(subj), ...labelled(text) };
  const all = `${subj}\n${text}`;

  // Address: labelled first, then anything that looks like a street address or highway.
  let address: string | null = lab.address ?? null;
  if (!address) {
    const a = all.match(ADDRESS_RE)?.[1] ?? all.match(ROAD_RE)?.[1] ?? null;
    address = a ? a.trim() : null;
  }
  if (address && lab.city && !address.toLowerCase().includes(lab.city.toLowerCase())) address = `${address}, ${lab.city}`;
  if (address && lab.cross) address = `${address} (at ${lab.cross})`;
  if (address) address = title(address).slice(0, 200);

  const rawType = lab.type ?? "";
  const callType = callTypeFor(rawType) ?? callTypeFor(subj) ?? callTypeFor(text);

  // Name: what dispatch called it, else the subject, else the first line that isn't the address.
  let name = rawType;
  if (!name && subj && !/^(page|dispatch|alert|call|new call|incident|message|notification)$/i.test(subj)) name = subj;
  if (!name) {
    const first = text.split("\n").find((l) => l.trim() && (!address || !l.toLowerCase().includes(address.toLowerCase().slice(0, 12))));
    name = first ?? "";
  }
  // A long first line is probably a whole page squashed into one line: use the call type instead.
  if (name.length > 60 && callType) name = callType;
  name = title(name.replace(/\s+/g, " ").trim()).slice(0, 120) || callType || "Dispatched call";

  const coords = all.match(COORDS_RE);
  const lat = coords ? Number(coords[1]) : null;
  const lng = coords ? Number(coords[2]) : null;
  const validCoords = lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

  return {
    name,
    address,
    callType,
    units: unitList(lab.units ?? ""),
    notes: (lab.notes ?? text).slice(0, 900),
    lat: validCoords ? lat : null,
    lng: validCoords ? lng : null,
  };
}

/** Does a page's unit code ("E1", "ENG1", "ENGINE1") mean this truck ("Engine 1")? */
export function unitMatches(code: string, truckName: string): boolean {
  const c = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const t = truckName.toUpperCase().replace(/[^A-Z0-9 ]/g, "");
  const num = t.match(/\d+/)?.[0];
  const cn = c.match(/\d+/)?.[0];
  if (!num || num !== cn) return false;
  const letters = c.replace(/\d+/g, "");
  const words = t.replace(/\d+/g, "").trim().split(/\s+/).filter(Boolean);
  if (!letters || !words.length) return false;
  const word = words.join("");
  const initials = words.map((w) => w[0]).join("");
  return word.startsWith(letters) || initials === letters || letters.startsWith(word) || word[0] === letters && letters.length === 1;
}
