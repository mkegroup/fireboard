// Bulk import from a spreadsheet: roster, certifications, training, equipment, trucks.
// Every kind has a template to download, fill in Excel or Google Sheets, and
// bring back as a CSV file, or paste straight from the spreadsheet.
// Rows are checked and shown before anything is saved.
import { S, RANKS, CREWS, TRAINING_TYPES, EQUIP_STATUSES, EQUIP_CATEGORIES, APP_KINDS } from "./state.js";
import { esc, download, csv, friendlyError, todayISO } from "./util.js";
import { icon, toast, openSheet } from "./ui.js";

// ---------------- reading spreadsheets ----------------
/** CSV, tab separated (pasted from Excel) or semicolon separated. Quotes handled. */
export function parseTable(text) {
  const src = String(text || "").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const first = src.split("\n").find((l) => l.trim()) || "";
  const sep = first.includes("\t") ? "\t" : (first.split(";").length > first.split(",").length ? ";" : ",");
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"' && cell === "") q = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim().replace(/^'(?=[=+\-@])/, ""))).filter((r) => r.some((c) => c));
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
/** "2026-03-05", "3/5/2026", "05/03/2026", "Mar 5 2026", "5 March 2026", Excel serial numbers. Returns YYYY-MM-DD or "". */
export function parseDate(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  const pad = (n) => String(n).padStart(2, "0");
  const ok = (y, m, d) => (y > 1900 && y < 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${pad(m)}-${pad(d)}` : "");
  let m;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) return ok(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/))) {
    let y = +m[3]; if (y < 100) y += 2000;
    const a = +m[1], b = +m[2];
    // Canada and the US write month first; if the first number can't be a month, it's the day.
    return a > 12 ? ok(y, b, a) : ok(y, a, b);
  }
  const mon = (w) => MONTHS[w.toLowerCase().slice(0, 4)] || MONTHS[w.toLowerCase().slice(0, 3)];
  if ((m = s.match(/^([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/i)) && mon(m[1])) return ok(+m[3], mon(m[1]), +m[2]);
  if ((m = s.match(/^(\d{1,2})\s+([a-z]{3,9})\.?,?\s+(\d{4})$/i)) && mon(m[2])) return ok(+m[3], mon(m[2]), +m[1]);
  if (/^\d{5}$/.test(s)) { // Excel date number
    const d = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000);
    return ok(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  return "";
}

const norm = (s) => String(s || "").normalize("NFD").toLowerCase().replace(/[^a-z0-9]/g, "");
const pick = (list, v) => { const n = norm(v); return n ? list.find((x) => norm(x) === n) || null : null; };
const listOf = (v) => String(v || "").split(/[;|\n]/).map((x) => x.trim()).filter(Boolean);

// ---------------- what can be imported ----------------
// cols: [key, header, aliases[], required?]
const KINDS = {
  roster: {
    label: "Roster",
    blurb: "People on your department. Anyone already on the roster with the same name gets their blank details filled in instead of being added twice.",
    cols: [
      ["name", "Name", ["fullname", "member", "firefighter", "nom", "nombre"], true],
      ["rank", "Rank", ["title", "position", "grade", "rango"]],
      ["crew", "Crew", ["platoon", "shift", "group", "station", "equipe", "peloton", "turno"]],
      ["phone", "Phone", ["cell", "mobile", "phonenumber", "telephone", "cellulaire", "telefono"]],
      ["call_sign", "Call sign", ["callsign", "unit"]],
      ["radio", "Radio number", ["radio", "radioid", "pager"]],
      ["years", "Years of service", ["years", "yearsofservice", "service"]],
      ["certs", "Certifications", ["certification", "certs", "qualifications"]],
    ],
    example: [["Jordan MacLeod", "Captain", "Alpha", "613-555-0101", "C1", "101", "12", "NFPA 1001 Level II; First Aid / CPR"], ["Sam Riopelle", "Firefighter", "Bravo", "613-555-0102", "", "102", "3", "NFPA 1001 Level I"]],
    row(r) {
      if (!r.name) return { skip: "No name" };
      const rank = pick(RANKS, r.rank) || (r.rank ? r.rank.slice(0, 40) : "");
      const crew = pick(CREWS, r.crew) || (r.crew ? r.crew.slice(0, 40) : "");
      const years = r.years && /^\d{1,2}$/.test(r.years) ? r.years : "";
      const certifications = listOf(r.certs).map((c) => ({ name: c.slice(0, 80), date: "", expiry: "" }));
      return { value: { name: r.name.slice(0, 80), rank, crew, phone: r.phone, call_sign: r.call_sign, radio: r.radio, years, certifications },
        show: [r.name, rank, crew, r.phone, certifications.length ? `Certifications: ${certifications.length}` : ""] };
    },
    async save(rows) {
      let added = 0;
      for (let i = 0; i < rows.length; i += 500) added += await S.api.importRoster(S.dept.id, rows.slice(i, i + 500));
      const updated = rows.length - added;
      return updated > 0 ? `Added to the roster: ${added}. Already on it and updated: ${updated}.` : `${added} added to the roster.`;
    },
  },
  certs: {
    label: "Certifications",
    blurb: "One row per certification. Matched to people on your roster by name, so add the roster first. Expiry dates show warnings in Records.",
    cols: [
      ["name", "Name", ["member", "firefighter", "person"], true],
      ["cert", "Certification", ["course", "qualification", "certificate", "certificacion", "formation"], true],
      ["date", "Completed", ["date", "completed", "issued", "datecompleted"]],
      ["expiry", "Expires", ["expiry", "expires", "expirydate", "expiration", "renewal", "echeance", "vence", "vencimiento"]],
    ],
    example: [["Jordan MacLeod", "NFPA 1001 Level II", "2021-05-14", ""], ["Sam Riopelle", "First Aid / CPR", "2025-03-01", "2028-03-01"]],
    async prepare() { this.members = await S.api.listMembers(S.dept.id); },
    row(r) {
      if (!r.name || !r.cert) return { skip: !r.name ? "No name" : "No certification" };
      const m = (this.members || []).find((x) => norm(x.name) === norm(r.name));
      if (!m) return { skip: `${r.name} isn't on the roster` };
      const date = parseDate(r.date), expiry = parseDate(r.expiry);
      if (r.date && !date) return { skip: `Can't read the date "${r.date}"` };
      if (r.expiry && !expiry) return { skip: `Can't read the date "${r.expiry}"` };
      return { value: { member: m, cert: { name: r.cert.slice(0, 80), date, expiry } }, show: [m.name, r.cert, date, expiry] };
    },
    async save(rows) {
      const by = new Map();
      for (const { member, cert } of rows) (by.get(member.id) || by.set(member.id, { member, certs: [] }).get(member.id)).certs.push(cert);
      let n = 0;
      for (const { member, certs } of by.values()) {
        const list = [...(member.certifications || [])];
        for (const c of certs) {
          const i = list.findIndex((x) => norm(x.name) === norm(c.name));
          if (i >= 0) list[i] = { ...list[i], ...Object.fromEntries(Object.entries(c).filter(([, v]) => v)) };
          else list.push(c);
          n++;
        }
        await S.api.updateMember(member.id, { certifications: list });
      }
      return `Certifications saved: ${n}. People updated: ${by.size}.`;
    },
  },
  training: {
    label: "Training",
    blurb: "One row per session. List who attended separated by semicolons, using the names on your roster.",
    cols: [
      ["date", "Date", ["sessiondate", "day", "fecha"], true],
      ["title", "Title", ["topic", "session", "subject", "name", "titre", "sujet", "titulo", "tema"], true],
      ["kind", "Type", ["type", "category", "tipo"]],
      ["hours", "Hours", ["duration", "hrs", "heures", "duree", "horas"]],
      ["location", "Location", ["place", "where", "lieu", "lugar"]],
      ["instructor", "Instructor", ["trainer", "lead", "instructeur", "formateur", "instructor"]],
      ["attendees", "Attendees", ["attendance", "present", "members", "who", "participants", "presents", "presences", "asistentes", "asistencia"]],
      ["notes", "Notes", ["description", "details", "comments", "remarques", "notas"]],
    ],
    example: [["2026-10-07", "Pump operations", "Pump Operations", "3", "Station 1", "Capt. MacLeod", "Jordan MacLeod; Sam Riopelle", "Drafting from the dry hydrant"], ["2026-10-21", "Live fire, acquired structure", "Live Fire", "4", "123 Farm Rd", "", "Sam Riopelle", ""]],
    row(r) {
      if (!r.title) return { skip: "No title" };
      const d = parseDate(r.date);
      if (!d) return { skip: r.date ? `Can't read the date "${r.date}"` : "No date" };
      const hours = r.hours ? String(r.hours).replace(",", ".") : "";
      if (hours && !/^\d{1,3}(\.\d{1,2})?$/.test(hours)) return { skip: `Hours "${r.hours}" isn't a number` };
      const attendees = listOf(r.attendees);
      return { value: { session_date: d, title: r.title.slice(0, 120), kind: pick(TRAINING_TYPES, r.kind) || r.kind || "", hours, location: r.location, instructor: r.instructor, notes: r.notes, attendees },
        show: [d, r.title, hours ? `${hours}h` : "", attendees.length ? `Attended: ${attendees.length}` : ""] };
    },
    async save(rows) {
      let s = 0, a = 0; const miss = [];
      for (let i = 0; i < rows.length; i += 500) {
        const r = await S.api.importTraining(S.dept.id, rows.slice(i, i + 500));
        s += r.sessions; a += r.attendance; miss.push(...(r.unmatched || []));
      }
      const base = `Training sessions added: ${s}. Attendance records: ${a}.`;
      return miss.length ? `${base} Not on the roster, so skipped: ${miss.slice(0, 8).join(", ")}${miss.length > 8 ? "..." : ""}` : base;
    },
  },
  equipment: {
    label: "Equipment",
    blurb: "One row per item, or one row with a quantity for identical items like hose lengths.",
    cols: [
      ["name", "Name", ["item", "equipment", "description"], true],
      ["category", "Category", ["type", "group", "categorie", "categoria"]],
      ["status", "Status", ["state", "statut", "etat", "estado"]],
      ["serial", "Serial", ["serialnumber", "sn", "assettag", "tag"]],
      ["qty", "Qty", ["quantity", "count", "number", "quantite", "cantidad"]],
      ["location", "Location", ["where", "truck", "apparatus", "compartment", "emplacement", "ubicacion", "lieu"]],
      ["condition", "Condition", ["cond"]],
      ["last_inspected", "Last inspected", ["lastinspection", "inspected", "lastcheck", "lastchecked"]],
      ["next_service", "Next service", ["nextservice", "due", "servicedue", "nextinspection"]],
      ["notes", "Notes", ["comments", "details"]],
    ],
    example: [["SCBA, MSA G1", "SCBA / Breathing", "In Service", "MSA-221045", "1", "Engine 1", "Good", "2026-09-01", "2027-09-01", ""], ["1.75 in attack hose, 50 ft", "Hose / Nozzles", "Available", "", "8", "Station", "Good", "", "2027-06-01", "Annual hose test"]],
    row(r) {
      if (!r.name) return { skip: "No name" };
      const li = parseDate(r.last_inspected), ns = parseDate(r.next_service);
      if (r.last_inspected && !li) return { skip: `Can't read the date "${r.last_inspected}"` };
      if (r.next_service && !ns) return { skip: `Can't read the date "${r.next_service}"` };
      const status = pick(EQUIP_STATUSES, r.status) || "Available";
      return { value: { name: r.name.slice(0, 120), category: pick(EQUIP_CATEGORIES, r.category) || r.category || "", status, serial: r.serial, qty: r.qty, location: r.location, condition: r.condition, last_inspected: li, next_service: ns, notes: r.notes },
        show: [r.name, status, r.qty && r.qty !== "1" ? `x${r.qty}` : "", ns ? `Service due ${ns}` : ""] };
    },
    async save(rows) {
      let n = 0;
      for (let i = 0; i < rows.length; i += 500) n += await S.api.importEquipment(S.dept.id, rows.slice(i, i + 500));
      return `Equipment items added: ${n}.`;
    },
  },
  trucks: {
    label: "Trucks",
    blurb: "Your apparatus. They show up as one-tap choices when someone starts an incident, and dispatch pages that name them put them on the call.",
    cols: [
      ["name", "Name", ["truck", "apparatus", "unit", "callsign"], true],
      ["kind", "Type", ["type", "kind", "category"]],
    ],
    example: [["Engine 1", "Engine"], ["Tanker 2", "Tanker"], ["Rescue 3", "Rescue"]],
    row(r) {
      if (!r.name) return { skip: "No name" };
      const kind = pick(APP_KINDS, r.kind) || (r.kind ? "Other" : "Engine");
      return { value: { name: r.name.slice(0, 40), kind }, show: [r.name, kind] };
    },
    async save(rows) {
      const list = [...(S.dept.settings?.apparatus || [])];
      let n = 0;
      for (const t of rows) {
        if (list.some((x) => norm(x.name) === norm(t.name))) continue;
        list.push(t); n++;
      }
      if (list.length > 30) throw new Error("That's more than the limit of 30 trucks. Trim the list and try again.");
      const settings = { ...(S.dept.settings || {}), apparatus: list };
      await S.api.updateDepartment(S.dept.id, { settings });
      S.dept.settings = settings;
      return `Trucks added: ${n}.`;
    },
  },
};
export const IMPORT_KINDS = Object.keys(KINDS);

