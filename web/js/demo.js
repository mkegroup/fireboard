// In-memory demo department. Same methods as api.js, nothing leaves the device.
// A few scripted crew actions run while the board is open so it feels live.

const ME = "demo-user";
const DEPT = "demo-dept";
const now = Date.now();
const min = 60000;
let seq = 1;
const id = (p) => `${p}-${seq++}`;
const clone = (o) => JSON.parse(JSON.stringify(o));

function seed() {
  const db = {
    departments: [{
      id: DEPT, name: "Demo Fire Department", created_at: new Date(now - 9 * 86400000).toISOString(),
      invite_code: "DEMO42", scanner_url: null, scanner_label: null,
      settings: {
        equipment_locations: ["Station"],
        apparatus: [{ name: "Engine 1", kind: "Engine" }, { name: "Tanker 2", kind: "Tanker" }, { name: "Rescue 3", kind: "Rescue" }, { name: "Brush 4", kind: "Brush" }],
      },
      trial_ends_at: new Date(now + 5 * 86400000).toISOString(), subscription_status: "none",
      current_period_end: null, past_due_since: null, seat_count: 9,
      plan_interval: null, plan_invoice: false, plan_cancel_at: null, plan_amount: null, plan_custom: false,
    }],
    members: [],
    medical: [],
    incidents: [],
    personnel: [],
    apparatus: [],
    mutualAid: [],
    events: [],
    messages: [],
    reactions: [],
    reads: [],
    locations: [],
    training: [],
    attendance: [],
    equipment: [],
  };

  const roster = [
    ["Jordan MacLeod", "Captain", "owner", "Command", true, "C1"],
    ["Tess MacDonald", "Lieutenant", "officer", "Alpha", true, "L2"],
    ["Sam Riopelle", "Firefighter", "member", "Alpha", true, ""],
    ["Mike Brown", "Engineer/Driver", "member", "Bravo", true, ""],
    ["Ana Tremblay", "Firefighter", "member", "Bravo", true, ""],
    ["Chris Walsh", "Medic", "member", "Bravo", true, ""],
    ["Dan Lafleur", "Firefighter", "member", "Alpha", true, ""],
    ["Pat Nolan", "Firefighter", "member", "Charlie", true, ""],
    ["Bea Dumont", "Engineer/Driver", "member", "Charlie", true, ""],
    ["Ken Arsenault", "Firefighter", "member", "Charlie", false, ""],
    ["Lou Seguin", "Firefighter", "member", "Alpha", false, ""],
    ["Gil Villeneuve", "Safety Officer", "member", "Command", false, ""],
  ];
  for (const [name, rank, role, crew, hasAccount, cs] of roster) {
    db.members.push({
      id: id("m"), dept_id: DEPT, user_id: name === "Jordan MacLeod" ? ME : hasAccount ? id("u") : null,
      role, active: true, name, rank, call_sign: cs || null, crew, phone: hasAccount ? "613-555-01" + String(seq).padStart(2, "0") : null,
      radio: hasAccount ? String(100 + seq) : null, years: 2 + (seq % 15),
      certifications: name === "Sam Riopelle"
        ? [{ name: "NFPA 1001 Level I", date: "2023-05-12", expiry: "" }, { name: "First Aid / CPR", date: "2023-03-01", expiry: new Date(now + 40 * 86400000).toISOString().slice(0, 10) }]
        : name === "Tess MacDonald"
          ? [{ name: "NFPA 1021 Officer I", date: "2022-10-02", expiry: "" }, { name: "Pump Operations", date: "2021-06-20", expiry: "" }]
          : [],
      notes: null, ec_name: null, ec_rel: null, ec_phone: null,
      created_at: new Date(now - 9 * 86400000).toISOString(),
    });
  }
  const m = (n) => db.members.find((x) => x.name === n);
  db.medical.push({ member_id: m("Chris Walsh").id, dept_id: DEPT, blood_type: "O+", allergies: "Bee stings", conditions: "", medications: "", epipen: "Carries own" });

  // Active incident
  const inc = {
    id: "demo-inc", dept_id: DEPT, name: "Structure fire", address: "142 Mill Street", call_type: "Structure",
    status: "active", source: "dispatch", started_at: new Date(now - 23 * min).toISOString(), started_by: ME,
    closed_at: null, par_started_at: null, iocanc: null, lat: 45.4884, lng: -77.6797,
  };
  db.incidents.push(inc);
  const e1 = { id: "app-e1", incident_id: inc.id, dept_id: DEPT, name: "Engine 1", kind: "Engine", status: "On Scene", created_at: inc.started_at };
  const t2 = { id: "app-t2", incident_id: inc.id, dept_id: DEPT, name: "Tanker 2", kind: "Tanker", status: "On Scene", created_at: inc.started_at };
  const r3 = { id: "app-r3", incident_id: inc.id, dept_id: DEPT, name: "Rescue 3", kind: "Rescue", status: "Responding", created_at: inc.started_at };
  db.apparatus.push(e1, t2, r3);
  db.mutualAid.push({ id: "ma-1", incident_id: inc.id, dept_id: DEPT, name: "Barry's Bay FD", status: "Responding", notes: "Tanker, ETA 10 min", created_at: inc.started_at });

  const onBoard = [
    ["Jordan MacLeod", "Staged", null, 22],
    ["Tess MacDonald", "IN", e1.id, 18],
    ["Sam Riopelle", "IN", e1.id, 18],
    ["Mike Brown", "OUT", t2.id, 9],
    ["Ana Tremblay", "Rehab", t2.id, 5],
    ["Chris Walsh", "Staged", null, 14],
    ["Dan Lafleur", "Responding", r3.id, 3],
  ];
  for (const [n, status, app, ago] of onBoard) {
    const mem = m(n);
    db.personnel.push({
      id: id("p"), incident_id: inc.id, dept_id: DEPT, member_id: mem.id, user_id: mem.user_id, name: n,
      rank: mem.rank, crew: mem.crew, status, no_radio: n === "Chris Walsh", apparatus_id: app, mutual_aid_id: null,
      par_ack_at: null, status_changed_at: new Date(now - ago * min).toISOString(), created_at: inc.started_at,
    });
  }
  const ev = (ago, actor, kind, message) => db.events.push({ id: seq++, incident_id: inc.id, dept_id: DEPT, at: new Date(now - ago * min).toISOString(), actor, kind, message });
  ev(23, "Dispatch", "incident", "Incident created from dispatch (Structure)");
  ev(22, "Jordan MacLeod", "personnel", "Jordan MacLeod added to board (Staged)");
  ev(18, "Tess MacDonald", "status", "Tess MacDonald: Staged to IN");
  ev(18, "Sam Riopelle", "status", "Sam Riopelle: Staged to IN");
  ev(9, "Mike Brown", "status", "Mike Brown: IN to OUT");
  ev(5, "Jordan MacLeod", "status", "Ana Tremblay: OUT to Rehab");
  ev(3, "Dan Lafleur", "personnel", "Dan Lafleur added to board (Responding)");

  const msg = (ago, who, body) => {
    const mem = m(who);
    db.messages.push({ id: id("msg"), incident_id: inc.id, dept_id: DEPT, user_id: mem.user_id, sender: who, body, created_at: new Date(now - ago * min).toISOString() });
  };
  // Station chat
  const st = (ago, who, body, extra = {}) => {
    const mem = m(who);
    const row = { id: id("msg"), incident_id: null, dept_id: DEPT, user_id: mem.user_id, sender: who, kind: "text", body, mentions: [], created_at: new Date(now - ago * min).toISOString(), ...extra };
    db.messages.push(row);
    return row;
  };
  const pin = st(60 * 26, "Jordan MacLeod", "Truck checks every Tuesday at 7 pm. Training is the second and fourth Thursday.", { pinned_at: new Date(now - 60 * 26 * min).toISOString(), pinned_by: "Jordan MacLeod" });
  const q = st(60 * 3, "Tess MacDonald", "Who can cover Saturday's open house at the station? Need two people from 10 to 2.");
  st(60 * 3 - 6, "Sam Riopelle", "I can do it.", { reply_to: q.id });
  st(60 * 2, "Mike Brown", "Engine 1 pump test done. Primer is sticking again, I left a note on the board.");
  st(60 * 2 - 4, "Bea Dumont", "@Mike Brown thanks. I'll call the shop in the morning.", { mentions: [m("Mike Brown").user_id] });
  const react = (msgRow, who, emoji) => db.reactions.push({ message_id: msgRow.id, user_id: m(who).user_id, emoji, name: who, dept_id: DEPT });
  react(pin, "Tess MacDonald", "👍");
  react(pin, "Sam Riopelle", "👍");
  react(q, "Jordan MacLeod", "✅");
  db.reads.push({ thread: "station", user_id: m("Tess MacDonald").user_id, name: "Tess MacDonald", read_at: new Date(now - 60 * min).toISOString() });

  msg(17, "Tess MacDonald", "Interior crew going in side A with a 1¾.");
  msg(10, "Mike Brown", "Tanker 2 dumped, heading to the fill site.");
  msg(4, "Jordan MacLeod", "Ana to rehab. Chris, check her vitals please.");

  const base = [45.4886, -77.6794];
  const loc = (who, dlat, dlng) => {
    const mem = m(who);
    db.locations.push({ incident_id: inc.id, user_id: mem.user_id, dept_id: DEPT, name: who, lat: base[0] + dlat, lng: base[1] + dlng, accuracy: 8, updated_at: new Date(now - 1 * min).toISOString() });
  };
  loc("Tess MacDonald", 0.0001, 0.0002);
  loc("Sam Riopelle", 0.00012, 0.00025);
  loc("Mike Brown", -0.0018, 0.0021);
  loc("Chris Walsh", -0.0003, -0.0004);
  loc("Dan Lafleur", 0.009, -0.012);

  // History
  const old = (days, name, address, mins) => {
    const st = new Date(now - days * 86400000);
    const i = { id: id("inc"), dept_id: DEPT, name, address, call_type: null, status: "closed", source: "app", started_at: st.toISOString(), started_by: ME, closed_at: new Date(st.getTime() + mins * min).toISOString(), par_started_at: null, iocanc: null };
    db.incidents.push(i);
    db.events.push({ id: seq++, incident_id: i.id, dept_id: DEPT, at: i.started_at, actor: "Jordan MacLeod", kind: "incident", message: "Incident started by Jordan MacLeod" });
    db.events.push({ id: seq++, incident_id: i.id, dept_id: DEPT, at: i.closed_at, actor: "Jordan MacLeod", kind: "incident", message: "Incident closed by Jordan MacLeod" });
  };
  old(3, "Chimney fire", "88 Lake Rd", 41);
  old(8, "MVC, two vehicles", "Hwy 62 at Old Barry's Bay Rd", 74);
  old(15, "Grass fire", "Kamaniskeg Lake Rd", 55);

  // Training
  const tr = (daysAgo, title, kind, hours, instructor, who) => {
    const s = { id: id("tr"), dept_id: DEPT, title, session_date: new Date(now - daysAgo * 86400000).toISOString().slice(0, 10), location: "Station 1", kind, hours, instructor, notes: null, attendance_open: false, created_by: ME, created_at: new Date().toISOString() };
    db.training.push(s);
    for (const n of who) db.attendance.push({ session_id: s.id, member_id: m(n).id, dept_id: DEPT, self_marked: false, marked_at: s.created_at });
  };
  tr(6, "Pump operations", "Pump Operations", 3, "Tess MacDonald", ["Jordan MacLeod", "Tess MacDonald", "Mike Brown", "Bea Dumont", "Dan Lafleur"]);
  tr(13, "Live fire, acquired structure", "Live Fire", 4, "OFM instructor", ["Jordan MacLeod", "Tess MacDonald", "Sam Riopelle", "Ana Tremblay", "Dan Lafleur", "Pat Nolan"]);
  tr(20, "Vehicle extrication refresher", "Vehicle Extrication", 2.5, "Jordan MacLeod", ["Sam Riopelle", "Chris Walsh", "Mike Brown"]);

  const eq = (name, category, status, location, qty, next, serial) => db.equipment.push({
    id: id("eq"), dept_id: DEPT, name, category, status, serial: serial || null, qty, location, condition: "Good",
    last_inspected: new Date(now - 120 * 86400000).toISOString().slice(0, 10),
    next_service: next === null ? null : new Date(now + next * 86400000).toISOString().slice(0, 10),
    notes: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  eq("SCBA pack", "SCBA / Breathing", "Deployed", "Engine 1", 4, 60, "MSA-G1-2231");
  eq("SCBA spare cylinder", "SCBA / Breathing", "Available", "Station", 8, 200);
  eq("Thermal imaging camera", "Thermal Imaging", "Deployed", "Engine 1", 1, 12, "TIC-4471");
  eq("Hydraulic spreader", "Rescue Tools", "Available", "Rescue 3", 1, -4, "HUR-SP555");
  eq("Portable radio", "Communications", "Available", "Station", 6, 90);
  eq("Portable pump", "Pumping Equipment", "Out of Service", "Station", 1, null);
  eq("24 ft extension ladder", "Ladders", "Available", "Engine 1", 1, 150);
  eq("AED", "Medical / EMS", "Available", "Rescue 3", 1, 25);
  return db;
}

export function createDemoApi() {
  let db = seed();
  const subs = new Set();
  const notify = (table, payload) => subs.forEach((s) => s(table, payload));
  const me = () => db.members.find((x) => x.user_id === ME);
  const dept = () => db.departments[0];
  const log = (incident_id, kind, message, actor) => {
    db.events.unshift({ id: seq++, incident_id, dept_id: DEPT, at: new Date().toISOString(), actor: actor ?? me().name, kind, message });
  };
  const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));
  let timers = [];

  // Scripted crew activity while a board is open.
  function startScript(incidentId) {
    stopScript();
    const p = (n) => db.personnel.find((x) => x.incident_id === incidentId && x.name === n);
    const steps = [
      [12000, () => { const x = p("Dan Lafleur"); if (x && x.status === "Responding") { setStatus(x, "Staged", "Dan Lafleur"); } }],
      [26000, () => say("Chris Walsh", "Ana's vitals are good. Holding her in rehab 10 more min.")],
      [45000, () => { const r = db.apparatus.find((a) => a.id === "app-r3"); if (r && r.status === "Responding") { r.status = "On Scene"; log(incidentId, "unit", "Apparatus Rescue 3: Responding to On Scene", "Dan Lafleur"); notify("incident_apparatus"); } }],
      [70000, () => say("Tess MacDonald", "Primary search complete, all clear on floor 1.")],
    ];
    for (const [ms, fn] of steps) timers.push(setTimeout(fn, ms));
  }
  function stopScript() { timers.forEach(clearTimeout); timers = []; }
  function setStatus(row, status, actor) {
    log(row.incident_id, status === "MISSING" ? "missing" : "status", `${row.name}: ${row.status} to ${status}`, actor);
    row.status = status;
    row.status_changed_at = new Date().toISOString();
    notify("incident_personnel");
  }
  function say(who, body) {
    const mem = db.members.find((x) => x.name === who);
    const row = { id: id("msg"), incident_id: "demo-inc", dept_id: DEPT, user_id: mem?.user_id, sender: who, kind: "text", body, mentions: [], created_at: new Date().toISOString() };
    db.messages.push(row);
    notify("incident_messages", { eventType: "INSERT", new: clone(row) });
  }

  const api = {
    isDemo: true,
    reset() { stopScript(); db = seed(); },

    async getSession() { return { user: { id: ME, email: "demo@firegroundboard.app" } }; },
    onAuth() { return { data: { subscription: { unsubscribe() {} } } }; },
    async signOut() { stopScript(); },
    async deleteAccount() { throw new Error("Not available in the demo."); },

    async myDepartments() { await wait(); return [{ dept: clone(dept()), member: clone(me()) }]; },
    async getDepartment() { return clone(dept()); },
    async createDepartment() { throw new Error("Not available in the demo."); },
    async joinDepartment() { throw new Error("Not available in the demo."); },
    async leaveDepartment() { throw new Error("Not available in the demo."); },
    async updateDepartment(_id, patch) { Object.assign(dept(), patch); },
    async regenerateInvite() { dept().invite_code = Math.random().toString(36).slice(2, 8).toUpperCase(); return dept().invite_code; },
    async getDispatchToken() { return "demo0000000000000000000000000000000000000000000000000000000000"; },
    async regenerateDispatchToken() { return api.getDispatchToken(); },
    dispatchUrl() { return "https://your-project.supabase.co/functions/v1/dispatch"; },
    async getIntegrations() {
      db.integrations ??= { dispatch_token: "demo0000000000000000000000000000000000000000000000000000000000", inbox_code: "demo42calls0", calendar_token: "demo1111111111111111111111111111111111111111111111111111111111", chat_webhook_url: null, chat_events: ["incident", "par", "missing"], inbox_allow_from: null };
      return clone(db.integrations);
    },
    async setIntegrations(_d, v) { await api.getIntegrations(); Object.assign(db.integrations, { chat_webhook_url: v.chat_webhook_url || null, chat_events: v.chat_events || db.integrations.chat_events, inbox_allow_from: v.inbox_allow_from || null }); },
    async regenerateIntegration() { throw new Error("Not available in the demo."); },
    async listDispatchInbox() {
      const t = (m) => new Date(Date.now() - m * 60000).toISOString();
      return [
        { id: 3, at: t(23), channel: "email", sender: "County Dispatch <dispatch@county.on.ca>", subject: "STRUCTURE FIRE - 142 MILL ST", excerpt: "CALL: STRUCTURE FIRE ADDR: 142 MILL ST CITY: COMBERMERE UNITS: E1,T2", outcome: "created", incident_id: db.incidents.find((i) => i.status === "active")?.id ?? null, confirm_url: null },
        { id: 2, at: t(26), channel: "email", sender: "County Dispatch <dispatch@county.on.ca>", subject: "STRUCTURE FIRE - 142 MILL ST", excerpt: "Repeat page", outcome: "duplicate", incident_id: null, confirm_url: null },
        { id: 1, at: t(60 * 24 * 3), channel: "email", sender: "Gmail Team <forwarding-noreply@google.com>", subject: "(#123456789) Gmail Forwarding Confirmation", excerpt: "", outcome: "confirmation", incident_id: null, confirm_url: "https://mail-settings.google.com/mail/vf-demo" },
      ];
    },
    async testChat() { throw new Error("Not available in the demo."); },
    calendarUrl(token) { return `https://your-project.supabase.co/functions/v1/calendar?token=${token}`; },
    async setLanguage() {},

    async listMembers() { await wait(); return clone(db.members.filter((x) => x.active).sort((a, b) => a.name.localeCompare(b.name))); },
    async addRosterEntry(_d, data) { const row = { id: id("m"), dept_id: DEPT, user_id: null, role: "member", active: true, certifications: [], created_at: new Date().toISOString(), ...data }; db.members.push(row); return clone(row); },
    async updateMember(mid, patch) { Object.assign(db.members.find((x) => x.id === mid), patch); },
    async importRoster(_d, people) {
      let n = 0;
      for (const p of people) {
        if (db.members.some((x) => x.active && x.name.toLowerCase() === p.name.toLowerCase())) continue;
        db.members.push({ id: id("m"), dept_id: DEPT, user_id: null, role: "member", active: true, certifications: [], created_at: new Date().toISOString(), rank: "Firefighter", crew: null, phone: null, ...p });
        n++;
      }
      return n;
    },
    async importTraining(_d, sessions) {
      let n = 0, att = 0; const unmatched = [];
      for (const s of sessions) {
        if (!s.title) continue;
        const row = { id: id("t"), dept_id: DEPT, title: s.title, session_date: s.session_date || new Date().toISOString().slice(0, 10), kind: s.kind || null, hours: s.hours ? Number(s.hours) : null, location: s.location || null, instructor: s.instructor || null, notes: s.notes || null, attendance_open: false, created_at: new Date().toISOString() };
        db.training.push(row); n++;
        for (const who of s.attendees || []) {
          const m = db.members.find((x) => x.active && x.name.toLowerCase() === who.toLowerCase());
          if (!m) { if (!unmatched.includes(who)) unmatched.push(who); continue; }
          db.attendance.push({ session_id: row.id, member_id: m.id, dept_id: DEPT, self_marked: false }); att++;
        }
      }
      notify("training_sessions");
      return { sessions: n, attendance: att, unmatched };
    },
    async importEquipment(_d, items) {
      let n = 0;
      for (const e of items) { if (!e.name) continue; db.equipment.push({ id: id("e"), dept_id: DEPT, status: "Available", qty: 1, ...e, qty: Math.max(1, parseInt(e.qty, 10) || 1) }); n++; }
      return n;
    },
    async deleteRosterEntry(mid) { db.members = db.members.filter((x) => x.id !== mid); },
    async listRemoved() { return []; },
    async allowBack() {},
    async invitePreview() { return "Demo Fire Department"; },
    async setRole(mid, role) { db.members.find((x) => x.id === mid).role = role; },
    async removeMember(mid) { db.members.find((x) => x.id === mid).active = false; },
    async getMedical(mid) { return clone(db.medical.find((x) => x.member_id === mid) || null); },
    async saveMedical(mid, _d, data) {
      const row = db.medical.find((x) => x.member_id === mid);
      if (row) Object.assign(row, data); else db.medical.push({ member_id: mid, dept_id: DEPT, ...data });
    },

    async listIncidents(_d, { status } = {}) {
      await wait();
      return clone(db.incidents.filter((i) => !status || i.status === status).sort((a, b) => b.started_at.localeCompare(a.started_at)));
    },
    async startIncident(_d, { name, address, call_type }) {
      const inc = { id: id("inc"), dept_id: DEPT, name, address: address || null, call_type: call_type || null, status: "active", source: "app", started_at: new Date().toISOString(), started_by: ME, closed_at: null, par_started_at: null, iocanc: null };
      db.incidents.push(inc);
      log(inc.id, "incident", `Incident started by ${me().name}`);
      db.personnel.push({ id: id("p"), incident_id: inc.id, dept_id: DEPT, member_id: me().id, user_id: ME, name: me().name, rank: me().rank, crew: "Command", status: "Staged", no_radio: false, apparatus_id: null, mutual_aid_id: null, par_ack_at: null, status_changed_at: inc.started_at, created_at: inc.started_at });
      notify("incidents");
      return inc.id;
    },
    async closeIncident(iid) {
      const inc = db.incidents.find((i) => i.id === iid);
      inc.status = "closed"; inc.closed_at = new Date().toISOString(); inc.par_started_at = null;
      db.locations = db.locations.filter((l) => l.incident_id !== iid);
      log(iid, "incident", `Incident closed by ${me().name}`);
      if (iid === "demo-inc") stopScript();
      notify("incidents");
    },
    async updateIncident(iid, patch) { Object.assign(db.incidents.find((i) => i.id === iid), patch); notify("incidents"); },
    async incidentState(iid) {
      await wait(80);
      const f = (arr) => clone(arr.filter((x) => x.incident_id === iid));
      const incident = db.incidents.find((i) => i.id === iid);
      if (!incident) throw new Error("Incident not found");
      return {
        incident: clone(incident),
        personnel: f(db.personnel),
        apparatus: f(db.apparatus),
        mutualAid: f(db.mutualAid),
        events: f(db.events).sort((a, b) => b.at.localeCompare(a.at)),
        messages: f(db.messages),
        locations: f(db.locations),
      };
    },
    async joinIncident(iid) {
      const ex = db.personnel.find((p) => p.incident_id === iid && p.member_id === me().id);
      if (ex) return ex.id;
      const row = { id: id("p"), incident_id: iid, dept_id: DEPT, member_id: me().id, user_id: ME, name: me().name, rank: me().rank, crew: me().crew, status: "Responding", no_radio: false, apparatus_id: null, mutual_aid_id: null, par_ack_at: null, status_changed_at: new Date().toISOString(), created_at: new Date().toISOString() };
      db.personnel.push(row);
      log(iid, "personnel", `${row.name} added to board (Responding)`);
      notify("incident_personnel");
      return row.id;
    },
    async addPersonnel(iid, { member_id, name, rank, crew, status, no_radio, mutual_aid_id }) {
      const mem = member_id ? db.members.find((x) => x.id === member_id) : null;
      if (mem) { const ex = db.personnel.find((p) => p.incident_id === iid && p.member_id === mem.id); if (ex) return ex.id; }
      const row = { id: id("p"), incident_id: iid, dept_id: DEPT, member_id: mem?.id || null, user_id: mem?.user_id || null, name: mem?.name || name, rank: rank || mem?.rank || "Firefighter", crew: crew || mem?.crew || null, status: status || "Responding", no_radio: !!no_radio, apparatus_id: null, mutual_aid_id: mutual_aid_id || null, par_ack_at: null, status_changed_at: new Date().toISOString(), created_at: new Date().toISOString() };
      db.personnel.push(row);
      log(iid, "personnel", `${row.name} added to board (${row.status})`);
      notify("incident_personnel");
      return row.id;
    },
    async updatePersonnel(pid, patch) {
      const row = db.personnel.find((p) => p.id === pid);
      if (patch.status && patch.status !== row.status) setStatus(row, patch.status);
      if ("apparatus_id" in patch && patch.apparatus_id !== row.apparatus_id) {
        const a = db.apparatus.find((x) => x.id === patch.apparatus_id);
        log(row.incident_id, "apparatus", `${row.name} assigned to ${a ? a.name : "no apparatus"}`);
      }
      const { status, ...rest } = patch;
      Object.assign(row, rest);
      notify("incident_personnel");
    },
    async removePersonnel(pid) {
      const row = db.personnel.find((p) => p.id === pid);
      db.personnel = db.personnel.filter((p) => p.id !== pid);
      log(row.incident_id, "personnel", `${row.name} removed from board`);
      notify("incident_personnel");
    },
    async startPar(iid) {
      const inc = db.incidents.find((i) => i.id === iid);
      inc.par_started_at = new Date().toISOString();
      db.personnel.filter((p) => p.incident_id === iid).forEach((p) => { p.par_ack_at = null; });
      log(iid, "par", "PAR check called");
      notify("incidents");
      // Crew confirm over the next few seconds. One interior firefighter is slow, on purpose.
      const crew = db.personnel.filter((p) => p.incident_id === iid && p.user_id !== ME && p.status !== "OUT");
      crew.forEach((p, i) => {
        if (p.name === "Sam Riopelle") return;
        timers.push(setTimeout(() => {
          if (!inc.par_started_at || p.par_ack_at) return;
          p.par_ack_at = new Date().toISOString();
          log(iid, "par", `${p.name} PAR confirmed`, p.name);
          notify("incident_personnel");
        }, 2500 + i * 1800));
      });
    },
    async endPar(iid) {
      const inc = db.incidents.find((i) => i.id === iid);
      const rows = db.personnel.filter((p) => p.incident_id === iid && p.status !== "OUT");
      log(iid, "par", `PAR closed: ${rows.filter((p) => p.par_ack_at).length} of ${rows.length} confirmed`);
      inc.par_started_at = null;
      notify("incidents");
    },
    async ackPar(pid) {
      const row = db.personnel.find((p) => p.id === pid);
      if (!row.par_ack_at) { row.par_ack_at = new Date().toISOString(); log(row.incident_id, "par", `${row.name} PAR confirmed`); }
      notify("incident_personnel");
    },
    async addApparatus(iid, { name, kind, status }) {
      db.apparatus.push({ id: id("app"), incident_id: iid, dept_id: DEPT, name, kind: kind || null, status: status || "Responding", created_at: new Date().toISOString() });
      log(iid, "unit", `Apparatus ${name} added (${status || "Responding"})`);
      notify("incident_apparatus");
    },
    async updateApparatus(aid, patch) {
      const a = db.apparatus.find((x) => x.id === aid);
      if (patch.status && patch.status !== a.status) log(a.incident_id, "unit", `Apparatus ${a.name}: ${a.status} to ${patch.status}`);
      Object.assign(a, patch); notify("incident_apparatus");
    },
    async removeApparatus(aid) {
      const a = db.apparatus.find((x) => x.id === aid);
      db.apparatus = db.apparatus.filter((x) => x.id !== aid);
      db.personnel.forEach((p) => { if (p.apparatus_id === aid) p.apparatus_id = null; });
      log(a.incident_id, "unit", `Apparatus ${a.name} removed`);
      notify("incident_apparatus");
    },
    async addMutualAid(iid, { name, status, notes }) {
      db.mutualAid.push({ id: id("ma"), incident_id: iid, dept_id: DEPT, name, status: status || "Requested", notes: notes || null, created_at: new Date().toISOString() });
      log(iid, "unit", `Mutual aid ${name} added (${status || "Requested"})`);
      notify("incident_mutual_aid");
    },
    async updateMutualAid(mid, patch) {
      const a = db.mutualAid.find((x) => x.id === mid);
      if (patch.status && patch.status !== a.status) log(a.incident_id, "unit", `Mutual aid ${a.name}: ${a.status} to ${patch.status}`);
      Object.assign(a, patch); notify("incident_mutual_aid");
    },
    async removeMutualAid(mid) {
      const a = db.mutualAid.find((x) => x.id === mid);
      db.mutualAid = db.mutualAid.filter((x) => x.id !== mid);
      log(a.incident_id, "unit", `Mutual aid ${a.name} removed`);
      notify("incident_mutual_aid");
    },
    async logNote(iid, message) { log(iid, "note", message); notify("incident_events"); },
    async sendMessage(iid, body) { return api.sendChat(DEPT, iid, { kind: "text", body }); },

    // ---------------- owner's console ----------------
    async isPlatformAdmin() { try { return sessionStorage.getItem("fgb_demo_admin") === "1"; } catch { return false; } },
    ...demoAdmin(),
    sweepAlerts() { return Promise.resolve(null); },
    async requestQuote() { await wait(300); },

    // ---------------- chat ----------------
    async setChatAlerts(mid, on) { const x = db.members.find((y) => y.id === mid); if (x) x.chat_alerts = !!on; },
    async listChat(_d, iid) {
      await wait();
      const msgs = db.messages.filter((x) => (iid ? x.incident_id === iid : x.incident_id == null))
        .map((x) => ({ kind: "text", mentions: [], ...x })).sort((a, b) => a.created_at.localeCompare(b.created_at));
      const ids = new Set(msgs.map((x) => x.id));
      return { messages: clone(msgs), reactions: clone(db.reactions.filter((r) => ids.has(r.message_id))), reads: clone(db.reads.filter((r) => r.thread === (iid || "station"))) };
    },
    async sendChat(_d, iid, msg) {
      await wait(150);
      const row = { id: id("msg"), incident_id: iid || null, dept_id: DEPT, user_id: ME, sender: me().name, kind: msg.kind || "text", body: msg.body || "",
        media_path: msg.media_path || null, media_seconds: msg.media_seconds ?? null, media_w: msg.media_w ?? null, media_h: msg.media_h ?? null,
        lat: msg.lat ?? null, lng: msg.lng ?? null, reply_to: msg.reply_to || null, mentions: msg.mentions || [], created_at: new Date().toISOString() };
      db.messages.push(row);
      notify("incident_messages", { eventType: "INSERT", new: clone(row) });
      return clone(row);
    },
    async uploadChatFile(_d, blob) { await wait(300); return URL.createObjectURL(blob); },
    async chatFileUrls(paths) { return Object.fromEntries(paths.map((p) => [p, p])); },
    async editChat(mid, body) { const x = db.messages.find((y) => y.id === mid); if (x) { x.body = body; x.edited_at = new Date().toISOString(); notify("incident_messages", { eventType: "UPDATE", new: clone(x) }); } },
    async deleteChat(mid) {
      const x = db.messages.find((y) => y.id === mid);
      if (!x) return;
      Object.assign(x, { body: "", media_path: null, lat: null, lng: null, deleted_at: new Date().toISOString(), pinned_at: null, pinned_by: null });
      db.reactions = db.reactions.filter((r) => r.message_id !== mid);
      notify("incident_messages", { eventType: "UPDATE", new: clone(x) });
    },
    async pinChat(mid, on) { const x = db.messages.find((y) => y.id === mid); if (x) { x.pinned_at = on ? new Date().toISOString() : null; x.pinned_by = on ? me().name : null; notify("incident_messages", { eventType: "UPDATE", new: clone(x) }); } },
    async react(mid, emoji, on) {
      db.reactions = db.reactions.filter((r) => !(r.message_id === mid && r.user_id === ME && r.emoji === emoji));
      const row = { message_id: mid, user_id: ME, emoji, name: me().name, dept_id: DEPT };
      if (on) db.reactions.push(row);
      notify("chat_reactions", on ? { eventType: "INSERT", new: row } : { eventType: "DELETE", old: row });
    },
    async markChatRead() {},
    subscribeChat(_d, iid, cb) {
      const fn = (table, p) => {
        if (!p) return;
        if (table === "incident_messages") { const r = p.new || p.old; if ((r?.incident_id ?? null) === (iid || null)) cb("message", p); }
        else if (table === "chat_reactions") cb("reaction", p);
      };
      subs.add(fn);
      return { off: () => subs.delete(fn), typing() {} };
    },
    subscribeStation(_d, cb) {
      const fn = (table, p) => { if (table === "incident_messages" && p?.eventType === "INSERT" && p.new.incident_id == null) cb(p.new); };
      subs.add(fn);
      return () => subs.delete(fn);
    },
    async lastStationMessage() {
      const s = db.messages.filter((x) => x.incident_id == null).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
      return s ? { created_at: s.created_at, user_id: s.user_id } : null;
    },
    async shareLocation(iid, { lat, lng, accuracy }) {
      db.locations = db.locations.filter((l) => !(l.incident_id === iid && l.user_id === ME));
      db.locations.push({ incident_id: iid, user_id: ME, dept_id: DEPT, name: me().name, lat, lng, accuracy, updated_at: new Date().toISOString() });
      notify("incident_locations");
    },
    async stopLocation(iid) {
      db.locations = db.locations.filter((l) => !(l.incident_id === iid && l.user_id === ME));
      notify("incident_locations");
    },
    subscribeIncident(iid, cb) {
      const fn = (table) => cb(table, {});
      subs.add(fn);
      if (iid === "demo-inc" && db.incidents.find((i) => i.id === iid)?.status === "active") startScript(iid);
      return () => { subs.delete(fn); stopScript(); };
    },
    subscribeDepartment(_d, cb) {
      const fn = (table) => { if (["incidents", "training_sessions", "training_attendance"].includes(table)) cb(table, {}); };
      subs.add(fn);
      return () => subs.delete(fn);
    },

    async listTraining() { await wait(); return clone(db.training.sort((a, b) => b.session_date.localeCompare(a.session_date))); },
    async listAttendance() { return clone(db.attendance); },
    async saveTraining(_d, data, tid) {
      if (tid) { const s = db.training.find((x) => x.id === tid); Object.assign(s, data); notify("training_sessions"); return clone(s); }
      const s = { id: id("tr"), dept_id: DEPT, attendance_open: false, created_by: ME, created_at: new Date().toISOString(), ...data };
      db.training.push(s); notify("training_sessions"); return clone(s);
    },
    async deleteTraining(tid) { db.training = db.training.filter((x) => x.id !== tid); db.attendance = db.attendance.filter((a) => a.session_id !== tid); notify("training_sessions"); },
    async setAttendance(sid, mid, present) {
      db.attendance = db.attendance.filter((a) => !(a.session_id === sid && a.member_id === mid));
      if (present) db.attendance.push({ session_id: sid, member_id: mid, dept_id: DEPT, self_marked: false, marked_at: new Date().toISOString() });
      notify("training_attendance");
    },
    async selfMarkAttendance(sid) { return api.setAttendance(sid, me().id, true); },

    async listEquipment() { await wait(); return clone(db.equipment.sort((a, b) => a.name.localeCompare(b.name))); },
    async saveEquipment(_d, data, eid) {
      if (eid) { const e = db.equipment.find((x) => x.id === eid); Object.assign(e, data); return clone(e); }
      const e = { id: id("eq"), dept_id: DEPT, created_at: new Date().toISOString(), ...data }; db.equipment.push(e); return clone(e);
    },
    async deleteEquipment(eid) { db.equipment = db.equipment.filter((x) => x.id !== eid); },

    async billing() { throw new Error("Billing is not available in the demo."); },
    async syncSeats() { return {}; },
    async notify() {},
  };
  return api;
}

