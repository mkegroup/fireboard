// Owner's console. Only platform admins (MKE Group) can open it; the server
// checks every call. Money, sign-ups, departments, people, activity and alerts.
import { S } from "./state.js";
import { esc, ago, dateLabel, friendlyError, debounce } from "./util.js";
import { icon, toast, openSheet } from "./ui.js";
import { bottomNav, demoStrip, bindActions } from "./app.js";

const cad = (n, cents = true) => new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 }).format(Number(n) || 0);
const num = (n) => new Intl.NumberFormat("en-CA").format(Number(n) || 0);

const KIND = {
  signup: ["user", "Sign-up", ""],
  department: ["shield", "New department", "gold"],
  member_joined: ["user", "Joined", ""],
  member_left: ["user", "Left", ""],
  plan: ["card", "Plan", "good"],
  payment: ["card", "Payment", "good"],
  payment_failed: ["alert", "Payment failed", "bad"],
  past_due: ["alert", "Overdue", "bad"],
  canceled: ["close", "Ended", "bad"],
  cancel_scheduled: ["alert", "Cancelling", "warn"],
  quote: ["mail", "Quote request", "gold"],
  trial_ending: ["alert", "Trial ending", "warn"],
  trial_ended: ["alert", "Trial ended", "warn"],
  error: ["alert", "Error", "bad"],
  admin: ["wrench", "Admin", ""],
  test: ["check", "Test", ""],
};
const ALERT_KINDS = [
  ["payment", "Payments received"],
  ["quote", "Quote requests"],
  ["department", "New departments"],
  ["plan", "Plans chosen and going active"],
  ["signup", "New sign-ups"],
  ["past_due", "Payments overdue"],
  ["cancel_scheduled", "Someone sets their plan to cancel"],
  ["canceled", "Plans ending"],
  ["trial_ending", "Trials ending tomorrow with no plan"],
  ["trial_ended", "Trials that ended with no plan"],
  ["error", "Errors (billing, alerts, Stripe)"],
];
const FEED_FILTERS = [
  ["", "All"],
  ["payment,payment_failed,plan,past_due,canceled,cancel_scheduled", "Money"],
  ["signup,department,member_joined,member_left", "Growth"],
  ["quote", "Quotes"],
  ["trial_ending,trial_ended", "Trials"],
  ["error", "Errors"],
];
const STAGE = {
  paying: ["Paying", "good"],
  plan_set: ["Plan set, in trial", "good"],
  trial: ["Free trial", "warn"],
  overdue: ["Overdue", "bad"],
  expired: ["Trial ended", ""],
  ended: ["Cancelled", ""],
};
const WHY = { quote: "Wants a quote", overdue: "Payment overdue", trial_ending: "Trial ending soon", trial_ended: "Trial ended, no plan", error: "Error" };

const pill = (stage) => { const [l, tone] = STAGE[stage] || [stage, ""]; return `<span class="pill ${tone}">${esc(l)}</span>`; };

function eventRow(e) {
  const [ic, label, tone] = KIND[e.kind] || ["log", e.kind, ""];
  return `<div class="ev ${tone ? `t-${tone}` : ""}" ${e.dept_id ? `data-act="dept" data-id="${e.dept_id}" role="button" tabindex="0"` : ""}>
    <span class="ev-ic">${icon(ic, "sm")}</span>
    <div class="grow"><b>${esc(e.title)}</b>${e.detail ? `<span>${esc(e.detail)}</span>` : ""}<small>${esc(label)}, ${esc(ago(e.at))}</small></div>
    ${e.amount != null && e.kind === "payment" ? `<em>${cad(e.amount)}</em>` : ""}
  </div>`;
}

