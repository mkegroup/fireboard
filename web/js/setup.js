// Guided setup. A chief who just started a department is walked through it one screen at a time, and every step
// is done right there: no hunting through menus. Any step can be skipped and finished later from the home screen.
// Crew who join get a short version: how the board works and call alerts.
import { CONFIG, IS_NATIVE } from "./config.js";
import { S, RANKS, CREWS, APP_KINDS, isOfficer, go } from "./state.js";
import { esc, copyText, friendlyError, parseRoster } from "./util.js";
import { icon, toast, field, input, select, textarea } from "./ui.js";
import { askForPush, pushState } from "./native.js";
import { refreshDept, bindActions, logo, demoStrip } from "./app.js";
import { track } from "./track.js";
import { t } from "./i18n.js";

const PROVINCES = [["", "Choose one"], ["ON", "Ontario"], ["QC", "Quebec"], ["NS", "Nova Scotia"], ["NB", "New Brunswick"], ["MB", "Manitoba"],
  ["BC", "British Columbia"], ["PE", "Prince Edward Island"], ["SK", "Saskatchewan"], ["AB", "Alberta"], ["NL", "Newfoundland and Labrador"],
  ["YT", "Yukon"], ["NT", "Northwest Territories"], ["NU", "Nunavut"], ["US", "United States"]];
const SIZES = [["", "Choose one"], ["under20", "Under 20"], ["20to40", "20 to 40"], ["40to60", "40 to 60"], ["60plus", "More than 60"]];
const QUICK = ["Engine", "Pumper", "Tanker", "Rescue", "Brush", "Ladder", "Command"];

const CHIEF = ["dept", "trucks", "people", "invite", "alerts", "try"];
const CREW = ["how", "alerts"];

const key = () => `fgb_setup_${S.dept?.id}`;
const stepOf = () => { try { return localStorage.getItem(key()) || ""; } catch { return ""; } };
const remember = (s) => { try { localStorage.setItem(key(), s); } catch { /* private mode */ } };

export function setupDone() {
  return !!S.dept?.settings?.setup_done;
}

async function saveSettings(patch) {
  await S.api.updateDepartment(S.dept.id, { settings: { ...(S.dept.settings || {}), ...patch } });
  await refreshDept();
}

