// Dispatch / CAD webhook. Starts an incident on a department's board.
//
// POST https://<project>.supabase.co/functions/v1/dispatch
//   header  x-dispatch-token: <token from Department > Dispatch>
//   (or ?token=<token> for systems that cannot set headers)
//
// Accepts JSON, form posts or plain text, so it works with CAD systems,
// Zapier / Make, and email-to-webhook services.
//   name | incident_name | title | subject   -> incident name
//   address | location                       -> address
//   call_type | type | nature                -> call type
//   notes | body | text | body-plain         -> logged to the activity log
import { adminClient, corsHeaders, json } from "../_shared/util.ts";
import { sendIncidentPush } from "../_shared/push.ts";

function pick(o: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
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
    const text = (await req.text()).trim();
    const [first, ...rest] = text.split(/\r?\n/);
    return { name: first ?? "", notes: rest.join("\n") };
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
    .select("id, name, trial_ends_at, subscription_status, current_period_end")
    .eq("dispatch_token", token).maybeSingle();
  if (!dept) return json({ error: "Invalid token" }, 401);

  const { data: access } = await admin.rpc("dept_has_access", { d: dept.id });
  if (!access) return json({ error: "Subscription inactive" }, 402);

  const body = await readBody(req);
  const name = pick(body, ["name", "incident_name", "title", "subject"]).slice(0, 120) || "Dispatched Call";
  const address = pick(body, ["address", "location"]).slice(0, 200) || null;
  const callType = pick(body, ["call_type", "type", "nature"]).slice(0, 60) || null;
  const notes = pick(body, ["notes", "body", "text", "body-plain"]).slice(0, 900);

  // Basic abuse protection.
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const { count } = await admin.from("incidents").select("id", { count: "exact", head: true })
    .eq("dept_id", dept.id).eq("source", "dispatch").gte("started_at", hourAgo);
  if ((count ?? 0) >= 20) return json({ error: "Rate limit reached" }, 429);

  // Dedupe repeated pages for the same call.
  const twoMin = new Date(Date.now() - 120_000).toISOString();
  let q = admin.from("incidents").select("id").eq("dept_id", dept.id).eq("status", "active")
    .eq("name", name).gte("started_at", twoMin);
  q = address ? q.eq("address", address) : q.is("address", null);
  const { data: dupes } = await q.limit(1);
  const dupe = dupes?.[0];
  if (dupe) return json({ ok: true, incident_id: dupe.id, duplicate: true });

  const { data: inc, error } = await admin.from("incidents").insert({
    dept_id: dept.id, name, address, call_type: callType, source: "dispatch",
  }).select("id, dept_id, name, address, status, par_started_at").single();
  if (error || !inc) {
    console.error("dispatch insert failed", error);
    return json({ error: "Could not create incident" }, 500);
  }

  await admin.from("incident_events").insert({
    incident_id: inc.id, dept_id: dept.id, actor: "Dispatch", kind: "incident",
    message: `Incident created from dispatch${callType ? ` (${callType})` : ""}`,
  });
  if (notes) {
    await admin.from("incident_events").insert({
      incident_id: inc.id, dept_id: dept.id, actor: "Dispatch", kind: "note", message: notes,
    });
  }

  // Page everyone's phone. A push failure never fails the dispatch.
  const push = await sendIncidentPush(admin, inc, "incident").catch((e) => { console.error("push failed", e); return { sent: 0 }; });

  return json({ ok: true, incident_id: inc.id, alerted: push.sent });
});
