import { CONFIG, HAS_BACKEND, IS_NATIVE } from "./config.js";
import { createApi } from "./api.js";
import { createDemoApi } from "./demo.js";
import { S, RANKS, CREWS, CALL_TYPES, APP_KINDS, isOfficer, isOwner, hasAccess, planLabel, go } from "./state.js";
import { esc, initials, colorFor, dateTime, dateLabel, elapsed, ago, daysUntil, download, csv, todayISO, formData, copyText, friendlyError, applyTheme, getTheme, setTheme, soundOn, setSound, alertTone } from "./util.js";
import { icon, toast, openSheet, confirmSheet, field, input, select, textarea } from "./ui.js";
import { boardView } from "./board.js";
import { startPush, stopPush, pushState, askForPush, settleViewport } from "./native.js";
import { recordsView, openMemberProfile } from "./records.js";
import { connectionsView } from "./connections.js";
import { mountChat, lastSeen } from "./chat.js";
import { adminView } from "./admin.js";
import { openImport } from "./importer.js";
import { bestDirections, addressPicker } from "./maps.js";
import { getLocale, getLang, setLang, LANGS, startTranslating, t } from "./i18n.js";

const root = document.getElementById("root");

// Never run inside someone else's page (clickjacking). GitHub Pages can't send
// a frame-ancestors header, so this is done here.
if (window.top !== window.self) {
  document.documentElement.innerHTML = "";
  try { window.top.location = window.self.location.href; } catch { /* blocked */ }
  throw new Error("framed");
}

document.addEventListener("click", (e) => {
  if (e.target.closest("[data-reload]")) location.reload();
  if (e.target.closest("[data-global=switch]")) { e.preventDefault(); switchDeptSheet(); }
});

