// Email from Fire Ground Board to department owners, sent through your own
// mailbox (Google Workspace by default) over SMTP.
// Secrets (Supabase > Edge Functions > Secrets):
//   SMTP_USER   hello@mkegroup.ca
//   SMTP_PASS   a Google app password for that mailbox
// Optional: SMTP_HOST (smtp.gmail.com), SMTP_PORT (465), MAIL_FROM.
import nodemailer from "npm:nodemailer@6.9.16";

export function mailConfigured(): boolean {
  return !!(Deno.env.get("SMTP_USER")?.trim() && Deno.env.get("SMTP_PASS")?.trim());
}

// deno-lint-ignore no-explicit-any
let transport: any = null;
function smtp() {
  if (transport) return transport;
  const port = Number(Deno.env.get("SMTP_PORT") ?? "465");
  transport = nodemailer.createTransport({
    host: Deno.env.get("SMTP_HOST")?.trim() || "smtp.gmail.com",
    port,
    secure: (Deno.env.get("SMTP_SECURE") ?? (port === 465 ? "on" : "off")) === "on",
    auth: { user: Deno.env.get("SMTP_USER")!.trim(), pass: Deno.env.get("SMTP_PASS")!.replace(/\s+/g, "") },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  return transport;
}

export type Mail = { to: string | string[]; subject: string; text: string; html: string };

/** Sends one email. Returns false (and logs) if it couldn't. Never throws. */
export async function sendMail(m: Mail): Promise<boolean> {
  if (!mailConfigured()) return false;
  const user = Deno.env.get("SMTP_USER")!.trim();
  try {
    await smtp().sendMail({
      from: Deno.env.get("MAIL_FROM")?.trim() || `Fire Ground Board <${user}>`,
      replyTo: Deno.env.get("MAIL_REPLY_TO")?.trim() || user,
      to: m.to,
      subject: m.subject,
      text: m.text,
      html: m.html,
    });
    return true;
  } catch (e) {
    console.error("email failed", e);
    transport = null;
    return false;
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const SITE = "https://fire.mkegroup.ca";
const APP_STORE = "https://apps.apple.com/app/fire-ground-board/id6833654518";

/**
 * The Fire Ground Board email: dark like the app, logo on top, one red button.
 * Built dark on purpose so Gmail and Apple Mail dark mode leave it alone instead of washing it out.
 * Paragraphs are plain text. Lines starting with "- " become a list.
 */
export function layout(o: { heading: string; paras: string[]; button?: { label: string; url: string }; footer?: string }): { text: string; html: string } {
  const text = [
    o.heading, "",
    ...o.paras.flatMap((p) => [p, ""]),
    ...(o.button ? [`${o.button.label}: ${o.button.url}`, ""] : []),
    "The Fire Ground Board team",
    "Reply to this email any time.",
    ...(o.footer ? ["", o.footer] : []),
  ].join("\n");

  const F = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const para = (p: string) => {
    const lines = p.split("\n");
    if (lines.every((l) => l.startsWith("- "))) {
      return `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 0 20px">${lines.map((l, i) => `<tr><td valign="top" style="padding:0 12px 12px 0"><div style="width:24px;height:24px;border-radius:12px;background:#c8102e;color:#ffffff;font:700 13px/24px ${F};text-align:center">${i + 1}</div></td><td style="padding:2px 0 12px;color:#33363c;font:16px/1.5 ${F}">${esc(l.slice(2))}</td></tr>`).join("")}</table>`;
    }
    return `<p style="margin:0 0 18px;color:#33363c;font:16px/1.6 ${F}">${esc(p).replace(/\n/g, "<br>")}</p>`;
  };
  const pre = esc((o.paras[0] || "").replace(/\s+/g, " ").slice(0, 140));
  const btn = o.button ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:6px 0 26px"><tr><td align="center" bgcolor="#c8102e" style="background:#c8102e;border-radius:10px">
    <a href="${esc(o.button.url)}" target="_blank" style="display:block;padding:15px 30px;background:#c8102e;border-radius:10px;color:#ffffff;text-decoration:none;font:700 16px ${F}">${esc(o.button.label)}</a></td></tr></table>
  <p style="margin:-14px 0 24px;color:#7a7d84;font:13px/1.5 ${F}">Button not working? Go to <a href="${esc(o.button.url)}" style="color:#c8102e">${esc(o.button.url.replace(/^https?:\/\//, "").replace(/\/$/, ""))}</a> or open the iPhone app.</p>` : "";
  // Light on purpose: Gmail on phones "inverts" dark emails into washed-out grey. A white card with a dark logo band
  // reads cleanly in light mode and Gmail's dark mode turns it into a proper dark email by itself.
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${esc(o.heading)}</title>
<style>a{color:#c8102e}@media (max-width:600px){.pad{padding-left:22px!important;padding-right:22px!important}.h1{font-size:24px!important}}</style></head>
<body style="margin:0;padding:0;background:#f1efeb" bgcolor="#f1efeb">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${pre}&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#f1efeb" style="background:#f1efeb"><tr><td align="center" style="padding:24px 12px 32px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;border-radius:14px;overflow:hidden;background:#ffffff" bgcolor="#ffffff">
<tr><td bgcolor="#141517" style="background:#141517;padding:18px 28px" class="pad">
  <a href="${SITE}" style="text-decoration:none"><img src="${SITE}/img/email-logo.png" width="180" alt="Fire Ground Board" style="display:block;border:0;width:180px;height:auto;color:#ffffff;font:800 18px ${F}"></a></td></tr>
<tr><td bgcolor="#c8102e" style="background:#c8102e;height:4px;line-height:4px;font-size:0">&nbsp;</td></tr>
<tr><td bgcolor="#ffffff" style="background:#ffffff;padding:30px 32px 28px" class="pad">
  <h1 class="h1" style="margin:0 0 16px;color:#141517;font:800 26px/1.25 ${F};letter-spacing:-.01em">${esc(o.heading)}</h1>
  ${o.paras.map(para).join("\n  ")}
  ${btn}
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="border-top:1px solid #e6e3dd;padding-top:16px;color:#141517;font:700 15px/1.5 ${F}">The Fire Ground Board team
    <div style="color:#7a7d84;font-weight:400;font-size:14px">Reply to this email any time. A real person reads it.</div></td></tr></table>
</td></tr></table>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px"><tr><td align="center" style="padding:18px 24px 0;color:#8a8780;font:13px/1.6 ${F}">
  <a href="${SITE}" style="color:#6b6862;text-decoration:none">fire.mkegroup.ca</a> &nbsp;&middot;&nbsp; <a href="${APP_STORE}" style="color:#6b6862;text-decoration:none">Get the iPhone app</a>
  ${o.footer ? `<div style="margin-top:8px">${esc(o.footer)}</div>` : ""}
</td></tr></table>
</td></tr></table></body></html>`;
  return { text, html };
}