/** Simple bar chart: values with labels, one colour, value on top. */
function bars(values, labels, fmt = num, highlightLast = true) {
  const max = Math.max(1, ...values);
  return `<div class="bars" role="img" aria-label="${esc(values.map((v, i) => `${labels[i]}: ${fmt(v)}`).join(", "))}">${values.map((v, i) => `
    <div class="bar ${highlightLast && i === values.length - 1 ? "now" : ""}"><span>${v ? fmt(v) : ""}</span><i style="height:${Math.max(v ? 4 : 1, Math.round((v / max) * 100))}%"></i><small>${esc(labels[i])}</small></div>`).join("")}</div>`;
}

export function adminView(root) {
  let alive = true;
  let tab = sessionStorage.getItem("fgb_admin_tab") || "overview";
  let feedKind = "";
  let feed = [];
  let deptQuery = "";
  let deptStage = "";
  let userQuery = "";
  const body = () => root.querySelector("#admin-body");

  root.innerHTML = `
  ${demoStrip()}
  <div class="screen ${S.dept ? "with-nav" : ""} admin" data-notr>
    <header class="topbar"><div class="wrap topbar-in">
      ${S.dept ? "" : `<a class="iconbtn ghost" href="#/" aria-label="Back">${icon("back")}</a>`}
      <h1>Admin</h1><span class="sub">MKE Group only</span>
      <button class="iconbtn ghost" data-act="refresh" aria-label="Refresh">${icon("log")}</button>
    </div>
    <div class="wrap"><nav class="views" aria-label="Admin sections">${[["overview", "Overview"], ["activity", "Activity"], ["departments", "Departments"], ["users", "People"], ["alerts", "Alerts"]]
      .map(([k, l]) => `<button data-act="tab" data-tab="${k}" class="${tab === k ? "on" : ""}">${l}</button>`).join("")}</nav></div></header>
    <div class="wrap" id="admin-body" style="padding-top:16px;padding-bottom:40px"><div class="spinner"></div></div>
  </div>
  ${S.dept ? bottomNav("admin") : ""}`;

  const fail = (e) => { if (alive) body().innerHTML = `<div class="empty"><div class="h3">Couldn't load this</div><p>${esc(friendlyError(e))}</p><button class="btn" data-act="refresh">Try again</button></div>`; };

  // ---------------- overview ----------------
  async function overview() {
    const o = await S.api.adminOverview();
    if (!alive || tab !== "overview") return;
    const st = o.stages || {};
    const paying = (st.paying || 0) + (st.overdue || 0);
    const stageOrder = ["paying", "plan_set", "trial", "overdue", "expired", "ended"];
    const total = Math.max(1, stageOrder.reduce((t, k) => t + (st[k] || 0), 0));
    const weeks = o.weeks || [];
    const wl = weeks.map((w) => new Date(`${w.week}T12:00:00`).toLocaleDateString("en-CA", { month: "short", day: "numeric" }));
    const months = o.months || [];
    const ml = months.map((m) => new Date(`${m.month}-15T12:00:00`).toLocaleDateString("en-CA", { month: "short" }));
    const recent = await S.api.adminEvents(null, null).catch(() => []);
    if (!alive || tab !== "overview") return;
    body().innerHTML = `
      <div class="tiles">
        <div class="tile big"><small>Monthly recurring revenue</small><b>${cad(o.mrr)}</b><span>${cad(o.mrr * 12, false)} a year${o.mrr_pending ? `. Another ${cad(o.mrr_pending)} starts when trials end.` : ""}</span></div>
        <div class="tile"><small>Collected, 30 days</small><b>${cad(o.collected_30d)}</b><span>${cad(o.collected_all, false)} all time</span></div>
        <div class="tile"><small>Paying departments</small><b>${num(paying)}</b><span>${num(o.departments)} departments in total</span></div>
        <div class="tile"><small>Free trials running</small><b>${num((st.trial || 0) + (st.plan_set || 0))}</b><span>${num(st.plan_set || 0)} already picked a plan</span></div>
        <div class="tile"><small>People using the app</small><b>${num(o.seats)}</b><span>${num(o.users_active_7d)} active this week. ${num(o.phones)} iPhones.</span></div>
        <div class="tile"><small>Incidents, 30 days</small><b>${num(o.incidents_30d)}</b><span>${num(o.incidents_from_dispatch_30d)} from dispatch. ${num(o.incidents_active)} active now.</span></div>
      </div>

      ${(o.attention || []).length ? `<section class="section"><div class="section-head"><div class="h2">Needs attention</div></div>
        <div class="list">${o.attention.map((a) => `<button class="row" ${a.dept_id ? `data-act="dept" data-id="${a.dept_id}"` : `data-act="tab" data-tab="activity"`}>
          <span class="ev-ic ${a.why === "overdue" || a.why === "error" ? "t-bad" : a.why === "quote" ? "t-gold" : "t-warn"}">${icon(a.why === "quote" ? "mail" : "alert", "sm")}</span>
          <div class="grow"><div class="title">${esc(a.name)}</div><div class="meta">${esc(WHY[a.why] || a.why)}${a.at ? `, ${esc(a.why === "trial_ending" ? `ends ${dateLabel(a.at)}` : ago(a.at))}` : ""}</div></div>
          <span class="chev">${icon("chev", "sm")}</span></button>`).join("")}</div></section>` : ""}

      <section class="section">
        <div class="section-head"><div class="h2">Departments by stage</div></div>
        <div class="panel">
          <div class="stack-bar">${stageOrder.filter((k) => st[k]).map((k) => `<i class="s-${k}" style="flex:${st[k]}" title="${STAGE[k][0]}: ${st[k]}"></i>`).join("") || '<i style="flex:1"></i>'}</div>
          <div class="legend">${stageOrder.map((k) => `<span><i class="s-${k}"></i>${STAGE[k][0]} <b>${num(st[k] || 0)}</b> <small>${Math.round(((st[k] || 0) / total) * 100)}%</small></span>`).join("")}</div>
        </div>
      </section>

      <div class="cols">
        <section class="section"><div class="section-head"><div class="h2">Sign-ups per week</div><span class="muted small">${num(o.users_new_7d)} this week</span></div>
          <div class="panel">${bars(weeks.map((w) => w.users), wl)}</div></section>
        <section class="section"><div class="section-head"><div class="h2">Incidents per week</div><span class="muted small">${num(o.incidents_7d)} this week</span></div>
          <div class="panel">${bars(weeks.map((w) => w.incidents), wl)}</div></section>
      </div>
      <div class="cols">
        <section class="section"><div class="section-head"><div class="h2">Collected per month</div></div>
          <div class="panel">${bars(months.map((m) => Number(m.collected)), ml, (v) => cad(v, false))}</div></section>
        <section class="section"><div class="section-head"><div class="h2">New departments per week</div></div>
          <div class="panel">${bars(weeks.map((w) => w.departments), wl)}</div></section>
      </div>

      <section class="section"><div class="section-head"><div class="h2">Latest</div><button class="btn sm quiet" data-act="tab" data-tab="activity">See all</button></div>
        <div class="panel feed">${recent.slice(0, 8).map(eventRow).join("") || '<p class="muted">Nothing yet.</p>'}</div></section>`;
  }

  // ---------------- activity ----------------
  async function activity(more = false) {
    const kinds = feedKind.split(",").filter(Boolean);
    const before = more && feed.length ? feed[feed.length - 1].id : null;
    // One kind is filtered on the server. Groups are filtered here.
    const rows = await S.api.adminEvents(before, kinds.length === 1 ? kinds[0] : null);
    if (!alive || tab !== "activity") return;
    const got = kinds.length > 1 ? rows.filter((e) => kinds.includes(e.kind)) : rows;
    feed = more ? feed.concat(got) : got;
    body().innerHTML = `
      <div class="segment" role="radiogroup" aria-label="Show">${FEED_FILTERS.map(([k, l]) => `<button data-act="feed" data-k="${k}" class="${feedKind === k ? "on" : ""}" role="radio" aria-checked="${feedKind === k}">${l}</button>`).join("")}</div>
      <div class="panel feed" style="margin-top:12px">${feed.map(eventRow).join("") || '<p class="muted">Nothing here yet.</p>'}</div>
      ${rows.length === 100 ? '<button class="btn block" style="margin-top:12px" data-act="more">Load older</button>' : ""}`;
  }

  // ---------------- departments ----------------
  async function departments() {
    const list = await S.api.adminDepartments(deptQuery);
    if (!alive || tab !== "departments") return;
    const shown = deptStage ? list.filter((d) => d.stage === deptStage) : list;
    const counts = list.reduce((m, d) => ((m[d.stage] = (m[d.stage] || 0) + 1), m), {});
    const hadFocus = document.activeElement?.id === "dept-q";
    body().innerHTML = `
      <input class="input" id="dept-q" type="search" placeholder="Search departments or owner email" value="${esc(deptQuery)}" autocomplete="off">
      <div class="segment" style="margin-top:10px">${[["", `All ${list.length}`], ...Object.keys(STAGE).filter((k) => counts[k]).map((k) => [k, `${STAGE[k][0]} ${counts[k]}`])]
        .map(([k, l]) => `<button data-act="stage" data-k="${k}" class="${deptStage === k ? "on" : ""}">${esc(l)}</button>`).join("")}</div>
      <div class="list" style="margin-top:12px">${shown.map((d) => `
        <button class="row" data-act="dept" data-id="${d.id}">
          <div class="grow"><div class="title">${esc(d.name)}</div>
            <div class="meta">${esc(d.owner_email || "no owner")}. ${num(d.seat_count)} with the app. ${d.last_seen ? `Seen ${esc(ago(d.last_seen))}` : "Not seen yet"}.</div></div>
          <div class="adm-right">${pill(d.stage)}${d.mrr ? `<small>${cad(d.mrr)}/mo</small>` : d.stage === "trial" ? `<small>ends ${esc(dateLabel(d.trial_ends_at))}</small>` : ""}</div>
        </button>`).join("") || '<div class="empty"><p>No departments match.</p></div>'}</div>`;
    const q = body().querySelector("#dept-q");
    q.addEventListener("input", debounce(() => { deptQuery = q.value.trim(); departments().catch(fail); }, 300));
    if (hadFocus) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
  }

  async function deptSheet(id) {
    let r;
    try { r = await S.api.adminDepartment(id); } catch (e) { return toast(friendlyError(e), true); }
    const d = r.dept;
    const u = r.usage || {};
    const owner = r.members.find((m) => m.role === "owner");
    const stripe = (path, idv) => idv ? `<a class="btn sm" href="https://dashboard.stripe.com/${path}/${esc(idv)}" target="_blank" rel="noopener">${icon("card", "sm")} Stripe ${path === "customers" ? "customer" : "subscription"}</a>` : "";
    const { el } = openSheet({
      title: d.name,
      wide: true,
      body: `
        <div class="adm-head">${pill(d.stage)}<span class="muted small">Created ${esc(dateLabel(d.created_at))}</span></div>
        <dl class="kv" style="margin-top:12px">
          <dt>Plan</dt><dd>${d.plan_interval ? `${d.plan_custom ? "Custom, " : ""}${d.plan_interval === "year" ? "Yearly" : "Monthly"}${d.plan_invoice ? " by invoice" : " by card"}` : "None yet"}</dd>
          <dt>Pays</dt><dd>${d.plan_amount != null ? `${cad(d.plan_amount)} a ${d.plan_interval === "year" ? "year" : "month"} (${cad(d.mrr)}/mo)` : `${cad(d.mrr)}/mo if they sign up today`}</dd>
          <dt>Trial</dt><dd>${new Date(d.trial_ends_at) > new Date() ? "Ends" : "Ended"} ${esc(dateLabel(d.trial_ends_at))}</dd>
          ${d.current_period_end ? `<dt>Renews</dt><dd>${esc(dateLabel(d.current_period_end))}</dd>` : ""}
          ${d.plan_cancel_at ? `<dt>Cancelling</dt><dd class="c-bad">${esc(dateLabel(d.plan_cancel_at))}</dd>` : ""}
          ${d.past_due_since ? `<dt>Overdue since</dt><dd class="c-bad">${esc(dateLabel(d.past_due_since))}</dd>` : ""}
          <dt>With the app</dt><dd>${num(d.seat_count)} of ${num(r.members.length)} on the roster</dd>
          <dt>iPhones</dt><dd>${num(u.phones)}</dd>
          <dt>Incidents</dt><dd>${num(u.incidents_total)} total</dd>
          <dt>From dispatch</dt><dd>${num(u.dispatch_30d)} in 30 days</dd>
          <dt>Chat</dt><dd>${num(u.messages_30d)} messages in 30 days</dd>
          <dt>Training, equipment</dt><dd>${num(u.training_sessions)} sessions, ${num(u.equipment)} items</dd>
          <dt>Group chat link</dt><dd>${u.group_chat ? "Connected" : "No"}</dd>
        </dl>
        <div class="btn-row" style="margin-top:14px">
          ${owner?.email ? `<a class="btn sm primary" href="mailto:${esc(owner.email)}?subject=${encodeURIComponent(`Fire Ground Board for ${d.name}`)}">${icon("mail", "sm")} Email the owner</a>` : ""}
          ${stripe("customers", d.stripe_customer_id)}${stripe("subscriptions", d.stripe_subscription_id)}
        </div>
        <div class="label" style="margin-top:16px">Give more free time</div>
        <div class="btn-row">${[7, 14, 30, 90].map((n) => `<button class="btn sm" data-extend="${n}">+${n} days</button>`).join("")}</div>

        <div class="section"><div class="h3" style="margin-bottom:8px">People</div>
          <div class="list">${r.members.map((m) => `<div class="row"><div class="grow"><div class="title" style="font-size:16px">${esc(m.name)} <span class="faint small">${esc(m.role === "member" ? m.rank : m.role)}</span></div>
            <div class="meta">${m.email ? esc(m.email) : "Roster only, no app"}${m.phone ? `, ${esc(m.phone)}` : ""}</div></div>
            <span class="faint small">${m.last_seen ? esc(ago(m.last_seen)) : ""}</span></div>`).join("")}</div></div>

        ${r.incidents.length ? `<div class="section"><div class="h3" style="margin-bottom:8px">Recent incidents</div>
          <div class="list">${r.incidents.map((i) => `<div class="row"><div class="grow"><div class="title" style="font-size:16px">${esc(i.name)}</div>
            <div class="meta">${esc(i.address || "No address")}, ${esc(dateLabel(i.started_at))}${i.source !== "app" ? `, from ${esc(i.source === "email" ? "dispatch email" : "dispatch")}` : ""}</div></div>
            <span class="pill ${i.status === "active" ? "live" : ""}">${esc(i.status)}</span></div>`).join("")}</div></div>` : ""}

        ${r.events.length ? `<div class="section"><div class="h3" style="margin-bottom:8px">History</div><div class="panel feed">${r.events.map(eventRow).join("")}</div></div>` : ""}`,
    });
    el.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-extend]");
      if (!b) return;
      b.disabled = true;
      try { const t = await S.api.adminExtendTrial(id, Number(b.dataset.extend)); toast(`Free until ${dateLabel(t)}.`); }
      catch (ex) { toast(friendlyError(ex), true); }
      b.disabled = false;
    });
  }

  // ---------------- people ----------------
  async function users() {
    const list = await S.api.adminUsers(userQuery);
    if (!alive || tab !== "users") return;
    const hadFocus = document.activeElement?.id === "user-q";
    body().innerHTML = `
      <input class="input" id="user-q" type="search" placeholder="Search email or name" value="${esc(userQuery)}" autocomplete="off">
      <p class="muted small" style="margin:10px 0">${num(list.length)} ${list.length === 1 ? "person" : "people"}${list.length === 500 ? " (newest 500)" : ""}</p>
      <div class="list">${list.map((u) => `
        <div class="row" ${u.departments[0] ? `data-act="dept" data-id="${u.departments[0].dept_id}" role="button" tabindex="0"` : ""}>
          <div class="grow"><div class="title" style="font-size:16px">${esc(u.email || "(no email)")}</div>
            <div class="meta">${u.departments.length ? u.departments.map((d) => `${esc(d.name)} (${esc(d.role)})`).join(", ") : "No department yet"}</div></div>
          <div class="adm-right"><small>Joined ${esc(dateLabel(u.created_at))}</small><small>${u.last_sign_in_at ? `Seen ${esc(ago(u.last_sign_in_at))}` : "Never signed in"}${u.has_iphone ? ", iPhone" : ""}</small></div>
        </div>`).join("") || '<div class="empty"><p>No one matches.</p></div>'}</div>`;
    const q = body().querySelector("#user-q");
    q.addEventListener("input", debounce(() => { userQuery = q.value.trim(); users().catch(fail); }, 300));
    if (hadFocus) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
  }

  // ---------------- alerts ----------------
  async function alerts() {
    const s = await S.api.adminSettings();
    if (!alive || tab !== "alerts") return;
    const on = new Set(s.alerts || []);
    body().innerHTML = `
      <div class="panel">
        <div class="h3">Alerts on your iPhone</div>
        <p class="muted small" style="margin:6px 0 12px">${s.phones ? `Going to ${s.phones} iPhone${s.phones === 1 ? "" : "s"} signed in to your account.` : "Sign in to the Fire Ground iPhone app with this account and allow alerts. Until then they only show here."}</p>
        ${ALERT_KINDS.map(([k, l]) => `<label class="check"><input type="checkbox" data-alert="${k}" ${on.has(k) ? "checked" : ""}> ${l}</label>`).join("")}
        <div class="btn-row" style="margin-top:12px"><button class="btn" data-act="test-alert">${icon("check", "sm")} Send a test alert</button></div>
        <p class="hint">Everything also shows under Activity, alert or not. To get these in Slack or Discord too, add the ADMIN_WEBHOOK_URL secret in Supabase.</p>
      </div>`;
    body().addEventListener("change", async (e) => {
      if (!e.target.matches("[data-alert]")) return;
      const list = [...body().querySelectorAll("[data-alert]:checked")].map((x) => x.dataset.alert).concat("test");
      try { await S.api.adminSetAlerts(list); toast("Saved."); } catch (ex) { toast(friendlyError(ex), true); }
    });
  }

  const views = { overview, activity: () => activity(false), departments, users, alerts };
  const paint = () => {
    body().innerHTML = '<div class="spinner"></div>';
    root.querySelectorAll('.views [data-act="tab"]').forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    return views[tab]().catch(fail);
  };

  const off = bindActions(root, {
    tab: (b) => { tab = b.dataset.tab; try { sessionStorage.setItem("fgb_admin_tab", tab); } catch { /* private mode */ } paint(); },
    refresh: () => paint(),
    feed: (b) => { feedKind = b.dataset.k; activity(false).catch(fail); },
    more: () => activity(true).catch(fail),
    stage: (b) => { deptStage = b.dataset.k; departments().catch(fail); },
    dept: (b) => deptSheet(b.dataset.id),
    "test-alert": async (b) => {
      b.disabled = true;
      try { await S.api.adminTestAlert(); toast("Test alert sent. Check your iPhone."); } catch (e) { toast(friendlyError(e), true); }
      b.disabled = false;
    },
  });
  paint();
  // Fresh numbers when coming back to the app.
  const onVis = () => { if (!document.hidden && tab === "overview") overview().catch(() => {}); };
  document.addEventListener("visibilitychange", onVis);
  return () => { alive = false; off(); document.removeEventListener("visibilitychange", onVis); };
}
