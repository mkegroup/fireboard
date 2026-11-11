// Sends a push alert to the iPhone app for something that just happened on an incident.
// Called by the app right after: starting an incident, calling PAR, or marking someone Missing.
// The server re-checks everything, so calling it by hand can't fake an alert:
//   incident -> caller must be an officer, incident started in the last 10 minutes
//   par      -> a PAR must have started in the last 10 minutes
//   missing  -> that person must really be marked Missing right now
//   closed   -> officer, incident closed in the last 10 minutes (group chat only)
//   chat     -> the caller sent that chat message in the last 2 minutes
// Each alert is sent at most once (push_log). Alerts also go to the
// department's group chat when one is connected.
import { adminClient, corsHeaders, getUser, json, lockedCors, membership } from "../_shared/util.ts";
import { sendChatPush, sendIncidentPush } from "../_shared/push.ts";
import { postToChat } from "../_shared/chat.ts";

Deno.serve(lockedCors(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const user = await getUser(req);
    if (!user) return json({ error: "Not signed in" }, 401);
    const { kind, incident_id, personnel_id, dept_id, message_id } = await req.json().catch(() => ({}));
    if (kind === "chat" && typeof message_id === "string") {
      const admin = adminClient();
      const { data: msg } = await admin.from("incident_messages").select("*").eq("id", message_id).maybeSingle();
      if (!msg) return json({ error: "Message not found" }, 404);
      if (msg.user_id !== user.id) return json({ error: "Not your message" }, 403);
      if (msg.deleted_at || Date.now() - new Date(msg.created_at).getTime() > 2 * 60 * 1000) return json({ sent: 0, reason: "too old" });
      const { data: access } = await admin.rpc("dept_has_access", { d: msg.dept_id });
      if (!access) return json({ sent: 0, reason: "plan inactive" });
      return json(await sendChatPush(admin, msg));
    }
    // Owner checks the group chat link works.
    if (kind === "test-chat" && typeof dept_id === "string") {
      const admin = adminClient();
      const me = await membership(admin, dept_id, user.id);
      if (me?.role !== "owner") return json({ error: "Only the owner can do this" }, 403);
      const { data: d } = await admin.from("departments").select("name").eq("id", dept_id).maybeSingle();
      const chat = await postToChat(admin, dept_id, "test", `Fire Ground Board is connected. ${d?.name ?? "Your department"} will see new calls, PAR checks and Missing alerts here.`, null);
      return json({ chat });
    }
    if (!["incident", "par", "missing", "closed"].includes(kind) || typeof incident_id !== "string") {
      return json({ error: "Bad request" }, 400);
    }
    const admin = adminClient();
    const { data: inc } = await admin.from("incidents")
      .select("id, dept_id, name, address, status, started_at, closed_at, par_started_at").eq("id", incident_id).maybeSingle();
    if (!inc) return json({ error: "Incident not found" }, 404);
    const me = await membership(admin, inc.dept_id, user.id);
    if (!me) return json({ error: "Not a member of this department" }, 403);

    if (kind === "incident") {
      if (me.role === "member") return json({ error: "Only officers start incidents" }, 403);
      if (Date.now() - new Date(inc.started_at).getTime() > 10 * 60 * 1000) return json({ sent: 0, reason: "too old" });
    }
    if (kind === "par" && me.role === "member") return json({ error: "Only officers call PAR" }, 403);
    if (kind === "closed") {
      if (me.role === "member") return json({ error: "Only officers close incidents" }, 403);
      if (!inc.closed_at || Date.now() - new Date(inc.closed_at).getTime() > 10 * 60 * 1000) return json({ sent: 0, reason: "not recently closed" });
    }

    const { data: access } = await admin.rpc("dept_has_access", { d: inc.dept_id });
    if (!access) return json({ sent: 0, reason: "plan inactive" });

    const r = await sendIncidentPush(admin, inc, kind, { exclude: user.id, personnelId: personnel_id });
    return json(r);
  } catch (e) {
    console.error("notify error", e);
    return json({ error: "Could not send alert" }, 500);
  }
}));
