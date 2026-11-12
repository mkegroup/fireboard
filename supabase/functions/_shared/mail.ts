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

/**
 * A plain, readable email: heading, short paragraphs, one button, sign-off.
 * Paragraphs are plain text. Lines starting with "- " become a list.
 */
export function layout(o: { heading: string; paras: string[]; button?: { label: string; url: string }; footer?: string }): { text: string; html: string } {
  const text = [
    o.heading, "",
    ...o.paras.flatMap((p) => [p, ""]),
    ...(o.button ? [`${o.button.label}: ${o.button.url}`, ""] : []),
    "Matt Kelley",
    "Fire Ground Board, MKE Group Inc.",
    "Reply to this email any time.",
    ...(o.footer ? ["", o.footer] : []),
  ].join("\n");

  const para = (p: string) => {
    const lines = p.split("\n");
    if (lines.every((l) => l.startsWith("- "))) {
      return `<ul style="margin:0 0 16px;padding-left:20px">${lines.map((l) => `<li style="margin:0 0 6px">${esc(l.slice(2))}</li>`).join("")}</ul>`;
    }
    return `<p style="margin:0 0 16px">${esc(p).replace(/\n/g, "<br>")}</p>`;
  };
  const html = `<!doctype html><html><body style="margin:0;background:#f2f1ee;padding:24px 12px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#17181a">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border-radius:8px;overflow:hidden" cellspacing="0" cellpadding="0">
<tr><td style="background:#1d1e21;padding:18px 24px;border-bottom:5px solid #c8102e"><span style="color:#e3b24f;font-weight:800;font-size:18px;letter-spacing:1px">FIRE GROUND BOARD</span></td></tr>
<tr><td style="padding:24px;font-size:16px;line-height:1.5">
<h1 style="font-size:22px;line-height:1.25;margin:0 0 16px">${esc(o.heading)}</h1>
${o.paras.map(para).join("\n")}
${o.button ? `<p style="margin:8px 0 24px"><a href="${esc(o.button.url)}" style="display:inline-block;background:#c8102e;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:6px">${esc(o.button.label)}</a></p>` : ""}
<p style="margin:0;color:#555">Matt Kelley<br>Fire Ground Board, MKE Group Inc.<br>Reply to this email any time.</p>
</td></tr></table>
${o.footer ? `<p style="max-width:560px;color:#888;font-size:12px;margin:12px auto 0">${esc(o.footer)}</p>` : ""}
</td></tr></table></body></html>`;
  return { text, html };
}
