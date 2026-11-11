// Connections: dispatch email, dispatch webhook, group chat, training calendar.
// Owner only. Every secret comes from the server through get_integrations().
import { CONFIG } from "./config.js";
import { S, isOwner, go } from "./state.js";
import { esc, copyText, friendlyError, formData, ago } from "./util.js";
import { icon, toast, confirmSheet } from "./ui.js";
import { bindActions, bottomNav, demoStrip } from "./app.js";

const OUTCOME = {
  created: ["good", "Started a call"],
  duplicate: ["", "Same call, skipped"],
  not_allowed_sender: ["warn", "Sender not on your list"],
  confirmation: ["warn", "Forwarding confirmation"],
  rate_limited: ["bad", "Too many pages this hour"],
  inactive: ["bad", "Plan inactive"],
  empty: ["", "Empty message"],
};

const CHAT_EVENTS = [["incident", "New calls"], ["par", "PAR checks"], ["missing", "Missing firefighters"], ["closed", "Calls closed"]];

export function connectionsView(root) {
  let alive = true;
  let c = null;
  let inbox = [];
  let showWebhook = false;

  if (!isOwner()) { go("#/dept"); return () => {}; }

  const paint = async () => {
    [c, inbox] = await Promise.all([
      S.api.getIntegrations(S.dept.id),
      S.api.listDispatchInbox(S.dept.id).catch(() => []),
    ]);
    if (!alive) return;
    const domain = (CONFIG.INBOX_DOMAIN || "").trim() || (S.api.isDemo ? "calls.example.com" : "");
    const email = domain ? `${c.inbox_code}@${domain}` : "";
    const hook = `${S.api.dispatchUrl()}?token=${c.dispatch_token}`;
    const cal = S.api.calendarUrl(c.calendar_token);
    const webcal = cal.replace(/^https:/, "webcal:");
    const confirm = inbox.find((m) => m.outcome === "confirmation" && m.confirm_url);

    root.innerHTML = `
    ${demoStrip()}
    <div class="screen with-nav">
      <header class="topbar"><div class="wrap topbar-in">
        <a href="#/dept" class="iconbtn ghost" aria-label="Back to Department">${icon("back")}</a>
        <h1>Connections</h1>
      </div></header>
      <div class="wrap" style="padding-top:16px">
        <p class="muted" style="max-width:70ch">Connect Fire Ground Board to the tools your department already uses. Only you, the owner, can see these.</p>
        <div class="cols">
        <div class="col">

        <section class="section">
          <div class="section-head"><div class="h2">Dispatch email</div></div>
          <div class="panel">
            <p class="muted small">Forward your pages to this address and every call starts on the board by itself, with the address and call type filled in. Works with county pages, CAD emails, Active911, IamResponding and your own inbox.</p>
            ${email ? `
              <div class="copy-row" style="margin-top:12px"><div class="mono grow">${esc(email)}</div><button class="btn sm" data-act="copy" data-text="${esc(email)}">${icon("copy", "sm")} Copy</button></div>
              ${confirm ? `<div class="banner warn" style="margin-top:12px">${icon("alert")}<div class="grow"><b>Confirm forwarding</b><br><span class="muted">Your email service sent a confirmation. Open it to finish setting up forwarding.</span></div><a class="btn sm primary" href="${esc(confirm.confirm_url)}" target="_blank" rel="noopener noreferrer">Confirm</a></div>` : ""}
              <details class="more"><summary class="muted small">How to forward pages here</summary>
                <ol class="steps small">
                  <li><b>Gmail:</b> Settings, See all settings, Forwarding and POP/IMAP, Add a forwarding address. Paste this address. Then make a filter for your dispatch emails and choose Forward it to this address. Gmail sends a confirmation, which shows up below with a Confirm button.</li>
                  <li><b>Outlook:</b> Settings, Mail, Rules, Add new rule. Pick your dispatch sender, then Forward to this address.</li>
                  <li><b>Your county or CAD:</b> ask dispatch to add this address to your department's page list.</li>
                  <li><b>Active911 or IamResponding:</b> add this address wherever those services send copies of your pages, or forward their alert emails.</li>
                </ol>
              </details>
              <form id="allow-form" style="margin-top:14px" novalidate>
                <label class="label" for="allow">Only accept pages from (optional)</label>
                <div class="copy-row"><input class="input grow" id="allow" name="allow" value="${esc(c.inbox_allow_from || "")}" placeholder="e.g. dispatch@county.on.ca or county.on.ca" autocapitalize="off" spellcheck="false"><button class="btn">Save</button></div>
                <p class="hint">Leave empty to accept any sender. Separate several with commas.</p>
              </form>
              <button class="btn quiet sm" style="margin-top:6px" data-act="new-inbox">Make a new address (old one stops working)</button>`
            : `<p class="banner" style="margin-top:12px">${icon("alert")}<span class="grow">Dispatch email is being set up. It will appear here soon.</span></p>`}
          </div>
        </section>

        <section class="section">
          <div class="section-head"><div class="h2">Recent dispatch messages</div></div>
          ${inbox.length ? `<div class="list">${inbox.map((m) => {
            const [tone, label] = OUTCOME[m.outcome] || ["", m.outcome];
            const go = m.incident_id ? `href="#/incident/${m.incident_id}"` : "";
            return `<${go ? "a" : "div"} class="row" ${go}>
              <div class="grow"><div class="title" data-notr>${esc(m.subject || (m.excerpt || "").slice(0, 60) || "(no subject)")}</div>
              <div class="meta"><span data-notr>${esc(m.sender || (m.channel === "webhook" ? "Webhook" : ""))}</span>, ${esc(ago(m.at))}</div></div>
              <span class="pill ${tone}">${label}</span>
            </${go ? "a" : "div"}>`;
          }).join("")}</div>` : `<p class="muted">Nothing yet. Pages sent to your dispatch email or webhook show up here, with what happened to each one.</p>`}
        </section>
        </div>

        <div class="col">
        <section class="section">
          <div class="section-head"><div class="h2">Group chat</div></div>
          <form class="panel" id="chat-form" novalidate>
            <p class="muted small">Post new calls, PAR checks and Missing alerts to your department's Slack, Microsoft Teams, Discord or Google Chat. Paste the chat's incoming webhook link.</p>
            <label class="label" for="chat-url" style="margin-top:12px">Webhook link</label>
            <input class="input" id="chat-url" name="url" type="url" value="${esc(c.chat_webhook_url || "")}" placeholder="https://hooks.slack.com/..." autocapitalize="off" spellcheck="false">
            <div class="label" style="margin-top:14px">Post</div>
            <div class="choice-grid">${CHAT_EVENTS.map(([k, l]) => `<label class="choice"><input type="checkbox" name="ev_${k}" ${(c.chat_events || []).includes(k) ? "checked" : ""}><span>${l}</span></label>`).join("")}</div>
            <div class="btn-row" style="margin-top:14px">
              <button class="btn primary">Save</button>
              ${c.chat_webhook_url ? `<button class="btn" type="button" data-act="test-chat">Send a test message</button>` : ""}
            </div>
            <details class="more"><summary class="muted small">Where to find the webhook link</summary>
              <ol class="steps small">
                <li><b>Slack:</b> add the Incoming Webhooks app to a channel and copy its webhook URL.</li>
                <li><b>Microsoft Teams:</b> in the channel, open Workflows, choose Post to a channel when a webhook request is received, and copy the link.</li>
                <li><b>Discord:</b> channel settings, Integrations, Webhooks, New Webhook, Copy Webhook URL.</li>
                <li><b>Google Chat:</b> space name, Apps and integrations, Webhooks, Add webhook.</li>
              </ol>
            </details>
          </form>
        </section>

        <section class="section">
          <div class="section-head"><div class="h2">Training calendar</div></div>
          <div class="panel">
            <p class="muted small">Training nights show up in everyone's calendar and stay up to date. Share this link with your crew.</p>
            <div class="copy-row" style="margin-top:12px"><div class="mono grow">${esc(cal)}</div><button class="btn sm" data-act="copy" data-text="${esc(cal)}">${icon("copy", "sm")} Copy</button></div>
            <div class="btn-row" style="margin-top:10px">
              <a class="btn sm" href="https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}" target="_blank" rel="noopener noreferrer">Add to Google Calendar</a>
              <a class="btn sm" href="${esc(webcal)}">Add to Apple or Outlook</a>
            </div>
            <button class="btn quiet sm" style="margin-top:6px" data-act="new-calendar">Make a new link (old one stops working)</button>
          </div>
        </section>

        <section class="section" style="margin-bottom:40px">
          <div class="section-head"><div class="h2">Dispatch webhook (CAD)</div></div>
          <div class="panel">
            <p class="muted small">For dispatch centres and CAD systems that can post to a web address, and for Zapier or Make. Send this to your county IT or dispatch supervisor. Keep it private.</p>
            ${showWebhook ? `
              <div class="copy-row" style="margin-top:12px"><div class="mono grow">${esc(hook)}</div><button class="btn sm" data-act="copy" data-text="${esc(hook)}">${icon("copy", "sm")} Copy</button></div>
              <p class="hint" style="margin-top:10px">Send a POST with JSON like <span class="mono inline">{"name":"Structure fire","address":"12 Main St","call_type":"Structure","units":"E1, T2"}</span>. Plain text and form posts work too. Messy text is read the same way as dispatch emails.</p>
              <button class="btn quiet sm" style="margin-top:6px" data-act="new-webhook">Reset key (old address stops working)</button>`
            : `<button class="btn block" style="margin-top:12px" data-act="show-webhook">Show webhook address</button>`}
          </div>
        </section>
        </div>
        </div>
      </div>
    </div>
    ${bottomNav("dept")}`;
    bindForms();
  };

  function bindForms() {
    root.querySelector("#allow-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await S.api.setIntegrations(S.dept.id, { chat_webhook_url: c.chat_webhook_url, chat_events: c.chat_events, inbox_allow_from: formData(e.target).allow });
        toast("Saved.");
        paint();
      } catch (ex) { toast(friendlyError(ex), true); }
    });
    root.querySelector("#chat-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = formData(e.target);
      const url = (f.url || "").trim();
      if (url && !/^https:\/\/\S+\.\S+/i.test(url)) return toast("The link should start with https://", true);
      const events = CHAT_EVENTS.map(([k]) => k).filter((k) => f[`ev_${k}`]);
      try {
        await S.api.setIntegrations(S.dept.id, { chat_webhook_url: url, chat_events: events, inbox_allow_from: c.inbox_allow_from });
        toast(url ? "Group chat connected." : "Group chat turned off.");
        paint();
      } catch (ex) { toast(friendlyError(ex), true); }
    });
  }

  const reset = async (what, title, message) => {
    if (!(await confirmSheet({ title, message, confirmLabel: "Make a new one", danger: true }))) return;
    try {
      if (what === "webhook") await S.api.regenerateDispatchToken(S.dept.id);
      else await S.api.regenerateIntegration(S.dept.id, what);
      toast("Done. Send the new one to whoever used the old one.");
      paint();
    } catch (e) { toast(friendlyError(e), true); }
  };

  const off = bindActions(root, {
    copy: async (b) => { if (await copyText(b.dataset.text)) toast("Copied."); },
    "show-webhook": () => { showWebhook = true; paint(); },
    "test-chat": async (b) => {
      b.disabled = true;
      try { await S.api.testChat(S.dept.id); toast("Test message sent. Check your chat."); }
      catch (e) { toast(friendlyError(e), true); }
      b.disabled = false;
    },
    "new-inbox": () => reset("inbox", "Make a new dispatch email?", "The old address stops working right away. You'll need to update your forwarding."),
    "new-calendar": () => reset("calendar", "Make a new calendar link?", "Calendars using the old link stop updating."),
    "new-webhook": () => reset("webhook", "Reset the webhook key?", "The old address stops working right away. You'll need to send the new one to dispatch."),
  });

  root.innerHTML = '<div class="spinner"></div>';
  paint().catch((e) => { root.innerHTML = `<div class="wrap empty" style="padding-top:80px"><div class="h3">Could not load connections</div><p>${esc(friendlyError(e))}</p></div>${bottomNav("dept")}`; });
  return () => { alive = false; off(); };
}
