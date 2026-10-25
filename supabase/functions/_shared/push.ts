// Push alerts through OneSignal. The iPhone app logs each person in to
// OneSignal with their Supabase user id, so alerts go to people, not devices.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type PushKind = "incident" | "par" | "missing";

type Incident = {
  id: string;
  dept_id: string;
  name: string;
  address: string | null;
  status: string;
  par_started_at: string | null;
};

const TEN_MIN = 10 * 60 * 1000;

/**
 * Works out who should get the alert, records it so it is only ever sent once,
 * then sends it. Returns how many people it went to.
 * `exclude` is the person who caused it (they don't need an alert on their own phone).
 */
export async function sendIncidentPush(
  admin: SupabaseClient,
  inc: Incident,
  kind: PushKind,
  opts: { exclude?: string | null; personnelId?: string } = {},
): Promise<{ sent: number; reason?: string }> {
  const appId = Deno.env.get("ONESIGNAL_APP_ID");
  const key = Deno.env.get("ONESIGNAL_REST_API_KEY");
  if (!appId || !key) return { sent: 0, reason: "push not configured" };
  if (inc.status !== "active") return { sent: 0, reason: "incident closed" };

  let ref = "";
  let title = "";
  let body = "";
  let users: string[] = [];

  const deptUsers = async (officersOnly = false) => {
    let q = admin.from("members").select("user_id, role")
      .eq("dept_id", inc.dept_id).eq("active", true).not("user_id", "is", null);
    if (officersOnly) q = q.in("role", ["owner", "officer"]);
    const { data } = await q;
    return (data ?? []).map((m) => m.user_id as string);
  };
  const boardUsers = async (skipOut: boolean) => {
    const { data } = await admin.from("incident_personnel").select("user_id, status")
      .eq("incident_id", inc.id).not("user_id", "is", null);
    return (data ?? []).filter((p) => !skipOut || p.status !== "OUT").map((p) => p.user_id as string);
  };

  if (kind === "incident") {
    title = inc.name;
    body = inc.address ? `${inc.address}. Tap to respond.` : "Tap to respond.";
    users = await deptUsers();
  } else if (kind === "par") {
    if (!inc.par_started_at || Date.now() - new Date(inc.par_started_at).getTime() > TEN_MIN) {
      return { sent: 0, reason: "no recent PAR" };
    }
    ref = inc.par_started_at;
    title = `PAR check: ${inc.name}`;
    body = "Tap to confirm you're accounted for.";
    users = await boardUsers(true);
  } else {
    const { data: p } = await admin.from("incident_personnel")
      .select("id, name, status, status_changed_at, incident_id").eq("id", opts.personnelId ?? "").maybeSingle();
    if (!p || p.incident_id !== inc.id || p.status !== "MISSING") return { sent: 0, reason: "not missing" };
    ref = `${p.id}:${p.status_changed_at}`;
    title = `MISSING: ${p.name}`;
    body = `${inc.name}. Open the board now.`;
    users = [...(await boardUsers(false)), ...(await deptUsers(true))];
  }

  users = [...new Set(users)].filter((u) => u && u !== opts.exclude);

  // Record first. A second call for the same alert hits the primary key and stops here.
  const { error: logErr } = await admin.from("push_log").insert({ incident_id: inc.id, kind, ref, sent_to: users.length });
  if (logErr) return { sent: 0, reason: logErr.code === "23505" ? "already sent" : "log failed" };
  if (!users.length) return { sent: 0, reason: "nobody to alert" };

  const base = (Deno.env.get("ONESIGNAL_API_BASE") ?? "https://api.onesignal.com").replace(/\/$/, "");
  let sent = 0;
  for (let i = 0; i < users.length; i += 2000) {
    const chunk = users.slice(i, i + 2000);
    const res = await fetch(`${base}/notifications?c=push`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Key ${key}` },
      body: JSON.stringify({
        app_id: appId,
        target_channel: "push",
        include_aliases: { external_id: chunk },
        headings: { en: title.slice(0, 80) },
        contents: { en: body.slice(0, 160) },
        data: { incident_id: inc.id, kind },
        ios_sound: "default",
        priority: 10,
        ttl: kind === "incident" ? 3600 : 600,
      }),
    });
    if (res.ok) sent += chunk.length;
    else console.error("onesignal error", res.status, await res.text().catch(() => ""));
  }
  return { sent };
}
