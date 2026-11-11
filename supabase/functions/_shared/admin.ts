// Alerts for the people running Fire Ground Board (MKE Group), not for departments.
// Everything worth knowing lands in platform_events. Events marked notify are
// pushed to every platform admin's iPhone, and posted to ADMIN_WEBHOOK_URL
// (Slack, Discord, Teams or Google Chat) when that secret is set.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { pushTo } from "./push.ts";
import { chatBody, safeWebhook } from "./chat.ts";
import { appUrl } from "./util.ts";

export type AdminEvent = {
  kind: string; title: string; detail?: string | null; dept_id?: string | null; user_id?: string | null;
  amount?: number | null; meta?: Record<string, unknown>; notify?: boolean;
};

/** Records an event. Never throws. */
export async function logEvent(admin: SupabaseClient, e: AdminEvent) {
  try {
    await admin.from("platform_events").insert({
      kind: e.kind.slice(0, 40), title: e.title.slice(0, 300), detail: e.detail?.slice(0, 2000) ?? null,
      dept_id: e.dept_id ?? null, user_id: e.user_id ?? null, amount: e.amount ?? null, meta: e.meta ?? {}, notify: !!e.notify,
    });
  } catch (err) { console.error("could not log event", err); }
}

/** Records an error so it shows in Admin. Never throws. */
export function logError(admin: SupabaseClient, where: string, err: unknown, dept_id?: string | null) {
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
  return logEvent(admin, { kind: "error", title: `Error in ${where}`, detail: (msg || "unknown").slice(0, 1500), dept_id, notify: true });
}

const money = (n: number) => `$${n.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Sends alerts for events that haven't gone out yet. Safe to call from anywhere,
 * as often as you like: each event is claimed once. Never throws.
 */
export async function sweepAdminEvents(admin: SupabaseClient): Promise<{ sent: number; events: number }> {
  try {
    const { data: pending } = await admin.from("platform_events").select("id")
      .eq("notify", true).is("pushed_at", null).order("id").limit(25);
    if (!pending?.length) return { sent: 0, events: 0 };
    const { data: events } = await admin.from("platform_events").update({ pushed_at: new Date().toISOString() })
      .in("id", pending.map((p) => p.id)).is("pushed_at", null).select("id, kind, title, detail, amount, dept_id");
    if (!events?.length) return { sent: 0, events: 0 };
    events.sort((a, b) => a.id - b.id);

    const { data: admins } = await admin.from("platform_admins").select("user_id, alerts");
    let sent = 0;
    for (const a of admins ?? []) {
      const mine = events.filter((e) => (a.alerts ?? []).includes(e.kind));
      if (!mine.length) continue;
      // One alert each when there are a few. A summary when lots happened at once.
      const groups = mine.length <= 3 ? mine.map((e) => [e]) : [mine];
      for (const g of groups) {
        const one = g.length === 1 ? g[0] : null;
        const payload = () => ({
          aps: {
            alert: one
              ? { title: one.title.slice(0, 90), body: (one.detail || (one.amount != null ? money(Number(one.amount)) : "")).slice(0, 180) }
              : { title: `${g.length} updates on Fire Ground`, body: g.slice(0, 4).map((e) => e.title).join("\n").slice(0, 180) },
            sound: "default",
            "thread-id": "admin",
          },
          kind: "admin",
          dept_id: one?.dept_id ?? null,
        });
        const r = await pushTo(admin, null, [a.user_id], payload, { collapse: `admin-${g[0].id}`, ttl: 86400, quiet: one?.kind !== "payment" && one?.kind !== "quote" });
        sent += r.sent;
      }
    }

    // Optional: a Slack, Discord, Teams or Google Chat channel for the business.
    const url = safeWebhook(Deno.env.get("ADMIN_WEBHOOK_URL"));
    if (url) {
      const text = events.map((e) => `${e.title}${e.detail ? `: ${e.detail}` : ""}${e.amount != null && !e.detail ? ` ${money(Number(e.amount))}` : ""}`).join("\n").slice(0, 3500);
      await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(chatBody(url, text, `${appUrl()}/#/admin`)), signal: AbortSignal.timeout(6000) })
        .then((r) => r.body?.cancel()).catch((e) => console.warn("admin webhook failed", e));
    }
    return { sent, events: events.length };
  } catch (e) {
    console.error("admin sweep failed", e);
    return { sent: 0, events: 0 };
  }
}
