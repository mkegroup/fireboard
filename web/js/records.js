// Department records: roster profiles, training, equipment.
import { S, RANKS, CREWS, TRAINING_TYPES, EQUIP_STATUSES, EQUIP_CATEGORIES, CONDITIONS, BLOOD_TYPES, isOfficer, hasAccess } from "./state.js";
import { esc, initials, colorFor, dateLabel, formData, download, csv, slug, todayISO, friendlyError, daysUntil, parseRoster } from "./util.js";
import { icon, toast, openSheet, confirmSheet, field, input, select, textarea } from "./ui.js";
import { bindActions, bottomNav, demoStrip, accessBanner } from "./app.js";

const canEdit = () => isOfficer() && hasAccess();

export function recordsView(root, tab) {
  let alive = true;
  let data = { members: [], training: [], attendance: [], equipment: [] };
  let q = "";
  let eqFilter = "all";

  async function load() {
    const [members, training, attendance, equipment] = await Promise.all([
      S.api.listMembers(S.dept.id),
      S.api.listTraining(S.dept.id),
      S.api.listAttendance(S.dept.id),
      S.api.listEquipment(S.dept.id),
    ]);
    if (!alive) return;
    data = { members, training, attendance, equipment };
    paint();
  }

  function paint() {
    root.innerHTML = `
    ${demoStrip()}
    <div class="screen with-nav">
      <header class="topbar"><div class="wrap">
        <div class="topbar-in"><h1>Records</h1>
          <button class="iconbtn" data-act="export" aria-label="Export ${tab}">${icon("download")}</button>
          ${canEdit() ? `<button class="btn sm primary" data-act="add">${icon("plus", "sm")} ${tab === "roster" ? "Add person" : tab === "training" ? "Log training" : "Add item"}</button>` : ""}
        </div>
        <nav class="views" style="border:0">
          ${[["roster", "Roster"], ["training", "Training"], ["equipment", "Equipment"]].map(([k, l]) => `<a href="#/records/${k}" role="tab" aria-selected="${tab === k}" class="${tab === k ? "on" : ""}">${l}</a>`).join("")}
        </nav>
      </div></header>
      <div class="wrap" style="padding-top:14px;padding-bottom:30px">
        ${accessBanner()}
        ${tab === "roster" ? rosterHtml() : tab === "training" ? trainingHtml() : equipmentHtml()}
      </div>
    </div>
    ${bottomNav("records")}`;
    const s = root.querySelector("[data-search]");
    if (s) {
      s.addEventListener("input", (e) => { q = e.target.value; const pos = e.target.selectionStart; paint(); const n = root.querySelector("[data-search]"); n.focus(); n.setSelectionRange(pos, pos); });
    }
  }

  // ---------------- roster ----------------
  function hoursFor(memberId) {
    const ids = new Set(data.attendance.filter((a) => a.member_id === memberId).map((a) => a.session_id));
    return data.training.filter((t) => ids.has(t.id)).reduce((s, t) => s + Number(t.hours || 0), 0);
  }

  function certFlags(m) {
    const certs = m.certifications || [];
    const left = (c) => daysUntil(c.expiry + "T12:00:00");
    const expired = certs.filter((c) => c.expiry && left(c) < 0).length;
    const soon = certs.filter((c) => c.expiry && left(c) >= 0 && left(c) <= 60).length;
    return `${expired ? `<span class="pill bad">${expired} expired</span>` : ""}${soon ? `<span class="pill warn">${soon} expiring</span>` : ""}`;
  }

  function rosterHtml() {
    const list = data.members.filter((m) => !q || m.name.toLowerCase().includes(q.toLowerCase()));
    return `
      <input class="input" data-search placeholder="Search ${data.members.length} people" value="${esc(q)}" style="margin:12px 0" autocomplete="off">
      ${list.length ? `<div class="list">${list.map((m) => `
        <button class="row" data-act="member" data-id="${m.id}">
          <div class="avatar" style="background:${colorFor(m.name)}">${esc(initials(m.name))}</div>
          <div class="grow">
            <div class="title">${esc(m.name)}</div>
            <div class="meta">${esc([m.rank, m.crew, m.call_sign].filter(Boolean).join(", "))}${m.user_id ? "" : ", no app"}</div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
            <span class="faint small">${hoursFor(m.id)}h training</span>
            <span style="display:flex;gap:4px">${certFlags(m)}</span>
          </div>
        </button>`).join("")}</div>` : `<div class="empty"><p>No one matches that search.</p></div>`}
      <p class="hint">Everyone who joins with the invite code shows up here. Add people who don't use the app so they can go on the board and in training records. They're free.</p>`;
  }

  // ---------------- training ----------------
  function trainingHtml() {
    if (!data.training.length) {
      return `<div class="empty"><div class="h3">No training logged</div><p>Log a session, then take attendance or let crew tap "I was there".</p>${canEdit() ? '<button class="btn primary" data-act="add">Log training</button>' : ""}</div>`;
    }
    const total = data.training.reduce((s, t) => s + Number(t.hours || 0), 0);
    return `
      <p class="muted small" style="margin:12px 0">${data.training.length} sessions, ${total} hours logged</p>
      <div class="list">${data.training.map((t) => {
        const att = data.attendance.filter((a) => a.session_id === t.id);
        const mine = att.some((a) => a.member_id === S.me.id);
        return `<button class="row" data-act="session" data-id="${t.id}">
          <div class="grow">
            <div class="title">${esc(t.title)}</div>
            <div class="meta">${dateLabel(t.session_date + "T12:00:00")}${t.kind ? `, ${esc(t.kind)}` : ""}${t.hours ? `, ${Number(t.hours)}h` : ""}</div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
            ${t.attendance_open ? '<span class="pill live">Attendance open</span>' : ""}
            <span class="faint small">${att.length} attended${mine ? ", incl. you" : ""}</span>
          </div>
        </button>`;
      }).join("")}</div>`;
  }

  function sessionSheet(t) {
    const att = new Set(data.attendance.filter((a) => a.session_id === t.id).map((a) => a.member_id));
    const mine = att.has(S.me.id);
    const { el, close } = openSheet({
      title: t.title,
      body: `
        <dl class="kv">
          <dt>Date</dt><dd>${dateLabel(t.session_date + "T12:00:00")}</dd>
          ${t.kind ? `<dt>Type</dt><dd>${esc(t.kind)}</dd>` : ""}
          ${t.hours ? `<dt>Hours</dt><dd>${Number(t.hours)}</dd>` : ""}
          ${t.location ? `<dt>Location</dt><dd>${esc(t.location)}</dd>` : ""}
          ${t.instructor ? `<dt>Instructor</dt><dd>${esc(t.instructor)}</dd>` : ""}
        </dl>
        ${t.notes ? `<p style="margin-top:12px;white-space:pre-wrap">${esc(t.notes)}</p>` : ""}
        ${t.attendance_open && !mine && hasAccess() ? `<button type="button" class="btn primary block" style="margin-top:16px" data-self>I was there</button>` : ""}
        <div class="section-head section"><div class="h3">Attendance (${att.size})</div>
          ${canEdit() ? `<button type="button" class="btn sm" data-toggle-open>${t.attendance_open ? "Close self check-in" : "Let crew check in"}</button>` : ""}</div>
        ${canEdit() ? `<div class="list">${data.members.map((m) => `
          <label class="row check" style="padding:8px 14px;min-height:52px"><input type="checkbox" data-mem="${m.id}" ${att.has(m.id) ? "checked" : ""}><span class="grow">${esc(m.name)}</span><span class="faint small">${esc(m.rank)}</span></label>`).join("")}</div>`
          : `<p class="muted">${data.members.filter((m) => att.has(m.id)).map((m) => esc(m.name)).join(", ") || "No one marked yet."}</p>`}
        ${canEdit() ? `<div class="btn-row" style="margin-top:16px"><button type="button" class="btn" data-edit>Edit session</button><button type="button" class="btn danger" data-del>Delete</button></div>` : ""}`,
    });
    const run = async (fn) => { try { await fn(); await load(); } catch (e) { toast(friendlyError(e), true); } };
    el.addEventListener("change", (e) => {
      const cb = e.target.closest("[data-mem]");
      if (cb) run(() => S.api.setAttendance(t.id, cb.dataset.mem, cb.checked));
    });
    el.addEventListener("click", async (e) => {
      if (e.target.closest("[data-self]")) { close(); run(() => S.api.selfMarkAttendance(t.id)).then(() => toast("Attendance recorded.")); }
      if (e.target.closest("[data-toggle-open]")) { close(); run(() => S.api.saveTraining(S.dept.id, { attendance_open: !t.attendance_open }, t.id)).then(() => toast(t.attendance_open ? "Self check-in closed." : "Crew can now mark themselves present from the Incidents screen.")); }
      if (e.target.closest("[data-edit]")) { close(); trainingForm(t); }
      if (e.target.closest("[data-del]")) {
        close();
        if (await confirmSheet({ title: "Delete this session?", message: "Attendance records for it are deleted too.", confirmLabel: "Delete", danger: true })) run(() => S.api.deleteTraining(t.id));
      }
    });
  }

  function trainingForm(t = null) {
    openSheet({
      title: t ? "Edit training" : "Log training",
      body: `
        ${field("Title", input("title", t?.title || "", 'placeholder="e.g. Pump operations"'))}
        <div class="grid2">${field("Date", input("session_date", t?.session_date || todayISO(), 'type="date"'))}${field("Hours", input("hours", t?.hours ?? "", 'type="number" inputmode="decimal" min="0" max="500" step="0.5" placeholder="e.g. 3"'))}</div>
        ${field("Type", select("kind", ["", ...TRAINING_TYPES], t?.kind || ""))}
        ${field("Location", input("location", t?.location || "", 'placeholder="e.g. Station 1"'))}
        ${field("Instructor", input("instructor", t?.instructor || ""))}
        ${field("Notes", textarea("notes", t?.notes || "", 'placeholder="What was covered"'))}
        ${t ? "" : `<label class="check"><input type="checkbox" name="attendance_open"> Let crew check themselves in</label>`}`,
      submitLabel: t ? "Save" : "Log training",
      errorText: friendlyError,
      onSubmit: async (form) => {
        const f = formData(form);
        if (!f.title) throw new Error("Give the session a title.");
        const row = { title: f.title, session_date: f.session_date || todayISO(), hours: f.hours === "" ? null : Number(f.hours), kind: f.kind || null, location: f.location || null, instructor: f.instructor || null, notes: f.notes || null };
        if (!t) row.attendance_open = !!f.attendance_open;
        const saved = await S.api.saveTraining(S.dept.id, row, t?.id);
        await load();
        if (!t) sessionSheet(saved);
      },
    });
  }

  // ---------------- equipment ----------------
  function serviceFlag(e) {
    if (!e.next_service) return "";
    const d = daysUntil(e.next_service + "T12:00:00");
    if (d < 0) return '<span class="pill bad">Service overdue</span>';
    if (d <= 30) return `<span class="pill warn">Service in ${d}d</span>`;
    return "";
  }

  function equipmentHtml() {
    const counts = Object.fromEntries(EQUIP_STATUSES.map((s) => [s, data.equipment.filter((e) => e.status === s).length]));
    const overdue = data.equipment.filter((e) => e.next_service && daysUntil(e.next_service + "T12:00:00") <= 30).length;
    const list = data.equipment.filter((e) =>
      (eqFilter === "all" || (eqFilter === "service" ? e.next_service && daysUntil(e.next_service + "T12:00:00") <= 30 : e.status === eqFilter))
      && (!q || `${e.name} ${e.serial || ""} ${e.location || ""}`.toLowerCase().includes(q.toLowerCase())));
    return `
      <div class="segment" style="margin:12px 0 10px">
        <button data-act="eqf" data-f="all" class="${eqFilter === "all" ? "on" : ""}">All ${data.equipment.length}</button>
        ${overdue ? `<button data-act="eqf" data-f="service" class="${eqFilter === "service" ? "on" : ""}">Service due ${overdue}</button>` : ""}
        ${EQUIP_STATUSES.filter((s) => counts[s]).map((s) => `<button data-act="eqf" data-f="${s}" class="${eqFilter === s ? "on" : ""}">${s} ${counts[s]}</button>`).join("")}
      </div>
      <input class="input" data-search placeholder="Search by name, serial or location" value="${esc(q)}" style="margin-bottom:12px" autocomplete="off">
      ${list.length ? `<div class="list">${list.map((e) => `
        <button class="row" data-act="item" data-id="${e.id}">
          <div class="grow">
            <div class="title">${esc(e.name)}${e.qty > 1 ? ` <span class="faint">x${e.qty}</span>` : ""}</div>
            <div class="meta">${esc([e.location, e.category, e.serial ? `SN ${e.serial}` : ""].filter(Boolean).join(", "))}</div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
            <span class="pill ${e.status === "Available" ? "good" : e.status === "Out of Service" || e.status === "Missing" ? "bad" : ""}">${esc(e.status)}</span>
            ${serviceFlag(e)}
          </div>
        </button>`).join("")}</div>`
        : `<div class="empty">${data.equipment.length ? "<p>Nothing matches.</p>" : `<div class="h3">No equipment yet</div><p>Track SCBA, tools and anything with a service date. You'll see what's overdue at a glance.</p>${canEdit() ? '<button class="btn primary" data-act="add">Add item</button>' : ""}`}</div>`}`;
  }

  function equipmentForm(e = null) {
    const trucks = (S.dept.settings?.apparatus || []).map((a) => a.name);
    const locs = [...new Set([...(S.dept.settings?.equipment_locations || ["Station"]), ...trucks])];
    const locOpts = e?.location && !locs.includes(e.location) ? [...locs, e.location] : locs;
    if (!canEdit()) {
      openSheet({
        title: e.name,
        body: `<dl class="kv"><dt>Status</dt><dd>${esc(e.status)}</dd><dt>Location</dt><dd>${esc(e.location || "")}</dd><dt>Category</dt><dd>${esc(e.category || "")}</dd>
          <dt>Quantity</dt><dd>${e.qty}</dd>${e.serial ? `<dt>Serial</dt><dd>${esc(e.serial)}</dd>` : ""}<dt>Condition</dt><dd>${esc(e.condition || "")}</dd>
          ${e.last_inspected ? `<dt>Last inspected</dt><dd>${dateLabel(e.last_inspected + "T12:00:00")}</dd>` : ""}
          ${e.next_service ? `<dt>Next service</dt><dd>${dateLabel(e.next_service + "T12:00:00")}</dd>` : ""}</dl>
          ${e.notes ? `<p style="margin-top:12px;white-space:pre-wrap">${esc(e.notes)}</p>` : ""}`,
      });
      return;
    }
    openSheet({
      title: e ? "Edit item" : "Add equipment",
      body: `
        ${field("Item name", input("name", e?.name || "", 'placeholder="e.g. SCBA pack, thermal camera"'))}
        <div class="grid2">${field("Category", select("category", EQUIP_CATEGORIES, e?.category || EQUIP_CATEGORIES[0]))}${field("Status", select("status", EQUIP_STATUSES, e?.status || "Available"))}</div>
        <div class="grid2">${field("Serial / ID", input("serial", e?.serial || ""))}${field("Quantity", input("qty", e?.qty ?? 1, 'type="number" inputmode="numeric" min="1"'))}</div>
        <div class="grid2">${field("Location", select("location", locOpts, e?.location || locs[0]))}${field("Condition", select("condition", CONDITIONS, e?.condition || "Good"))}</div>
        <div class="grid2">${field("Last inspected", input("last_inspected", e?.last_inspected || "", 'type="date"'))}${field("Next service", input("next_service", e?.next_service || "", 'type="date"'))}</div>
        ${field("Notes", textarea("notes", e?.notes || "", 'placeholder="Damage, service history, anything useful"'))}
        <p class="hint">Trucks and other locations are set in Department.</p>`,
      submitLabel: e ? "Save" : "Add item",
      secondary: e ? "Delete" : null,
      secondaryClass: "danger",
      onSecondary: async (close) => {
        close();
        if (await confirmSheet({ title: `Delete ${e.name}?`, message: "This can't be undone.", confirmLabel: "Delete", danger: true })) {
          try { await S.api.deleteEquipment(e.id); await load(); } catch (ex) { toast(friendlyError(ex), true); }
        }
      },
      errorText: friendlyError,
      onSubmit: async (form) => {
        const f = formData(form);
        if (!f.name) throw new Error("Give the item a name.");
        const qty = Math.max(1, parseInt(f.qty, 10) || 1);
        await S.api.saveEquipment(S.dept.id, {
          name: f.name, category: f.category, status: f.status, serial: f.serial || null, qty,
          location: f.location || null, condition: f.condition, last_inspected: f.last_inspected || null,
          next_service: f.next_service || null, notes: f.notes || null,
        }, e?.id);
        await load();
      },
    });
  }

  // ---------------- export ----------------
  function exportCsv() {
    const name = slug(S.dept.name);
    const date = todayISO();
    if (tab === "roster") {
      const rows = [["Name", "Rank", "Crew", "Call sign", "Phone", "Radio", "Years", "Uses app", "Training hours", "Certifications"]];
      data.members.forEach((m) => rows.push([m.name, m.rank, m.crew, m.call_sign, m.phone, m.radio, m.years, m.user_id ? "Yes" : "No", hoursFor(m.id),
        (m.certifications || []).map((c) => `${c.name}${c.expiry ? ` (exp ${c.expiry})` : ""}`).join("; ")]));
      download(`${name}-roster-${date}.csv`, csv(rows), "text/csv");
    } else if (tab === "training") {
      const byId = Object.fromEntries(data.members.map((m) => [m.id, m.name]));
      const rows = [["Date", "Title", "Type", "Hours", "Location", "Instructor", "Attendees", "Count", "Notes"]];
      data.training.forEach((t) => {
        const names = data.attendance.filter((a) => a.session_id === t.id).map((a) => byId[a.member_id]).filter(Boolean);
        rows.push([t.session_date, t.title, t.kind, t.hours, t.location, t.instructor, names.join("; "), names.length, t.notes]);
      });
      download(`${name}-training-${date}.csv`, csv(rows), "text/csv");
    } else {
      const rows = [["Name", "Category", "Status", "Serial", "Qty", "Location", "Condition", "Last inspected", "Next service", "Notes"]];
      data.equipment.forEach((e) => rows.push([e.name, e.category, e.status, e.serial, e.qty, e.location, e.condition, e.last_inspected, e.next_service, e.notes]));
      download(`${name}-equipment-${date}.csv`, csv(rows), "text/csv");
    }
    toast("Exported. Opens in Excel or Google Sheets.");
  }

  const off = bindActions(root, {
    add: () => {
      if (tab === "roster") addPersonForm(load);
      else if (tab === "training") trainingForm();
      else equipmentForm();
    },
    export: exportCsv,
    member: (b) => openMemberProfile(b.dataset.id, load, data),
    session: (b) => sessionSheet(data.training.find((t) => t.id === b.dataset.id)),
    item: (b) => equipmentForm(data.equipment.find((e) => e.id === b.dataset.id)),
    eqf: (b) => { eqFilter = b.dataset.f; paint(); },
  });
  const unsub = S.api.subscribeDepartment(S.dept.id, (table) => { if (table !== "incidents") load().catch(() => {}); });

  root.innerHTML = '<div class="spinner"></div>';
  load().catch((e) => { root.innerHTML = `<div class="wrap empty" style="padding-top:80px"><div class="h3">Couldn't load records</div><p>${esc(friendlyError(e))}</p></div>${bottomNav("records")}`; });
  return () => { alive = false; off(); unsub(); };
}