/** Downloads a template with the right headings and two sample rows. */
export function downloadTemplate(kind) {
  const k = KINDS[kind];
  download(`fire-ground-${kind}-template.csv`, csv([k.cols.map((c) => c[1]), ...k.example]), "text/csv");
}

/** Matches spreadsheet headings to fields. Returns [fieldKey|null per column] or null when there's no heading row. */
function mapHeaders(kind, head) {
  const k = KINDS[kind];
  const keys = head.map((h) => {
    const n = norm(h);
    const col = k.cols.find(([key, label, aliases]) => norm(label) === n || norm(key) === n || aliases.includes(n));
    return col ? col[0] : null;
  });
  return keys.some(Boolean) ? keys : null;
}

/** Turns table rows into checked records. */
function check(kind, rows) {
  const k = KINDS[kind];
  const head = mapHeaders(kind, rows[0] || []);
  const keys = head || k.cols.map((c) => c[0]); // no heading row: assume template order
  const body = head ? rows.slice(1) : rows;
  const missing = head ? k.cols.filter((c) => c[3] && !keys.includes(c[0])).map((c) => c[1]) : [];
  const unknown = head ? rows[0].filter((h, j) => h && !keys[j]) : [];
  const good = [], bad = [];
  body.forEach((cells, i) => {
    const r = {};
    keys.forEach((key, j) => { if (key && cells[j] !== undefined && !r[key]) r[key] = cells[j]; });
    const out = k.row(r);
    if (out.skip) bad.push({ line: i + (head ? 2 : 1), why: out.skip });
    else good.push(out);
  });
  return { good, bad, missing, unknown };
}

