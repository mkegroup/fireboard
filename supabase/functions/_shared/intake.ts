// Turns a dispatch page (from the webhook or from email) into an incident.
// Shared by the dispatch and inbound-email functions so both behave the same.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { sendIncidentPush } from "./push.ts";
import { type ParsedPage, unitMatches } from "./page.ts";

export type Dept = { id: string; name: string; settings?: { apparatus?: { name: string; kind?: string }[] } | null };
export type Channel = "webhook" | "email";
export type Outcome = "created" | "duplicate" | "not_allowed_sender" | "confirmation" | "rate_limited" | "inactive" | "empty";

/** Keeps a record of what came in, trimmed to the newest 50 per department. */
export async function logInbox(
  admin: SupabaseClient,
  deptId: string,
  row: { channel: Channel; sender?: string | null; subject?: string | null; excerpt?: string | null; outcome: Outcome; incident_id?: string | null; confirm_url?: string | null },
) {
  await admin.from("dispatch_inbox").insert({
    dept_id: deptId,
    channel: row.channel,
    sender: row.sender?.slice(0, 200) ?? null,
    subject: row.subject?.slice(0, 200) ?? null,
    excerpt: row.excerpt?.slice(0, 600) ?? null,
    outcome: row.outcome,
    incident_id: row.incident_id ?? null,
    confirm_url: row.confirm_url?.slice(0, 600) ?? null,
  });
  const { data: old } = await admin.from("dispatch_inbox").select("id").eq("dept_id", deptId)
    .order("at", { ascending: false }).range(50, 200);
  if (old?.length) await admin.from("dispatch_inbox").delete().in("id", old.map((r) => r.id));
}

const SUFFIX: Record<string, string> = { street: "st", road: "rd", avenue: "ave", av: "ave", drive: "dr", lane: "ln", crescent: "cres", court: "ct", crt: "ct", boulevard: "blvd", highway: "hwy", place: "pl", concession: "conc", trail: "trl", parkway: "pkwy", circle: "cir", terrace: "ter", terr: "ter" };

/** "142 Mill Street, Combermere" and "142 MILL ST" give the same key. */
export function streetKey(address: string | null | undefined): string {
  if (!address) return "";
  return address.split(/[,(]/)[0].toLowerCase().replace(/[.']/g, "").split(/\s+/).filter(Boolean)
    .map((w) => SUFFIX[w] ?? w).join(" ");
}

export async function intake(
  admin: SupabaseClient,
  dept: Dept,
  page: ParsedPage,
  channel: Channel,
  meta: { sender?: string | null; subject?: string | null; raw?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const log = (outcome: Outcome, incident_id?: string) =>
    logInbox(admin, dept.id, { channel, sender: meta.sender, subject: meta.subject, excerpt: (meta.raw ?? page.notes).slice(0, 600), outcome, incident_id });

  const { data: access } = await admin.rpc("dept_has_access", { d: dept.id });
  if (!access) { await log("inactive"); return { status: 402, body: { error: "Subscription inactive" } }; }

  // Basic abuse protection.
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const { count } = await admin.from("incidents").select("id", { count: "exact", head: true })
    .eq("dept_id", dept.id).in("source", ["dispatch", "email"]).gte("started_at", hourAgo);
  if ((count ?? 0) >= 20) { await log("rate_limited"); return { status: 429, body: { error: "Rate limit reached" } }; }

  // The same call is often paged more than once, sometimes worded differently.
  // Same street address in the last 3 minutes, or the same name with no address, is the same call.
  const since = new Date(Date.now() - 180_000).toISOString();
  const { data: recent } = await admin.from("incidents").select("id, name, address").eq("dept_id", dept.id)
    .eq("status", "active").gte("started_at", since).limit(20);
  const key = streetKey(page.address);
  const dupe = (recent ?? []).find((r) => key ? streetKey(r.address) === key : !r.address && r.name.toLowerCase() === page.name.toLowerCase());
  if (dupe) {
    await log("duplicate", dupe.id);
    return { status: 200, body: { ok: true, incident_id: dupe.id, duplicate: true } };
  }

  const { data: inc, error } = await admin.from("incidents").insert({
    dept_id: dept.id, name: page.name, address: page.address, call_type: page.callType, lat: page.lat, lng: page.lng,
    source: channel === "email" ? "email" : "dispatch",
  }).select("id, dept_id, name, address, status, par_started_at").single();
  if (error || !inc) {
    console.error("intake insert failed", error);
    return { status: 500, body: { error: "Could not create incident" } };
  }

  const events: { incident_id: string; dept_id: string; actor: string; kind: string; message: string }[] = [
    { incident_id: inc.id, dept_id: dept.id, actor: "Dispatch", kind: "incident", message: `Incident created from ${channel === "email" ? "a dispatch email" : "dispatch"}${page.callType ? ` (${page.callType})` : ""}` },
  ];
  if (page.units.length) events.push({ incident_id: inc.id, dept_id: dept.id, actor: "Dispatch", kind: "note", message: `Units paged: ${page.units.join(", ")}` });
  if (page.lat !== null && page.lng !== null) events.push({ incident_id: inc.id, dept_id: dept.id, actor: "Dispatch", kind: "note", message: `Map: ${page.lat}, ${page.lng}` });
  if (page.notes) events.push({ incident_id: inc.id, dept_id: dept.id, actor: "Dispatch", kind: "note", message: page.notes.slice(0, 900) });
  await admin.from("incident_events").insert(events);

  // Put the department's trucks named in the page on the call.
  const trucks = (dept.settings?.apparatus ?? []).filter((t) => page.units.some((u) => unitMatches(u, t.name)));
  if (trucks.length) {
    await admin.from("incident_apparatus").insert(trucks.map((t) => ({ incident_id: inc.id, name: t.name.slice(0, 60), kind: t.kind ?? null, status: "Responding" })));
  }

  // Page everyone's phone and the group chat. A failure here never fails the dispatch.
  const push = await sendIncidentPush(admin, inc, "incident").catch((e) => { console.error("alert failed", e); return { sent: 0 }; });
  await log("created", inc.id);
  return { status: 200, body: { ok: true, incident_id: inc.id, alerted: push.sent, units: trucks.map((t) => t.name) } };
}