if ("serviceWorker" in navigator && location.protocol === "https:") {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
let cleanup = null;
let pendingJoinCode = null;

// ============================================================
// Boot
// ============================================================
async function boot() {
  settleViewport();
  applyTheme();
  startTranslating();
  const params = new URLSearchParams(location.search);
  const joinMatch = location.hash.match(/^#\/join\/([A-Za-z0-9]{4,10})/);
  if (joinMatch) pendingJoinCode = joinMatch[1].toUpperCase();
  if (params.get("join")) pendingJoinCode = params.get("join").toUpperCase();
  // Keep the invite code through the confirm-your-email step, which reloads the app.
  try {
    if (pendingJoinCode) localStorage.setItem("fgb_join", pendingJoinCode);
    else pendingJoinCode = localStorage.getItem("fgb_join");
  } catch { /* private mode */ }

  const wantDemo = params.has("demo") || sessionStorage.getItem("fgb_demo") === "1";
  if (wantDemo || !HAS_BACKEND) {
    if (wantDemo) return startDemo();
    return renderAuth("email");
  }

  S.api = createApi();
  S.api.onAuth(async (event, session) => {
    if (event === "PASSWORD_RECOVERY") return renderNewPassword();
    if (event === "SIGNED_OUT") { stationOff?.(); stationOff = null; S.user = null; S.dept = null; S.me = null; return renderAuth("email"); }
    if (event === "SIGNED_IN" && session && !S.user) { S.user = session.user; await afterSignIn(); }
  });
  const session = await S.api.getSession();
  if (!session) return renderAuth("email");
  S.user = session.user;
  await afterSignIn();

  if (params.get("billing")) {
    const b = params.get("billing");
    if (b === "success") toast("You're all set. Your plan is saved.");
    if (b === "cancel") toast("Checkout closed. Nothing was charged.");
    history.replaceState(null, "", location.pathname + (IS_NATIVE ? location.hash : "#/plan"));
    route();
    // Stripe tells us about the new plan a few seconds later.
    [2500, 8000, 20000].forEach((ms) => setTimeout(refreshDept, ms));
  }
}

async function startDemo() {
  sessionStorage.setItem("fgb_demo", "1");
  document.documentElement.classList.add("is-demo");
  S.api = createDemoApi();
  const session = await S.api.getSession();
  S.user = session.user;
  await afterSignIn();
}

function exitDemo() {
  sessionStorage.removeItem("fgb_demo");
  location.href = location.pathname;
}

async function afterSignIn() {
  root.innerHTML = '<div class="spinner"></div>';
  try {
    S.memberships = await S.api.myDepartments(S.user.id);
  } catch (e) {
    root.innerHTML = `<div class="wrap empty" style="padding-top:80px"><div class="h3">Could not load your department</div><p>${esc(friendlyError(e))}</p><button class="btn" data-reload>Try again</button></div>`;
    return;
  }
  if (pendingJoinCode) {
    const already = S.memberships.find((m) => m.dept.invite_code === pendingJoinCode);
    if (!already) return renderOnboarding(pendingJoinCode);
    localStorage.setItem("fgb_dept", already.dept.id);
    clearJoinCode();
  }
  S.isAdmin = await S.api.isPlatformAdmin().catch(() => false);
  if (!S.api.isDemo) {
    S.api.sweepAlerts(); // sends any waiting owner's alerts (new sign-ups and the like)
    S.api.setLanguage(S.user.id, getLang()).catch(() => {});
    S.api.setBeforeSignOut(stopPush);
    startPush({
      save: (t) => S.api.registerPushDevice(t),
      remove: (t) => S.api.unregisterPushDevice(t),
      openIncident: (id) => go(`#/incident/${id}`),
      openChat: (incidentId) => go(incidentId ? `#/incident/${incidentId}?chat=1` : "#/chat"),
      openAdmin: () => go("#/admin"),
    });
  }
  if (!S.memberships.length) {
    if (S.isAdmin && location.hash.startsWith("#/admin")) { cleanup = adminView(root); return; }
    return renderOnboarding();
  }
  const saved = localStorage.getItem("fgb_dept");
  const pick = S.memberships.find((m) => m.dept.id === saved) || S.memberships[0];
  setDept(pick);
  if (/^#\/join\//.test(location.hash) || !location.hash) location.replace("#/");
  route();
}

function clearJoinCode() {
  pendingJoinCode = null;
  try { localStorage.removeItem("fgb_join"); } catch { /* private mode */ }
}

function setDept(m) {
  const changed = S.dept?.id !== m.dept.id;
  S.dept = m.dept;
  S.me = m.member;
  localStorage.setItem("fgb_dept", m.dept.id);
  if (changed) watchStation();
}

// ---------------- station chat unread dot ----------------
let stationOff = null;
function watchStation() {
  stationOff?.();
  stationOff = null;
  S.stationLast = 0;
  if (!S.dept || !S.api?.subscribeStation) return;
  const deptId = S.dept.id;
  const saw = (m) => {
    if (!m || m.user_id === S.user?.id || S.dept?.id !== deptId) return;
    S.stationLast = Math.max(S.stationLast || 0, Date.parse(m.created_at));
    paintChatDot();
  };
  S.api.lastStationMessage(deptId).then(saw).catch(() => {});
  stationOff = S.api.subscribeStation(deptId, saw);
}
const chatUnread = () => !!S.dept && (S.stationLast || 0) > lastSeen(S.dept.id, null);
function paintChatDot() {
  const on = chatUnread() && !location.hash.startsWith("#/chat");
  document.querySelectorAll('[data-nav="chat"]').forEach((a) => {
    a.querySelector(".nav-dot")?.remove();
    if (on) a.insertAdjacentHTML("beforeend", '<i class="nav-dot" aria-label="New messages"></i>');
  });
}
window.addEventListener("fgb:chat-seen", paintChatDot);

export async function refreshDept() {
  if (!S.dept) return;
  try {
    const before = JSON.stringify([S.dept, S.me, S.memberships.length]);
    S.memberships = await S.api.myDepartments(S.user.id);
    const m = S.memberships.find((x) => x.dept.id === S.dept.id);
    if (m) setDept(m);
    else if (S.memberships[0]) setDept(S.memberships[0]);
    else return renderOnboarding();
    // Only redraw when something actually changed, so the page doesn't jump.
    if (JSON.stringify([S.dept, S.me, S.memberships.length]) !== before) S.rerender();
  } catch { /* keep current */ }
}

// ============================================================
// Router
// ============================================================
function route() {
  // A sheet left open shouldn't follow you to another screen.
  document.querySelectorAll(".overlay [data-close]").forEach((b) => b.click());
  if (S.user && S.isAdmin && (location.hash || "").startsWith("#/admin")) {
    if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
    window.scrollTo(0, 0);
    cleanup = adminView(root);
    return;
  }
  if (!S.user || !S.dept) return;
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  window.scrollTo(0, 0);
  const h = location.hash || "#/";
  let m;
  if ((m = h.match(/^#\/incident\/([\w-]+)/))) cleanup = boardView(root, m[1]);
  else if ((m = h.match(/^#\/records(?:\/(\w+))?/))) cleanup = recordsView(root, m[1] || "roster");
  else if (h.startsWith("#/dept")) cleanup = deptView();
  else if (h.startsWith("#/me")) cleanup = meView();
  else if (h.startsWith("#/plan") && !IS_NATIVE) cleanup = planView();
  else if (h.startsWith("#/connections")) cleanup = connectionsView(root);
  else if (h.startsWith("#/chat")) cleanup = stationChatView();
  else cleanup = homeView();
}
S.rerender = route;
window.addEventListener("hashchange", route);
window.addEventListener("online", () => { S.online = true; document.querySelector(".offline-strip")?.remove(); });
window.addEventListener("offline", () => { S.online = false; showOffline(); });
function showOffline() {
  if (document.querySelector(".offline-strip")) return;
  const d = document.createElement("div");
  d.className = "offline-strip";
  d.textContent = "No connection. Changes will not save until you are back online.";
  document.body.prepend(d);
}

// ============================================================
// Shared chrome
// ============================================================
export function logo(cls = "") {
  return `<span class="logo ${cls}" role="img" aria-label="Fire Ground Board"><img class="logo-on-dark" src="img/logo-dark.png" alt="" width="900" height="301"><img class="logo-on-light" src="img/logo.png" alt="" width="900" height="301"></span>`;
}

export function money(n) {
  const v = Math.round(Number(n) * 100) / 100;
  const cents = Math.round(v * 100) % 100 !== 0;
  const loc = getLocale();
  // Canadian dollars read "$9.99" in English and "9,99 $" in French.
  if (loc === "en-CA") return "$" + v.toLocaleString("en-CA", { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: 2 });
  return v.toLocaleString(loc, { style: "currency", currency: "CAD", currencyDisplay: "narrowSymbol", minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: 2 });
}

/** What the department would pay per year right now. */
/** What a roster of `seats` people costs. Never more than seatCap people are billed. */
export function priceFor(seats) {
  const P = CONFIG.PRICING;
  const n = Math.max(1, seats || 0);
  const billed = Math.min(n, P.seatCap || n);
  return { n, billed, capped: billed < n, monthly: billed * P.monthly, annual: billed * P.annual };
}

export function helpSheet() {
  const q = (t, a) => `<details class="faq"><summary>${t}</summary><p>${a}</p></details>`;
  openSheet({
    title: "Help",
    body: `
      ${q("I didn't get the sign-in code", "Check your junk or spam folder and search for Fire Ground Board. It can take a minute. Codes work for 10 minutes. You can ask for a new one after 60 seconds.")}
      ${q("I got a new phone", "Open the app and sign in with the same email. Everything is saved to your account, not the phone.")}
      ${IS_NATIVE ? "" : q("Get the iPhone app", "Search Fire Ground Board in the App Store and sign in with the same email. On Android or a computer, use this website. Everything stays in sync.")}
      ${q("My phone didn't sound for PAR", IS_NATIVE ? "Check that call alerts are on in Me, On a call, and that Fire Ground is allowed notifications in your iPhone Settings. Keep your ringer on." : "The alarm plays while the app is open. Keep your ringer on and test it in Me, On a call.")}
      ${q("Make someone else the owner", "Department, Members, tap the person, Make owner. Do this before the old owner leaves.")}
      ${q("I removed someone by mistake", "Department, Members, Removed people, Allow back. Then they can rejoin with the invite code.")}
      ${q("Someone shouldn't have the invite code", "Department, Make a new code. The old code and link stop working. People already in stay in.")}
      ${IS_NATIVE ? "" : q("Receipts, card or cancelling", "The department owner opens Plan, then Open billing. Card, receipts, switching monthly or yearly, and cancelling are all there.")}
      ${q("Getting our records out", "Records has a download button on each tab. Incident reports download from the incident menu.")}
      <p class="muted small" style="margin-top:16px">Still stuck? Email <a href="mailto:${CONFIG.SUPPORT_EMAIL}">${CONFIG.SUPPORT_EMAIL}</a> with your department name.</p>`,
  });
}

/** On the website, point iPhone people to the App Store app. Nothing in the app itself. */
export function appStoreCard(dismissed) {
  if (IS_NATIVE || dismissed || !CONFIG.APP_STORE_URL) return "";
  if (!/iphone|ipad|ipod/i.test(navigator.userAgent)) return "";
  return `<div class="banner">${icon("download")}<div class="grow"><b>Get the iPhone app</b><br><span class="muted">Call alerts with sound, even when your phone is locked.</span></div>
    <a class="btn sm primary" href="${CONFIG.APP_STORE_URL}" target="_blank" rel="noopener">App Store</a><button class="iconbtn ghost" data-act="dismiss" data-k="appstore" aria-label="Hide">${icon("close", "sm")}</button></div>`;
}

export function demoStrip() {
  if (!S.api?.isDemo) return "";
  return `<div class="demo-strip">Demo department. Nothing here is saved. <button data-act="exit-demo">Exit demo</button></div>`;
}

/** Does the plan need the owner's attention? Shows a dot on the Plan tab. */
function planNeedsAttention(d = S.dept) {
  if (!d || IS_NATIVE) return false;
  if (d.subscription_status === "past_due" || !hasAccess(d)) return true;
  const paid = ["active", "trialing"].includes(d.subscription_status);
  return !paid && isOwner();
}

/** Main navigation: tabs along the bottom on phones, a side menu on computers. */
export function bottomNav(active) {
  // Plan is for the owner, on the website only. Everyone else sees the plan summary in Department.
  const items = [
    ["#/", "home", "flame", "Incidents"],
    ["#/chat", "chat", "chat", "Chat"],
    ["#/records", "records", "book", "Records"],
    ["#/dept", "dept", "shield", "Department"],
    ...(IS_NATIVE || !isOwner() ? [] : [["#/plan", "plan", "card", "Plan"]]),
    ["#/me", "me", "user", "Me"],
  ];
  const dot = planNeedsAttention();
  const chatDot = active !== "chat" && chatUnread();
  // Admin (MKE Group only) shows in the side menu on a computer, and under Me on a phone.
  const side = S.isAdmin ? [...items, ["#/admin", "admin", "wrench", "Admin"]] : items;
  const item = ([href, key, ic, label]) => `<a href="${href}" data-nav="${key}" class="${active === key ? "on" : ""}" ${active === key ? 'aria-current="page"' : ""}>${icon(ic)}<span>${label}</span>${(key === "plan" && dot) || (key === "chat" && chatDot) ? `<i class="nav-dot" aria-label="${key === "chat" ? "New messages" : "Needs attention"}"></i>` : ""}</a>`;
  const d = S.dept;
  const many = S.memberships.length > 1;
  return `<nav class="bottomnav no-print" aria-label="Main"><div class="bottomnav-in" style="--n:${items.length}">${items.map(item).join("")}</div></nav>
  <aside class="sidenav no-print" aria-label="Main">
    <a href="#/" class="sidenav-logo" aria-label="Fire Ground Board home">${logo()}</a>
    ${d ? `<${many ? 'button data-global="switch"' : "div"} class="sidenav-dept"><span class="grow"><b>${esc(d.name)}</b><small>${esc(S.me?.rank || "")}${S.me?.role && S.me.role !== "member" ? `, ${S.me.role === "owner" ? "owner" : "officer"}` : ""}</small></span>${many ? icon("chev", "sm") : ""}</${many ? "button" : "div"}>` : ""}
    <nav class="sidenav-links">${side.map(item).join("")}</nav>
    <div class="sidenav-foot">${S.api?.isDemo ? '<button class="btn sm block" data-act="exit-demo">Exit demo</button>' : `<span class="faint small">Signed in as ${esc(S.user?.email || "")}</span>`}</div>
  </aside>`;
}

export function accessBanner() {
  const d = S.dept;
  if (!d) return "";
  // Inside the iOS app we never point people at buying. Owners manage the plan on the web.
  const canBuy = isOwner() && !IS_NATIVE;
  if (!hasAccess(d)) {
    const title = IS_NATIVE ? "New incidents are paused for this department." : d.subscription_status && d.subscription_status !== "incomplete" ? "This department's plan has ended." : "Your free trial has ended.";
    const msg = canBuy ? "Choose a plan to start new incidents again." : IS_NATIVE ? "Your department owner can sort this out." : "Ask your department owner to choose a plan.";
    return `<div class="banner bad">${icon("alert")}<div class="grow"><b>${title}</b><br>${msg} Your records are safe and still readable.</div>
      ${canBuy ? '<a class="btn sm primary" href="#/plan">Choose a plan</a>' : ""}</div>`;
  }
  if (d.subscription_status === "past_due") {
    if (IS_NATIVE) return `<div class="banner warn">${icon("alert")}<div class="grow"><b>There's a billing problem with this department.</b> Let your chief know.</div></div>`;
    return `<div class="banner warn">${icon("alert")}<div class="grow"><b>Payment overdue.</b> ${isOwner() ? "Pay the open invoice or update your card to keep the board running." : "Let your chief know the department's payment is overdue."}</div>${isOwner() ? '<a class="btn sm primary" href="#/plan">Fix billing</a>' : ""}</div>`;
  }
  const paid = ["active", "trialing"].includes(d.subscription_status);
  const left = daysUntil(d.trial_ends_at);
  if (!paid && left <= (isOwner() ? 7 : 2) && !IS_NATIVE) {
    return `<div class="banner warn">${icon("alert")}<div class="grow"><b>${left} day${left === 1 ? "" : "s"} left in your free trial.</b> ${isOwner() ? "Pick a plan so the board keeps working." : "Your department owner picks the plan."}</div>${isOwner() ? '<a class="btn sm primary" href="#/plan">Choose a plan</a>' : ""}</div>`;
  }
  return "";
}

function bindActions(el, handlers) {
  const onClick = (e) => {
    const t = e.target.closest("[data-act]");
    if (!t || !el.contains(t)) return;
    const fn = handlers[t.dataset.act] || (t.dataset.act === "exit-demo" ? exitDemo : null);
    if (fn) { e.preventDefault(); fn(t, e); }
  };
  el.addEventListener("click", onClick);
  return () => el.removeEventListener("click", onClick);
}
export { bindActions };

// ============================================================
// Auth
// ============================================================
// Sign in with an emailed 6-digit code. No passwords to forget, no separate sign-up.
// "password" mode is kept for App Store review and test accounts only.
let authEmail = "";
let resendAt = 0;
function renderAuth(mode = "email") {
  if (cleanup) { cleanup(); cleanup = null; }
  const P = CONFIG.PRICING;
  const code = mode === "code";
  const pw = mode === "password";
  const priceLine = IS_NATIVE ? "" : `<p class="auth-price-line">${t("{m} a month or {y} a year per member, in {c}. Never more than {cap} a month for the whole department. Free for {d} days, no card needed.", {
    m: `<b>${money(P.monthly)}</b>`, y: `<b>${money(P.annual)}</b>`, c: esc(P.currency), cap: money(P.seatCap * P.monthly), d: P.trialDays })}</p>`;
  const intro = !code && !pendingJoinCode;
  root.innerHTML = `
  <div class="auth">
    <div class="auth-hero">
      <div class="auth-hero-in">
      ${logo("auth-logo")}
      <h1>${code ? "Check your email." : pendingJoinCode ? "You're invited." : "Know where every firefighter is."}</h1>
      <p>${code ? `We sent a 6-digit code to <b class="text">${esc(authEmail)}</b>. It works for 10 minutes.`
        : pendingJoinCode ? "Enter your email to join your department's board. No password needed."
        : "Live PAR accountability for volunteer and career fire departments."}</p>
      ${intro ? `<ul class="auth-points">
        <li><i>${icon("user", "sm")}</i><div><b>Every firefighter, live</b><span>Responding, staged, inside and out, on every phone and screen.</span></div></li>
        <li><i>${icon("radio", "sm")}</i><div><b>PAR in seconds</b><span>Call a PAR and watch each confirmation come in. Missing sounds the alarm.</span></div></li>
        <li><i>${icon("mail", "sm")}</i><div><b>Starts from dispatch</b><span>Pages and dispatch emails open the call and alert the crew.</span></div></li>
        <li><i>${icon("book", "sm")}</i><div><b>Records built in</b><span>Roster, training hours and equipment checks in one place.</span></div></li>
      </ul>` : ""}
      </div>
    </div>
    <div class="auth-body"><div class="auth-body-in">
      ${code ? "" : `<div class="h2 auth-form-title">${pw ? "Sign in with a password" : pendingJoinCode ? "Join your department" : "Sign in or start free"}</div>`}
      ${!HAS_BACKEND ? `<div class="banner warn" style="margin-bottom:18px">${icon("alert")}<div class="grow">This copy of the app isn't connected to a server yet. Try the demo to look around.</div></div>` : ""}
      <form id="auth-form" novalidate>
        ${code
          ? field("Sign-in code", input("token", "", 'inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="10" class="input code-input" placeholder="123456"'))
          : field("Email", input("email", authEmail, 'type="email" autocomplete="email" inputmode="email" autocapitalize="off" spellcheck="false" placeholder="you@yourdepartment.ca" required'))}
        ${pw ? field("Password", input("password", "", 'type="password" autocomplete="current-password" required')) : ""}
        <div class="error-text" id="auth-err" hidden></div>
        <button class="btn primary block" style="margin-top:14px" ${!HAS_BACKEND ? "disabled" : ""}>${code ? "Sign in" : pw ? "Sign in" : "Email me a sign-in code"}</button>
      </form>
      ${code ? `<div class="auth-switch"><button data-act="resend" id="resend">Send a new code</button> &nbsp; <button data-mode="email">Use a different email</button></div>`
        : pw ? "" : `<p class="auth-new">New here? Same button. No password needed.</p>`}
      ${code ? "" : `<button class="btn block auth-demo" id="try-demo">Try the demo department</button>`}
      <div class="auth-fine">
        ${intro ? priceLine : ""}
        <p><button data-act="help">Trouble signing in?</button><span class="sep">|</span>${pw ? '<button data-mode="email">Use an email code</button>' : '<button data-mode="password">Password sign-in</button>'}</p>
        <p><a href="privacy.html">Privacy</a><span class="sep">|</span><a href="terms.html">Terms</a><span class="sep">|</span><a href="support.html">Support</a></p>
        <div class="lang-pick" role="group" aria-label="Language" data-notr>${LANGS.map(([k, l]) => `<button data-lang="${k}" class="${getLang() === k ? "on" : ""}" lang="${k}">${l}</button>`).join("")}</div>
      </div>
    </div></div>
  </div>`;
  root.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => renderAuth(b.dataset.mode)));
  root.querySelector("#try-demo")?.addEventListener("click", startDemo);
  root.querySelectorAll("[data-lang]").forEach((b) => b.addEventListener("click", () => setLang(b.dataset.lang)));
  root.querySelector('[data-act="help"]').addEventListener("click", () => helpSheet());
  const err = root.querySelector("#auth-err");
  const showErr = (m) => { err.textContent = m; err.hidden = false; };
  const form = root.querySelector("#auth-form");
  const resend = root.querySelector("#resend");
  let timer = null;
  const tickResend = () => {
    if (!resend) return;
    const left = Math.ceil((resendAt - Date.now()) / 1000);
    resend.disabled = left > 0;
    resend.textContent = left > 0 ? `Send a new code (${left}s)` : "Send a new code";
    if (left <= 0) clearInterval(timer);
  };
  if (resend) {
    timer = setInterval(tickResend, 1000);
    tickResend();
    cleanup = () => clearInterval(timer);
    resend.addEventListener("click", async () => {
      try { await S.api.sendCode(authEmail); resendAt = Date.now() + 60000; timer = setInterval(tickResend, 1000); tickResend(); toast("New code sent."); }
      catch (e) { showErr(friendlyError(e)); }
    });
  }

  const submit = async () => {
    const f = formData(form);
    const btn = form.querySelector("button");
    err.hidden = true;
    if (code) {
      const t = (f.token || "").replace(/\D/g, "");
      if (t.length < 6) return showErr("Enter the 6-digit code from the email.");
      btn.disabled = true;
      try { await S.api.verifyCode(authEmail, t); } // onAuth SIGNED_IN takes it from here
      catch (e) { showErr(friendlyError(e)); btn.disabled = false; }
      return;
    }
    const email = (f.email || "").toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) return showErr("Enter a valid email.");
    btn.disabled = true;
    try {
      if (pw) await S.api.signIn(email, f.password);
      else {
        await S.api.sendCode(email);
        authEmail = email;
        resendAt = Date.now() + 60000;
        renderAuth("code");
        return;
      }
    } catch (e) { showErr(friendlyError(e)); }
    btn.disabled = false;
  };
  form.addEventListener("submit", (e) => { e.preventDefault(); submit(); });
  // Auto-submit once all 6 digits are in (pasted or typed).
  form.querySelector('[name="token"]')?.addEventListener("input", (e) => {
    const v = e.target.value.replace(/\D/g, "");
    if (v !== e.target.value) e.target.value = v;
    if (v.length === 6) submit();
  });
  if (code) form.querySelector('[name="token"]').focus();
}

function renderNewPassword() {
  openSheet({
    title: "Set a new password",
    body: field("New password", input("password", "", 'type="password" autocomplete="new-password" minlength="8"')),
    submitLabel: "Save password",
    errorText: friendlyError,
    onSubmit: async (form) => {
      const { password } = formData(form);
      if (password.length < 8) throw new Error("Password needs at least 8 characters.");
      await S.api.updatePassword(password);
      toast("Password updated.");
    },
  });
}

// ============================================================
// Onboarding: join or create a department
// ============================================================
// One short screen: join with an invite (name only), or set up a department (two fields).
async function renderOnboarding(code = "") {
  if (cleanup) { cleanup(); cleanup = null; }
  const hasDepts = S.memberships.length > 0;
  const P = CONFIG.PRICING;
  let deptName = null;
  if (code) deptName = await S.api.invitePreview(code).catch(() => null);
  const optional = (rankDefault) => `<details class="more"><summary class="muted small">Rank and crew (optional)</summary>
      <div class="grid2" style="margin-top:10px">${field("Rank", select("rank", RANKS, rankDefault))}${field("Crew", select("crew", ["", ...CREWS], ""))}</div></details>`;
  root.innerHTML = `
  ${demoStrip()}
  <div class="screen">
    <div class="wrap" style="padding-top:calc(28px + env(safe-area-inset-top));max-width:520px">
      ${hasDepts ? `<button class="btn quiet" data-act="cancel">${icon("back")} Back</button>` : `<div style="width:200px;margin-bottom:8px">${logo()}</div>`}
      ${deptName ? `
      <div class="h2" style="font-size:32px;margin-top:10px">Join ${esc(deptName)}</div>
      <p class="muted" style="margin-top:6px">Last step. Your name is what command sees on the board.</p>
      <form class="panel section" id="join-form" novalidate>
        <input type="hidden" name="code" value="${esc(code)}">
        ${field("Your name", input("name", "", 'autocomplete="name" autocapitalize="words" placeholder="First and last name"'))}
        ${optional("Firefighter")}
        <div class="error-text" data-err hidden></div>
        <button class="btn primary block" style="margin-top:16px">Join ${esc(deptName)}</button>
      </form>
      <div style="text-align:center;margin-top:14px"><button class="btn quiet sm" data-act="no-invite">That's not my department</button></div>` : `
      <div class="h2" style="font-size:32px;margin-top:10px">${code ? "That invite has expired" : "Get on your department's board"}</div>
      <p class="muted" style="margin-top:6px">${code ? "The code may have been changed. Ask your chief for the new one." : "Most people join with a code from their chief."}</p>

      <form class="panel section" id="join-form" novalidate>
        <div class="h3" style="margin-bottom:12px">I have an invite code</div>
        ${field("Invite code", input("code", "", 'autocapitalize="characters" autocomplete="off" spellcheck="false" maxlength="6" placeholder="6 letters and numbers" class="input code-input"'))}
        <p class="hint" data-preview></p>
        ${field("Your name", input("name", "", 'autocomplete="name" autocapitalize="words" placeholder="First and last name"'))}
        ${optional("Firefighter")}
        <div class="error-text" data-err hidden></div>
        <button class="btn primary block" style="margin-top:16px">Join department</button>
      </form>

      <form class="panel section" id="create-form" novalidate style="margin-bottom:24px">
        <div class="h3">I'm setting up my department</div>
        <p class="muted small" style="margin:4px 0 12px">For chiefs and officers.${IS_NATIVE ? " You'll get an invite code for your crew." : ` Free for ${P.trialDays} days, no card needed. Then ${money(P.monthly)} a month or ${money(P.annual)} a year per member with the app.`}</p>
        ${field("Department name", input("dept", "", 'placeholder="e.g. Madawaska Valley Fire" autocapitalize="words"'))}
        ${field("Your name", input("name", "", 'autocomplete="name" autocapitalize="words"'))}
        <details class="more"><summary class="muted small">Your rank (optional)</summary><div style="margin-top:10px">${field("Rank", select("rank", RANKS, "Chief"))}</div></details>
        <div class="error-text" data-err hidden></div>
        <button class="btn block" style="margin-top:16px">${IS_NATIVE ? "Create department" : "Start free trial"}</button>
      </form>`}
      <div style="text-align:center;margin:10px 0 40px"><button class="btn quiet" data-act="help">Help</button><button class="btn quiet" data-act="signout">Sign out</button></div>
    </div>
  </div>`;
  const off = bindActions(root, {
    cancel: () => { clearJoinCode(); location.hash = "#/"; afterSignIn(); },
    "no-invite": () => { clearJoinCode(); renderOnboarding(); },
    help: () => helpSheet(),
    signout: () => S.api.signOut().then(() => S.api.isDemo ? exitDemo() : renderAuth("email")),
  });
  cleanup = off;

  // Show the department name once a full code is typed.
  const codeIn = root.querySelector('#join-form [name="code"]:not([type=hidden])');
  codeIn?.addEventListener("input", async () => {
    const v = codeIn.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    if (v !== codeIn.value) codeIn.value = v;
    const out = root.querySelector("[data-preview]");
    out.textContent = "";
    if (v.length !== 6) return;
    const n = await S.api.invitePreview(v).catch((e) => { out.textContent = friendlyError(e); return undefined; });
    if (n === undefined || codeIn.value !== v) return;
    out.innerHTML = n ? `${icon("check", "sm")} <b class="text">${esc(n)}</b>` : "That code wasn't found. Check it with your chief.";
    out.classList.toggle("ok", !!n);
  });

  const handle = (id, fn) => root.querySelector(id)?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = formData(e.target);
    const err = e.target.querySelector("[data-err]");
    const btn = e.target.querySelector("button:not([type=button])");
    err.hidden = true;
    btn.disabled = true;
    try {
      await fn(f);
    } catch (ex) {
      err.textContent = friendlyError(ex);
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
  handle("#join-form", async (f) => {
    const c = (f.code || "").toUpperCase().trim();
    if (c.length < 6) throw new Error("Enter the 6-character invite code from your chief.");
    if (!f.name) throw new Error("Enter your name.");
    const deptId = await S.api.joinDepartment(c, f.name, f.rank, f.crew);
    clearJoinCode();
    localStorage.setItem("fgb_dept", deptId);
    location.hash = "#/";
    await afterSignIn();
    toast(`Welcome to ${S.dept?.name || "the department"}.`);
  });
  handle("#create-form", async (f) => {
    if (!f.dept || f.dept.length < 2) throw new Error("Enter your department name.");
    if (!f.name) throw new Error("Enter your name.");
    const deptId = await S.api.createDepartment(f.dept, f.name, f.rank || "Chief");
    localStorage.setItem("fgb_dept", deptId);
    location.hash = "#/";
    await afterSignIn();
    toast("Department created. Next, invite your crew.");
  });
}

// ============================================================
// Home: incidents
// ============================================================
function homeView() {
  let alive = true;
  let memberCount = 0;
  const dismissKey = (k) => `fgb_${k}_${S.dept.id}`;
  const dismissed = (k) => { try { return localStorage.getItem(dismissKey(k)) === "1"; } catch { return false; } };

  const paint = async () => {
    const [active, recent, training, attendance, members] = await Promise.all([
      S.api.listIncidents(S.dept.id, { status: "active" }),
      S.api.listIncidents(S.dept.id, { status: "closed", limit: 25 }),
      S.api.listTraining(S.dept.id).catch(() => []),
      S.api.listAttendance(S.dept.id).catch(() => []),
      isOfficer() ? S.api.listMembers(S.dept.id).catch(() => []) : Promise.resolve([]),
    ]);
    const states = await Promise.all(active.map((i) => S.api.incidentState(i.id).catch(() => null)));
    const push = await pushState();
    if (!alive) return;
    memberCount = members.length;
    const openTraining = training.filter((t) => t.attendance_open && !attendance.some((a) => a.session_id === t.id && a.member_id === S.me.id));
    const canStart = isOfficer() && hasAccess();

    const side = [
      ...openTraining.map((t) => `<div class="banner"><div class="grow"><b>${esc(t.title)}</b><br><span class="muted">Attendance is open. Mark yourself present.</span></div><button class="btn sm primary" data-act="attend" data-id="${t.id}">I was there</button></div>`),
      alertsCard(push),
      appStoreCard(dismissed("appstore")),
      isOfficer() ? setupCard(recent.length + active.length) : howItWorks(),
    ].filter(Boolean).join("");

    root.innerHTML = `
    ${demoStrip()}
    <div class="screen with-nav">
      <div class="wrap dept-head">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="flex:1;min-width:0">
            <div class="dept-name">${esc(S.dept.name)}</div>
            ${IS_NATIVE ? "" : `<a class="plan-link small" href="#/plan">${icon("card", "sm")}${esc(planLabel())}</a>`}
          </div>
          ${S.memberships.length > 1 ? `<button class="iconbtn hide-desk" data-act="switch" aria-label="Switch department">${icon("shield")}</button>` : ""}
          ${canStart ? `<button class="btn primary show-desk" data-act="start">${icon("plus", "sm")} Start incident</button>` : ""}
        </div>
      </div>
      ${accessBanner() ? `<div class="wrap" style="margin-top:12px">${accessBanner()}</div>` : ""}
      <div class="wrap home-grid ${side ? "has-side" : ""}">
        ${side ? `<aside class="home-side stack">${side}</aside>` : ""}
        <div class="home-main">
          <div class="section">
            <div class="section-head">
              <div class="h2">Active</div>
              ${canStart && active.length ? `<button class="btn sm primary hide-desk" data-act="start">${icon("plus", "sm")} Start incident</button>` : ""}
            </div>
            ${active.length ? `<div class="active-list">${active.map((inc, i) => activeCard(inc, states[i])).join("")}</div>` : canStart ? `
              <button class="start-big" data-act="start">${icon("flame")}<span><b>Start incident</b><small>Paged out? Tap here. Your crew joins from their phones.</small></span></button>` : `
              <div class="panel empty" style="padding:28px 20px">
                <div class="h3">No active incidents</div>
                <p>When an officer starts an incident it shows up here. Tap I'm responding and you're on the board.</p>
              </div>`}
          </div>

          <div class="section" style="margin-bottom:24px">
            <div class="section-head"><div class="h2">Recent</div>${recent.length && isOfficer() ? `<button class="btn sm quiet" data-act="export-incidents">${icon("download", "sm")} Download all</button>` : ""}</div>
            ${recent.length ? `<div class="list">${recent.map((inc) => `
              <a class="row" href="#/incident/${inc.id}">
                <div class="grow">
                  <div class="title">${esc(inc.name)}</div>
                  <div class="meta">${esc(inc.address || t("No address"))}, ${dateTime(inc.started_at)}${inc.closed_at ? `, ${elapsed(inc.started_at, inc.closed_at)}` : ""}</div>
                </div>
                <span class="chev">${icon("chev", "sm")}</span>
              </a>`).join("")}</div>` : `<p class="muted">Closed incidents and their reports will appear here.</p>`}
          </div>
        </div>
      </div>
    </div>
    ${bottomNav("home")}`;
  };

  // First-run checklist for officers. Hides itself once everything is done or dismissed.
  function setupCard(incidentCount) {
    if (dismissed("setup") || S.api.isDemo) return "";
    const apparatus = S.dept.settings?.apparatus || [];
    const steps = [
      ["Invite your crew", "Share the code or print the station poster.", S.dept.seat_count > 1, "#/dept"],
      ["Add people without the app", "Paste your roster so everyone can go on the board.", memberCount > S.dept.seat_count, "#/records/roster"],
      ["Add your trucks", "They show up as one-tap choices on every call.", apparatus.length > 0, "#/dept"],
      ["Run a practice incident", "Start one at training. Close it when you're done.", incidentCount > 0, null],
      ...(isOwner() && !IS_NATIVE ? [["Choose a plan", "Monthly or yearly. Billing starts when the trial ends.", ["active", "trialing"].includes(S.dept.subscription_status), "#/plan"]] : []),
    ];
    const done = steps.filter((x) => x[2]).length;
    if (done === steps.length) return "";
    return `<div class="panel setup">
      <div style="display:flex;align-items:center;gap:10px"><div class="h3" style="flex:1">Get your department ready</div><span class="muted small">${done} of ${steps.length}</span></div>
      <div class="setup-steps">${steps.map(([t, m, ok, href]) => `
        <${href && !ok ? `a href="${href}"` : "div"} class="setup-step ${ok ? "ok" : ""}">
          <span class="tick">${ok ? icon("check", "sm") : ""}</span>
          <span class="grow"><b>${t}</b><small>${m}</small></span>
          ${href && !ok ? `<span class="chev">${icon("chev", "sm")}</span>` : ""}
        </${href && !ok ? "a" : "div"}>`).join("")}</div>
      <button class="btn quiet sm" data-act="dismiss" data-k="setup">Hide this</button>
    </div>`;
  }

  // iPhone app: ask for alerts in context, with a reason, instead of on launch.
  function alertsCard(state) {
    if (state === "ask") {
      return `<div class="banner warn">${icon("alert")}<div class="grow"><b>Turn on call alerts</b><br><span class="muted">Get buzzed for new calls, PAR checks and Missing firefighters, even with the app closed.</span></div><button class="btn sm primary" data-act="alerts-on">Turn on</button></div>`;
    }
    if (state === "off" && !dismissed("alerts")) {
      return `<div class="banner warn">${icon("alert")}<div class="grow"><b>Call alerts are off</b><br><span class="muted">Turn them on in iPhone Settings, Fire Ground, Notifications.</span></div><button class="btn sm" data-act="alerts-on">Settings</button><button class="iconbtn ghost" data-act="dismiss" data-k="alerts" aria-label="Hide">${icon("close", "sm")}</button></div>`;
    }
    return "";
  }

  // Three lines for regular members on how the board works.
  function howItWorks() {
    if (dismissed("howto")) return "";
    return `<div class="panel setup">
      <div class="h3">How it works</div>
      <div class="setup-steps">
        <div class="setup-step"><span class="tick num">1</span><span class="grow"><b>Paged?</b><small>Open the app and tap I'm responding on the incident.</small></span></div>
        <div class="setup-step"><span class="tick num">2</span><span class="grow"><b>On scene</b><small>Tap your name to change your status. Command sees it right away.</small></span></div>
        <div class="setup-step"><span class="tick num">3</span><span class="grow"><b>PAR called</b><small>Your phone sounds. Tap I'm accounted for.</small></span></div>
      </div>
      <button class="btn quiet sm" data-act="dismiss" data-k="howto">Got it</button>
    </div>`;
  }

  const offClicks = bindActions(root, {
    start: () => startIncidentSheet(),
    switch: () => switchDeptSheet(),
    "alerts-on": async () => { await askForPush(); paint().catch(() => {}); },
    dismiss: (b) => { try { localStorage.setItem(dismissKey(b.dataset.k), "1"); } catch { /* private mode */ } paint().catch(() => {}); },
    respond: async (b) => {
      b.disabled = true;
      try { await S.api.joinIncident(b.dataset.id); go(`#/incident/${b.dataset.id}`); }
      catch (e) { toast(friendlyError(e), true); b.disabled = false; }
    },
    "export-incidents": async (b) => {
      b.disabled = true;
      try { await exportIncidents(); } catch (e) { toast(friendlyError(e), true); }
      b.disabled = false;
    },
    attend: async (b) => {
      try { await S.api.selfMarkAttendance(b.dataset.id); toast("Attendance recorded."); paint(); }
      catch (e) { toast(friendlyError(e), true); }
    },
  });
  root.innerHTML = '<div class="spinner"></div>';
  paint().catch((e) => { root.innerHTML = `<div class="wrap empty" style="padding-top:80px"><div class="h3">Could not load incidents</div><p>${esc(friendlyError(e))}</p><button class="btn" data-reload>Try again</button></div>${bottomNav("home")}`; });
  const unsub = S.api.subscribeDepartment(S.dept.id, () => paint().catch(() => {}));
  const tick = setInterval(() => root.querySelectorAll("[data-since]").forEach((el) => { el.textContent = elapsed(el.dataset.since); }), 15000);
  // Phones drop the live connection when locked. Catch up when the app comes back.
  const onVis = () => { if (document.visibilityState === "visible") paint().catch(() => {}); };
  document.addEventListener("visibilitychange", onVis);
  return () => { alive = false; offClicks(); unsub(); clearInterval(tick); document.removeEventListener("visibilitychange", onVis); };
}

/** Every incident as a spreadsheet, for fire reports and the year-end summary. */
async function exportIncidents() {
  const list = await S.api.listIncidents(S.dept.id, { limit: 2000 });
  const states = await Promise.all(list.map((i) => S.api.incidentState(i.id).catch(() => null)));
  const rows = [["Started", "Closed", "Duration (minutes)", "Name", "Call type", "Address", "Source", "Personnel", "Apparatus", "Mutual aid"]];
  list.forEach((inc, i) => {
    const st = states[i];
    const mins = inc.closed_at ? Math.round((new Date(inc.closed_at) - new Date(inc.started_at)) / 60000) : "";
    rows.push([
      new Date(inc.started_at).toISOString(), inc.closed_at ? new Date(inc.closed_at).toISOString() : "", mins,
      inc.name, inc.call_type || "", inc.address || "", inc.source,
      (st?.personnel || []).map((p) => p.name).join("; "), (st?.apparatus || []).map((a) => a.name).join("; "), (st?.mutualAid || []).map((m) => m.name).join("; "),
    ]);
  });
  download(`${S.dept.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-incidents-${todayISO()}.csv`, csv(rows), "text/csv");
  toast("Exported. Opens in Excel or Google Sheets.");
}

function activeCard(inc, st) {
  const p = st?.personnel || [];
  const n = (s) => p.filter((x) => x.status === s).length;
  const onScene = p.filter((x) => !["Responding", "OUT"].includes(x.status)).length;
  const meOn = p.some((x) => x.member_id === S.me.id);
  const missing = n("MISSING");
  return `<div class="active-wrap">
    <a class="active-card" href="#/incident/${inc.id}">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <span class="pill live">Live</span>
        <span class="pill" data-since="${inc.started_at}">${elapsed(inc.started_at)}</span>
        ${inc.par_started_at ? '<span class="pill par-pill">PAR in progress</span>' : ""}
        ${missing ? `<span class="pill bad">${missing} missing</span>` : ""}
        ${meOn ? '<span class="pill good">You\'re on the board</span>' : ""}
      </div>
      <div class="name">${esc(inc.name)}</div>
      <div class="muted">${esc(inc.address || t("No address"))}${inc.call_type && inc.call_type !== inc.name ? `, ${esc(inc.call_type)}` : ""}</div>
      <div class="counts">
        <span class="count"><b class="c-IN">${n("IN")}</b>In</span>
        <span class="count"><b>${onScene}</b>On scene</span>
        <span class="count"><b>${n("Responding")}</b>Responding</span>
        <span class="count"><b>${p.length}</b>Total</span>
      </div>
    </a>
    ${!meOn && hasAccess() ? `<button class="btn primary block respond" data-act="respond" data-id="${inc.id}">I'm responding</button>` : ""}
    ${bestDirections(inc) ? `<a class="btn block dir-btn" href="${esc(bestDirections(inc))}" target="_blank" rel="noopener noreferrer">${icon("pin", "sm")} Directions</a>` : ""}
  </div>`;
}

function startIncidentSheet() {
  const units = S.dept.settings?.apparatus || [];
  openSheet({
    title: "Start incident",
    body: `
      <div class="label">Call type</div>
      <div class="choice-grid" role="radiogroup" aria-label="Call type">${CALL_TYPES.map((c) => `
        <label class="choice"><input type="radio" name="call_type" value="${esc(c)}"><span>${esc(c)}</span></label>`).join("")}</div>
      <div style="margin-top:14px">${field("Address or location", input("address", "", 'placeholder="Start typing an address" autocomplete="off"'))}<input type="hidden" name="lat"><input type="hidden" name="lng"></div>
      ${units.length ? `<div class="label" style="margin-top:14px">Trucks responding</div>
        <div class="choice-grid">${units.map((u, i) => `<label class="choice"><input type="checkbox" name="unit_${i}"><span>${esc(u.name)}</span></label>`).join("")}</div>` : ""}
      <details style="margin-top:14px"><summary class="muted small">Give it a custom name</summary>
        <div style="margin-top:10px">${field("Incident name", input("name", "", 'placeholder="Defaults to the call type"'))}</div></details>
      <p class="hint">You go on the board as Staged. Your crew sees it on their phones right away.</p>`,
    submitLabel: "Start incident",
    errorText: friendlyError,
    onOpen: (el) => {
      const form = el.querySelector("form") || el;
      addressPicker(form.querySelector('[name="address"]'), { latEl: form.querySelector('[name="lat"]'), lngEl: form.querySelector('[name="lng"]') });
    },
    onSubmit: async (form) => {
      const f = formData(form);
      const name = f.name || f.call_type || "";
      if (!name) throw new Error("Pick a call type or give the incident a name.");
      const id = await S.api.startIncident(S.dept.id, { name, address: f.address, call_type: f.call_type });
      const lat = Number(f.lat), lng = Number(f.lng);
      if (f.lat && f.lng && Number.isFinite(lat) && Number.isFinite(lng)) await S.api.updateIncident(id, { lat, lng }).catch(() => {});
      S.api.notify("incident", id);
      const picked = units.filter((_, i) => f[`unit_${i}`]);
      await Promise.all(picked.map((u) => S.api.addApparatus(id, { name: u.name, kind: u.kind, status: "Responding" }).catch(() => {})));
      go(`#/incident/${id}`);
    },
  });
}

function switchDeptSheet() {
  const { el, close } = openSheet({
    title: "Switch department",
    body: `<div class="list">${S.memberships.map((m) => `
      <button class="row" data-id="${m.dept.id}">
        <div class="grow"><div class="title">${esc(m.dept.name)}</div><div class="meta">${esc(m.member.rank)}</div></div>
        ${m.dept.id === S.dept.id ? icon("check") : ""}
      </button>`).join("")}</div>
      <button class="btn block" style="margin-top:14px" data-join>Join another department</button>`,
  });
  el.addEventListener("click", (e) => {
    const r = e.target.closest("[data-id]");
    if (r) { setDept(S.memberships.find((m) => m.dept.id === r.dataset.id)); close(); go("#/"); }
    if (e.target.closest("[data-join]")) { close(); renderOnboarding(); }
  });
}

// ============================================================
// Department: members, invite, plan, integrations
// ============================================================
function deptView() {
  let alive = true;
  let members = [];
  let removed = [];

  const paint = async () => {
    [members, removed] = await Promise.all([
      S.api.listMembers(S.dept.id),
      isOfficer() ? S.api.listRemoved(S.dept.id).catch(() => []) : Promise.resolve([]),
    ]);
    if (!alive) return;
    const withAccount = members.filter((m) => m.user_id);
    const inviteLink = `${CONFIG.APP_URL}/#/join/${S.dept.invite_code}`;
    const d = S.dept;
    const paid = ["active", "trialing", "past_due"].includes(d.subscription_status);
    const locations = d.settings?.equipment_locations || ["Station"];
    const apparatus = d.settings?.apparatus || [];

    root.innerHTML = `
    ${demoStrip()}
    <div class="screen with-nav">
      <header class="topbar"><div class="wrap topbar-in"><h1>Department</h1></div></header>
      <div class="wrap" style="padding-top:16px">
        ${accessBanner()}
        <div class="cols">
        <div class="col">
        <section class="section">
          <div class="section-head"><div class="h2">Invite your crew</div></div>
          <div class="panel">
            <p class="muted small" style="margin-bottom:12px">Crew download the app or open the link, create an account, and enter this code.</p>
            <div class="code-box">${esc(d.invite_code)}</div>
            <div class="btn-row" style="margin-top:12px">
              <button class="btn" data-act="share-invite">${icon("share", "sm")} Share link</button>
              <button class="btn" data-act="qr">Show QR code</button>
            </div>
            <button class="btn block" style="margin-top:10px" data-act="poster">${icon("print", "sm")} Print a poster for the station</button>
            ${isOfficer() ? `<button class="btn quiet sm" style="margin-top:8px" data-act="new-code">Make a new code (old one stops working)</button>` : ""}
          </div>
          <input type="hidden" id="invite-link" value="${esc(inviteLink)}">
        </section>

        <section class="section">
          <div class="section-head"><div class="h2">Members</div><span class="muted small">${withAccount.length} with the app</span></div>
          <div class="list">${withAccount.map((m) => `
            <button class="row" data-act="member" data-id="${m.id}">
              <div class="avatar" style="background:${colorFor(m.name)}">${esc(initials(m.name))}</div>
              <div class="grow"><div class="title">${esc(m.name)}${m.user_id === S.user.id ? ' <span class="faint" style="font-weight:600">(you)</span>' : ""}</div>
              <div class="meta">${esc(m.rank)}${m.crew ? `, ${esc(m.crew)}` : ""}</div></div>
              ${m.role !== "member" ? `<span class="pill">${m.role === "owner" ? "Owner" : "Officer"}</span>` : ""}
            </button>`).join("")}</div>
          <p class="hint">Owners manage billing and roles. Officers run incidents and records. Members join boards and update their own status. People without the app live in Records, Roster.</p>
          ${isOfficer() && removed.length ? `<details class="more" style="margin-top:12px"><summary class="muted small">Removed people (${removed.length})</summary>
            <div class="list" style="margin-top:10px">${removed.map((r) => `<div class="row"><div class="grow"><div class="title">${esc(r.name)}</div><div class="meta">Removed ${esc(ago(r.removed_at))}. They can't rejoin with the code.</div></div><button class="btn sm" data-act="allow-back" data-id="${r.id}">Allow back</button></div>`).join("")}</div></details>` : ""}
        </section>

        </div>
        <div class="col">
        ${IS_NATIVE ? "" : `<section class="section">
          <div class="section-head"><div class="h2">Plan</div></div>
          <a class="panel plan-summary" href="#/plan">
            <span class="grow"><b>${esc(planLabel())}</b>
            <small>${d.seat_count} member${d.seat_count === 1 ? "" : "s"} with the app${d.current_period_end && paid ? `, renews ${dateLabel(d.current_period_end)}` : ""}</small></span>
            <span class="btn sm ${paid ? "" : "primary"}">${paid ? "View plan" : isOwner() ? "Choose a plan" : "View plan"}</span>
          </a>
        </section>`}

        ${isOfficer() ? `
        <section class="section">
          <div class="section-head"><div class="h2">Scanner feed</div></div>
          <form class="panel" id="scanner-form" novalidate>
            <p class="muted small" style="margin-bottom:12px">Paste a live audio stream (Broadcastify, your county's stream) and crew can listen from the incident screen.</p>
            ${field("Stream URL", input("scanner_url", d.scanner_url || "", 'type="url" placeholder="https://..." autocapitalize="off"'))}
            ${field("Label", input("scanner_label", d.scanner_label || "", 'placeholder="e.g. County fire dispatch"'))}
            <button class="btn block" style="margin-top:14px">Save scanner feed</button>
          </form>
        </section>` : ""}

        ${isOwner() ? `
        <section class="section">
          <div class="section-head"><div class="h2">Connections</div></div>
          <a class="panel plan-summary" href="#/connections">
            <span class="grow"><b>Dispatch, group chat and calendar</b>
            <small>Start calls from dispatch pages and emails, post alerts to your group chat, and share the training calendar.</small></span>
            <span class="btn sm">Set up</span>
          </a>
        </section>` : ""}

        ${isOfficer() ? `
        <section class="section">
          <div class="section-head"><div class="h2">Trucks</div><button class="btn sm" data-act="trucks-import">${icon("upload", "sm")} Import</button></div>
          <div class="panel">
            <p class="muted small" style="margin-bottom:12px">Your department's apparatus. They show up as one-tap choices when you start an incident.</p>
            ${apparatus.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px">${apparatus.map((a, i) => `<span class="chip">${icon("truck", "sm")}${esc(a.name)} <button data-act="app-del" data-i="${i}" aria-label="Remove ${esc(a.name)}" class="faint">${icon("close", "sm")}</button></span>`).join("")}</div>` : ""}
            <form id="app-form" class="grid2" style="margin-top:12px;grid-template-columns:1fr auto auto" novalidate>
              <input class="input" name="name" placeholder="e.g. Engine 1" maxlength="40">
              ${select("kind", APP_KINDS, "Engine", 'aria-label="Type"')}
              <button class="btn">Add</button>
            </form>
          </div>
        </section>

        <section class="section">
          <div class="section-head"><div class="h2">Equipment locations</div></div>
          <div class="panel">
            <div style="display:flex;flex-wrap:wrap;gap:6px">${locations.map((l, i) => `<span class="chip">${esc(l)}${i ? ` <button data-act="loc-del" data-i="${i}" aria-label="Remove ${esc(l)}" class="faint">${icon("close", "sm")}</button>` : ""}</span>`).join("")}</div>
            <form id="loc-form" style="display:flex;gap:8px;margin-top:12px" novalidate>
              <input class="input" name="loc" placeholder="e.g. Engine 1, Bay 2">
              <button class="btn">Add</button>
            </form>
          </div>
        </section>

        <section class="section">
          <div class="section-head"><div class="h2">Department name</div></div>
          <form class="panel" id="name-form" novalidate style="display:flex;gap:8px">
            <input class="input" name="name" value="${esc(d.name)}">
            <button class="btn">Save</button>
          </form>
        </section>` : ""}

        <section class="section" style="margin-bottom:40px">
          <button class="btn danger block" data-act="leave">Leave ${esc(d.name)}</button>
        </section>
        </div>
        </div>
      </div>
    </div>
    ${bottomNav("dept")}`;
    bindForms();
  };

  function printPoster() {
    const link = `${CONFIG.APP_URL}/#/join/${S.dept.invite_code}`;
    const qr = window.qrcode(0, "M");
    qr.addData(link);
    qr.make();
    const w = window.open("", "_blank");
    if (!w) return toast("Allow pop-ups to print the poster.", true);
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(t("Join {dept} on Fire Ground Board", { dept: S.dept.name }))}</title>
      <style>
        @page { size: letter; margin: 0.6in; }
        body { font-family: "Arial Narrow", Arial, sans-serif; color: #111; text-align: center; margin: 0; }
        img.logo { width: 70%; margin: 10px auto 26px; display: block; }
        h1 { font-size: 40px; margin: 0 0 6px; }
        p { font-size: 20px; margin: 6px 0; }
        .qr { width: 3.6in; margin: 26px auto 18px; }
        .qr svg { width: 100%; height: auto; }
        .code { font-size: 54px; font-weight: 800; letter-spacing: 10px; border: 3px dashed #111; display: inline-block; padding: 10px 26px; margin: 8px 0 20px; }
        ol { text-align: left; font-size: 19px; max-width: 5.6in; margin: 0 auto; line-height: 1.5; }
      </style></head><body>
      <img class="logo" src="${location.origin}${location.pathname.replace(/[^/]*$/, "")}img/logo.png" alt="Fire Ground Board">
      <h1>${esc(S.dept.name)}</h1>
      <p>${t("Get on the accountability board")}</p>
      <div class="qr">${qr.createSvgTag({ cellSize: 8, margin: 0, scalable: true })}</div>
      <div class="code">${esc(S.dept.invite_code)}</div>
      <ol>
        <li>${esc(t("Scan the code with your phone camera, or go to {url}", { url: CONFIG.APP_URL.replace(/^https?:\/\//, "") }))}</li>
        <li>${t("Create an account with your email")}</li>
        <li>${t("Enter the code above if it isn't filled in")}</li>
        <li>${t("Add the app to your home screen so it's one tap away on a call")}</li>
      </ol>
      </body></html>`);
    w.document.close();
    const img = w.document.querySelector("img.logo");
    const ready = img && !img.complete ? new Promise((r) => { img.onload = r; img.onerror = r; }) : Promise.resolve();
    ready.then(() => setTimeout(() => { w.focus(); w.print(); }, 200));
  }

  function bindForms() {
    root.querySelector("#scanner-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = formData(e.target);
      if (f.scanner_url && !/^https:\/\//i.test(f.scanner_url)) return toast("Stream URL must start with https://", true);
      try {
        await S.api.updateDepartment(S.dept.id, { scanner_url: f.scanner_url || null, scanner_label: f.scanner_label || null });
        await refreshDept();
        toast("Scanner feed saved.");
      } catch (ex) { toast(friendlyError(ex), true); }
    });
    root.querySelector("#loc-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const v = formData(e.target).loc;
      if (!v) return;
      const locs = [...(S.dept.settings?.equipment_locations || ["Station"])];
      if (locs.includes(v)) return toast("That location already exists.", true);
      locs.push(v.slice(0, 40));
      await saveSettings({ ...S.dept.settings, equipment_locations: locs });
    });
    root.querySelector("#app-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = formData(e.target);
      if (!f.name) return toast("Enter the truck's name, like Engine 1.", true);
      const list = [...(S.dept.settings?.apparatus || [])];
      if (list.some((a) => a.name.toLowerCase() === f.name.toLowerCase())) return toast("That truck is already on the list.", true);
      if (list.length >= 30) return toast("That's the limit of 30 trucks.", true);
      list.push({ name: f.name.slice(0, 40), kind: f.kind });
      await saveSettings({ ...S.dept.settings, apparatus: list });
    });
    root.querySelector("#name-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const { name } = formData(e.target);
      if (name.length < 2) return toast("Name is too short.", true);
      try { await S.api.updateDepartment(S.dept.id, { name }); await refreshDept(); toast("Name saved."); }
      catch (ex) { toast(friendlyError(ex), true); }
    });
  }

  async function saveSettings(settings) {
    try { await S.api.updateDepartment(S.dept.id, { settings }); await refreshDept(); }
    catch (ex) { toast(friendlyError(ex), true); }
  }

  const off = bindActions(root, {
    "share-invite": async () => {
      const link = root.querySelector("#invite-link").value;
      const text = `${t("Join {dept} on Fire Ground Board. Invite code: {code}", { dept: S.dept.name, code: S.dept.invite_code })}\n${link}`;
      if (navigator.share) { try { await navigator.share({ title: t("Fire Ground Board invite"), text }); return; } catch { /* cancelled */ } }
      if (await copyText(text)) toast("Invite copied. Paste it in your group chat.");
    },
    qr: () => {
      const link = root.querySelector("#invite-link").value;
      const qr = window.qrcode(0, "M");
      qr.addData(link);
      qr.make();
      openSheet({ title: "Scan to join", body: `<div class="qr">${qr.createSvgTag({ cellSize: 6, margin: 0, scalable: true })}</div><div class="code-box" style="margin-top:14px">${esc(S.dept.invite_code)}</div>` });
    },
    "new-code": async () => {
      if (!(await confirmSheet({ title: "Make a new invite code?", message: "The current code and link stop working. People already in the department are not affected.", confirmLabel: "Make new code" }))) return;
      try { await S.api.regenerateInvite(S.dept.id); await refreshDept(); toast("New invite code ready."); }
      catch (e) { toast(friendlyError(e), true); }
    },
    member: (b) => memberSheet(members.find((m) => m.id === b.dataset.id)),
    "allow-back": async (b) => {
      try { await S.api.allowBack(b.dataset.id); toast("They can rejoin with the invite code now."); paint(); }
      catch (e) { toast(friendlyError(e), true); }
    },
    poster: () => printPoster(),
    "trucks-import": () => openImport("trucks", async () => { await refreshDept(); paint().catch(() => {}); }),
    "app-del": async (b) => {
      const list = [...(S.dept.settings?.apparatus || [])];
      list.splice(Number(b.dataset.i), 1);
      await saveSettings({ ...S.dept.settings, apparatus: list });
    },
    "loc-del": async (b) => {
      const locs = [...(S.dept.settings?.equipment_locations || [])];
      locs.splice(Number(b.dataset.i), 1);
      await saveSettings({ ...S.dept.settings, equipment_locations: locs });
    },
    leave: async () => {
      if (!(await confirmSheet({ title: `Leave ${S.dept.name}?`, message: "You'll lose access to its incidents and records. An officer can invite you back.", confirmLabel: "Leave department", danger: true }))) return;
      try {
        await S.api.leaveDepartment(S.dept.id);
        localStorage.removeItem("fgb_dept");
        location.hash = "#/";
        await afterSignIn();
      } catch (e) { toast(friendlyError(e), true); }
    },
  });

  function memberSheet(m) {
    if (!m) return;
    const self = m.user_id === S.user.id;
    const actions = [];
    actions.push(`<button class="option" data-a="profile">View profile</button>`);
    if (isOwner() && !self) {
      if (m.role !== "owner") actions.push(`<button class="option" data-a="owner">Make owner</button>`);
      if (m.role !== "officer") actions.push(`<button class="option" data-a="officer">Make officer</button>`);
      if (m.role !== "member") actions.push(`<button class="option" data-a="member">Make member</button>`);
    }
    if (isOfficer() && !self && m.role !== "owner" && (m.role !== "officer" || isOwner())) {
      actions.push(`<button class="option c-bad" data-a="remove">Remove from department</button>`);
    }
    const { el, close } = openSheet({ title: m.name, body: actions.join("") });
    el.addEventListener("click", async (e) => {
      const a = e.target.closest("[data-a]")?.dataset.a;
      if (!a) return;
      close();
      try {
        if (a === "profile") return openMemberProfile(m.id, () => paint());
        if (a === "remove") {
          if (!(await confirmSheet({ title: `Remove ${m.name}?`, message: "They lose access right away, stop counting as a paid member, and can't rejoin with the invite code unless you allow it.", confirmLabel: "Remove", danger: true }))) return;
          await S.api.removeMember(m.id, S.dept.id);
          toast(`${m.name} removed.`);
        } else {
          await S.api.setRole(m.id, a);
          toast(`${m.name} is now ${a === "owner" ? "an owner" : a === "officer" ? "an officer" : "a member"}.`);
        }
        await refreshDept();
        if (alive) paint().catch(() => {});
      } catch (ex) { toast(friendlyError(ex), true); }
    });
  }

  root.innerHTML = '<div class="spinner"></div>';
  paint().catch((e) => toast(friendlyError(e), true));
  return () => { alive = false; off(); };
}

// ============================================================
// Plan: pick monthly or yearly, pay, or manage billing. Web only.
// Apple doesn't allow paying outside the App Store inside an iPhone app,
// so the iPhone app never shows this screen.
// ============================================================
function planView() {
  let alive = true;
  let owner = null;
  let roster = 0;
  let pick = null; // seats chosen in the picker before checkout

  const paint = async () => {
    const d = S.dept;
    const P = CONFIG.PRICING;
    if (!owner) {
      const members = await S.api.listMembers(d.id).catch(() => []);
      owner = members.find((m) => m.role === "owner") || null;
      roster = members.length;
    }
    if (!alive) return;
    const status = d.subscription_status || "none";
    const subscribed = ["active", "trialing", "past_due"].includes(status);
    const used = Math.max(1, d.seat_count || 0);
    if (pick === null) pick = Math.min(P.seatCap, Math.max(used, d.seats_paid || 0, roster || 0, 1));
    pick = Math.min(P.seatCap, Math.max(1, pick));
    const { n, billed, capped, monthly, annual } = priceFor(Math.max(pick, Math.min(used, P.seatCap)));
    const seatsBilled = d.seats_billed || priceFor(d.seat_count).billed;
    const capM = money(P.seatCap * P.monthly);
    const capY = money(P.seatCap * P.annual);
    const save = money(P.monthly * 12 - P.annual);
    const perMonthYearly = (P.annual / 12).toFixed(2);
    const left = daysUntil(d.trial_ends_at);
    const inTrial = left > 0;
    const yearly = d.plan_interval === "year";
    const planName = d.plan_custom ? "Custom plan" : d.plan_interval ? (yearly ? "Yearly plan" : "Monthly plan") : "Your plan";
    const amount = d.plan_amount != null ? Number(d.plan_amount) : seatsBilled * (yearly ? P.annual : P.monthly);
    const cost = d.plan_interval ? t(yearly ? "{x} a year" : "{x} a month", { x: money(amount) }) : "";
    const whoLine = d.plan_custom ? t("Custom plan, {cost} plus tax.", { cost })
      : t(seatsBilled === 1 ? "1 seat, {cost} plus tax." : "{n} seats, {cost} plus tax.", { n: seatsBilled, cost });
    const ownerName = owner ? (owner.user_id === S.user.id ? t("you") : owner.name) : t("the department owner");

    // ---- where things stand ----
    let tone = "";
    let title = "";
    let line = "";
    let bar = "";
    if (status === "past_due") {
      tone = "warn";
      title = "Payment overdue";
      const until = d.past_due_since ? new Date(new Date(d.past_due_since).getTime() + 14 * 86400000) : null;
      line = [
        t(d.plan_invoice ? "The invoice hasn't been paid yet." : "Your last card payment didn't go through."),
        until && until > new Date() ? t("The board keeps working until {d}.", { d: dateLabel(until) }) : t("New incidents are paused until it's paid."),
        isOwner() ? t("Open billing to pay or update your card.") : esc(t("Let {name} know.", { name: ownerName })),
      ].join(" ");
    } else if (status === "active") {
      tone = "good";
      title = planName;
      line = [
        whoLine,
        t(d.plan_invoice ? "Paid by invoice." : "Paid by card."),
        d.plan_cancel_at ? `<b class="text">${t("Ends {d}.", { d: dateLabel(d.plan_cancel_at) })}</b>` : d.current_period_end ? t("Renews {d}.", { d: dateLabel(d.current_period_end) }) : "",
      ].join(" ");
    } else if (status === "trialing") {
      tone = "good";
      title = t("{plan} is set up", { plan: t(planName) });
      line = [
        inTrial ? t("Billing starts when your free trial ends on {d}.", { d: dateLabel(d.trial_ends_at) }) : t("Billing starts now."),
        cost ? whoLine : "",
        d.plan_cancel_at ? `<b class="text">${t("Set to end {d}.", { d: dateLabel(d.plan_cancel_at) })}</b>` : "",
      ].join(" ");
    } else if (inTrial) {
      title = `Free trial: ${left} day${left === 1 ? "" : "s"} left`;
      line = `Ends ${dateLabel(d.trial_ends_at)}. No card on file and nothing is charged until you choose a plan.`;
      const used = Math.min(P.trialDays, Math.max(0, P.trialDays - left));
      bar = `<div class="trial-bar" role="img" aria-label="${used} of ${P.trialDays} trial days used"><i style="width:${Math.round((used / P.trialDays) * 100)}%"></i></div>`;
    } else {
      tone = "bad";
      title = status === "canceled" ? "Your plan has ended" : "Your free trial has ended";
      line = `${t("New incidents are paused. Your records are safe and still readable.")} ${isOwner() ? t("Choose a plan below to turn everything back on.") : esc(t("Ask {name} to choose a plan.", { name: ownerName }))}`;
    }

    const planCard = (key) => {
      const isYear = key === "annual";
      return `<div class="plan-card ${isYear ? "best" : ""}">
        <div class="plan-top"><span class="plan-name">${isYear ? "Yearly" : "Monthly"}</span>${isYear ? `<span class="pill save">Save ${save} a member</span>` : ""}</div>
        <div class="plan-price"><b>${money(isYear ? P.annual : P.monthly)}</b><span>per member<br>${isYear ? "a year" : "a month"}</span></div>
        <div class="plan-total">${t(n === 1 ? "1 seat:" : "{n} seats:", { n })} <b>${isYear ? `${money(annual)} a year` : `${money(monthly)} a month`}</b> ${esc(P.taxNote)}</div>
        <ul class="plan-list">
          <li>${icon("check", "sm")}${t("Never more than {x} for the whole department", { x: isYear ? t("{x} a year", { x: capY }) : t("{x} a month", { x: capM }) })}</li>
          ${isYear
            ? `<li>${icon("check", "sm")}Works out to ${money(perMonthYearly)} a member each month</li><li>${icon("check", "sm")}Pay by card, or by invoice for your treasurer</li>`
            : `<li>${icon("check", "sm")}Lowest cost to start</li><li>${icon("check", "sm")}Cancel any time</li>`}
        </ul>
        ${isOwner() ? `
          <button class="btn ${isYear ? "primary" : ""} block" data-act="checkout" data-plan="${key}">Choose ${isYear ? "yearly" : "monthly"}</button>
          ${isYear ? `<button class="btn quiet block sm" data-act="invoice">Pay by invoice instead (cheque or EFT)</button>` : ""}` : ""}
      </div>`;
    };

    const choose = !subscribed || status === "canceled";
    root.innerHTML = `
    ${demoStrip()}
    <div class="screen with-nav">
      <header class="topbar"><div class="wrap topbar-in"><h1>Plan</h1></div></header>
      <div class="wrap plan-page" style="padding-top:16px">
        <section class="plan-status panel ${tone}">
          <div class="h2">${title}</div>
          ${bar}
          <p>${line}</p>
        </section>

        ${choose ? `
        <section class="section">
          <div class="section-head"><div class="h2">Choose a plan</div></div>
          <p class="muted" style="margin:4px 0 14px">${t("One price per person who signs in to the app, and never more than {b} paid seats. People on your roster without the app are free.", { b: P.seatCap })}</p>
          ${isOwner() ? seatPicker() : ""}
          <div class="plans">${planCard("annual")}${planCard("monthly")}</div>
          ${isOwner() ? `<p class="secure">${icon("lock", "sm")}<span>Secure checkout by Stripe. ${inTrial ? `Nothing is charged until your trial ends on ${dateLabel(d.trial_ends_at)}.` : "You're charged today."} Cancel any time.</span></p>`
            : `<div class="banner" style="margin-top:14px">${icon("user")}<div class="grow">Only ${esc(ownerName)} can choose the plan. Send them this page.</div></div>`}
        </section>` : `
        <section class="section">
          <div class="cols">
            <div class="col">
              <div class="panel">
                <div class="h3">Billing</div>
                <p class="muted small" style="margin:6px 0 14px">Update your card, pay an invoice, download receipts, switch between monthly and yearly, or cancel.</p>
                ${isOwner() ? `<button class="btn primary block" data-act="portal">${icon("card", "sm")} Open billing</button>` : `<p class="muted small">Only ${esc(ownerName)} can change billing.</p>`}
              </div>
            </div>
            <div class="col">
              ${seatsPanel()}
            </div>
          </div>
        </section>`}

        <section class="section">
          <div class="quote panel">
            <div class="grow">
              <div class="h3">${t("County, regional service or {n}+ members?", { n: P.quoteFrom })}</div>
              <p class="muted small">We set up one plan for every station, with one invoice and pricing that fits your budget. Tell us about your service and we'll send a quote.</p>
            </div>
            <button class="btn" data-act="quote">${icon("mail", "sm")} Get a quote</button>
          </div>
        </section>

        <section class="section" style="margin-bottom:40px">
          <div class="section-head"><div class="h2">Questions</div></div>
          <div class="panel faq-list">
            ${faq("How do seats work?", "Choose how many people will sign in to the app. Each one uses a seat. Names you add to the roster for people without the app are free. Change the number any time in Plan.")}
            ${faq("What if more people join than we paid for?", "They get in right away. Nobody is ever locked out of the board. We add a seat to your plan, up to the limit, and let you know.")}
            ${faq("Is there a limit on what we pay?", t("Yes. You never pay for more than {b} seats: {m} a month or {y} a year, plus tax, however many people you have.", { b: P.seatCap, m: capM, y: capY }))}
            ${faq("What happens when we add or remove seats?", "Added seats are charged for the rest of the current period on your next bill. Fewer seats lower your next bill. You can't go below the number of people signed in. Remove people in Department first.")}
            ${faq("Can we pay by cheque or EFT?", `Yes. Choose yearly, then Pay by invoice. We email a yearly invoice your treasurer can pay within 30 days.`)}
            ${faq("Is tax included?", `Prices are in ${esc(P.currency)}, plus tax where it applies.`)}
            ${faq("Can we switch or cancel?", "Any time, in Open billing. If you cancel, the board keeps working until the end of what you've paid for.")}
            ${faq("What if we stop paying?", "The board goes read-only. Nothing is deleted and you can still close active incidents. Pick a plan again and everything turns back on.")}
            <p class="muted small" style="padding-top:12px">Something else? Email <a href="mailto:${CONFIG.SUPPORT_EMAIL}">${CONFIG.SUPPORT_EMAIL}</a>.</p>
          </div>
        </section>
      </div>
    </div>
    ${bottomNav("plan")}`;
  };

  const faq = (q, a) => `<details class="faq"><summary>${q}</summary><p>${a}</p></details>`;

  // ---- seat picker (before checkout) ----
  function seatPicker() {
    const P = CONFIG.PRICING;
    const used = Math.max(1, S.dept.seat_count || 0);
    const quick = [
      [Math.min(used, P.seatCap), t(used === 1 ? "Just me" : "Signed in now ({n})", { n: used })],
      ...(roster > used ? [[Math.min(roster, P.seatCap), t("Whole roster ({n})", { n: roster })]] : []),
      [P.seatCap, t("{n} or more", { n: P.seatCap })],
    ].filter((q, i, a) => a.findIndex((x) => x[0] === q[0]) === i);
    return `<div class="seat-pick panel">
      <div class="seat-pick-head">
        <div class="grow">
          <div class="h3">How many people will use the app?</div>
          <p class="muted small">Count everyone who will sign in on their phone. If more join later, they get in right away and we add a seat.</p>
        </div>
        <div class="stepper" role="group" aria-label="Seats">
          <button type="button" class="iconbtn" data-act="seat-step" data-d="-1" aria-label="Fewer seats" ${pick <= Math.min(used, P.seatCap) ? "disabled" : ""}>${icon("minus")}</button>
          <output aria-live="polite">${pick}</output>
          <button type="button" class="iconbtn" data-act="seat-step" data-d="1" aria-label="More seats" ${pick >= P.seatCap ? "disabled" : ""}>${icon("plus")}</button>
        </div>
      </div>
      <div class="seat-quick">${quick.map(([v, l]) => `<button type="button" class="chip ${pick === v ? "on" : ""}" data-act="seat-set" data-n="${v}">${esc(l)}</button>`).join("")}</div>
      ${pick >= P.seatCap ? `<p class="faint small" style="margin-top:8px">${t("Past {b}, everyone is free.", { b: P.seatCap })}</p>` : ""}
    </div>`;
  }

  // ---- seats on an active plan ----
  function seatsPanel() {
    const P = CONFIG.PRICING;
    const d = S.dept;
    const used = d.seat_count || 0;
    const billed = d.seats_billed || priceFor(used).billed;
    const chose = d.seats_paid || 0;
    const pct = Math.min(100, Math.round((Math.min(used, billed) / Math.max(1, billed)) * 100));
    const extra = chose && used > chose ? Math.min(used, P.seatCap) - chose : 0;
    return `<div class="panel">
      <div class="h3">Seats</div>
      ${d.plan_custom ? `<p class="muted small" style="margin:6px 0 14px">${t("Custom plan. {u} people signed in. Email us to change it.", { u: used })}</p>
        <a class="btn block" href="mailto:${CONFIG.SUPPORT_EMAIL}?subject=${encodeURIComponent(`Fire Ground seats: ${d.name}`)}">${icon("mail", "sm")} Email us</a>` : `
      <div class="seat-meter" role="img" aria-label="${used} of ${billed}"><i style="width:${pct}%"></i></div>
      <p class="small" style="margin:8px 0 2px"><b>${t("{u} of {b} seats in use", { u: Math.min(used, billed), b: billed })}</b></p>
      <p class="muted small" style="margin:0 0 14px">${extra > 0 ? t("{x} joined after you chose {c}, so we added seats for them.", { x: extra, c: chose }) : used > P.seatCap ? t("Past {b}, everyone is free.", { b: P.seatCap }) : t("Anyone past that still gets in. We add a seat and let you know.")}</p>
      ${isOwner() ? `<button class="btn block" data-act="seats">${icon("user", "sm")} Change seats</button>` : ""}`}
      <a class="btn quiet block sm" href="#/dept" style="margin-top:8px">Manage people in Department</a>
    </div>`;
  }

  function seatsSheet() {
    const P = CONFIG.PRICING;
    const d = S.dept;
    const used = Math.min(d.seat_count || 0, P.seatCap);
    const min = Math.max(1, used);
    const current = d.seats_billed || priceFor(d.seat_count).billed;
    let v = Math.min(P.seatCap, Math.max(min, d.seats_paid || current));
    const yearly = d.plan_interval === "year";
    const each = yearly ? P.annual : P.monthly;
    const { el, close } = openSheet({
      title: "Change seats",
      body: `<p class="muted small" style="margin-bottom:14px">${t("{u} people are signed in, so the lowest you can choose is {m}. To go lower, remove people in Department first.", { u: d.seat_count || 0, m: min })}</p>
        <div class="stepper big" role="group" aria-label="Seats">
          <button type="button" class="iconbtn" data-d="-1" aria-label="Fewer seats">${icon("minus")}</button>
          <output aria-live="polite"></output>
          <button type="button" class="iconbtn" data-d="1" aria-label="More seats">${icon("plus")}</button>
        </div>
        <div class="seat-sum panel" aria-live="polite"></div>`,
      submitLabel: "Save seats",
      errorText: friendlyError,
      onSubmit: async () => {
        if (S.api.isDemo) { toast("Payments are turned off in the demo."); return; }
        await S.api.billing("seats", d.id, { seats: v });
        await refreshDept();
        toast(t("Saved. Your plan now has {n} seats.", { n: Math.max(v, used) }));
        paint().catch(() => {});
      },
    });
    const out = el.querySelector("output");
    const sum = el.querySelector(".seat-sum");
    const btns = el.querySelectorAll("[data-d]");
    const show = () => {
      out.textContent = String(v);
      btns[0].disabled = v <= min;
      btns[1].disabled = v >= P.seatCap;
      const total = money(v * each);
      const diff = v - current;
      sum.innerHTML = `<div><b>${t(yearly ? "{x} a year" : "{x} a month", { x: total })}</b> ${esc(P.taxNote)}</div>
        <div class="muted small" style="margin-top:4px">${diff > 0 ? t("Adding {n}. They're charged for the rest of this period on your next bill.", { n: diff })
          : diff < 0 ? t("Removing {n}. Your next bill is lower. No refund for the current period.", { n: -diff })
          : t("No change.")}</div>`;
    };
    btns.forEach((b) => b.addEventListener("click", () => { v = Math.min(P.seatCap, Math.max(min, v + Number(b.dataset.d))); show(); }));
    show();
    return { close };
  }

  function invoiceSheet() {
    const PROV = ["ON", "QC", "NS", "NB", "MB", "SK", "AB", "BC", "PE", "NL", "YT", "NT", "NU"];
    openSheet({
      title: "Pay by invoice",
      body: `<p class="muted small" style="margin-bottom:14px">We email a yearly invoice (${money(CONFIG.PRICING.annual)} per member) your treasurer or municipality can pay by cheque or EFT. Due in 30 days.${daysUntil(S.dept.trial_ends_at) > 2 ? " <span>The first one is sent when your free trial ends.</span>" : ""}</p>
        ${field("Bill to", input("org", S.dept.name, 'placeholder="Department or municipality name"'))}
        ${field("Invoice email", input("email", S.user.email || "", 'type="email" inputmode="email" placeholder="treasurer@township.ca"'), "Usually your treasurer or clerk")}
        ${field("Street address", input("line1", "", 'autocomplete="address-line1"'))}
        <div class="grid2">${field("Town", input("city", "", 'autocomplete="address-level2"'))}${field("Province", select("province", PROV, "ON"))}</div>
        <div class="grid2">${field("Postal code", input("postal", "", 'autocomplete="postal-code" autocapitalize="characters" maxlength="7"'))}${field("PO number", input("po", "", 'placeholder="Optional"'))}</div>`,
      submitLabel: "Send invoices to this address",
      errorText: friendlyError,
      onSubmit: async (form) => {
        const f = formData(form);
        if (!/^\S+@\S+\.\S+$/.test(f.email)) throw new Error("Enter the email where invoices should go.");
        if (!f.line1 || !f.city || !f.postal) throw new Error("Enter the full billing address.");
        await S.api.billing("invoice", S.dept.id, { ...f, seats: pick });
        await refreshDept();
        toast(`Done. Invoices go to ${f.email}.`);
      },
    });
  }

  function quoteSheet() {
    const PROV = ["ON", "QC", "NS", "NB", "MB", "SK", "AB", "BC", "PE", "NL", "YT", "NT", "NU", "Outside Canada"];
    openSheet({
      title: "Get a quote",
      body: `<p class="muted small" style="margin-bottom:14px">For counties, regional services and big departments. Tell us about your service and we reply within one business day.</p>
        ${field("Service or department", input("org", S.dept.name))}
        <div class="grid2">${field("Stations", input("stations", "", 'inputmode="numeric" placeholder="e.g. 6"'))}${field("People", input("people", String(S.dept.seat_count || ""), 'inputmode="numeric"'))}</div>
        <div class="grid2">${field("Your name", input("name", S.me?.name || ""))}${field("Province", select("province", PROV, "ON"))}</div>
        ${field("Phone", input("phone", S.me?.phone || "", 'type="tel" inputmode="tel" placeholder="Optional"'))}
        ${field("Anything else", textarea("notes", "", 'placeholder="Budget timing, how you pay, what you use now"'))}`,
      submitLabel: "Send request",
      errorText: friendlyError,
      onSubmit: async (form) => {
        const f = formData(form);
        if (!f.org) throw new Error("Enter your service or department.");
        const lines = [
          `Service: ${f.org}`, `Stations: ${f.stations || "-"}`, `People: ${f.people || "-"}`, `Province: ${f.province}`,
          `Contact: ${f.name || "-"}, ${f.phone || "no phone"}, ${S.user.email || ""}`, f.notes ? `Notes: ${f.notes}` : "",
        ].filter(Boolean);
        if (S.api.isDemo) { toast("Quote requests are turned off in the demo."); return; }
        try {
          await S.api.requestQuote(S.dept.id, lines.join("\n"));
          toast("Sent. We'll get back to you within one business day.");
        } catch {
          // If it can't be sent from here, fall back to the email app.
          location.href = `mailto:${CONFIG.SUPPORT_EMAIL}?subject=${encodeURIComponent(`Fire Ground quote: ${f.org}`)}&body=${encodeURIComponent(lines.join("\n"))}`;
        }
      },
    });
  }

  const off = bindActions(root, {
    quote: () => quoteSheet(),
    checkout: async (b) => {
      if (S.api.isDemo) return toast("Payments are turned off in the demo.");
      b.disabled = true;
      const label = b.textContent;
      b.textContent = "Opening secure checkout...";
      try { const { url } = await S.api.billing("checkout", S.dept.id, { plan: b.dataset.plan, seats: pick }); location.href = url; }
      catch (e) { toast(friendlyError(e), true); b.disabled = false; b.textContent = label; }
    },
    invoice: () => (S.api.isDemo ? toast("Payments are turned off in the demo.") : invoiceSheet()),
    "seat-step": (b) => { pick += Number(b.dataset.d); paint().catch(() => {}); },
    "seat-set": (b) => { pick = Number(b.dataset.n); paint().catch(() => {}); },
    seats: () => seatsSheet(),
    portal: async (b) => {
      if (S.api.isDemo) return toast("Payments are turned off in the demo.");
      b.disabled = true;
      try { const { url } = await S.api.billing("portal", S.dept.id); location.href = url; }
      catch (e) { toast(friendlyError(e), true); b.disabled = false; }
    },
  });

  root.innerHTML = '<div class="spinner"></div>';
  paint().catch((e) => toast(friendlyError(e), true));
  return () => { alive = false; off(); };
}

// ============================================================
// Station chat
// ============================================================
function stationChatView() {
  root.innerHTML = `
  ${demoStrip()}
  <div class="screen with-nav chat-screen">
    <header class="topbar"><div class="wrap topbar-in"><h1>Station chat</h1><span class="sub show-wide">${esc(t("Everyone in {dept}", { dept: S.dept.name }))}</span></div></header>
    <div class="wrap chat-wrap"></div>
  </div>
  ${bottomNav("chat")}`;
  const ui = mountChat(root.querySelector(".chat-wrap"), { deptId: S.dept.id, incidentId: null });
  return () => ui.destroy();
}

// ============================================================
// Me
// ============================================================
function meView() {
  const m = S.me;
  root.innerHTML = `
  ${demoStrip()}
  <div class="screen with-nav">
    <header class="topbar"><div class="wrap topbar-in"><h1>Me</h1></div></header>
    <div class="wrap" style="padding-top:16px">
      <div class="cols">
      <div class="col">
      <div class="panel" style="display:flex;align-items:center;gap:14px">
        <div class="avatar" style="width:54px;height:54px;font-size:20px;background:${colorFor(m.name)}">${esc(initials(m.name))}</div>
        <div style="min-width:0"><div class="h3" style="font-size:22px">${esc(m.name)}</div><div class="muted small">${esc(t("{rank} at {dept}", { rank: t(m.rank), dept: S.dept.name }))}</div><div class="faint small">${esc(S.user.email || "")}</div></div>
      </div>

      <form class="panel section" id="me-form" novalidate>
        <div class="h3" style="margin-bottom:12px">My details</div>
        ${field("Name", input("name", m.name))}
        <div class="grid2">${field("Rank", select("rank", RANKS.includes(m.rank) ? RANKS : [m.rank, ...RANKS], m.rank))}${field("Crew", select("crew", ["", ...CREWS], m.crew || ""))}</div>
        <div class="grid2">${field("Call sign", input("call_sign", m.call_sign || ""))}${field("Radio number", input("radio", m.radio || ""))}</div>
        ${field("Phone", input("phone", m.phone || "", 'type="tel" autocomplete="tel"'))}
        <button class="btn block" style="margin-top:16px">Save my details</button>
      </form>
      </div>
      <div class="col">

      <section class="section first-desk">
        <div class="section-head"><div class="h2">Language</div></div>
        <div class="segment" role="radiogroup" aria-label="Language" data-notr>
          ${LANGS.map(([k, l]) => `<button data-act="lang" data-k="${k}" role="radio" lang="${k}" aria-checked="${getLang() === k}" class="${getLang() === k ? "on" : ""}">${l}</button>`).join("")}
        </div>
        <p class="hint">Call alerts on your phone use this language too.</p>
      </section>

      <section class="section">
        <div class="section-head"><div class="h2">On a call</div></div>
        <div class="panel">
          <div class="label">Screen</div>
          <div class="segment" role="radiogroup" aria-label="Screen">
            ${[["dark", "Night"], ["sun", "Sunlight"], ["auto", "Match phone"]].map(([k, l]) => `<button data-act="theme" data-k="${k}" role="radio" aria-checked="${getTheme() === k}" class="${getTheme() === k ? "on" : ""}">${l}</button>`).join("")}
          </div>
          <p class="hint">Sunlight is easier to read outside in daylight.</p>
          <label class="check" style="margin-top:10px"><input type="checkbox" data-sound ${soundOn() ? "checked" : ""}> Sound an alarm for PAR and Missing</label>
          <button class="btn sm" data-act="test-sound">Test the alarm</button>
          <p class="hint">${IS_NATIVE ? "The alarm plays while the app is open. Call alerts below reach you when it's closed." : "Keep your ringer on. Phones only play sound while the app is open."}</p>
          ${IS_NATIVE ? `<div class="label" style="margin-top:16px">Call alerts</div><div id="push-row" class="muted small">Checking...</div>
          <label class="check" style="margin-top:6px"><input type="checkbox" data-chat-alerts ${S.me?.chat_alerts !== false ? "checked" : ""}> Chat alerts for station chat and your incidents</label>
          <p class="hint">You always get an alert when someone @mentions you.</p>` : ""}
        </div>
      </section>

      ${S.isAdmin ? `<a class="list section row admin-link" href="#/admin">${icon("wrench")}<div class="grow"><div class="title">Admin</div><div class="meta">Money, sign-ups, departments and alerts. Only you see this.</div></div><span class="chev">${icon("chev", "sm")}</span></a>` : ""}

      <div class="list section">
        <button class="row" data-act="profile"><div class="grow"><div class="title">Certifications, medical, emergency contact</div><div class="meta">Officers can see these on a call</div></div><span class="chev">${icon("chev", "sm")}</span></button>
        ${S.memberships.length > 1 ? `<button class="row" data-act="switch"><div class="grow"><div class="title">Switch department</div></div><span class="chev">${icon("chev", "sm")}</span></button>` : ""}
        <button class="row" data-act="join"><div class="grow"><div class="title">Join another department</div></div><span class="chev">${icon("chev", "sm")}</span></button>
      </div>

      <div class="list section">
        <a class="row" href="privacy.html"><div class="grow"><div class="title">Privacy policy</div></div><span class="chev">${icon("chev", "sm")}</span></a>
        <a class="row" href="terms.html"><div class="grow"><div class="title">Terms of use</div></div><span class="chev">${icon("chev", "sm")}</span></a>
        <button class="row" data-act="help"><div class="grow"><div class="title">Help</div><div class="meta">Sign-in codes, new phones, alarms, billing</div></div><span class="chev">${icon("chev", "sm")}</span></button>
      </div>

      <div class="section stack" style="margin-bottom:30px">
        <button class="btn block" data-act="signout">${S.api.isDemo ? "Exit demo" : "Sign out"}</button>
        ${S.api.isDemo ? "" : `<button class="btn quiet block" data-act="signout-all">Sign out on all my devices</button>`}
        ${S.api.isDemo ? "" : `<button class="btn danger block" data-act="delete">Delete my account</button>`}
        <div style="max-width:220px;margin:18px auto 0;opacity:.9">${logo()}</div>
        <p class="faint small" style="text-align:center">Version ${CONFIG.VERSION}. Made in Canada by MKE Group Inc.</p>
      </div>
      </div>
      </div>
    </div>
  </div>
  ${bottomNav("me")}`;

  root.querySelector("#me-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = formData(e.target);
    if (!f.name) return toast("Name can't be empty.", true);
    try {
      await S.api.updateMember(S.me.id, { name: f.name, rank: f.rank, crew: f.crew || null, call_sign: f.call_sign || null, radio: f.radio || null, phone: f.phone || null });
      await refreshDept();
      toast("Saved.");
    } catch (ex) { toast(friendlyError(ex), true); }
  });

  const pushRow = root.querySelector("#push-row");
  if (pushRow) {
    const show = async () => {
      const st = await pushState();
      pushRow.innerHTML = st === "on" ? `${icon("check", "sm")} On. You'll get new calls, PAR checks and Missing alerts.`
        : st === "ask" ? `<button class="btn sm primary" data-act="alerts-on">Turn on call alerts</button>`
        : st === "off" ? `Off. <button class="btn sm" data-act="alerts-on">Open Settings</button>`
        : "Not available on this device.";
    };
    show();
    pushRow.addEventListener("click", async (e) => { if (e.target.closest('[data-act="alerts-on"]')) { await askForPush(); show(); } });
  }
  root.querySelector("[data-sound]").addEventListener("change", (e) => { setSound(e.target.checked); toast(e.target.checked ? "Alarm sound on." : "Alarm sound off. You'll still see the banner."); });

  root.querySelector("[data-chat-alerts]")?.addEventListener("change", async (e) => {
    const on = e.target.checked;
    try { await S.api.setChatAlerts(S.me.id, on); S.me.chat_alerts = on; toast(on ? "Chat alerts on." : "Chat alerts off. Mentions still come through."); }
    catch (ex) { e.target.checked = !on; toast(friendlyError(ex), true); }
  });
  return bindActions(root, {
    theme: (b) => {
      setTheme(b.dataset.k);
      root.querySelectorAll('[data-act="theme"]').forEach((x) => { const on = x.dataset.k === b.dataset.k; x.classList.toggle("on", on); x.setAttribute("aria-checked", on); });
    },
    lang: async (b) => {
      if (!S.api.isDemo) await S.api.setLanguage(S.user.id, b.dataset.k).catch(() => {});
      setLang(b.dataset.k);
    },
    "test-sound": () => {
      if (!soundOn()) return toast("Turn the alarm sound on first.", true);
      toast("Playing the PAR tone, then the Missing alarm. Turn your volume up.");
      alertTone("par");
      setTimeout(() => alertTone("missing"), 1400);
    },
    profile: () => openMemberProfile(S.me.id, () => refreshDept()),
    switch: () => switchDeptSheet(),
    join: () => renderOnboarding(),
    signout: async () => { if (S.api.isDemo) return exitDemo(); await S.api.signOut(); },
    help: () => helpSheet(),
    "signout-all": async () => {
      if (!(await confirmSheet({ title: "Sign out everywhere?", message: "Every phone and computer signed in to your account is signed out. Use this if a device was lost.", confirmLabel: "Sign out everywhere" }))) return;
      try { await S.api.signOut(true); } catch (e) { toast(friendlyError(e), true); }
    },
    delete: () => {
      openSheet({
        title: "Delete your account",
        body: `<p>This permanently deletes your login and removes you from your departments. If you're the only person in a department, that department and its records are deleted too.</p>
          <p class="muted" style="margin-top:10px">Type <b>DELETE</b> to confirm.</p>${input("confirm", "", 'autocomplete="off" autocapitalize="characters"')}`,
        submitLabel: "Delete account",
        danger: true,
        errorText: friendlyError,
        onSubmit: async (form) => {
          if (formData(form).confirm.toUpperCase() !== "DELETE") throw new Error("Type DELETE to confirm.");
          await S.api.deleteAccount();
          await S.api.signOut().catch(() => {});
          localStorage.clear();
          location.href = location.pathname;
        },
      });
    },
  });
}

// ============================================================
boot().catch((e) => {
  console.error(e);
  root.innerHTML = `<div class="wrap empty" style="padding-top:80px"><div class="h3">Fire Ground Board could not start</div><p>${esc(friendlyError(e))}</p><button class="btn" data-reload>Reload</button></div>`;
});

export { renderOnboarding };