function addPersonForm(onDone) {
  const { el, close } = openSheet({
    title: "Add to roster",
    body: `<div class="segment" style="margin-bottom:16px" role="tablist">
        <button type="button" class="on" data-mode="one" role="tab">One person</button>
        <button type="button" data-mode="many" role="tab">Paste a list</button>
      </div>
      <form data-one novalidate>
        <p class="muted small" style="margin-bottom:14px">For people who don't use the app. Anyone with the app joins with your invite code instead.</p>
        ${field("Name", input("name", "", 'placeholder="First and last name"'))}
        <div class="grid2">${field("Rank", select("rank", RANKS, "Firefighter"))}${field("Crew", select("crew", ["", ...CREWS], ""))}</div>
        ${field("Phone", input("phone", "", 'type="tel"'))}
        <div class="error-text" data-err1 hidden></div>
        <button class="btn primary block" style="margin-top:16px">Add to roster</button>
      </form>
      <form data-many novalidate hidden>
        <p class="muted small" style="margin-bottom:12px">One person per line. Copy a column of names from Excel, a sign-in sheet or a group text. Rank, crew and phone after a comma are picked up too.</p>
        ${field("People", textarea("list", "", 'rows="9" placeholder="Jordan Kelley, Captain\nTess MacDonald, Lieutenant\nSam Riopelle\nMike Brown, Engineer/Driver, Bravo"'))}
        <p class="hint" data-count>Nobody yet.</p>
        <div class="error-text" data-err2 hidden></div>
        <button class="btn primary block" style="margin-top:12px" data-many-btn disabled>Add people</button>
      </form>`,
  });
  const one = el.querySelector("[data-one]");
  const many = el.querySelector("[data-many]");
  el.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => {
    el.querySelectorAll("[data-mode]").forEach((x) => x.classList.toggle("on", x === b));
    one.hidden = b.dataset.mode !== "one";
    many.hidden = b.dataset.mode !== "many";
  }));
  const parsed = () => parseRoster(many.list.value, RANKS, CREWS);
  many.list.addEventListener("input", () => {
    const n = parsed().length;
    el.querySelector("[data-count]").textContent = n ? `${n} ${n === 1 ? "person" : "people"} ready to add.` : "Nobody yet.";
    el.querySelector("[data-many-btn]").disabled = !n;
    el.querySelector("[data-many-btn]").textContent = n ? `Add ${n} ${n === 1 ? "person" : "people"}` : "Add people";
  });
  const submit = (form, errSel, fn) => form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = el.querySelector(errSel);
    const btn = form.querySelector("button:not([type=button])");
    err.hidden = true;
    btn.disabled = true;
    try { await fn(); close(); await onDone?.(); }
    catch (ex) { err.textContent = friendlyError(ex); err.hidden = false; btn.disabled = false; }
  });
  submit(one, "[data-err1]", async () => {
    const f = formData(one);
    if (!f.name) throw new Error("Enter a name.");
    await S.api.addRosterEntry(S.dept.id, { name: f.name, rank: f.rank, crew: f.crew || null, phone: f.phone || null });
    toast(`${f.name} added.`);
  });
  submit(many, "[data-err2]", async () => {
    const people = parsed();
    if (!people.length) throw new Error("Paste at least one name.");
    if (people.length > 300) throw new Error("That's more than 300 people. Add them in a few batches.");
    const n = await S.api.importRoster(S.dept.id, people);
    const skipped = people.length - n;
    toast(`${n} added to the roster.${skipped ? ` ${skipped} already on it.` : ""}`);
  });
}

