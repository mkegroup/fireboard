import { CONFIG, HAS_BACKEND, IS_NATIVE } from "./config.js";
import { createApi } from "./api.js";
import { createDemoApi } from "./demo.js";
import { S, RANKS, CREWS, CALL_TYPES, APP_KINDS, isOfficer, isOwner, hasAccess, planLabel, go } from "./state.js";
import { esc, initials, colorFor, dateTime, elapsed, ago, daysUntil, formData, copyText, friendlyError, applyTheme, getTheme, setTheme, soundOn, setSound, alertTone } from "./util.js";
import { icon, toast, openSheet, confirmSheet, field, input, select } from "./ui.js";
import { boardView } from "./board.js";
import { recordsView, openMemberProfile } from "./records.js";

const root = document.getElementById("root");

// Never run inside someone else's page (clickjacking). GitHub Pages can't send
// a frame-ancestors header, so this is done here.
if (window.top !== window.self) {
  document.documentElement.innerHTML = "";
  try { window.top.location = window.self.location.href; } catch { /* blocked */ }
  throw new Error("framed");
}

document.addEventListener("click", (e) => { if (e.target.closest("[data-reload]")) location.reload(); });

if ("serviceWorker" in navigator && location.protocol === "https:") {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
let cleanup = null;
let pendingJoinCode = null;

// ============================================================
// Boot
// ============================================================
async function boot() {
  applyTheme();
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
    if (event === "SIGNED_OUT") { S.user = null; S.dept = null; S.me = null; return renderAuth("email"); }
    if (event === "SIGNED_IN" && session && !S.user) { S.user = session.user; await afterSignIn(); }
  });
  const session = await S.api.getSession();
  if (!session) return renderAuth("email");
  S.user = session.user;
  await afterSignIn();

  if (params.get("billing")) {
    const b = params.get("billing");
    if (b === "success") toast("You're all set. Thanks for supporting the board.");
    history.replaceState(null, "", location.pathname + location.hash);
    setTimeout(refreshDept, 2500);
  }
}

async function startDemo() {
  sessionStorage.setItem("fgb_demo", "1");
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
  if (!S.memberships.length) return renderOnboarding();
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
  S.dept = m.dept;
  S.me = m.member;
  localStorage.setItem("fgb_dept", m.dept.id);
}

export async function refreshDept() {
  if (!S.dept) return;
  try {
    S.memberships = await S.api.myDepartments(S.user.id);
    const m = S.memberships.find((x) => x.dept.id === S.dept.id);
    if (m) setDept(m);
    else if (S.memberships[0]) setDept(S.memberships[0]);
    else return renderOnboarding();
    S.rerender();
  } catch { /* keep current */ }
}

