// The incident board: live accountability for one incident.
import { CONFIG } from "./config.js";
import { S, STATUSES, STATUS_HELP, STATUS_SHORT, APP_STATUSES, APP_KINDS, MA_STATUSES, RANKS, CREWS, isOfficer, hasAccess } from "./state.js";
import { esc, initials, colorFor, clock, dateTime, elapsed, stopwatch, ago, formData, download, slug, copyText, vibrate, friendlyError, debounce, alertTone, keepAwake, setTheme } from "./util.js";
import { icon, toast, openSheet, confirmSheet, field, input, select, textarea } from "./ui.js";
import { bindActions, demoStrip } from "./app.js";
import { openMemberProfile } from "./records.js";

const GROUP_ORDER = ["MISSING", "IN", "Staged", "Standby", "Rehab", "Responding", "OUT"];
const STATUS_VAR = { Responding: "--st-responding", Staged: "--st-staged", IN: "--st-in", OUT: "--st-out", Rehab: "--st-rehab", Standby: "--st-standby", MISSING: "--st-missing" };

// One audio element for the scanner so it keeps playing across re-renders.
let scannerAudio = null;

export function boardView(root, incidentId) {
  let st = null;
  let tab = sessionStorage.getItem("fgb_board_tab") || "crew";
  let filter = null;
  let alive = true;
  let map = null;
  let markers = {};
  let watchId = null;
  let chatOpen = false;
  let lastPar = undefined;
  let lastMissing = new Set();
  let members = [];
  let iCalledPar = false;
  const releaseScreen = keepAwake();

  const seenKey = `fgb_chat_seen_${incidentId}`;
  const officer = () => isOfficer() && hasAccess();
  const active = () => st?.incident.status === "active";
  const myRow = () => st?.personnel.find((p) => p.member_id === S.me.id || (p.user_id && p.user_id === S.user.id));

  root.innerHTML = `${demoStrip()}<div class="screen" id="board">
    <header class="topbar"><div class="wrap" id="b-head"></div></header>
    <div id="b-banners"></div>
    <div class="wrap" id="b-body" style="padding-top:12px;padding-bottom:110px"><div class="spinner"></div></div>
  </div>
  <div id="b-fab"></div>`;

  // ---------------- data ----------------
  async function load() {
    const next = await S.api.incidentState(incidentId);
    if (!alive) return;
    if (next.incident.dept_id && next.incident.dept_id !== S.dept.id) {
      const m = S.memberships.find((x) => x.dept.id === next.incident.dept_id);
      if (m) { S.dept = m.dept; S.me = m.member; }
    }
    alerts(st, next);
    st = next;
    paint();
  }
  const reload = debounce(() => load().catch((e) => console.warn(e)), 150);

  function alerts(prev, next) {
    if (!prev) {
      lastPar = next.incident.par_started_at;
      lastMissing = new Set(next.personnel.filter((p) => p.status === "MISSING").map((p) => p.id));
      return;
    }
    if (next.incident.par_started_at && next.incident.par_started_at !== lastPar) {
      if (!iCalledPar) { vibrate([400, 150, 400, 150, 400]); alertTone("par"); }
      iCalledPar = false;
    }
    lastPar = next.incident.par_started_at;
    const missing = new Set(next.personnel.filter((p) => p.status === "MISSING").map((p) => p.id));
    if ([...missing].some((id) => !lastMissing.has(id))) { vibrate([900, 200, 900]); alertTone("missing"); }
    lastMissing = missing;
  }

  // ---------------- painting ----------------
  function paint() {
    if (!st || !alive) return;
    paintHead();
    paintBanners();
    paintBody();
    paintFab();
    if (chatOpen) paintChat();
  }

  function counts() {
    const c = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    st.personnel.forEach((p) => { c[p.status] = (c[p.status] || 0) + 1; });
    return c;
  }

  function paintHead() {
    const inc = st.incident;
    const c = counts();
    root.querySelector("#b-head").innerHTML = `
      <div class="inc-head">
        <div class="inc-head-row">
          <a href="#/" class="iconbtn ghost" aria-label="Back to incidents">${icon("back")}</a>
          <div class="inc-title">
            <div class="name">${esc(inc.name)}</div>
            <div class="addr">${esc(inc.address || "No address")}${inc.call_type ? `, ${esc(inc.call_type)}` : ""}</div>
          </div>
          <div class="inc-clock" ${active() ? `data-clock="${inc.started_at}"` : ""}>${active() ? elapsed(inc.started_at) : "Closed"}<small>${active() ? `since ${clock(inc.started_at)}` : dateTime(inc.closed_at)}</small></div>
          <button class="iconbtn" data-act="menu" aria-label="Incident menu">${icon("more")}</button>
        </div>
        ${active() ? `<div class="tally" role="group" aria-label="Filter by status">${STATUSES.map((s) => `
          <button data-act="filter" data-s="${s}" class="${filter === s ? "on" : ""} ${c[s] ? "" : "zero"}" aria-pressed="${filter === s}">
            <b class="c-${s}">${c[s]}</b><span>${STATUS_SHORT[s]}</span>
          </button>`).join("")}</div>` : ""}
      </div>
      <nav class="views" role="tablist">
        ${[["crew", "Crew"], ["units", "Units"], ["map", "Map"], ["log", active() ? "Log" : "Report"]].map(([k, l]) => `<button role="tab" data-act="tab" data-tab="${k}" class="${tab === k ? "on" : ""}">${l}</button>`).join("")}
      </nav>`;
  }

  function paintBanners() {
    const el = root.querySelector("#b-banners");
    if (!active()) { el.innerHTML = ""; return; }
    const inc = st.incident;
    const missing = st.personnel.filter((p) => p.status === "MISSING");
    const me = myRow();
    let html = "";
    if (missing.length) {
      html += `<div class="alarm" role="alert"><div class="wrap" style="display:flex;align-items:center;gap:10px">${icon("alert")}<span style="flex:1">Missing: ${missing.map((p) => esc(p.name)).join(", ")}</span>${filter !== "MISSING" ? '<button class="btn sm" data-act="filter" data-s="MISSING" style="background:#fff;color:#a00;border-color:#fff">Show</button>' : ""}</div></div>`;
    }
    if (inc.par_started_at) {
      const pool = st.personnel.filter((p) => p.status !== "OUT");
      const acked = pool.filter((p) => p.par_ack_at).length;
      const needMine = me && !me.par_ack_at && me.status !== "OUT";
      html += `<div class="par" role="alert"><div class="wrap par-in">
        <div style="flex:1;min-width:0">
          <div class="par-title">PAR check</div>
          <div class="par-sub"><span data-stopwatch="${inc.par_started_at}">${stopwatch(inc.par_started_at)}</span> elapsed, ${acked} of ${pool.length} confirmed</div>
        </div>
        ${needMine ? `<button class="btn hivis" data-act="ack-me">I'm accounted for</button>` : ""}
        ${officer() ? `<button class="btn" data-act="end-par">Close PAR</button>` : ""}
      </div></div>`;
    }
    if (!me && hasAccess()) {
      html += `<div class="wrap" style="margin-top:12px"><div class="banner"><div class="grow"><b>You're not on this board.</b><br><span class="muted">Join so command knows you're responding.</span></div><button class="btn primary sm" data-act="join">Join board</button></div></div>`;
    }
    el.innerHTML = html;
  }

  function paintBody() {
    const body = root.querySelector("#b-body");
    if (tab !== "map" && map) { map.remove(); map = null; markers = {}; }
    if (tab === "crew") body.innerHTML = crewHtml();
    else if (tab === "units") body.innerHTML = unitsHtml();
    else if (tab === "log") body.innerHTML = active() ? logHtml() : reportHtml();
    else if (tab === "map") paintMap(body);
  }

  function crewHtml() {
    const me = myRow();
    const parOn = !!st.incident.par_started_at;
    const apps = Object.fromEntries(st.apparatus.map((a) => [a.id, a.name]));
    const mas = Object.fromEntries(st.mutualAid.map((a) => [a.id, a.name]));
    const list = st.personnel.filter((p) => !filter || p.status === filter);
    const tools = active() && officer() ? `<div class="btn-row" style="margin-bottom:6px">
        <button class="btn primary" data-act="add-crew">${icon("plus", "sm")} Add crew</button>
        ${parOn ? "" : `<button class="btn" data-act="start-par" style="border-color:var(--hivis);color:var(--hivis)">Call PAR</button>`}
      </div>` : "";
    if (!st.personnel.length) {
      return `${tools}<div class="empty"><div class="h3">Nobody on the board yet</div><p>${officer() ? "Add crew from your roster, or have them open the incident on their phones and tap Join board." : "Tap Join board above when you're responding."}</p></div>`;
    }
    const tag = (p) => {
      const mine = me && p.id === me.id;
      const parCls = parOn && p.status !== "OUT" ? (p.par_ack_at ? "par-ok" : "par-wait") : "";
      return `<button class="tag ${mine ? "me" : ""} ${parCls}" data-act="person" data-id="${p.id}">
        <div class="tag-status st-${p.status}">${esc(p.status === "Responding" ? "Resp" : p.status)}<small ${active() ? `data-since="${p.status_changed_at}"` : ""}>${elapsed(p.status_changed_at, active() ? Date.now() : st.incident.closed_at)}</small></div>
        <div class="tag-body">
          <div class="tag-name"><span>${esc(p.name)}</span>${mine ? '<span class="pill">You</span>' : ""}</div>
          <div class="tag-meta">
            <span>${esc([p.rank, p.crew].filter(Boolean).join(", ") || "Crew")}</span>
            ${p.apparatus_id && apps[p.apparatus_id] ? `<span class="pill">${icon("truck", "sm")}${esc(apps[p.apparatus_id])}</span>` : ""}
            ${p.mutual_aid_id && mas[p.mutual_aid_id] ? `<span class="pill">${esc(mas[p.mutual_aid_id])}</span>` : ""}
            ${p.no_radio ? '<span class="pill warn">No radio</span>' : ""}
          </div>
        </div>
        <div class="tag-side"></div>
      </button>`;
    };
    const groups = GROUP_ORDER.map((s) => [s, list.filter((p) => p.status === s)]).filter(([, g]) => g.length);
    return `${tools}
      ${filter ? `<div class="banner" style="margin:10px 0"><div class="grow">Showing <b>${esc(filter)}</b> only</div><button class="btn sm" data-act="filter" data-s="${filter}">Show all</button></div>` : ""}
      ${groups.map(([s, g]) => `
        <div class="group-label"><span class="dot" style="background:var(${STATUS_VAR[s]})"></span>${esc(s === "IN" ? "In" : s === "OUT" ? "Out" : s === "MISSING" ? "Missing" : s)} (${g.length})</div>
        ${g.map(tag).join("")}`).join("")}
      ${!list.length ? `<div class="empty"><p>No one is ${esc(filter)} right now.</p></div>` : ""}`;
  }

  function unitsHtml() {
    const byApp = (aid) => st.personnel.filter((p) => p.apparatus_id === aid);
    const byMa = (mid) => st.personnel.filter((p) => p.mutual_aid_id === mid);
    const me = myRow();
    const canEditUnits = active() && hasAccess();
    const chip = (p) => `<span class="chip"><span class="dot" style="background:var(${STATUS_VAR[p.status]})"></span>${esc(p.name)}</span>`;
    return `
      <div class="section-head" style="margin-top:4px"><div class="h2">Apparatus</div>${canEditUnits ? `<button class="btn sm" data-act="add-app">${icon("plus", "sm")} Add</button>` : ""}</div>
      ${st.apparatus.length ? st.apparatus.map((a) => `
        <div class="unit">
          <div class="unit-head">
            <div class="title">${esc(a.name)}${a.kind ? ` <span class="faint small" style="font-family:var(--body);font-weight:500">${esc(a.kind)}</span>` : ""}</div>
            ${canEditUnits ? select("app-status", APP_STATUSES, a.status, `class="select inline" data-change="app-status" data-id="${a.id}" aria-label="${esc(a.name)} status"`).replace('class="select"', "") : `<span class="pill">${esc(a.status)}</span>`}
          </div>
          <div class="unit-crew">${byApp(a.id).map(chip).join("") || '<span class="faint small">No crew assigned</span>'}</div>
          ${canEditUnits ? `<div class="btn-row" style="margin-top:10px">
            ${me && me.apparatus_id !== a.id ? `<button class="btn sm" data-act="on-truck" data-id="${a.id}">I'm on this truck</button>` : ""}
            ${officer() ? `<button class="btn sm quiet" data-act="del-app" data-id="${a.id}">Remove</button>` : ""}
          </div>` : ""}
        </div>`).join("") : `<p class="muted">No apparatus added yet.${canEditUnits ? " Add trucks so crew can assign themselves." : ""}</p>`}

      <div class="section-head section"><div class="h2">Mutual aid</div>${officer() && active() ? `<button class="btn sm" data-act="add-ma">${icon("plus", "sm")} Add</button>` : ""}</div>
      ${st.mutualAid.length ? st.mutualAid.map((m) => `
        <div class="unit">
          <div class="unit-head">
            <div class="title">${esc(m.name)}</div>
            ${officer() && active() ? select("ma-status", MA_STATUSES, m.status, `class="select inline" data-change="ma-status" data-id="${m.id}" aria-label="${esc(m.name)} status"`).replace('class="select"', "") : `<span class="pill">${esc(m.status)}</span>`}
          </div>
          ${m.notes ? `<p class="muted small" style="margin-top:6px">${esc(m.notes)}</p>` : ""}
          <div class="unit-crew">${byMa(m.id).map(chip).join("") || '<span class="faint small">No personnel listed</span>'}</div>
          ${officer() && active() ? `<div class="btn-row" style="margin-top:10px">
            <button class="btn sm" data-act="add-crew" data-ma="${m.id}">Add their crew</button>
            <button class="btn sm quiet" data-act="edit-ma" data-id="${m.id}">Edit</button>
          </div>` : ""}
        </div>`).join("") : `<p class="muted">No mutual aid on this call.</p>`}`;
  }

  function logHtml() {
    return `
      <div class="section-head" style="margin-top:4px"><div class="h2">Activity log</div>${hasAccess() ? `<button class="btn sm" data-act="note">${icon("plus", "sm")} Add note</button>` : ""}</div>
      ${st.events.map(logItem).join("") || '<p class="muted">Nothing logged yet.</p>'}`;
  }

  function logItem(e) {
    return `<div class="log-item k-${esc(e.kind)}"><time>${clock(e.at)}</time><div><div class="msg">${esc(e.message)}</div>${e.actor && !e.message.includes(e.actor) ? `<div class="who">${esc(e.actor)}</div>` : ""}</div></div>`;
  }

  function reportHtml() {
    const inc = st.incident;
    const pars = st.events.filter((e) => e.kind === "par" && /^PAR (check called|closed)/.test(e.message));
    const c = counts();
    return `
      <div class="btn-row no-print" style="margin-bottom:14px">
        <button class="btn" data-act="download">${icon("download", "sm")} Download report</button>
        <button class="btn" data-act="print">${icon("print", "sm")} Print</button>
      </div>
      <div class="panel">
        <div class="h3">Summary</div>
        <dl class="kv" style="margin-top:10px">
          <dt>Started</dt><dd>${dateTime(inc.started_at)}</dd>
          <dt>Closed</dt><dd>${dateTime(inc.closed_at)}</dd>
          <dt>Duration</dt><dd>${elapsed(inc.started_at, inc.closed_at)}</dd>
          <dt>Personnel</dt><dd>${st.personnel.length}</dd>
          <dt>Apparatus</dt><dd>${st.apparatus.map((a) => esc(a.name)).join(", ") || "None"}</dd>
          <dt>Mutual aid</dt><dd>${st.mutualAid.map((a) => esc(a.name)).join(", ") || "None"}</dd>
          <dt>PAR checks</dt><dd>${pars.filter((e) => e.message.startsWith("PAR check")).length}</dd>
          ${c.MISSING ? `<dt>Still missing at close</dt><dd class="c-bad">${c.MISSING}</dd>` : ""}
        </dl>
      </div>
      ${inc.iocanc ? `<div class="panel section"><div class="h3">Arrival report</div><p style="margin-top:8px;white-space:pre-wrap">${esc(iocancScript(inc.iocanc))}</p></div>` : ""}
      <div class="section"><div class="h3" style="margin-bottom:8px">Personnel</div>
        <div class="list">${st.personnel.map((p) => `<div class="row"><div class="grow"><div class="title">${esc(p.name)}</div><div class="meta">${esc([p.rank, p.crew].filter(Boolean).join(", "))}</div></div><span class="pill c-${p.status}">${esc(p.status)}</span></div>`).join("") || '<div class="row muted">No personnel</div>'}</div>
      </div>
      <div class="section"><div class="h3" style="margin-bottom:6px">Full log</div>${[...st.events].reverse().map(logItem).join("")}</div>
      ${st.messages.length ? `<div class="section"><div class="h3" style="margin-bottom:6px">Chat</div>${st.messages.map((m) => `<div class="log-item"><time>${clock(m.created_at)}</time><div><div class="msg">${esc(m.body)}</div><div class="who">${esc(m.sender)}</div></div></div>`).join("")}</div>` : ""}`;
  }

  // ---------------- map ----------------
  function paintMap(body) {
    if (!map) {
      const sharing = watchId !== null;
      body.innerHTML = `
        <div style="display:flex;gap:10px;align-items:center;margin-bottom:10px">
          <div class="grow muted small" style="flex:1">Positions update while people have this incident open. Accuracy drops inside buildings.</div>
          ${active() && hasAccess() ? `<button class="btn sm ${sharing ? "danger" : "primary"}" data-act="share-loc">${icon("pin", "sm")} ${sharing ? "Stop sharing" : "Share my location"}</button>` : ""}
        </div>
        <div id="map" role="application" aria-label="Map of crew positions"></div>
        <div id="map-list" class="section"></div>`;
      if (!window.L) { body.querySelector("#map").innerHTML = '<p class="muted" style="padding:20px">Map could not load.</p>'; return; }
      map = window.L.map("map", { zoomControl: true, attributionControl: true }).setView([45.5, -77.5], 13);
      window.L.tileLayer(CONFIG.TILE_URL, { maxZoom: 19, attribution: CONFIG.TILE_ATTRIBUTION }).addTo(map);
      setTimeout(() => map && map.invalidateSize(), 60);
      markers = {};
      updateMarkers(true);
    } else {
      updateMarkers(false);
      const btn = body.querySelector('[data-act="share-loc"]');
      if (btn) {
        const sharing = watchId !== null;
        btn.className = `btn sm ${sharing ? "danger" : "primary"}`;
        btn.innerHTML = `${icon("pin", "sm")} ${sharing ? "Stop sharing" : "Share my location"}`;
      }
    }
  }

  function updateMarkers(fit) {
    if (!map) return;
    const L = window.L;
    const seen = new Set();
    for (const loc of st.locations) {
      const p = st.personnel.find((x) => x.user_id === loc.user_id);
      const color = p ? `var(${STATUS_VAR[p.status]})` : "#9aa3b0";
      const html = `<div class="map-pin" style="background:${color}">${esc(initials(loc.name))}</div>`;
      const ic = L.divIcon({ html, className: "", iconSize: [34, 34], iconAnchor: [17, 17] });
      const popup = `<b>${esc(loc.name)}</b><br>${esc(p?.status || "Not on board")}<br><span style="color:#9aa3b0">${ago(loc.updated_at)}${loc.accuracy ? `, within ${Math.round(loc.accuracy)} m` : ""}</span>`;
      seen.add(loc.user_id);
      if (markers[loc.user_id]) {
        markers[loc.user_id].setLatLng([loc.lat, loc.lng]).setIcon(ic).setPopupContent(popup);
      } else {
        markers[loc.user_id] = L.marker([loc.lat, loc.lng], { icon: ic }).addTo(map).bindPopup(popup);
      }
    }
    Object.keys(markers).forEach((k) => { if (!seen.has(k)) { map.removeLayer(markers[k]); delete markers[k]; } });
    if (fit) {
      const pts = st.locations.map((l) => [l.lat, l.lng]);
      if (pts.length === 1) map.setView(pts[0], 16);
      else if (pts.length > 1) map.fitBounds(pts, { padding: [40, 40], maxZoom: 17 });
    }
    const list = root.querySelector("#map-list");
    if (list) {
      const sharing = st.locations.map((l) => l.user_id);
      const notSharing = st.personnel.filter((p) => !p.user_id || !sharing.includes(p.user_id));
      list.innerHTML = `
        ${st.locations.length ? `<div class="list">${st.locations.map((l) => {
          const p = st.personnel.find((x) => x.user_id === l.user_id);
          return `<button class="row" data-act="fly" data-uid="${esc(l.user_id)}">
            <div class="avatar" style="background:${p ? `var(${STATUS_VAR[p.status]})` : "#9aa3b0"}">${esc(initials(l.name))}</div>
            <div class="grow"><div class="title">${esc(l.name)}</div><div class="meta">${esc(p?.status || "Not on board")}, ${ago(l.updated_at)}</div></div>
            ${icon("pin", "sm")}</button>`;
        }).join("")}</div>` : '<p class="muted">Nobody is sharing their location yet.</p>'}
        ${notSharing.length ? `<p class="hint" style="margin-top:10px">Not sharing: ${notSharing.map((p) => esc(p.name)).join(", ")}</p>` : ""}`;
    }
  }

  function toggleLocation() {
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
      S.api.stopLocation(incidentId, S.user.id).catch(() => {});
      paint();
      return;
    }
    if (!navigator.geolocation) return toast("This device can't share location.", true);
    let first = true;
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude: lat, longitude: lng, accuracy } = pos.coords;
        S.api.shareLocation(incidentId, { lat, lng, accuracy }).catch((e) => toast(friendlyError(e), true));
        if (first && map) { map.setView([lat, lng], 17); first = false; }
      },
      (err) => {
        if (watchId !== null) navigator.geolocation.clearWatch(watchId);
        watchId = null;
        toast(err.code === 1 ? "Location permission is off. Turn it on in your phone's settings." : "Couldn't get your location.", true);
        paint();
      },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 },
    );
    paint();
  }

  // ---------------- chat ----------------
  function unread() {
    const seen = Number(localStorage.getItem(seenKey) || 0);
    return st.messages.filter((m) => new Date(m.created_at).getTime() > seen && m.user_id !== S.user.id).length;
  }

  function paintFab() {
    const el = document.getElementById("b-fab");
    if (!el) return;
    if (!active()) { el.innerHTML = ""; return; }
    const n = unread();
    el.innerHTML = chatOpen ? "" : `<button class="fab no-print" data-fab aria-label="Open chat${n ? `, ${n} unread` : ""}">${icon("chat")}${n ? `<span class="badge">${n > 9 ? "9+" : n}</span>` : ""}</button>`;
  }

  function openChat() {
    chatOpen = true;
    const d = document.createElement("div");
    d.className = "drawer";
    d.id = "chat-drawer";
    d.setAttribute("role", "dialog");
    d.setAttribute("aria-label", "Incident chat");
    d.innerHTML = `
      <div class="drawer-head"><div class="h3">Chat</div><span class="muted small">Everyone on this incident</span><button class="iconbtn ghost" data-close-chat aria-label="Close chat">${icon("close")}</button></div>
      <div class="chat-list" id="chat-list"></div>
      ${hasAccess() ? `<form class="chat-form" id="chat-form" autocomplete="off"><input class="input" name="body" placeholder="Message" maxlength="1000" enterkeyhint="send"><button class="btn primary">Send</button></form>` : ""}`;
    document.body.appendChild(d);
    d.querySelector("[data-close-chat]").addEventListener("click", closeChat);
    d.querySelector("#chat-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const inp = e.target.body;
      const body = inp.value.trim();
      if (!body) return;
      inp.value = "";
      try { await S.api.sendMessage(incidentId, body); }
      catch (ex) { inp.value = body; toast(friendlyError(ex), true); }
    });
    paintChat();
    paintFab();
  }

  function closeChat() {
    chatOpen = false;
    document.getElementById("chat-drawer")?.remove();
    paintFab();
  }

  function paintChat() {
    const list = document.getElementById("chat-list");
    if (!list) return;
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    list.innerHTML = st.messages.length ? st.messages.map((m) => {
      const mine = m.user_id === S.user.id;
      return `<div class="bubble ${mine ? "mine" : ""}">${mine ? "" : `<div class="from">${esc(m.sender)}</div>`}${esc(m.body)}<time>${clock(m.created_at)}</time></div>`;
    }).join("") : '<div class="empty"><p>No messages yet. Use chat for things that don\'t need to go over the radio.</p></div>';
    if (atBottom || !list.dataset.init) list.scrollTop = list.scrollHeight;
    list.dataset.init = "1";
    const last = st.messages[st.messages.length - 1];
    if (last) localStorage.setItem(seenKey, String(new Date(last.created_at).getTime()));
  }

  // ---------------- sheets ----------------
  function personSheet(p) {
    const self = p.user_id === S.user.id || p.member_id === S.me.id;
    const canEdit = active() && (officer() || (self && hasAccess()));
    const parOn = !!st.incident.par_started_at;
    if (!canEdit) {
      const { el, close } = openSheet({
        title: p.name,
        body: `<dl class="kv"><dt>Status</dt><dd class="c-${p.status}">${esc(p.status)}</dd><dt>Since</dt><dd>${clock(p.status_changed_at)}</dd>
          <dt>Rank</dt><dd>${esc(p.rank || "")}</dd><dt>Crew</dt><dd>${esc(p.crew || "")}</dd></dl>
          ${p.member_id && isOfficer() ? `<button class="btn block" style="margin-top:16px" data-profile>Profile and medical</button>` : ""}`,
      });
      el.querySelector("[data-profile]")?.addEventListener("click", () => { close(); openMemberProfile(p.member_id); });
      return;
    }
    const appOpts = [["", "No apparatus"], ...st.apparatus.map((a) => [a.id, a.name])];
    const { el, close } = openSheet({
      title: self ? "Your status" : p.name,
      body: `
        <div role="radiogroup" aria-label="Status">${STATUSES.map((s) => `
          <button type="button" class="option ${p.status === s ? "on" : ""}" data-status="${s}" role="radio" aria-checked="${p.status === s}">
            <span class="sw st-${s}" style="animation:none"></span>${esc(s === "IN" ? "In" : s === "OUT" ? "Out" : s === "MISSING" ? "Missing" : s)}<small>${esc(STATUS_HELP[s])}</small>
          </button>`).join("")}</div>
        ${st.apparatus.length ? `<div class="section" style="margin-top:18px">${field("Apparatus", select("apparatus_id", appOpts, p.apparatus_id || "", 'data-app'))}</div>` : ""}
        ${officer() ? `<label class="check" style="margin-top:8px"><input type="checkbox" data-noradio ${p.no_radio ? "checked" : ""}> No radio</label>` : ""}
        <div class="stack" style="margin-top:14px">
          ${parOn && !p.par_ack_at && p.status !== "OUT" ? `<button type="button" class="btn hivis block" data-ack>${self ? "I'm accounted for" : `Confirm PAR for ${esc(p.name)}`}</button>` : ""}
          ${p.member_id && isOfficer() && !self ? `<button type="button" class="btn block" data-profile>Profile and medical</button>` : ""}
          <button type="button" class="btn quiet block" data-remove>${self ? "Leave this board" : "Remove from board"}</button>
        </div>`,
    });
    const run = async (fn) => { try { await fn(); } catch (e) { toast(friendlyError(e), true); } };
    el.addEventListener("click", async (e) => {
      const s = e.target.closest("[data-status]")?.dataset.status;
      if (s) {
        if (s === "MISSING" && p.status !== "MISSING") {
          close();
          if (!(await confirmSheet({ title: `Mark ${p.name} missing?`, message: "Every device on this incident will alarm.", confirmLabel: "Mark missing", danger: true }))) return;
        } else close();
        return run(() => S.api.updatePersonnel(p.id, { status: s }));
      }
      if (e.target.closest("[data-ack]")) { close(); return run(() => S.api.ackPar(p.id)); }
      if (e.target.closest("[data-profile]")) { close(); return openMemberProfile(p.member_id); }
      if (e.target.closest("[data-remove]")) {
        close();
        if (!(await confirmSheet({ title: self ? "Leave this board?" : `Remove ${p.name}?`, message: self ? "Command will no longer see you on this incident." : "They come off the accountability board for this incident.", confirmLabel: self ? "Leave board" : "Remove", danger: true }))) return;
        return run(() => S.api.removePersonnel(p.id));
      }
    });
    el.querySelector("[data-app]")?.addEventListener("change", (e) => run(() => S.api.updatePersonnel(p.id, { apparatus_id: e.target.value || null })));
    el.querySelector("[data-noradio]")?.addEventListener("change", (e) => run(() => S.api.updatePersonnel(p.id, { no_radio: e.target.checked })));
  }

  async function addCrewSheet(maId = null) {
    if (!members.length) members = await S.api.listMembers(S.dept.id).catch(() => []);
    const onBoard = new Set(st.personnel.map((p) => p.member_id).filter(Boolean));
    const avail = members.filter((m) => !onBoard.has(m.id));
    const maOpts = [["", "Our department"], ...st.mutualAid.map((m) => [m.id, m.name])];
    const { el } = openSheet({
      title: maId ? "Add mutual aid crew" : "Add crew",
      body: `
        ${!maId && avail.length ? `
          <input class="input" placeholder="Search roster" data-search autocomplete="off" style="margin-bottom:10px">
          <div class="list" style="max-height:38dvh;overflow-y:auto" data-roster>${avail.map((m) => `
            <button type="button" class="row" data-add="${m.id}" data-name="${esc(m.name.toLowerCase())}">
              <div class="avatar" style="background:${colorFor(m.name)}">${esc(initials(m.name))}</div>
              <div class="grow"><div class="title">${esc(m.name)}</div><div class="meta">${esc([m.rank, m.crew].filter(Boolean).join(", "))}${m.user_id ? "" : ", no app"}</div></div>
              ${icon("plus", "sm")}
            </button>`).join("")}</div>
          <p class="hint">Tap names to add them as Responding. Add as many as you need.</p>
          <div class="divider">or someone not on the roster</div>` : ""}
        <form data-manual novalidate>
          ${field("Name", input("name", "", 'placeholder="First and last name"'))}
          <div class="grid2">${field("Rank", select("rank", RANKS, "Firefighter"))}${field("Status", select("status", STATUSES.filter((s) => s !== "MISSING"), "Responding"))}</div>
          ${st.mutualAid.length ? field("Department", select("mutual_aid_id", maOpts, maId || "")) : ""}
          <label class="check"><input type="checkbox" name="no_radio"> No radio</label>
          <button class="btn primary block" style="margin-top:10px">Add to board</button>
        </form>`,
    });
    const run = async (fn, okMsg) => { try { await fn(); if (okMsg) toast(okMsg); } catch (e) { toast(friendlyError(e), true); } };
    el.querySelector("[data-search]")?.addEventListener("input", (e) => {
      const q = e.target.value.trim().toLowerCase();
      el.querySelectorAll("[data-add]").forEach((r) => { r.hidden = q && !r.dataset.name.includes(q); });
    });
    el.addEventListener("click", (e) => {
      const b = e.target.closest("[data-add]");
      if (!b) return;
      b.remove();
      const m = members.find((x) => x.id === b.dataset.add);
      run(() => S.api.addPersonnel(incidentId, { member_id: m.id }), `${m.name} added.`);
    });
    el.querySelector("[data-manual]").addEventListener("submit", (e) => {
      e.preventDefault();
      const f = formData(e.target);
      if (!f.name) return toast("Enter a name.", true);
      run(() => S.api.addPersonnel(incidentId, { name: f.name, rank: f.rank, status: f.status, no_radio: f.no_radio, mutual_aid_id: f.mutual_aid_id || null }), `${f.name} added.`);
      e.target.reset();
    });
  }

  function apparatusSheet() {
    const onScene = new Set(st.apparatus.map((a) => a.name.toLowerCase()));
    const saved = (S.dept.settings?.apparatus || []).filter((u) => !onScene.has(u.name.toLowerCase()));
    const { el } = openSheet({
      title: "Add apparatus",
      body: `${saved.length ? `<div class="label">Your trucks</div>
          <div class="choice-grid" style="margin-bottom:6px">${saved.map((u, i) => `<button type="button" class="choice btn-choice" data-quick="${i}"><span>${icon("truck", "sm")} ${esc(u.name)}</span></button>`).join("")}</div>
          <p class="hint">Tap to add as Responding.</p>
          <div class="divider">or another unit</div>` : ""}
        ${field("Unit name", input("name", "", 'placeholder="e.g. Engine 1, Tanker 2"'))}
        <div class="grid2">${field("Type", select("kind", [["", "Not set"], ...APP_KINDS], ""))}${field("Status", select("status", APP_STATUSES, "Responding"))}</div>
        ${!saved.length && isOfficer() ? '<p class="hint">Save your trucks in Department and they show up here as one tap.</p>' : ""}`,
      submitLabel: "Add apparatus",
      errorText: friendlyError,
      onSubmit: async (form) => {
        const f = formData(form);
        if (!f.name) throw new Error("Give the unit a name.");
        await S.api.addApparatus(incidentId, f);
      },
    });
    el.addEventListener("click", (e) => {
      const q = e.target.closest("[data-quick]");
      if (!q) return;
      const u = saved[Number(q.dataset.quick)];
      q.remove();
      S.api.addApparatus(incidentId, { name: u.name, kind: u.kind, status: "Responding" })
        .then(() => toast(`${u.name} added.`)).catch((ex) => toast(friendlyError(ex), true));
    });
  }

  function mutualAidSheet(existing) {
    openSheet({
      title: existing ? `Edit ${existing.name}` : "Add mutual aid",
      body: `${field("Department", input("name", existing?.name || "", 'placeholder="e.g. Barry\'s Bay FD"'))}
        ${field("Status", select("status", MA_STATUSES, existing?.status || "Requested"))}
        ${field("Notes", input("notes", existing?.notes || "", 'placeholder="e.g. Tanker, ETA 15 min"'))}`,
      submitLabel: existing ? "Save" : "Add mutual aid",
      secondary: existing ? "Remove" : null,
      secondaryClass: "danger",
      onSecondary: async (close) => {
        close();
        if (!(await confirmSheet({ title: `Remove ${existing.name}?`, message: "Their personnel stay on the board.", confirmLabel: "Remove", danger: true }))) return;
        try { await S.api.removeMutualAid(existing.id); } catch (e) { toast(friendlyError(e), true); }
      },
      errorText: friendlyError,
      onSubmit: async (form) => {
        const f = formData(form);
        if (!f.name) throw new Error("Enter the department name.");
        if (existing) await S.api.updateMutualAid(existing.id, { name: f.name, status: f.status, notes: f.notes || null });
        else await S.api.addMutualAid(incidentId, f);
      },
    });
  }

  function iocancSheet() {
    const v = st.incident.iocanc || {};
    const opt = (name, opts) => select(name, ["", ...opts], v[name] || "");
    openSheet({
      title: "Arrival report (IOCANC)",
      body: `
        <p class="muted small" style="margin-bottom:14px">Fill in what you see on arrival. The radio script builds itself.</p>
        ${field("Identify", input("identify", v.identify || `${S.me.call_sign || S.me.name} on scene`, 'placeholder="e.g. Engine 1 on scene"'))}
        <div class="grid2">${field("Building", opt("building", ["Single storey residential", "Two storey residential", "Multi-unit residential", "Commercial", "Outbuilding / barn", "Vehicle", "Open area"]))}
        ${field("Conditions", opt("conditions", ["Nothing showing", "Light smoke showing", "Heavy smoke showing", "Fire showing", "Fully involved"]))}</div>
        ${field("Observations", input("observations", v.observations || "", 'placeholder="e.g. Fire on side A, second floor"'))}
        <div class="grid2">${field("Command", opt("command", ["Assuming command", "Passing command", "Transferring command"]))}
        ${field("Strategy", opt("strategy", ["Offensive", "Defensive", "Investigative", "Rescue"]))}</div>
        ${field("Command post", input("post", v.post || "", 'placeholder="e.g. Engine 1, side A"'))}
        ${field("Actions", textarea("actions", v.actions || "", 'placeholder="e.g. Interior attack, primary search"'))}
        ${field("Needs", input("needs", v.needs || "", 'placeholder="e.g. Second tanker, hydro"'))}
        <div class="mono" data-preview style="margin-top:16px;white-space:pre-wrap;font-family:var(--body);font-size:15px;color:var(--text)"></div>`,
      submitLabel: "Save and copy script",
      secondary: "Copy only",
      onSecondary: async () => { const ok = await copyText(iocancScript(formData(document.querySelector(".overlay form")))); if (ok) toast("Script copied."); },
      errorText: friendlyError,
      onOpen: (form) => {
        const prev = form.querySelector("[data-preview]");
        const upd = () => { prev.textContent = iocancScript(formData(form)) || "Your script appears here."; };
        form.addEventListener("input", upd);
        form.addEventListener("change", upd);
        upd();
      },
      onSubmit: async (form) => {
        const f = formData(form);
        await S.api.updateIncident(incidentId, { iocanc: f });
        await S.api.logNote(incidentId, `Arrival report: ${iocancScript(f)}`.slice(0, 1000)).catch(() => {});
        if (await copyText(iocancScript(f))) toast("Saved and copied.");
      },
    });
  }

  function menuSheet() {
    const inc = st.incident;
    const scanner = S.dept.scanner_url;
    const playing = scannerAudio && !scannerAudio.paused;
    const items = [];
    if (active()) items.push(["share", icon("share"), "Share this incident", "Send crew a link straight to this board"]);
    if (scanner) items.push(["scanner", icon(playing ? "stop" : "radio"), playing ? "Stop scanner" : "Listen to scanner", S.dept.scanner_label || "Live audio feed"]);
    if (active() && officer()) items.push(["iocanc", icon("radio"), "Arrival report (IOCANC)", inc.iocanc ? "Saved, tap to edit" : "Build the radio script"]);
    if (active() && officer()) items.push(["edit", icon("log"), "Edit incident details", "Name, address, call type"]);
    items.push(["download", icon("download"), "Download report", "Text file with the full log"]);
    const sun = document.documentElement.dataset.theme === "sun";
    items.push(["theme", icon(sun ? "moon" : "sun"), sun ? "Night screen" : "Sunlight screen", sun ? "Dark, for night calls" : "High contrast, for daylight"]);
    if (active() && isOfficer()) items.push(["close-inc", icon("check"), "Close incident", "Ends the board for everyone"]);
    const { el, close } = openSheet({
      title: "Incident",
      body: `<div class="list">${items.map(([k, ic, t, m]) => `<button class="row" data-k="${k}">${ic}<div class="grow"><div class="title">${t}</div><div class="meta">${esc(m)}</div></div></button>`).join("")}</div>`,
    });
    el.addEventListener("click", (e) => {
      const k = e.target.closest("[data-k]")?.dataset.k;
      if (!k) return;
      close();
      handlers[k]?.();
    });
  }

  const handlers = {
    share: async () => {
      const url = `${CONFIG.APP_URL}/#/incident/${incidentId}`;
      const text = `${st.incident.name}${st.incident.address ? `, ${st.incident.address}` : ""}. Join the board: ${url}`;
      if (navigator.share) { try { await navigator.share({ title: st.incident.name, text, url }); return; } catch { /* cancelled */ } }
      if (await copyText(text)) toast("Link copied. Paste it in your group chat.");
    },
    scanner: () => {
      if (!scannerAudio) { scannerAudio = new Audio(); scannerAudio.preload = "none"; }
      if (!scannerAudio.paused) { scannerAudio.pause(); toast("Scanner stopped."); return; }
      scannerAudio.src = S.dept.scanner_url;
      scannerAudio.play().then(() => toast(`Playing ${S.dept.scanner_label || "scanner"}.`)).catch(() => toast("That stream couldn't be played. Check the address in Department.", true));
    },
    iocanc: iocancSheet,
    theme: () => setTheme(document.documentElement.dataset.theme === "sun" ? "dark" : "sun"),
    edit: () => openSheet({
      title: "Edit incident",
      body: `${field("Incident name", input("name", st.incident.name))}${field("Address", input("address", st.incident.address || ""))}${field("Call type", input("call_type", st.incident.call_type || ""))}`,
      errorText: friendlyError,
      onSubmit: async (form) => {
        const f = formData(form);
        if (!f.name) throw new Error("Name can't be empty.");
        await S.api.updateIncident(incidentId, { name: f.name, address: f.address || null, call_type: f.call_type || null });
        reload();
      },
    }),
    download: () => download(`${slug(st.incident.name)}-${st.incident.started_at.slice(0, 10)}.txt`, reportText()),
    "close-inc": async () => {
      const inN = st.personnel.filter((p) => ["IN", "MISSING"].includes(p.status)).length;
      if (!(await confirmSheet({
        title: "Close this incident?",
        message: inN ? `${inN} ${inN === 1 ? "person is" : "people are"} still In or Missing. Closing ends the board for everyone and saves the report.` : "This ends the board for everyone and saves the report to history.",
        confirmLabel: "Close incident", danger: !!inN,
      }))) return;
      try {
        await S.api.closeIncident(incidentId);
        if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
        tab = "log";
        closeChat();
        await load();
        toast("Incident closed. Report saved.");
      } catch (e) { toast(friendlyError(e), true); }
    },
  };

  // ---------------- events ----------------
  const offClicks = bindActions(root, {
    tab: (b) => { tab = b.dataset.tab; sessionStorage.setItem("fgb_board_tab", tab); window.scrollTo(0, 0); paint(); },
    filter: (b) => { filter = filter === b.dataset.s ? null : b.dataset.s; tab = "crew"; paint(); },
    menu: menuSheet,
    person: (b) => { const p = st.personnel.find((x) => x.id === b.dataset.id); if (p) personSheet(p); },
    join: async () => { try { await S.api.joinIncident(incidentId); toast("You're on the board as Responding."); reload(); } catch (e) { toast(friendlyError(e), true); } },
    "ack-me": async () => { const me = myRow(); if (!me) return; try { await S.api.ackPar(me.id); } catch (e) { toast(friendlyError(e), true); } },
    "start-par": async () => {
      if (!(await confirmSheet({ title: "Call PAR?", message: "Every phone on this incident gets the PAR banner. Crew confirm with one tap. Call it on the radio as usual.", confirmLabel: "Call PAR" }))) return;
      iCalledPar = true;
      try { await S.api.startPar(incidentId); } catch (e) { iCalledPar = false; toast(friendlyError(e), true); }
    },
    "end-par": async () => {
      const pool = st.personnel.filter((p) => p.status !== "OUT");
      const missing = pool.filter((p) => !p.par_ack_at).map((p) => p.name);
      if (missing.length && !(await confirmSheet({ title: "Close PAR?", message: `Not confirmed: ${missing.join(", ")}. Make sure they're accounted for on the radio.`, confirmLabel: "Close PAR" }))) return;
      try { await S.api.endPar(incidentId); } catch (e) { toast(friendlyError(e), true); }
    },
    "add-crew": (b) => addCrewSheet(b.dataset.ma || null),
    "add-app": apparatusSheet,
    "del-app": async (b) => {
      const a = st.apparatus.find((x) => x.id === b.dataset.id);
      if (!(await confirmSheet({ title: `Remove ${a.name}?`, message: "Crew assigned to it stay on the board, unassigned.", confirmLabel: "Remove", danger: true }))) return;
      try { await S.api.removeApparatus(a.id); } catch (e) { toast(friendlyError(e), true); }
    },
    "on-truck": async (b) => { const me = myRow(); if (!me) return toast("Join the board first.", true); try { await S.api.updatePersonnel(me.id, { apparatus_id: b.dataset.id }); } catch (e) { toast(friendlyError(e), true); } },
    "add-ma": () => mutualAidSheet(null),
    "edit-ma": (b) => mutualAidSheet(st.mutualAid.find((x) => x.id === b.dataset.id)),
    note: () => openSheet({
      title: "Add note to log",
      body: field("Note", textarea("message", "", 'maxlength="900" placeholder="e.g. Hydro called, ETA 30 min"')),
      submitLabel: "Add note",
      errorText: friendlyError,
      onSubmit: async (form) => { const { message } = formData(form); if (!message) throw new Error("Write something first."); await S.api.logNote(incidentId, message); },
    }),
    "share-loc": toggleLocation,
    fly: (b) => { const m = markers[b.dataset.uid]; if (m && map) { map.setView(m.getLatLng(), 18); m.openPopup(); window.scrollTo({ top: 0, behavior: "smooth" }); } },
    download: () => handlers.download(),
    print: () => window.print(),
  });
  const onChange = (e) => {
    const t = e.target.closest("[data-change]");
    if (!t) return;
    const fn = t.dataset.change === "app-status" ? S.api.updateApparatus : S.api.updateMutualAid;
    fn(t.dataset.id, { status: t.value }).catch((ex) => { toast(friendlyError(ex), true); reload(); });
  };
  root.addEventListener("change", onChange);
  const fabEl = document.getElementById("b-fab");
  const onFab = (e) => { if (e.target.closest("[data-fab]")) openChat(); };
  fabEl.addEventListener("click", onFab);

  // Live clocks, refreshed in place.
  const tick = setInterval(() => {
    root.querySelectorAll("[data-since]").forEach((el) => { el.textContent = elapsed(el.dataset.since); });
    root.querySelectorAll("[data-stopwatch]").forEach((el) => { el.textContent = stopwatch(el.dataset.stopwatch); });
    const c = root.querySelector("[data-clock]");
    if (c) c.firstChild.textContent = elapsed(c.dataset.clock);
  }, 1000);

  const unsub = S.api.subscribeIncident(incidentId, (table, payload) => {
    if (table === "_status") { if (payload === "SUBSCRIBED" && st) reload(); return; }
    reload();
  });
  const onVis = () => { if (document.visibilityState === "visible") reload(); };
  document.addEventListener("visibilitychange", onVis);
  const onOnline = () => reload();
  window.addEventListener("online", onOnline);

  load().catch((e) => {
    root.querySelector("#b-body").innerHTML = `<div class="empty"><div class="h3">Couldn't open this incident</div><p>${esc(friendlyError(e))}</p><a class="btn" href="#/">Back to incidents</a></div>`;
  });

  // ---------------- report text ----------------
  function reportText() {
    const inc = st.incident;
    const lines = [];
    lines.push(`${S.dept.name.toUpperCase()}`, "INCIDENT REPORT", "".padEnd(48, "="), "");
    lines.push(`Incident:  ${inc.name}`);
    if (inc.address) lines.push(`Address:   ${inc.address}`);
    if (inc.call_type) lines.push(`Call type: ${inc.call_type}`);
    lines.push(`Started:   ${dateTime(inc.started_at)}`);
    lines.push(`Closed:    ${inc.closed_at ? dateTime(inc.closed_at) : "Still active"}`);
    lines.push(`Duration:  ${elapsed(inc.started_at, inc.closed_at || Date.now())}`, "");
    if (inc.iocanc) lines.push("ARRIVAL REPORT", iocancScript(inc.iocanc), "");
    lines.push("PERSONNEL", "".padEnd(48, "-"));
    st.personnel.forEach((p) => lines.push(`${p.name.padEnd(26)} ${String(p.status).padEnd(11)} ${[p.rank, p.crew].filter(Boolean).join(", ")}${p.no_radio ? " (no radio)" : ""}`));
    lines.push("", "APPARATUS", "".padEnd(48, "-"));
    st.apparatus.forEach((a) => lines.push(`${a.name.padEnd(26)} ${a.status}  Crew: ${st.personnel.filter((p) => p.apparatus_id === a.id).map((p) => p.name).join(", ") || "none"}`));
    if (!st.apparatus.length) lines.push("None");
    lines.push("", "MUTUAL AID", "".padEnd(48, "-"));
    st.mutualAid.forEach((m) => lines.push(`${m.name.padEnd(26)} ${m.status}${m.notes ? `  ${m.notes}` : ""}`));
    if (!st.mutualAid.length) lines.push("None");
    lines.push("", "ACTIVITY LOG", "".padEnd(48, "-"));
    [...st.events].reverse().forEach((e) => lines.push(`${clock(e.at)}  ${e.message}${e.actor && !e.message.includes(e.actor) ? `  (${e.actor})` : ""}`));
    if (st.messages.length) {
      lines.push("", "CHAT", "".padEnd(48, "-"));
      st.messages.forEach((m) => lines.push(`${clock(m.created_at)}  ${m.sender}: ${m.body}`));
    }
    lines.push("", `Generated ${dateTime(Date.now())} by Fire Ground Board`);
    return lines.join("\n");
  }

  return () => {
    alive = false;
    releaseScreen();
    offClicks();
    root.removeEventListener("change", onChange);
    fabEl?.removeEventListener("click", onFab);
    clearInterval(tick);
    unsub();
    document.removeEventListener("visibilitychange", onVis);
    window.removeEventListener("online", onOnline);
    if (watchId !== null) { navigator.geolocation.clearWatch(watchId); S.api.stopLocation(incidentId, S.user.id).catch(() => {}); }
    if (map) map.remove();
    document.getElementById("chat-drawer")?.remove();
    document.getElementById("b-fab")?.remove();
  };
}

export function iocancScript(v) {
  if (!v) return "";
  const parts = [];
  if (v.identify) parts.push(v.identify);
  if (v.building) parts.push(v.building);
  if (v.conditions) parts.push(v.conditions);
  if (v.observations) parts.push(v.observations);
  if (v.command) parts.push(`${v.command}${v.post ? `, command post ${v.post}` : ""}`);
  else if (v.post) parts.push(`Command post ${v.post}`);
  if (v.strategy) parts.push(`${v.strategy} strategy`);
  if (v.actions) parts.push(v.actions);
  if (v.needs) parts.push(`Requesting ${v.needs}`);
  return parts.map((p) => p.trim().replace(/[.\s]+$/, "")).filter(Boolean).join(". ") + (parts.length ? "." : "");
}