// ============================================================
// Member profile (used from roster, board and Me)
// ============================================================
export async function openMemberProfile(memberId, onChange, cache) {
  let members = cache?.members;
  let training = cache?.training;
  let attendance = cache?.attendance;
  try {
    if (!members) [members, training, attendance] = await Promise.all([S.api.listMembers(S.dept.id), S.api.listTraining(S.dept.id), S.api.listAttendance(S.dept.id)]);
  } catch (e) { return toast(friendlyError(e), true); }
  const m = members.find((x) => x.id === memberId);
  if (!m) return toast("That person isn't on the roster anymore.", true);
  const self = m.user_id && m.user_id === S.user.id;
  const private_ = self || isOfficer();
  const medical = private_ ? await S.api.getMedical(m.id).catch(() => null) : null;
  const sessions = (training || []).filter((t) => (attendance || []).some((a) => a.session_id === t.id && a.member_id === m.id));
  const hours = sessions.reduce((s, t) => s + Number(t.hours || 0), 0);
  const editable = (self || isOfficer()) && hasAccess();

  const certRow = (c) => {
    const d = c.expiry ? daysUntil(c.expiry + "T12:00:00") : null;
    const flag = d === null ? "" : d < 0 ? '<span class="pill bad">Expired</span>' : d <= 60 ? `<span class="pill warn">${d}d left</span>` : "";
    return `<div class="row" style="min-height:52px"><div class="grow"><div class="title" style="font-size:16px">${esc(c.name)}</div><div class="meta">${c.date ? `Completed ${dateLabel(c.date + "T12:00:00")}` : ""}${c.expiry ? `${c.date ? ", " : ""}expires ${dateLabel(c.expiry + "T12:00:00")}` : ""}</div></div>${flag}</div>`;
  };
  const hasMed = medical && (medical.blood_type || medical.allergies || medical.conditions || medical.medications || medical.epipen);

  const { el, close } = openSheet({
    title: m.name,
    body: `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
        <div class="avatar" style="width:48px;height:48px;font-size:18px;background:${colorFor(m.name)}">${esc(initials(m.name))}</div>
        <div><div class="h3">${esc(m.rank)}</div><div class="muted small">${esc([m.crew, m.call_sign ? `Call sign ${m.call_sign}` : "", m.years ? `${m.years} years` : ""].filter(Boolean).join(", ")) || "No details yet"}</div></div>
      </div>
      <dl class="kv">
        ${m.phone ? `<dt>Phone</dt><dd><a href="tel:${esc(m.phone)}">${esc(m.phone)}</a></dd>` : ""}
        ${m.radio ? `<dt>Radio</dt><dd>${esc(m.radio)}</dd>` : ""}
        <dt>Uses the app</dt><dd>${m.user_id ? "Yes" : "No"}</dd>
        <dt>Training</dt><dd>${sessions.length} session${sessions.length === 1 ? "" : "s"}, ${hours}h</dd>
      </dl>
      <div class="section"><div class="h3" style="margin-bottom:8px">Certifications</div>
        ${(m.certifications || []).length ? `<div class="list">${m.certifications.map(certRow).join("")}</div>` : '<p class="muted">None recorded.</p>'}</div>
      ${private_ ? `
      <div class="section"><div class="h3" style="margin-bottom:8px">Emergency contact</div>
        ${m.ec_name || m.ec_phone ? `<dl class="kv"><dt>${esc(m.ec_rel || "Contact")}</dt><dd>${esc(m.ec_name || "")}</dd>${m.ec_phone ? `<dt>Phone</dt><dd><a href="tel:${esc(m.ec_phone)}">${esc(m.ec_phone)}</a></dd>` : ""}</dl>` : '<p class="muted">None recorded.</p>'}</div>
      <div class="section medical"><div class="h3 c-bad" style="margin-bottom:4px">Medical</div>
        <p class="faint small" style="margin-bottom:10px">Only officers and ${self ? "you" : "this member"} can see this.</p>
        ${hasMed ? `<dl class="kv">
          ${medical.blood_type ? `<dt>Blood type</dt><dd>${esc(medical.blood_type)}</dd>` : ""}
          ${medical.epipen ? `<dt>EpiPen</dt><dd>${esc(medical.epipen)}</dd>` : ""}
          ${medical.allergies ? `<dt>Allergies</dt><dd>${esc(medical.allergies)}</dd>` : ""}
          ${medical.conditions ? `<dt>Conditions</dt><dd>${esc(medical.conditions)}</dd>` : ""}
          ${medical.medications ? `<dt>Medications</dt><dd>${esc(medical.medications)}</dd>` : ""}
        </dl>` : '<p class="muted">Nothing recorded. Everything here is optional.</p>'}
      </div>` : ""}
      ${m.notes && private_ ? `<div class="section"><div class="h3">Notes</div><p style="white-space:pre-wrap;margin-top:6px">${esc(m.notes)}</p></div>` : ""}
      ${sessions.length ? `<div class="section"><div class="h3" style="margin-bottom:8px">Training history</div><div class="list">${sessions.slice(0, 20).map((t) => `<div class="row" style="min-height:48px"><div class="grow"><div class="title" style="font-size:16px">${esc(t.title)}</div><div class="meta">${dateLabel(t.session_date + "T12:00:00")}${t.hours ? `, ${Number(t.hours)}h` : ""}</div></div></div>`).join("")}</div></div>` : ""}
      <div class="btn-row section">
        ${editable ? `<button type="button" class="btn primary" data-edit>Edit</button>` : ""}
        ${isOfficer() && !m.user_id && hasAccess() ? `<button type="button" class="btn danger" data-del>Remove</button>` : ""}
      </div>`,
  });

  el.addEventListener("click", async (e) => {
    if (e.target.closest("[data-edit]")) { close(); editProfile(m, medical, private_, onChange); }
    if (e.target.closest("[data-del]")) {
      close();
      if (await confirmSheet({ title: `Remove ${m.name}?`, message: "They come off the roster. Past incidents and training records keep their name.", confirmLabel: "Remove", danger: true })) {
        try { await S.api.deleteRosterEntry(m.id); await onChange?.(); } catch (ex) { toast(friendlyError(ex), true); }
      }
    }
  });
}

