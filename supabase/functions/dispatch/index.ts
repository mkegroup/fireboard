// Dispatch / CAD webhook. Starts an incident on a department's board.
//
// POST https://<project>.supabase.co/functions/v1/dispatch
//   header  x-dispatch-token: <token from Department > Connections>
//   (or ?token=<token> for systems that cannot set headers)
//
// Accepts JSON, form posts or plain text, so it works with CAD systems,
// Zapier / Make, and email-to-webhook services. Named fields win:
//   name | incident_name | title | subject   -> incident name
//   address | location                       -> address
//   call_type | type | nature                -> call type
//   units                                    -> trucks put on the call
//   notes | body | text | body-plain         -> logged to the activity log
// Anything missing is read out of the text, the same way dispatch emails are.
import { adminClient, corsHeaders, json } from "../_shared/util.ts";
import { parsePage, callTypeFor, unitList } from "../_shared/page.ts";
import { intake } from "../_shared/intake.ts";

function pick(o: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (Array.isArray(v) && k === "units") return v.join(", ");
  }
  return "";
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type") ?? "";
  try {
    if (type.includes("application/json")) return await req.json();
    if (type.includes("form")) {
      const f = await req.formData();
      const o: Record<string, unknown> = {};
      f.forEach((v, k) => { if (typeof v === "string") o[k] = v; });
      return o;
    }
    return { text: (await req.text()).trim() };
  } catch {
    return {};
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = new URL(req.url);
  const token = req.headers.get("x-dispatch-token") ?? url.searchParams.get("token") ?? "";
  if (!/^[a-f0-9]{64}$/.test(token)) return json({ error: "Invalid token" }, 401);

  const admin = adminClient();
  const { data: dept } = await admin.from("departments")
    .select("id, name, settings").eq("dispatch_token", token).maybeSingle();
  if (!dept) return json({ error: "Invalid token" }, 401);

  const body = await readBody(req);
  const subject = pick(body, ["subject"]);
  const text = pick(body, ["notes", "body", "text", "body-plain", "message"]);
  // Read the free text first, then let any named fields override it.
  const page = parsePage(text, subject);
  const name = pick(body, ["name", "incident_name", "title"]);
  const address = pick(body, ["address", "location"]);
  const type = pick(body, ["call_type", "type", "nature"]);
  const units = pick(body, ["units"]);
  if (name) page.name = name.slice(0, 120);
  if (address) page.address = address.slice(0, 200);
  if (type) { page.callType = callTypeFor(type) ?? type.slice(0, 60); if (!name) page.name = type.slice(0, 120); }
  if (units) page.units = unitList(units);
  if (text) page.notes = text.slice(0, 900);
  if (!name && !address && !type && !text && !subject) return json({ error: "Empty page" }, 400);

  const r = await intake(admin, dept, page, "webhook", { subject: subject || null, raw: text || JSON.stringify(body).slice(0, 600) });
  return json(r.body, r.status);
});