export function setupView(root, mode) {
  const crew = mode === "crew" || !isOfficer();
  const steps = crew ? CREW : CHIEF;
  let i = Math.max(0, steps.indexOf(stepOf()));
  if (crew) i = 0;
  let poll = null;
  let alive = true;

  const bar = () => `<div style="display:flex;gap:4px;margin:14px 0 18px">${steps.map((_, n) => `<i style="flex:1;height:5px;border-radius:9px;background:${n <= i ? "var(--red,#e5332a)" : "var(--line,#2e2f33)"}"></i>`).join("")}</div>`;

  async function paint() {
    if (!alive) return;
    clearInterval(poll);
    const s = steps[i];
    if (!crew) remember(s);
    const body = await (BODIES[s] || (() => ""))();
    if (!alive) return;
    const last = i === steps.length - 1;
    root.innerHTML = `
    ${demoStrip()}
    <div class="screen">
      <div class="wrap" style="padding-top:calc(20px + env(safe-area-inset-top));max-width:560px;padding-bottom:40px">
        <div style="display:flex;align-items:center;gap:10px"><div style="width:150px">${logo()}</div><div class="grow"></div>
          <span class="muted small">${t("Step {a} of {b}", { a: i + 1, b: steps.length })}</span></div>
        ${bar()}
        <div data-step="${s}">${body}</div>
        <div style="display:flex;gap:8px;margin-top:22px;align-items:center">
          ${i > 0 ? `<button class="btn quiet" data-act="back">${icon("back", "sm")} Back</button>` : ""}
          <div class="grow"></div>
          ${crew || last ? "" : `<button class="btn quiet" data-act="skip">Skip for now</button>`}
          <button class="btn primary" data-act="next">${last ? (crew ? "Go to the board" : "Finish") : "Next"} ${last ? "" : icon("chev", "sm")}</button>
        </div>
        ${crew ? "" : `<div style="text-align:center;margin-top:18px"><button class="btn quiet sm" data-act="later">Finish setup later</button></div>`}
      </div>
    </div>`;
    window.scrollTo(0, 0);
    WIRE[s]?.();
  }

  // ---------------------------------------------------------------- the steps
  const BODIES = {
    dept: () => {
      const p = S.dept.settings?.profile || {};
      return `<div class="h2" style="font-size:28px">${t("Let's get {dept} ready", { dept: S.dept.name })}</div>
      <p class="muted" style="margin:6px 0 16px">About 5 minutes. You can skip anything and come back to it.</p>
      <form class="panel" id="st-dept" novalidate>
        <div class="h3" style="margin-bottom:10px">Your department</div>
        <div class="grid2">${field("Province or state", select("province", PROVINCES, p.province || ""))}
        ${field("Town or area", input("town", p.town || "", 'autocapitalize="words" placeholder="e.g. Huntsville"'))}</div>
        ${field("How many members?", select("size", SIZES, p.size || ""))}
        ${field("Best phone number for you", input("phone", p.phone || "", 'type="tel" inputmode="tel" autocomplete="tel" placeholder="Optional"'),
          "Only used if you want a hand getting set up. Never shared.")}
      </form>`;
    },
    trucks: () => {
      const list = S.dept.settings?.apparatus || [];
      return `<div class="h2" style="font-size:28px">Add your trucks</div>
      <p class="muted" style="margin:6px 0 16px">They become one-tap choices on every call, so command sees who's on what. Tap to add.</p>
      <div class="panel">
        <div style="display:flex;flex-wrap:wrap;gap:8px">${QUICK.map((k) => `<button class="btn sm" data-act="quick-truck" data-k="${k}">${icon("plus", "sm")} ${esc(t(k))}</button>`).join("")}</div>
        <form id="st-truck" style="display:flex;gap:8px;margin-top:12px" novalidate>
          ${input("name", "", 'placeholder="Or type a name, like Tanker 2" style="flex:1"')}
          ${select("kind", APP_KINDS, "Engine", 'aria-label="Type" style="width:auto"')}
          <button class="btn">Add</button></form>
        <div style="margin-top:14px">${list.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px">${list.map((a, n) => `<span class="chip">${icon("truck", "sm")}${esc(a.name)} <button data-act="del-truck" data-i="${n}" class="faint" aria-label="Remove ${esc(a.name)}">${icon("close", "sm")}</button></span>`).join("")}</div>`
          : `<p class="muted small">No trucks yet.</p>`}</div>
      </div>`;
    },
    people: async () => {
      const members = await S.api.listMembers(S.dept.id).catch(() => []);
      const noApp = members.filter((m) => !m.user_id).length;
      return `<div class="h2" style="font-size:28px">Add your people</div>
      <p class="muted" style="margin:6px 0 16px">Put your whole roster on now. People without the app can still go on the board, and they're free. When someone joins with the code, they match up.</p>
      <form class="panel" id="st-people" novalidate>
        ${field("Paste names, one per line", textarea("roster", "", 'rows="7" placeholder="Dan Smith, Captain\nSam Riopelle\nTess MacDonald, Lieutenant, 613 555 0100"'),
          "Rank and phone are optional. Copy straight from a spreadsheet or your call list.")}
        <p class="hint" data-count></p>
        <button class="btn primary" data-act="add-people">Add them</button>
        <p class="muted small" style="margin-top:12px">${t("On your roster now: {n}", { n: members.length })}${noApp ? ` ${t("({n} without the app)", { n: noApp })}` : ""}</p>
      </form>`;
    },
    invite: () => {
      const link = `${CONFIG.APP_URL}/#/join/${S.dept.invite_code}`;
      const qr = window.qrcode ? (() => { const q = window.qrcode(0, "M"); q.addData(link); q.make(); return q.createSvgTag({ cellSize: 5, margin: 0, scalable: true }); })() : "";
      const seats = Math.max(0, (S.dept.seat_count || 1) - 1);
      return `<div class="h2" style="font-size:28px">Invite your crew</div>
      <p class="muted" style="margin:6px 0 16px">Send this to your department's group chat. They download the app or open the link, make an account and they're on your board.</p>
      <div class="panel" style="text-align:center">
        <div class="muted small">Invite code</div>
        <div class="code-box" style="margin:6px auto 14px">${esc(S.dept.invite_code)}</div>
        <div class="btn-row" style="justify-content:center;flex-wrap:wrap">
          <button class="btn primary" data-act="share">${icon("share", "sm")} Share invite</button>
          <a class="btn" href="sms:?&body=${encodeURIComponent(inviteText(link))}">Text it</a>
          <button class="btn" data-act="copy">Copy link</button>
        </div>
        ${qr ? `<details class="more" style="margin-top:14px;text-align:left"><summary class="muted small">Show a QR code to scan at the station</summary><div class="qr" style="max-width:220px;margin:12px auto 0">${qr}</div></details>` : ""}
        <div class="banner ${seats ? "" : "warn"}" style="margin-top:16px;text-align:left" data-joined>${icon("user")}<div class="grow">${seats ? `<b>${t("{n} joined so far", { n: seats })}</b>` : "<b>Waiting for your first crew member</b>"}<br><span class="muted small">This updates by itself.</span></div></div>
      </div>`;
    },
    alerts: async () => {
      const st = S.api.isDemo ? "on" : await pushState().catch(() => "unsupported");
      const ok = st === "on" || st === "granted";
      const can = st === "ask";
      return `<div class="h2" style="font-size:28px">Turn on call alerts</div>
      <p class="muted" style="margin:6px 0 16px">${crew ? "Your phone sounds when a call starts, when command calls a PAR, and if someone is marked Missing. Even with the app closed." : "Get buzzed for new calls, PAR checks and Missing firefighters, even with the app closed. Your crew gets the same prompt when they join."}</p>
      <div class="panel" style="text-align:center;padding:24px">
        ${ok ? `<div class="h3">${icon("check")} Alerts are on for this device</div>`
          : can ? `<button class="btn primary" data-act="alerts">${icon("alert", "sm")} Turn on alerts</button>`
          : `<p class="muted">${IS_NATIVE ? "Turn them on in iPhone Settings, Fire Ground, Notifications." : "This browser can't show alerts. Get the iPhone app, or use Chrome on Android or a computer."}</p>
             ${IS_NATIVE ? "" : `<a class="btn" href="${esc(CONFIG.APP_STORE_URL || "https://apps.apple.com/app/fire-ground-board/id6833654518")}" target="_blank" rel="noopener">Get the iPhone app</a>`}`}
      </div>`;
    },
    try: () => `<div class="h2" style="font-size:28px">Try it once</div>
      <p class="muted" style="margin:6px 0 16px">Two minutes, best at your next training night. Start a practice incident, have the crew tap I'm responding, then call a PAR and watch the board fill in.</p>
      <div class="panel">
        <div class="setup-steps">
          <div class="setup-step"><span class="tick num">1</span><span class="grow"><b>Start a practice incident</b><small>It's named Practice, so it's easy to tell apart.</small></span></div>
          <div class="setup-step"><span class="tick num">2</span><span class="grow"><b>Tap a name to change status</b><small>Responding, In, Out, Rehab. Command sees it right away.</small></span></div>
          <div class="setup-step"><span class="tick num">3</span><span class="grow"><b>Call a PAR</b><small>Every phone sounds. Anyone who doesn't answer is flagged.</small></span></div>
          <div class="setup-step"><span class="tick num">4</span><span class="grow"><b>Close it</b><small>The report is saved under Recent.</small></span></div>
        </div>
        <button class="btn primary block" style="margin-top:14px" data-act="practice">${icon("flame", "sm")} Start a practice incident now</button>
        <a class="btn quiet block" style="margin-top:8px" href="#/guide">Read the full guide</a>
      </div>`,
    how: () => `<div class="h2" style="font-size:28px">${t("You're on {dept}'s board", { dept: S.dept.name })}</div>
      <p class="muted" style="margin:6px 0 16px">Here's all you need to know.</p>
      <div class="panel"><div class="setup-steps">
        <div class="setup-step"><span class="tick num">1</span><span class="grow"><b>Paged?</b><small>Open the app and tap I'm responding on the incident.</small></span></div>
        <div class="setup-step"><span class="tick num">2</span><span class="grow"><b>On scene</b><small>Tap your name to change your status. Command sees it right away.</small></span></div>
        <div class="setup-step"><span class="tick num">3</span><span class="grow"><b>PAR called</b><small>Your phone sounds. Tap I'm accounted for.</small></span></div>
      </div></div>`,
  };

  const inviteText = (link) => `${t("Join {dept} on Fire Ground Board. Invite code: {code}", { dept: S.dept.name, code: S.dept.invite_code })}\n${link}`;

  // ---------------------------------------------------------------- what each step does
  const WIRE = {
    people: () => {
      const ta = root.querySelector('[name="roster"]'), out = root.querySelector("[data-count]");
      ta?.addEventListener("input", () => { const n = parseRoster(ta.value, RANKS, CREWS).length; out.textContent = n ? t("{n} people ready to add", { n }) : ""; });
    },
    invite: () => {
      // Watch for crew joining while the chief is on this screen.
      poll = setInterval(async () => { if (!alive) return; const before = S.dept.seat_count; await refreshDept(); if (S.dept.seat_count !== before && steps[i] === "invite") paint(); }, 8000);
    },
  };

  async function saveDept() {
    const f = root.querySelector("#st-dept");
    if (!f) return;
    const v = (n) => (f.querySelector(`[name="${n}"]`)?.value || "").trim();
    const profile = { province: v("province"), town: v("town").slice(0, 60), size: v("size"), phone: v("phone").replace(/[^\d+()\-. x]/g, "").slice(0, 30) };
    await saveSettings({ profile });
    track("setup_dept", `${profile.town || ""} ${profile.province || ""}`.trim());
  }

  async function addTruck(name, kind) {
    const list = [...(S.dept.settings?.apparatus || [])];
    if (list.some((a) => a.name.toLowerCase() === name.toLowerCase())) return toast("That truck is already on the list.", true);
    if (list.length >= 30) return toast("That's the limit of 30 trucks.", true);
    list.push({ name: name.slice(0, 40), kind });
    await saveSettings({ apparatus: list });
    paint();
  }

  async function finish() {
    if (!crew) {
      try { await saveSettings({ setup_done: true }); } catch { /* not fatal */ }
      track("setup_done", "finished guided setup");
    } else {
      try { localStorage.setItem(`fgb_howto_${S.dept.id}`, "1"); } catch { /* private mode */ }
    }
    go("#/");
  }

  const off = bindActions(root, {
    back: () => { i = Math.max(0, i - 1); paint(); },
    skip: () => { i = Math.min(steps.length - 1, i + 1); if (!crew) remember(steps[i]); paint(); },
    later: () => go("#/"),
    next: async (b) => {
      b.disabled = true;
      try {
        if (i === steps.length - 1) return finish();
        // Saving can redraw the app; it picks up where we left off from this.
        if (!crew) remember(steps[i + 1]);
        if (steps[i] === "dept") await saveDept();
        i += 1;
        paint();
      } catch (e) { toast(friendlyError(e), true); b.disabled = false; }
    },
    "quick-truck": (b) => {
      const k = b.dataset.k, list = S.dept.settings?.apparatus || [];
      let n = 1;
      while (list.some((a) => a.name.toLowerCase() === `${k} ${n}`.toLowerCase())) n += 1;
      addTruck(`${t(k)} ${n}`, k).catch((e) => toast(friendlyError(e), true));
    },
    "del-truck": async (b) => {
      const list = [...(S.dept.settings?.apparatus || [])];
      list.splice(Number(b.dataset.i), 1);
      try { await saveSettings({ apparatus: list }); paint(); } catch (e) { toast(friendlyError(e), true); }
    },
    "add-people": async (b) => {
      const people = parseRoster(root.querySelector('[name="roster"]').value, RANKS, CREWS);
      if (!people.length) return toast("Paste at least one name.", true);
      b.disabled = true;
      try { await S.api.importRoster(S.dept.id, people); toast(t("Added {n} to your roster.", { n: people.length })); track("setup_roster", `${people.length} people`); paint(); }
      catch (e) { toast(friendlyError(e), true); b.disabled = false; }
    },
    share: async () => {
      const text = inviteText(`${CONFIG.APP_URL}/#/join/${S.dept.invite_code}`);
      if (navigator.share) { try { await navigator.share({ title: t("Fire Ground Board invite"), text }); track("setup_invite", "shared the invite"); return; } catch { /* cancelled */ } }
      if (await copyText(text)) toast("Invite copied. Paste it in your group chat.");
    },
    copy: async () => { if (await copyText(`${CONFIG.APP_URL}/#/join/${S.dept.invite_code}`)) toast("Link copied."); },
    alerts: async () => {
      const ok = await askForPush();
      if (!ok && !IS_NATIVE) toast("Alerts weren't turned on. If you blocked them, allow notifications for this site in your browser settings.", true);
      paint();
    },
    practice: async (b) => {
      b.disabled = true;
      try {
        try { await saveSettings({ setup_done: true }); } catch { /* not fatal */ }
        const id = await S.api.startIncident(S.dept.id, { name: t("Practice"), address: "", call_type: "Other" });
        track("setup_practice", "started a practice incident");
        go(`#/incident/${id}`);
      } catch (e) { toast(friendlyError(e), true); b.disabled = false; }
    },
  });

  root.addEventListener("submit", onSubmit);
  async function onSubmit(e) {
    if (e.target.id === "st-truck") {
      e.preventDefault();
      const name = e.target.querySelector('[name="name"]').value.trim();
      if (!name) return toast("Enter the truck's name, like Engine 1.", true);
      addTruck(name, e.target.querySelector('[name="kind"]').value).catch((x) => toast(friendlyError(x), true));
    } else if (e.target.id === "st-dept" || e.target.id === "st-people") e.preventDefault();
  }

  paint().catch((e) => toast(friendlyError(e), true));
  return () => { alive = false; clearInterval(poll); off(); root.removeEventListener("submit", onSubmit); };
}