// Made-up numbers for previewing the owner's console in demo mode (/?demo then sessionStorage fgb_demo_admin=1).
function demoAdmin() {
  const day = 86400000;
  const iso = (d) => new Date(Date.now() - d * day).toISOString();
  const depts = [
    ["Combermere VFD", "paying", "month", 79.92, 8, 2, "chief@combermere.ca", 41],
    ["Madawaska Valley Fire", "paying", "year", 1299.87, 13, 0.3, "fd@madawaskavalley.ca", 30],
    ["Killaloe Hagarty Richards FD", "plan_set", "month", 59.94, 6, 5, "kfd@khr.ca", 6],
    ["Bonnechere Valley FD", "trial", null, null, 4, 1, "bvfd@bonnechere.ca", 5],
    ["Brudenell Lyndoch Raglan FD", "trial", null, null, 2, 3, "chief@blr.ca", 2],
    ["North Algona Wilberforce FD", "expired", null, null, 3, 12, "nawfd@nalgona.ca", 9],
    ["Arnprior Fire", "overdue", "month", 139.86, 14, 1, "fire@arnprior.ca", 45],
  ].map(([name, stage, interval, amount, seats, seen, email, age], i) => ({
    id: `adm-${i}`, name, stage, plan_interval: interval, plan_amount: amount, seat_count: seats, owner_email: email,
    subscription_status: { paying: "active", plan_set: "trialing", trial: "none", expired: "none", overdue: "past_due" }[stage],
    mrr: amount == null ? 0 : interval === "year" ? Math.round((amount / 12) * 100) / 100 : amount,
    created_at: iso(age), trial_ends_at: iso(age - 7), last_seen: iso(seen), last_incident: iso(seen + 1), incidents_30d: 3 + i * 2, roster: seats + 4,
    stripe_customer_id: amount ? `cus_demo${i}` : null, stripe_subscription_id: amount ? `sub_demo${i}` : null, plan_custom: false, plan_invoice: i === 1, plan_cancel_at: null,
  }));
  const ev = [
    [0.02, "quote", "Quote request: Renfrew County", "Stations: 17, people: 410. Budget timing: January.", null],
    [0.1, "payment", "Payment received: Combermere VFD", "$79.92 CAD by card", 79.92],
    [0.4, "signup", "New sign-up", "captain@bonnechere.ca", null],
    [0.5, "member_joined", "Sam Riopelle joined Bonnechere Valley FD", null, null],
    [1, "past_due", "Payment overdue: Arnprior Fire", "The last payment did not go through. The board keeps working for 14 days.", null],
    [1.2, "trial_ending", "Trial ends tomorrow: Bonnechere Valley FD", "4 people use the app. A quick call could close it.", null],
    [2, "department", "New department: Brudenell Lyndoch Raglan FD", "chief@blr.ca. Free trial ends Nov 16.", null],
    [5, "plan", "Plan chosen: Killaloe Hagarty Richards FD", "Billing starts when the trial ends. $59.94 a month", 59.94],
    [9, "trial_ended", "Trial ended with no plan: North Algona Wilberforce FD", "3 people use the app. Worth a follow-up.", null],
    [12, "payment", "Payment received: Madawaska Valley Fire", "$1,299.87 CAD by invoice", 1299.87],
  ].map(([d, kind, title, detail, amount], i) => ({ id: 100 - i, at: iso(d), kind, title, detail, amount, dept_id: null, meta: {} }));
  const weeks = Array.from({ length: 12 }, (_, i) => ({ week: iso((11 - i) * 7).slice(0, 10), users: [2, 3, 1, 6, 4, 9, 7, 12, 8, 15, 11, 14][i], departments: [0, 1, 0, 1, 1, 0, 2, 1, 0, 1, 2, 1][i], incidents: [3, 5, 4, 9, 7, 11, 14, 12, 18, 16, 21, 24][i] }));
  const months = Array.from({ length: 12 }, (_, i) => ({ month: iso((11 - i) * 30).slice(0, 7), collected: [0, 0, 0, 0, 0, 0, 0, 0, 0, 79.92, 1379.79, 219.78][i] }));
  return {
    async adminOverview() {
      return { mrr: 327.10, mrr_pending: 59.94, collected_30d: 1599.57, collected_all: 1679.49, departments: depts.length,
        stages: { paying: 2, overdue: 1, plan_set: 1, trial: 2, expired: 1 }, users: 64, users_new_7d: 14, users_active_7d: 41, seats: 50,
        incidents_7d: 24, incidents_30d: 79, incidents_active: 1, incidents_from_dispatch_30d: 31, messages_7d: 212, phones: 38, weeks, months,
        attention: [
          { dept_id: null, name: "Quote request: Renfrew County", why: "quote", at: iso(0.02) },
          { dept_id: "adm-6", name: "Arnprior Fire", why: "overdue", at: iso(1) },
          { dept_id: "adm-3", name: "Bonnechere Valley FD", why: "trial_ending", at: iso(-1) },
          { dept_id: "adm-5", name: "North Algona Wilberforce FD", why: "trial_ended", at: iso(9) },
        ] };
    },
    async adminDepartments(q) { return depts.filter((d) => !q || d.name.toLowerCase().includes(q.toLowerCase()) || d.owner_email.includes(q)); },
    async adminDepartment(id) {
      const d = depts.find((x) => x.id === id) || depts[0];
      return { dept: { ...d, current_period_end: iso(-20), invite_code: "ABC123" },
        members: [{ name: "Chief Owner", rank: "Chief", role: "owner", email: d.owner_email, last_seen: d.last_seen, joined: d.created_at }, { name: "Tess MacDonald", rank: "Lieutenant", role: "officer", email: "tess@example.ca", last_seen: iso(3), joined: d.created_at }],
        incidents: [{ name: "Structure fire", address: "142 Mill St", status: "closed", source: "email", started_at: iso(2), closed_at: iso(1.9) }],
        events: ev.slice(1, 4), usage: { incidents_total: 37, messages_30d: 88, training_sessions: 6, equipment: 41, phones: 9, group_chat: true, dispatch_30d: 12 } };
    },
    async adminEvents(before, kind) { return ev.filter((e) => (!kind || e.kind === kind) && (!before || e.id < before)); },
    async adminUsers(q) {
      return depts.map((d, i) => ({ id: `u${i}`, email: d.owner_email, created_at: d.created_at, last_sign_in_at: d.last_seen, has_iphone: i % 2 === 0,
        departments: [{ dept_id: d.id, name: d.name, role: "owner", member: "Chief" }] })).filter((u) => !q || u.email.includes(q));
    },
    async adminExtendTrial(_id, days) { return new Date(Date.now() + days * day).toISOString(); },
    async adminSettings() { return { alerts: ["signup", "department", "plan", "payment", "past_due", "canceled", "cancel_scheduled", "quote", "trial_ending", "trial_ended", "error", "test"], phones: 1 }; },
    async adminSetAlerts() {},
    async adminTestAlert() {},
  };
}
