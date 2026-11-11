// Email to incident. Each department has a private address:
//   <code>@<INBOX_DOMAIN>     (or anything+<code>@...)
// Pages forwarded there (from the county, CAD, Active911, IamResponding,
// a chief's own inbox) start an incident on that department's board.
//
// Something has to hand the email to this function. Any of these work:
//   * Cloudflare Email Routing with the worker in integrations/cloudflare-email-worker.js
//     (free, instant). Posts the raw email as message/rfc822.
//   * Postmark inbound (JSON with ToFull, From, Subject, TextBody...).
//   * Mailgun routes or SendGrid inbound parse (form posts).
//   * Anything that posts JSON { to, from, subject, text, html }.
// Every request must carry the shared secret: header x-inbound-secret or ?key=.
import { adminClient, json } from "../_shared/util.ts";
import { parsePage } from "../_shared/page.ts";
import { intake, logInbox } from "../_shared/intake.ts";
import PostalMime from "npm:postal-mime@2.4.4";

type Mail = { to: string; from: string; subject: string; text: string; html: string };

async function readMail(req: Request): Promise<Mail> {
  const type = req.headers.get("content-type") ?? "";
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  if (type.includes("message/rfc822")) {
    const raw = new Uint8Array(await req.arrayBuffer()).slice(0, 2_000_000);
    const m = await PostalMime.parse(raw);
    const addrs = (list?: { address?: string }[]) => (list ?? []).map((a) => a.address ?? "").join(", ");
    const headers = (m.headers ?? []).filter((h) => /^(delivered-to|x-original-to|x-forwarded-to|envelope-to)$/i.test(h.key)).map((h) => h.value).join(", ");
    return {
      to: [req.headers.get("x-envelope-to") ?? "", addrs(m.to), addrs(m.cc), headers].filter(Boolean).join(", "),
      from: m.from?.address ? (m.from.name ? `${m.from.name} <${m.from.address}>` : m.from.address) : (req.headers.get("x-envelope-from") ?? ""),
      subject: m.subject ?? "",
      text: m.text ?? "",
      html: m.html ?? "",
    };
  }
  if (type.includes("application/json")) {
    const b = await req.json().catch(() => ({})) as Record<string, unknown>;
    // deno-lint-ignore no-explicit-any
    const toFull = (b.ToFull as any[] | undefined)?.map((x) => x?.Email).join(", ") ?? "";
    return {
      to: [s(b.to), s(b.To), toFull, s(b.OriginalRecipient), s(b.recipient), s(b.delivered_to)].filter(Boolean).join(", "),
      from: s(b.from) || s(b.From) || s(b.sender),
      subject: s(b.subject) || s(b.Subject),
      text: s(b.text) || s(b.TextBody) || s(b.StrippedTextReply) || s(b["body-plain"]),
      html: s(b.html) || s(b.HtmlBody) || s(b["body-html"]),
    };
  }
  const f = await req.formData().catch(() => null);
  const g = (k: string) => (f?.get(k) as string | null) ?? "";
  // SendGrid puts the envelope recipients in a JSON field.
  let envelope = "";
  try { envelope = (JSON.parse(g("envelope") || "{}").to ?? []).join(", "); } catch { /* none */ }
  return {
    to: [g("recipient"), g("to"), g("To"), envelope].filter(Boolean).join(", "),
    from: g("sender") || g("from") || g("From"),
    subject: g("subject") || g("Subject"),
    text: g("body-plain") || g("stripped-text") || g("text"),
    html: g("body-html") || g("html"),
  };
}

/** Pulls "k7m2x9q4ab3d" out of "k7m2x9q4ab3d@calls.example.com" or "calls+k7m2x9q4ab3d@example.com". */
export function inboxCodes(to: string): string[] {
  return [...new Set([...to.toLowerCase().matchAll(/(?:^|[\s<,;"+])([a-z0-9]{12})@/g)].map((m) => m[1]))].slice(0, 10);
}

/** Allowed senders: a list of addresses or domains. Empty means anyone. */
export function senderAllowed(from: string, allow: string | null): boolean {
  if (!allow || !allow.trim()) return true;
  const addr = (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
  return allow.toLowerCase().split(/[\s,;]+/).filter(Boolean).some((rule) => {
    const r = rule.replace(/^\*?@/, "");
    return r.includes("@") ? addr === r : addr.endsWith(`@${r}`) || addr.endsWith(`.${r}`);
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const secret = Deno.env.get("INBOUND_SECRET") ?? "";
  const given = req.headers.get("x-inbound-secret") ?? new URL(req.url).searchParams.get("key") ?? "";
  if (secret.length < 16 || given !== secret) return json({ error: "Unauthorized" }, 401);

  const mail = await readMail(req);
  const codes = inboxCodes(mail.to);
  // Unknown or missing address: say OK so the mail service doesn't retry forever.
  if (!codes.length) return json({ ok: true, ignored: "no department address" });

  const admin = adminClient();
  const { data: rows } = await admin.from("dept_integrations").select("dept_id, inbox_allow_from").in("inbox_code", codes).limit(1);
  const row = rows?.[0];
  if (!row) return json({ ok: true, ignored: "unknown department address" });
  const { data: dept } = await admin.from("departments").select("id, name, settings").eq("id", row.dept_id).maybeSingle();
  if (!dept) return json({ ok: true, ignored: "unknown department" });

  const body = mail.text || mail.html;
  const base = { channel: "email" as const, sender: mail.from, subject: mail.subject, excerpt: body.slice(0, 600) };

  // Setting up forwarding in Gmail or Google Workspace sends a confirmation
  // email first. Keep its link so the owner can click it in the app.
  if (/forwarding-noreply@google\.com/i.test(mail.from) || /forwarding confirmation/i.test(mail.subject)) {
    const link = `${mail.text}\n${mail.html}`.match(/https:\/\/(?:mail-settings|mail|isolated\.mail)\.google\.com\/[^\s"'<>]+/i)?.[0] ?? null;
    await logInbox(admin, dept.id, { ...base, outcome: "confirmation", confirm_url: link });
    return json({ ok: true, confirmation: true });
  }
  // Outlook and other services send a test or verification message. Never make an incident from one.
  if (/(verify|verification|confirm) (your )?(forwarding|email|address)|test message from/i.test(`${mail.subject} ${body.slice(0, 200)}`)) {
    await logInbox(admin, dept.id, { ...base, outcome: "confirmation" });
    return json({ ok: true, confirmation: true });
  }

  if (!senderAllowed(mail.from, row.inbox_allow_from)) {
    await logInbox(admin, dept.id, { ...base, outcome: "not_allowed_sender" });
    return json({ ok: true, ignored: "sender not allowed" });
  }
  if (!body.trim() && !mail.subject.trim()) {
    await logInbox(admin, dept.id, { ...base, outcome: "empty" });
    return json({ ok: true, ignored: "empty" });
  }

  const page = parsePage(body, mail.subject);
  const r = await intake(admin, dept, page, "email", { sender: mail.from, subject: mail.subject, raw: body });
  // Always 200 to the mail service. The outcome is in the department's dispatch inbox.
  return json({ ...r.body, status: r.status });
});