// ============================================================
// Router
// ============================================================
function route() {
  if (!S.user || !S.dept) return;
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  window.scrollTo(0, 0);
  const h = location.hash || "#/";
  let m;
  if ((m = h.match(/^#\/incident\/([\w-]+)/))) cleanup = boardView(root, m[1]);
  else if ((m = h.match(/^#\/records(?:\/(\w+))?/))) cleanup = recordsView(root, m[1] || "roster");
  else if (h.startsWith("#/dept")) cleanup = deptView();
  else if (h.startsWith("#/me")) cleanup = meView();
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
  const v = Number(n);
  return `$${v % 1 ? v.toFixed(2) : v.toLocaleString("en-CA")}`;
}

/** What the department would pay per year right now. */
export function priceFor(seats) {
  const P = CONFIG.PRICING;
  const n = Math.max(1, seats || 0);
  return { n, monthly: n * P.monthly, annual: n * P.annual };
}

export function helpSheet() {
  const q = (t, a) => `<details class="faq"><summary>${t}</summary><p>${a}</p></details>`;
  openSheet({
    title: "Help",
    body: `
      ${q("I didn't get the sign-in code", "Check your junk or spam folder and search for Fire Ground Board. It can take a minute. Codes work for 10 minutes. You can ask for a new one after 60 seconds.")}
      ${q("I got a new phone", "Open the app and sign in with the same email. Everything is saved to your account, not the phone.")}
      ${q("Put the app on my home screen", "iPhone: open it in Safari, tap Share, then Add to Home Screen. Android: tap the menu, then Install app. It opens like a normal app after that.")}
      ${q("My phone didn't sound for PAR", "The alarm plays while the app is open. Keep your ringer on and test it in Me, On a call.")}
      ${q("Make someone else the owner", "Department, Members, tap the person, Make owner. Do this before the old owner leaves.")}
      ${q("I removed someone by mistake", "Department, Members, Removed people, Allow back. Then they can rejoin with the invite code.")}
      ${q("Someone shouldn't have the invite code", "Department, Make a new code. The old code and link stop working. People already in stay in.")}
      ${q("Receipts, card or cancelling", "The department owner opens Department, Plan, Manage plan, card and receipts. Everything is there.")}
      ${q("Getting our records out", "Records has a download button on each tab. Incident reports download from the incident menu.")}
      <p class="muted small" style="margin-top:16px">Still stuck? Email <a href="mailto:${CONFIG.SUPPORT_EMAIL}">${CONFIG.SUPPORT_EMAIL}</a> with your department name.</p>`,
  });
}

// Android/desktop Chrome hands us an install prompt we can show on a button.
let installEvt = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvt = e; });
const isStandalone = () => window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;

export function installCard(dismissed) {
  if (IS_NATIVE || isStandalone() || dismissed) return "";
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (!installEvt && !ios) return "";
  return `<div class="banner">${icon("download")}<div class="grow"><b>Put Fire Ground on your home screen</b><br><span class="muted">${installEvt ? "One tap to open it on a call." : "In Safari tap Share, then Add to Home Screen."}</span></div>
    ${installEvt ? '<button class="btn sm primary" data-act="install">Install</button>' : ""}<button class="iconbtn ghost" data-act="dismiss" data-k="install" aria-label="Hide">${icon("close", "sm")}</button></div>`;
}

export function demoStrip() {
  if (!S.api?.isDemo) return "";
  return `<div class="demo-strip">Demo department. Nothing here is saved. <button data-act="exit-demo">Exit demo</button></div>`;
}

export function bottomNav(active) {
  const item = (href, key, ic, label) => `<a href="${href}" class="${active === key ? "on" : ""}">${icon(ic)}${label}</a>`;
  return `<nav class="bottomnav no-print"><div class="bottomnav-in">
    ${item("#/", "home", "flame", "Incidents")}
    ${item("#/records", "records", "book", "Records")}
    ${item("#/dept", "dept", "shield", "Department")}
    ${item("#/me", "me", "user", "Me")}
  </div></nav>`;
}

export function accessBanner() {
  const d = S.dept;
  if (!d) return "";
  // Inside the iOS app we never point people at buying. Owners manage the plan on the web.
  const canBuy = isOwner() && !IS_NATIVE;
  if (!hasAccess(d)) {
    const title = d.subscription_status && d.subscription_status !== "incomplete" ? "This department's plan has ended." : "Your free trial has ended.";
    const msg = canBuy ? "Choose a plan to start new incidents again." : IS_NATIVE ? "New incidents are paused." : "Ask your chief to choose a plan.";
    return `<div class="banner bad">${icon("alert")}<div class="grow"><b>${title}</b><br>${msg} Your records are safe and still readable.</div>
      ${canBuy ? '<a class="btn sm primary" href="#/dept">Plans</a>' : ""}</div>`;
  }
  if (d.subscription_status === "past_due") {
    if (IS_NATIVE) return `<div class="banner warn">${icon("alert")}<div class="grow"><b>There's a billing problem with this department.</b> Let your chief know.</div></div>`;
    return `<div class="banner warn">${icon("alert")}<div class="grow"><b>Payment overdue.</b> ${isOwner() ? "Pay the open invoice or update your card to keep the board running." : "Let your chief know the department's payment is overdue."}</div>${isOwner() ? '<a class="btn sm" href="#/dept">Fix</a>' : ""}</div>`;
  }
  const paid = ["active", "trialing"].includes(d.subscription_status);
  const left = daysUntil(d.trial_ends_at);
  if (!paid && left <= (isOwner() ? 7 : 2) && !IS_NATIVE) {
    return `<div class="banner warn">${icon("alert")}<div class="grow"><b>${left} day${left === 1 ? "" : "s"} left in your free trial.</b> ${isOwner() ? "Pick a plan so the board keeps working." : "Your chief can pick a plan in Department."}</div>${isOwner() ? '<a class="btn sm" href="#/dept">Plans</a>' : ""}</div>`;
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
  root.innerHTML = `
  <div class="auth">
    <div class="auth-hero">
      ${logo("auth-logo")}
      <h1>${code ? "Check your email." : pendingJoinCode ? "You're invited." : "Know where every firefighter is."}</h1>
      <p>${code ? `We sent a 6-digit code to <b class="text">${esc(authEmail)}</b>. It works for 10 minutes.`
        : pendingJoinCode ? "Enter your email to join your department's board. No password needed."
        : `Live PAR accountability for volunteer and career departments. Free for ${P.trialDays} days.`}</p>
    </div>
    <div class="auth-body">
      ${!HAS_BACKEND ? `<div class="banner warn" style="margin-bottom:18px">${icon("alert")}<div class="grow">This copy of the app isn't connected to a server yet. Try the demo to look around.</div></div>` : ""}
      <form id="auth-form" novalidate>
        ${code
          ? field("Sign-in code", input("token", "", 'inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="10" class="input code-input" placeholder="123456"'))
          : field("Email", input("email", authEmail, 'type="email" autocomplete="email" inputmode="email" autocapitalize="off" spellcheck="false" required'))}
        ${pw ? field("Password", input("password", "", 'type="password" autocomplete="current-password" required')) : ""}
        <div class="error-text" id="auth-err" hidden></div>
        <button class="btn primary block" style="margin-top:18px" ${!HAS_BACKEND ? "disabled" : ""}>${code ? "Sign in" : pw ? "Sign in" : "Email me a code"}</button>
      </form>
      ${code ? `<div class="auth-switch"><button data-act="resend" id="resend">Send a new code</button> &nbsp; <button data-mode="email">Use a different email</button></div>`
        : `<p class="hint" style="text-align:center;margin-top:12px">${pw ? "" : "New here? Same button. Your account is made when you sign in."}</p>`}
      <div class="divider">or</div>
      <button class="btn block" id="try-demo">Try the demo department</button>
      <p class="small faint" style="margin-top:22px;text-align:center">
        <button class="faint" data-act="help" style="text-decoration:underline">Trouble signing in?</button> &nbsp;
        ${pw ? '<button class="faint" data-mode="email" style="text-decoration:underline">Use an email code</button>' : '<button class="faint" data-mode="password" style="text-decoration:underline">Password sign-in</button>'}<br><br>
        <a href="privacy.html" class="faint">Privacy</a> &nbsp; <a href="terms.html" class="faint">Terms</a>
      </p>
    </div>
  </div>`;
  root.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => renderAuth(b.dataset.mode)));
  root.querySelector("#try-demo").addEventListener("click", startDemo);
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
        <p class="muted small" style="margin:4px 0 12px">For chiefs and officers. Free for ${P.trialDays} days, no card needed. Then ${money(P.monthly)} a month or ${money(P.annual)} a year per member with the app.</p>
        ${field("Department name", input("dept", "", 'placeholder="e.g. Madawaska Valley Fire" autocapitalize="words"'))}
        ${field("Your name", input("name", "", 'autocomplete="name" autocapitalize="words"'))}
        <details class="more"><summary class="muted small">Your rank (optional)</summary><div style="margin-top:10px">${field("Rank", select("rank", RANKS, "Chief"))}</div></details>
        <div class="error-text" data-err hidden></div>
        <button class="btn block" style="margin-top:16px">Start free trial</button>
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
    if (!alive) return;
    memberCount = members.length;
    const openTraining = training.filter((t) => t.attendance_open && !attendance.some((a) => a.session_id === t.id && a.member_id === S.me.id));
    const canStart = isOfficer() && hasAccess();

    root.innerHTML = `
    ${demoStrip()}
    <div class="screen with-nav">
      <div class="wrap dept-head">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="flex:1;min-width:0">
            <div class="dept-name">${esc(S.dept.name)}</div>
            <div class="muted small" style="margin-top:4px">${esc(planLabel())}</div>
          </div>
          ${S.memberships.length > 1 ? `<button class="iconbtn" data-act="switch" aria-label="Switch department">${icon("shield")}</button>` : ""}
        </div>
      </div>
      <div class="wrap stack" style="margin-top:12px">
        ${accessBanner()}
        ${openTraining.map((t) => `<div class="banner"><div class="grow"><b>${esc(t.title)}</b><br><span class="muted">Attendance is open. Mark yourself present.</span></div><button class="btn sm primary" data-act="attend" data-id="${t.id}">I was there</button></div>`).join("")}
        ${installCard(dismissed("install"))}
        ${isOfficer() ? setupCard(recent.length + active.length) : howItWorks()}
      </div>

      <div class="wrap section">
        <div class="section-head">
          <div class="h2">Active</div>
          ${canStart && active.length ? `<button class="btn sm primary" data-act="start">${icon("plus", "sm")} Start incident</button>` : ""}
        </div>
        ${active.length ? active.map((inc, i) => activeCard(inc, states[i])).join('<div style="height:12px"></div>') : canStart ? `
          <button class="start-big" data-act="start">${icon("flame")}<span><b>Start incident</b><small>Paged out? Tap here. Your crew joins from their phones.</small></span></button>` : `
          <div class="panel empty" style="padding:28px 20px">
            <div class="h3">No active incidents</div>
            <p>When an officer starts an incident it shows up here. Tap I'm responding and you're on the board.</p>
          </div>`}
      </div>

      <div class="wrap section" style="margin-bottom:24px">
        <div class="section-head"><div class="h2">Recent</div></div>
        ${recent.length ? `<div class="list">${recent.map((inc) => `
          <a class="row" href="#/incident/${inc.id}">
            <div class="grow">
              <div class="title">${esc(inc.name)}</div>
              <div class="meta">${esc(inc.address || "No address")}, ${dateTime(inc.started_at)}${inc.closed_at ? `, ${elapsed(inc.started_at, inc.closed_at)}` : ""}</div>
            </div>
            <span class="chev">${icon("chev", "sm")}</span>
          </a>`).join("")}</div>` : `<p class="muted">Closed incidents and their reports will appear here.</p>`}
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
    install: async () => {
      if (!installEvt) return;
      installEvt.prompt();
      await installEvt.userChoice.catch(() => {});
      installEvt = null;
      paint().catch(() => {});
    },
    dismiss: (b) => { try { localStorage.setItem(dismissKey(b.dataset.k), "1"); } catch { /* private mode */ } paint().catch(() => {}); },
    respond: async (b) => {
      b.disabled = true;
      try { await S.api.joinIncident(b.dataset.id); go(`#/incident/${b.dataset.id}`); }
      catch (e) { toast(friendlyError(e), true); b.disabled = false; }
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
      <div class="muted">${esc(inc.address || "No address")}${inc.call_type && inc.call_type !== inc.name ? `, ${esc(inc.call_type)}` : ""}</div>
      <div class="counts">
        <span class="count"><b class="c-IN">${n("IN")}</b>In</span>
        <span class="count"><b>${onScene}</b>On scene</span>
        <span class="count"><b>${n("Responding")}</b>Responding</span>
        <span class="count"><b>${p.length}</b>Total</span>
      </div>
    </a>
    ${!meOn && hasAccess() ? `<button class="btn primary block respond" data-act="respond" data-id="${inc.id}">I'm responding</button>` : ""}
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
      <div style="margin-top:14px">${field("Address or location", input("address", "", 'placeholder="e.g. 142 Mill Street" autocomplete="off"'))}</div>
      ${units.length ? `<div class="label" style="margin-top:14px">Trucks responding</div>
        <div class="choice-grid">${units.map((u, i) => `<label class="choice"><input type="checkbox" name="unit_${i}"><span>${esc(u.name)}</span></label>`).join("")}</div>` : ""}
      <details style="margin-top:14px"><summary class="muted small">Give it a custom name</summary>
        <div style="margin-top:10px">${field("Incident name", input("name", "", 'placeholder="Defaults to the call type"'))}</div></details>
      <p class="hint">You go on the board as Staged. Your crew sees it on their phones right away.</p>`,
    submitLabel: "Start incident",
    errorText: friendlyError,
    onSubmit: async (form) => {
      const f = formData(form);
      const name = f.name || f.call_type || "";
      if (!name) throw new Error("Pick a call type or give the incident a name.");
      const id = await S.api.startIncident(S.dept.id, { name, address: f.address, call_type: f.call_type });
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
  let dispatchToken = null;

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

        <section class="section">
          <div class="section-head"><div class="h2">Plan</div></div>
          <div class="panel">
            <div style="display:flex;align-items:center;gap:10px">
              <div class="grow" style="flex:1"><div class="h3">${esc(planLabel())}</div>
              <div class="muted small">${d.seat_count} member${d.seat_count === 1 ? "" : "s"} with the app${d.current_period_end && paid ? `, renews ${new Date(d.current_period_end).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" })}` : ""}</div></div>
            </div>
            ${planActions(paid)}
          </div>
        </section>

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
          <div class="section-head"><div class="h2">Dispatch connection</div></div>
          <div class="panel">
            <p class="muted small">When your dispatch centre or CAD sends a page to this address, Fire Ground Board starts the incident automatically. Send this to your county IT or dispatch supervisor.</p>
            <div id="dispatch-box" style="margin-top:12px">
              <button class="btn block" data-act="show-dispatch">Show connection details</button>
            </div>
          </div>
        </section>` : ""}

        ${isOfficer() ? `
        <section class="section">
          <div class="section-head"><div class="h2">Trucks</div></div>
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
    ${bottomNav("dept")}`;
    bindForms();
  };

  function planActions(paid) {
    const P = CONFIG.PRICING;
    if (IS_NATIVE) return `<p class="muted small" style="margin-top:10px">Your department's plan can't be changed in this app.</p>`;
    if (paid) {
      return isOwner()
        ? `<button class="btn block" style="margin-top:14px" data-act="portal">Manage plan, card and receipts</button>
           <p class="hint">Add or remove people any time. Your bill adjusts on its own. Switch monthly or yearly, or cancel, in the same place.</p>`
        : `<p class="muted small" style="margin-top:10px">Your department's owner manages billing.</p>`;
    }
    const { n, monthly, annual } = priceFor(S.dept.seat_count);
    const left = daysUntil(S.dept.trial_ends_at);
    const save = Math.round((1 - P.annual / (P.monthly * 12)) * 100);
    return `
      <div class="price-box">
        <div class="price"><b>${money(P.monthly)}</b><span>a month, or ${money(P.annual)} a year, per member</span></div>
        <div class="muted small" style="margin-top:6px">For your ${n} member${n === 1 ? "" : "s"} with the app: <b class="text">${money(monthly)} a month</b> or <b class="text">${money(annual)} a year</b>, ${esc(P.taxNote)}. People on the roster without the app are free.</div>
      </div>
      ${S.api.isDemo ? `<p class="muted small" style="margin-top:12px">Payments are turned off in the demo.</p>`
        : isOwner() ? `<div class="stack" style="margin-top:14px">
          <button class="btn primary block plan-btn" data-act="checkout" data-plan="annual"><span>Pay yearly by card</span><small>Save ${save}%</small></button>
          <button class="btn block plan-btn" data-act="checkout" data-plan="monthly"><span>Pay monthly by card</span></button>
          <button class="btn quiet block" data-act="invoice">Pay yearly by invoice (cheque or EFT)</button>
        </div>
        <p class="hint">${left > 2 ? `Nothing is charged until your free trial ends in ${left} days. ` : ""}Cancel any time from the same screen.</p>`
        : `<p class="muted small" style="margin-top:12px">Your department's owner can choose a plan here.</p>`}`;
  }

  function invoiceSheet() {
    const PROV = ["ON", "QC", "NS", "NB", "MB", "SK", "AB", "BC", "PE", "NL", "YT", "NT", "NU"];
    openSheet({
      title: "Pay by invoice",
      body: `<p class="muted small" style="margin-bottom:14px">We email a yearly invoice (${money(CONFIG.PRICING.annual)} per member) your treasurer or municipality can pay by cheque or EFT. Due in 30 days.${daysUntil(S.dept.trial_ends_at) > 2 ? " The first one is sent when your free trial ends." : ""}</p>
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
        await S.api.billing("invoice", S.dept.id, f);
        await refreshDept();
        toast(`Done. Invoices go to ${f.email}.`);
      },
    });
  }

  function printPoster() {
    const link = `${CONFIG.APP_URL}/#/join/${S.dept.invite_code}`;
    const qr = window.qrcode(0, "M");
    qr.addData(link);
    qr.make();
    const w = window.open("", "_blank");
    if (!w) return toast("Allow pop-ups to print the poster.", true);
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Join ${esc(S.dept.name)} on Fire Ground Board</title>
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
      <p>Get on the accountability board</p>
      <div class="qr">${qr.createSvgTag({ cellSize: 8, margin: 0, scalable: true })}</div>
      <div class="code">${esc(S.dept.invite_code)}</div>
      <ol>
        <li>Scan the code with your phone camera, or go to ${esc(CONFIG.APP_URL.replace(/^https?:\/\//, ""))}</li>
        <li>Create an account with your email</li>
        <li>Enter the code above if it isn't filled in</li>
        <li>Add the app to your home screen so it's one tap away on a call</li>
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
      const text = `Join ${S.dept.name} on Fire Ground Board. Invite code: ${S.dept.invite_code}\n${link}`;
      if (navigator.share) { try { await navigator.share({ title: "Fire Ground Board invite", text }); return; } catch { /* cancelled */ } }
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
    checkout: async (b) => {
      b.disabled = true;
      try { const { url } = await S.api.billing("checkout", S.dept.id, { plan: b.dataset.plan }); location.href = url; }
      catch (e) { toast(friendlyError(e), true); b.disabled = false; }
    },
    invoice: () => invoiceSheet(),
    "allow-back": async (b) => {
      try { await S.api.allowBack(b.dataset.id); toast("They can rejoin with the invite code now."); paint(); }
      catch (e) { toast(friendlyError(e), true); }
    },
    poster: () => printPoster(),
    "app-del": async (b) => {
      const list = [...(S.dept.settings?.apparatus || [])];
      list.splice(Number(b.dataset.i), 1);
      await saveSettings({ ...S.dept.settings, apparatus: list });
    },
    portal: async (b) => {
      b.disabled = true;
      try { const { url } = await S.api.billing("portal", S.dept.id); location.href = url; }
      catch (e) { toast(friendlyError(e), true); b.disabled = false; }
    },
    "show-dispatch": async () => { dispatchToken = await S.api.getDispatchToken(S.dept.id).catch((e) => { toast(friendlyError(e), true); return null; }); showDispatch(); },
    "copy-dispatch": async (b) => { if (await copyText(b.dataset.text)) toast("Copied."); },
    "new-dispatch": async () => {
      if (!(await confirmSheet({ title: "Reset dispatch key?", message: "The old address stops working immediately. You'll need to send the new one to dispatch.", confirmLabel: "Reset key", danger: true }))) return;
      try {
        dispatchToken = await S.api.regenerateDispatchToken(S.dept.id);
        showDispatch();
        toast("New dispatch key created.");
      } catch (e) { toast(friendlyError(e), true); }
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

  function showDispatch() {
    const box = root.querySelector("#dispatch-box");
    if (!box || !dispatchToken) return;
    const url = `${S.api.dispatchUrl()}?token=${dispatchToken}`;
    box.innerHTML = `
      <div class="label">Webhook address</div>
      <div class="mono">${esc(url)}</div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn sm" data-act="copy-dispatch" data-text="${esc(url)}">${icon("copy", "sm")} Copy</button>
        <button class="btn sm danger" data-act="new-dispatch">Reset key</button>
      </div>
      <p class="hint" style="margin-top:12px">Dispatch sends a POST with JSON like <span class="mono" style="display:inline;padding:1px 4px">{"name":"Structure fire","address":"12 Main St","call_type":"Structure"}</span>. Plain text and form posts also work, so email-to-webhook services and Zapier can connect too. Keep this address private.</p>`;
  }

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
      } catch (ex) { toast(friendlyError(ex), true); }
    });
  }

  root.innerHTML = '<div class="spinner"></div>';
  paint().catch((e) => toast(friendlyError(e), true));
  return () => { alive = false; off(); };
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
      <div class="panel" style="display:flex;align-items:center;gap:14px">
        <div class="avatar" style="width:54px;height:54px;font-size:20px;background:${colorFor(m.name)}">${esc(initials(m.name))}</div>
        <div style="min-width:0"><div class="h3" style="font-size:22px">${esc(m.name)}</div><div class="muted small">${esc(m.rank)} at ${esc(S.dept.name)}</div><div class="faint small">${esc(S.user.email || "")}</div></div>
      </div>

      <form class="panel section" id="me-form" novalidate>
        <div class="h3" style="margin-bottom:12px">My details</div>
        ${field("Name", input("name", m.name))}
        <div class="grid2">${field("Rank", select("rank", RANKS.includes(m.rank) ? RANKS : [m.rank, ...RANKS], m.rank))}${field("Crew", select("crew", ["", ...CREWS], m.crew || ""))}</div>
        <div class="grid2">${field("Call sign", input("call_sign", m.call_sign || ""))}${field("Radio number", input("radio", m.radio || ""))}</div>
        ${field("Phone", input("phone", m.phone || "", 'type="tel" autocomplete="tel"'))}
        <button class="btn block" style="margin-top:16px">Save my details</button>
      </form>

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
          <p class="hint">Keep your ringer on. Phones only play sound while the app is open.</p>
        </div>
      </section>

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

  root.querySelector("[data-sound]").addEventListener("change", (e) => { setSound(e.target.checked); toast(e.target.checked ? "Alarm sound on." : "Alarm sound off. You'll still see the banner."); });

  return bindActions(root, {
    theme: (b) => {
      setTheme(b.dataset.k);
      root.querySelectorAll('[data-act="theme"]').forEach((x) => { const on = x.dataset.k === b.dataset.k; x.classList.toggle("on", on); x.setAttribute("aria-checked", on); });
    },
    "test-sound": () => { if (!soundOn()) return toast("Turn the alarm sound on first.", true); alertTone("par"); setTimeout(() => alertTone("missing"), 1400); },
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