/**
 * Opens the import sheet. `kind` picks what's selected first.
 * onDone() runs after a successful import so the screen can reload.
 */
export function openImport(kind = "roster", onDone) {
  let current = KINDS[kind] ? kind : "roster";
  let result = null;
  const { el, close } = openSheet({
    title: "Import from a spreadsheet",
    wide: true,
    body: `
      <div class="label">What are you importing?</div>
      <div class="segment imp-kinds" role="radiogroup">${IMPORT_KINDS.map((k) => `<button type="button" data-kind="${k}" role="radio">${KINDS[k].label}</button>`).join("")}</div>
      <p class="muted small imp-blurb" style="margin:10px 0 0"></p>
      <ol class="imp-steps">
        <li><b>Get the template.</b> It has the right column headings and two example rows.
          <button type="button" class="btn sm" data-template>${icon("download", "sm")} Download template</button></li>
        <li><b>Fill it in</b> in Excel, Numbers or Google Sheets. Delete the example rows. Your own spreadsheet works too if the headings are close.</li>
        <li><b>Bring it back.</b> Save as CSV and choose the file, or copy the cells and paste them below.
          <label class="btn sm imp-file">${icon("attach", "sm")} Choose CSV file<input type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" data-file hidden></label></li>
      </ol>
      <textarea class="textarea mono-ish" data-paste rows="5" placeholder="Or paste rows from your spreadsheet here, headings included"></textarea>
      <div class="imp-preview" aria-live="polite"></div>`,
    submitLabel: "Import",
    errorText: friendlyError,
    onSubmit: async () => {
      if (!result || !result.good.length) throw new Error("Nothing to import yet. Choose a file or paste some rows.");
      const msg = await KINDS[current].save(result.good.map((g) => g.value));
      toast(msg);
      onDone?.();
    },
  });

  const blurb = el.querySelector(".imp-blurb");
  const paste = el.querySelector("[data-paste]");
  const preview = el.querySelector(".imp-preview");
  const submit = el.querySelector('button[type="submit"]');

  const setKind = async (k) => {
    current = k;
    el.querySelectorAll("[data-kind]").forEach((b) => { const on = b.dataset.kind === k; b.classList.toggle("on", on); b.setAttribute("aria-checked", String(on)); });
    blurb.textContent = KINDS[k].blurb;
    await KINDS[k].prepare?.().catch(() => {});
    run();
  };

  const run = () => {
    const text = paste.value;
    if (!text.trim()) { result = null; preview.innerHTML = ""; submit.disabled = true; return; }
    const rows = parseTable(text);
    result = check(current, rows);
    const shown = result.good.slice(0, 8);
    preview.innerHTML = `
      ${result.missing.length ? `<div class="banner bad" style="margin-top:12px">${icon("alert")}<div class="grow"><div>Missing a column: <b>${esc(result.missing.join(", "))}</b></div><div>Check the headings match the template.</div></div></div>` : ""}
      <div class="imp-sum"><span>Ready to import: ${result.good.length}</span>${result.bad.length ? ` <span class="c-bad">Will be skipped: ${result.bad.length}</span>` : ""}</div>
      ${shown.length ? `<div class="imp-table" role="table">${shown.map((g) => `<div role="row">${g.show.filter((x) => x !== undefined).map((c) => `<span role="cell">${esc(c || "")}</span>`).join("")}</div>`).join("")}
        ${result.good.length > shown.length ? `<div class="faint small" style="padding:6px 10px">And ${result.good.length - shown.length} more</div>` : ""}</div>` : ""}
      ${result.bad.length ? `<details class="imp-bad"><summary class="small">Why some rows are skipped</summary><ul>${result.bad.slice(0, 30).map((b) => `<li><span>Row ${b.line}:</span> <span>${esc(b.why)}</span></li>`).join("")}</ul></details>` : ""}
      ${result.unknown?.length ? `<p class="faint small">Ignored columns: ${esc(result.unknown.join(", "))}</p>` : ""}`;
    submit.disabled = !result.good.length;
  };

  el.querySelectorAll("[data-kind]").forEach((b) => b.addEventListener("click", () => setKind(b.dataset.kind)));
  el.querySelector("[data-template]").addEventListener("click", () => downloadTemplate(current));
  el.querySelector("[data-file]").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (/\.(xlsx|xls|numbers)$/i.test(f.name)) return toast("Save the spreadsheet as CSV first (File, Save As or Download, CSV), then choose that file.", true);
    if (f.size > 2_000_000) return toast("That file is too big. Split it into smaller files.", true);
    paste.value = await f.text();
    run();
  });
  let timer;
  paste.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 250); });
  submit.disabled = true;
  setKind(current);
  return { close };
}

export const _test = { parseTable, parseDate, check, KINDS, todayISO };
