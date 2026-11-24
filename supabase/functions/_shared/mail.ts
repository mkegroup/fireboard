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
      return `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 0 18px">${lines.map((l) => `<tr><td valign="top" style="padding:0 10px 8px 0;color:#e5332a;font:700 16px/1.5 ${F}">&#9632;</td><td style="padding:0 0 8px;color:#d6d2ca;font:16px/1.5 ${F}">${esc(l.slice(2))}</td></tr>`).join("")}</table>`;
    }
    return `<p style="margin:0 0 18px;color:#d6d2ca;font:16px/1.6 ${F}">${esc(p).replace(/\n/g, "<br>")}</p>`;
  };
  const pre = esc((o.paras[0] || "").replace(/\s+/g, " ").slice(0, 140));
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"><title>${esc(o.heading)}</title>
<style>:root{color-scheme:dark;supported-color-schemes:dark}a{color:#ff6b5f}@media (max-width:600px){.pad{padding-left:22px!important;padding-right:22px!important}.h1{font-size:23px!important}}</style></head>
<body style="margin:0;padding:0;background:#0f1012" bgcolor="#0f1012">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#0f1012">${pre}&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#0f1012" style="background:#0f1012"><tr><td align="center" style="padding:28px 12px 32px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:580px">
<tr><td bgcolor="#17181a" style="background:#17181a;border-radius:16px 16px 0 0;padding:22px 32px 18px" class="pad">
  <a href="${SITE}" style="text-decoration:none"><img src="${SITE}/img/email-logo.png" width="208" height="70" alt="Fire Ground Board" style="display:block;border:0;width:208px;height:auto;color:#f3efe8;font:800 20px ${F}"></a></td></tr>
<tr><td bgcolor="#e5332a" style="background:#e5332a;height:4px;line-height:4px;font-size:0">&nbsp;</td></tr>
<tr><td bgcolor="#1d1e21" style="background:#1d1e21;border-radius:0 0 16px 16px;padding:30px 32px 30px" class="pad">
  <h1 class="h1" style="margin:0 0 18px;color:#ffffff;font:800 26px/1.25 ${F};letter-spacing:-.01em">${esc(o.heading)}</h1>
  ${o.paras.map(para).join("\n  ")}
  ${o.button ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:8px 0 26px"><tr><td bgcolor="#e5332a" style="background:#e5332a;border-radius:10px">
    <a href="${esc(o.button.url)}" style="display:inline-block;padding:15px 28px;color:#ffffff;text-decoration:none;font:800 16px ${F};border-radius:10px">${esc(o.button.label)} &rarr;</a></td></tr></table>` : ""}
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="border-top:1px solid #2e2f33;padding-top:18px;color:#f3efe8;font:700 15px/1.5 ${F}">The Fire Ground Board team
    <div style="color:#8f8b84;font-weight:400;font-size:14px">Reply to this email any time. A real person reads it.</div></td></tr></table>
</td></tr>
<tr><td align="center" style="padding:20px 24px 0;color:#77746e;font:13px/1.6 ${F}">
  <a href="${SITE}" style="color:#a9a59d;text-decoration:none">fire.mkegroup.ca</a> &nbsp;&middot;&nbsp; <a href="${APP_STORE}" style="color:#a9a59d;text-decoration:none">Get the iPhone app</a>
  ${o.footer ? `<div style="margin-top:8px">${esc(o.footer)}</div>` : ""}
</td></tr></table>
</td></tr></table></body></html>`;
  return { text, html };
}
