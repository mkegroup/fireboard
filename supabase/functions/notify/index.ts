// Sends a push alert to the iPhone app for something that just happened on an incident.
// Called by the app right after: starting an incident, calling PAR, or marking someone Missing.
// The server re-checks everything, so calling it by hand can't fake an alert:
//   incident -> caller must be an officer, incident started in the last 10 minutes
//   par      -> a PAR must have started in the last 10 minutes
//   missing  -> that person must really be marked Missing right now
// Each alert is sent at most once (push_log).
import { adminClient, corsHeaders, getUser, json, lockedCors, membership } from "../_shared/util.ts";
import { sendIncidentPush, type PushKind } from "../_shared/push.ts";

Deno.serve(lockedCors(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const user = await getUser(req);
    if (!user) return json({ error: "Not signed in" }, 401);
    const { kind, incident_id, personnel_id } = await req.json().catch(() => ({}));
    if (!["incident", "par", "missing"].includes(kind) || typeof incident_id !== "string") {
      return json({ error: "Bad request" }, 400);
    }
    const admin = adminClient();
    const { data: inc } = await admin.from("incidents")
      .select("id, dept_id, name, address, status, started_at, par_started_at").eq("id", incident_id).maybeSingle();
    if (!inc) return json({ error: "Incident not found" }, 404);
    const me = await membership(admin, inc.dept_id, user.id);
    if (!me) return json({ error: "Not a member of this department" }, 403);

    if (kind === "incident") {
      if (me.role === "member") return json({ error: "Only officers start incidents" }, 403);
      if (Date.now() - new Date(inc.started_at).getTime() > 10 * 60 * 1000) return json({ sent: 0, reason: "too old" });
    }
    if (kind === "par" && me.role === "member") return json({ error: "Only officers call PAR" }, 403);

    const { data: access } = await admin.rpc("dept_has_access", { d: inc.dept_id });
    if (!access) return json({ sent: 0, reason: "plan inactive" });

    const r = await sendIncidentPush(admin, inc, kind as PushKind, { exclude: user.id, personnelId: personnel_id });
    return json(r);
  } catch (e) {
    console.error("notify error", e);
    return json({ error: "Could not send alert" }, 500);
  }
}));