function editProfile(m, medical, private_, onChange) {
  const certs = (m.certifications || []).length ? m.certifications : [];
  const certInputs = (c = {}, i) => `
    <div class="panel" style="padding:12px;margin-top:8px" data-cert>
      ${field("Certification", input(`cert_name_${i}`, c.name || "", 'placeholder="e.g. NFPA 1001 Level I"'))}
      <div class="grid2">${field("Completed", input(`cert_date_${i}`, c.date || "", 'type="date"'))}${field("Expires", input(`cert_exp_${i}`, c.expiry || "", 'type="date"'))}</div>
      <button type="button" class="btn quiet sm" data-rmcert>Remove</button>
    </div>`;
  let n = Math.max(certs.length, 0);
  openSheet({
    title: `Edit ${m.name}`,
    body: `
      ${field("Name", input("name", m.name))}
      <div class="grid2">${field("Rank", select("rank", RANKS.includes(m.rank) ? RANKS : [m.rank, ...RANKS], m.rank))}${field("Crew", select("crew", ["", ...CREWS], m.crew || ""))}</div>
      <div class="grid2">${field("Call sign", input("call_sign", m.call_sign || ""))}${field("Years of service", input("years", m.years ?? "", 'type="number" min="0" max="80" inputmode="numeric"'))}</div>
      <div class="grid2">${field("Phone", input("phone", m.phone || "", 'type="tel"'))}${field("Radio", input("radio", m.radio || ""))}</div>

      <div class="section"><div class="h3">Certifications</div><div data-certs>${certs.map((c, i) => certInputs(c, i)).join("")}</div>
        <button type="button" class="btn sm block" style="margin-top:10px" data-addcert>${icon("plus", "sm")} Add certification</button></div>

      ${private_ ? `
      <div class="section"><div class="h3" style="margin-bottom:10px">Emergency contact</div>
        <div class="grid2">${field("Name", input("ec_name", m.ec_name || ""))}${field("Relationship", input("ec_rel", m.ec_rel || ""))}</div>
        ${field("Phone", input("ec_phone", m.ec_phone || "", 'type="tel"'))}</div>
      <div class="section medical"><div class="h3 c-bad" style="margin-bottom:10px">Medical (optional)</div>
        <div class="grid2">${field("Blood type", select("blood_type", BLOOD_TYPES.map((b) => [b, b || "Unknown"]), medical?.blood_type || ""))}${field("EpiPen", select("epipen", [["", "No"], "Carries own", "Needs supply"], medical?.epipen || ""))}</div>
        ${field("Allergies", input("allergies", medical?.allergies || ""))}
        ${field("Conditions command should know", textarea("conditions", medical?.conditions || ""))}
        ${field("Medications", input("medications", medical?.medications || ""))}
      </div>
      ${field("Notes", textarea("notes", m.notes || ""))}` : ""}`,
    submitLabel: "Save",
    errorText: friendlyError,
    onOpen: (form) => {
      form.querySelector("[data-addcert]").addEventListener("click", () => {
        form.querySelector("[data-certs]").insertAdjacentHTML("beforeend", certInputs({}, n++));
      });
      form.addEventListener("click", (e) => { if (e.target.closest("[data-rmcert]")) e.target.closest("[data-cert]").remove(); });
    },
    onSubmit: async (form) => {
      const f = formData(form);
      if (!f.name) throw new Error("Name can't be empty.");
      const certifications = [...form.querySelectorAll("[data-cert]")].map((box) => {
        const get = (p) => box.querySelector(`[name^="${p}"]`)?.value.trim() || "";
        return { name: get("cert_name_"), date: get("cert_date_"), expiry: get("cert_exp_") };
      }).filter((c) => c.name);
      const years = f.years === "" ? null : Math.min(80, Math.max(0, parseInt(f.years, 10) || 0));
      const patch = { name: f.name, rank: f.rank, crew: f.crew || null, call_sign: f.call_sign || null, years, phone: f.phone || null, radio: f.radio || null, certifications };
      if (private_) Object.assign(patch, { ec_name: f.ec_name || null, ec_rel: f.ec_rel || null, ec_phone: f.ec_phone || null, notes: f.notes || null });
      await S.api.updateMember(m.id, patch);
      if (private_) {
        await S.api.saveMedical(m.id, S.dept.id, {
          blood_type: f.blood_type || null, epipen: f.epipen || null, allergies: f.allergies || null,
          conditions: f.conditions || null, medications: f.medications || null,
        });
      }
      toast("Saved.");
      await onChange?.();
    },
  });
}
