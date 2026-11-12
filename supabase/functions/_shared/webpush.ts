// Call alerts in web browsers: Android phones and computers.
// Same alerts the iPhone app gets from Apple, sent with the Web Push standard.
// Needs the VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY secrets. The public key is
// also in web/js/config.js (WEB_PUSH_KEY) so browsers can subscribe.
import webpush from "npm:web-push@3.6.7";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type WebAlert = { title: string; body: string; kind?: string; incident_id?: string | null; chat?: string | null; url?: string };

let ready: boolean | null = null;
export function webPushConfigured(): boolean {
  if (ready !== null) return ready;
  const pub = Deno.env.get("VAPID_PUBLIC_KEY")?.trim();
  const priv = Deno.env.get("VAPID_PRIVATE_KEY")?.trim();
  if (!pub || !priv) return (ready = false);
  try {
    webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT")?.trim() || "mailto:hello@mkegroup.ca", pub, priv);
    ready = true;
  } catch (e) {
    console.error("bad VAPID keys", e);
    ready = false;
  }
  return ready;
}

/** Where tapping the alert should go in the web app. */
function urlFor(a: WebAlert): string {
  if (a.url) return a.url;
  if (a.kind === "admin") return "/#/admin";
  if (a.kind === "seats") return "/#/plan";
  if (a.kind === "join") return "/#/dept";
  if (a.kind === "chat") return a.chat === "station" || !a.incident_id ? "/#/chat" : `/#/incident/${a.incident_id}?chat=1`;
  if (a.incident_id) return `/#/incident/${a.incident_id}`;
  return "/";
}

/**
 * Sends one alert to every browser these people turned alerts on in.
 * Returns the people it reached. Browsers that are gone get removed.
 */
export async function sendWebPush(
  admin: SupabaseClient,
  users: string[],
  alertFor: (userId: string) => WebAlert,
  opts: { collapse: string; ttl: number; quiet?: boolean },
): Promise<Set<string>> {
  const reached = new Set<string>();
  if (!webPushConfigured() || !users.length) return reached;
  const subs: { endpoint: string; user_id: string; p256dh: string; auth: string }[] = [];
  for (let i = 0; i < users.length; i += 200) {
    const { data } = await admin.from("web_push_subs").select("endpoint, user_id, p256dh, auth").in("user_id", users.slice(i, i + 200));
    subs.push(...(data ?? []));
  }
  if (!subs.length) return reached;

  // Topic lets a newer alert replace an older one that hasn't been delivered yet.
  const topic = opts.collapse.replace(/[^A-Za-z0-9_-]/g, "").slice(-32) || undefined;
  const dead: string[] = [];
  const sendOne = async (s: typeof subs[number]) => {
    const a = alertFor(s.user_id);
    const payload = JSON.stringify({ ...a, url: urlFor(a), tag: opts.collapse.slice(0, 64), loud: !opts.quiet });
    let req;
    try {
      req = webpush.generateRequestDetails({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, {
        TTL: opts.ttl, urgency: opts.quiet ? "normal" : "high", ...(topic ? { topic } : {}),
      });
    } catch (e) { console.error("web push encrypt failed", e); dead.push(s.endpoint); return; }
    const headers = { ...req.headers } as Record<string, string>;
    delete headers["Content-Length"];
    const res = await fetch(req.endpoint, { method: "POST", headers, body: req.body }).catch((e) => { console.error("web push network error", e); return null; });
    if (!res) return;
    await res.body?.cancel();
    if (res.ok) reached.add(s.user_id);
    else if (res.status === 404 || res.status === 410) dead.push(s.endpoint);
    else console.error("web push error", res.status);
  };
  for (let i = 0; i < subs.length; i += 10) await Promise.all(subs.slice(i, i + 10).map(sendOne));
  if (dead.length) await admin.from("web_push_subs").delete().in("endpoint", dead);
  return reached;
}
