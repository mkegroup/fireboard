// Push alerts sent straight to Apple (APNs). No OneSignal, no Firebase.
// The iPhone app saves each phone's Apple device token in push_devices,
// linked to the person who signed in on it.
//
// Secrets (Supabase > Edge Functions > Secrets):
//   APNS_KEY      the contents of your .p8 key file from Apple
//   APNS_KEY_ID   the key's 10 character ID
//   APNS_TEAM_ID  your Apple team ID
// Optional: APNS_BUNDLE_ID (default ca.mkegroup.fireground),
//           APNS_HOST (default https://api.push.apple.com, used by TestFlight and the App Store)
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { postToChat } from "./chat.ts";

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

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let cached: { jwt: string; at: number; kid: string } | null = null;

/** Apple wants a signed token (ES256) that is reused for up to an hour. */
async function appleToken(keyPem: string, keyId: string, teamId: string, fresh = false): Promise<string> {
  if (!fresh && cached && cached.kid === keyId && Date.now() - cached.at < 45 * 60 * 1000) return cached.jwt;
  const body = keyPem.replace(/-----[^-]+-----/g, "").replace(/\\n/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = `${enc({ alg: "ES256", kid: keyId })}.${enc({ iss: teamId, iat: Math.floor(Date.now() / 1000) })}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(unsigned)));
  cached = { jwt: `${unsigned}.${b64url(sig)}`, at: Date.now(), kid: keyId };
  return cached.jwt;
}

/** True when Apple push is set up on the server. */
export function pushConfigured() {
  return !!(Deno.env.get("APNS_KEY") && Deno.env.get("APNS_KEY_ID") && Deno.env.get("APNS_TEAM_ID"));
}

// What the alert says, in each person's language.
const WORDS = {
  en: { respond: "Tap to respond.", par: "PAR check", parBody: "Tap to confirm you're accounted for.", missing: "MISSING", missingBody: "Open the board now." },
  fr: { respond: "Touchez pour répondre.", par: "Appel PAR", parBody: "Touchez pour confirmer votre présence.", missing: "MANQUANT", missingBody: "Ouvrez le tableau maintenant." },
  es: { respond: "Toque para responder.", par: "Control PAR", parBody: "Toque para confirmar que está presente.", missing: "DESAPARECIDO", missingBody: "Abra el tablero ahora." },
} as const;
type Lang = keyof typeof WORDS;

/**
 * Announces something that just happened on an incident: a new call, a PAR,
 * a Missing firefighter, or (group chat only) the call being closed.
 * Records it first so it is only ever sent once, then sends push alerts to
 * the right people's phones and a message to the department's group chat.
 * `exclude` is the person who caused it (they don't need an alert on their own phone).
 * Returns how many people the push reached.
 */
export async function sendIncidentPush(
  admin: SupabaseClient,
  inc: Incident,
  kind: PushKind | "closed",
  opts: { exclude?: string | null; personnelId?: string } = {},
): Promise<{ sent: number; reason?: string; chat?: boolean }> {
  if (kind === "closed" ? inc.status !== "closed" : inc.status !== "active") return { sent: 0, reason: kind === "closed" ? "not closed" : "incident closed" };

  let ref = "";
  let users: string[] = [];
  let personName = "";
  let words: (l: Lang) => { title: string; body: string } = () => ({ title: "", body: "" });
  let chatText = "";

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
    words = (l) => ({ title: inc.name, body: inc.address ? `${inc.address}. ${WORDS[l].respond}` : WORDS[l].respond });
    chatText = `New call: ${inc.name}${inc.address ? `, ${inc.address}` : ""}`;
    users = await deptUsers();
  } else if (kind === "par") {
    if (!inc.par_started_at || Date.now() - new Date(inc.par_started_at).getTime() > TEN_MIN) {
      return { sent: 0, reason: "no recent PAR" };
    }
    ref = inc.par_started_at;
    words = (l) => ({ title: `${WORDS[l].par}: ${inc.name}`, body: WORDS[l].parBody });
    chatText = `PAR check called on ${inc.name}`;
    users = await boardUsers(true);
  } else if (kind === "missing") {
    const { data: p } = await admin.from("incident_personnel")
      .select("id, name, status, status_changed_at, incident_id").eq("id", opts.personnelId ?? "").maybeSingle();
    if (!p || p.incident_id !== inc.id || p.status !== "MISSING") return { sent: 0, reason: "not missing" };
    ref = `${p.id}:${p.status_changed_at}`;
    personName = p.name;
    words = (l) => ({ title: `${WORDS[l].missing}: ${personName}`, body: `${inc.name}. ${WORDS[l].missingBody}` });
    chatText = `MISSING: ${personName} on ${inc.name}`;
    users = [...(await boardUsers(false)), ...(await deptUsers(true))];
  } else {
    chatText = `Incident closed: ${inc.name}`;
  }

  users = [...new Set(users)].filter((u) => u && u !== opts.exclude);

  // Record first. A second call for the same alert hits the primary key and stops here.
  const { error: logErr } = await admin.from("push_log").insert({ incident_id: inc.id, kind, ref, sent_to: users.length });
  if (logErr) return { sent: 0, reason: logErr.code === "23505" ? "already sent" : "log failed" };

  const chat = postToChat(admin, inc.dept_id, kind, chatText, inc.id);
  const payloadFor = (l: Lang) => {
    const w = words(l);
    return { aps: { alert: { title: w.title.slice(0, 80), body: w.body.slice(0, 160) }, sound: "default" }, incident_id: inc.id, kind };
  };
  const push = kind === "closed" ? Promise.resolve({ sent: 0, reason: "chat only" })
    : pushTo(admin, inc.dept_id, users, payloadFor, { collapse: `${kind}-${inc.id}`, ttl: kind === "incident" ? 3600 : 600 });
  const [c, p] = await Promise.all([chat, push]);
  return { ...p, chat: c };
}

export async function pushTo(
  admin: SupabaseClient,
  deptId: string | null,
  users: string[],
  payloadFor: (l: Lang) => Record<string, unknown>,
  opts: { collapse: string; ttl: number; quiet?: boolean },
): Promise<{ sent: number; reason?: string }> {
  if (!pushConfigured()) return { sent: 0, reason: "push not configured" };
  if (!users.length) return { sent: 0, reason: "nobody to alert" };

  // Every phone those people are signed in on, and the language each reads.
  const devices: { token: string; user_id: string }[] = [];
  const langOf = new Map<string, Lang>();
  for (let i = 0; i < users.length; i += 200) {
    const chunk = users.slice(i, i + 200);
    const [{ data: d }, { data: m }] = await Promise.all([
      admin.from("push_devices").select("token, user_id").in("user_id", chunk),
      deptId ? admin.from("members").select("user_id, lang").eq("dept_id", deptId).in("user_id", chunk) : Promise.resolve({ data: [] as { user_id: string; lang: string | null }[] }),
    ]);
    devices.push(...(d ?? []));
    for (const r of m ?? []) if (r.lang && r.lang in WORDS) langOf.set(r.user_id, r.lang as Lang);
  }
  if (!devices.length) return { sent: 0, reason: "no phones with alerts on" };

  const host = (Deno.env.get("APNS_HOST") ?? "https://api.push.apple.com").replace(/\/$/, "");
  const topic = Deno.env.get("APNS_BUNDLE_ID") ?? "ca.mkegroup.fireground";
  const keyPem = Deno.env.get("APNS_KEY")!;
  const keyId = Deno.env.get("APNS_KEY_ID")!.trim();
  const teamId = Deno.env.get("APNS_TEAM_ID")!.trim();
  const bodies = new Map<Lang, string>();
  const bodyFor = (l: Lang) => {
    if (!bodies.has(l)) bodies.set(l, JSON.stringify(payloadFor(l)));
    return bodies.get(l)!;
  };

  const reached = new Set<string>();
  const dead: string[] = [];
  const sendOne = async (d: { token: string; user_id: string }, retry = true): Promise<void> => {
    const res = await fetch(`${host}/3/device/${d.token}`, {
      method: "POST",
      headers: {
        authorization: `bearer ${await appleToken(keyPem, keyId, teamId, !retry)}`,
        "apns-topic": topic,
        "apns-push-type": "alert",
        "apns-priority": opts.quiet ? "5" : "10",
        "apns-expiration": String(Math.floor(Date.now() / 1000) + opts.ttl),
        "apns-collapse-id": opts.collapse.slice(0, 64),
        "content-type": "application/json",
      },
      body: bodyFor(langOf.get(d.user_id) ?? "en"),
    }).catch((e) => { console.error("apns network error", e); return null; });
    if (!res) return;
    if (res.ok) { reached.add(d.user_id); await res.body?.cancel(); return; }
    const reason = ((await res.json().catch(() => ({}))) as { reason?: string }).reason ?? "";
    if (res.status === 410 || ["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"].includes(reason)) {
      dead.push(d.token);
    } else if (res.status === 403 && reason === "ExpiredProviderToken" && retry) {
      return sendOne(d, false);
    } else {
      console.error("apns error", res.status, reason);
    }
  };

  // Ten at a time so a big department doesn't open hundreds of connections.
  for (let i = 0; i < devices.length; i += 10) {
    await Promise.all(devices.slice(i, i + 10).map((d) => sendOne(d)));
  }
  if (dead.length) await admin.from("push_devices").delete().in("token", dead);
  return { sent: reached.size };
}

// ---------------- chat alerts ----------------
const CHAT_WORDS = {
  en: { station: "Station chat", photo: "Photo", voice: "Voice note", location: "Shared a location" },
  fr: { station: "Clavardage de la caserne", photo: "Photo", voice: "Message vocal", location: "A partagé une position" },
  es: { station: "Chat de la estación", photo: "Foto", voice: "Nota de voz", location: "Compartió una ubicación" },
} as const;

type ChatMessage = {
  id: string; dept_id: string; incident_id: string | null; user_id: string | null; sender: string | null;
  kind: string; body: string; media_seconds: number | null; mentions: string[] | null; created_at: string; pushed_at: string | null;
};

/**
 * Alerts people about a new chat message, once.
 * Station chat: everyone in the department with chat alerts on.
 * Incident chat: everyone on that incident's board with chat alerts on.
 * People @mentioned always get it. The sender never does.
 */
export async function sendChatPush(admin: SupabaseClient, msg: ChatMessage): Promise<{ sent: number; reason?: string }> {
  // Claim it first so a second call does nothing.
  const { data: claimed } = await admin.from("incident_messages").update({ pushed_at: new Date().toISOString() })
    .eq("id", msg.id).is("pushed_at", null).select("id");
  if (!claimed?.length) return { sent: 0, reason: "already sent" };

  const { data: members } = await admin.from("members").select("user_id, chat_alerts")
    .eq("dept_id", msg.dept_id).eq("active", true).not("user_id", "is", null);
  const inDept = new Map((members ?? []).map((m) => [m.user_id as string, m.chat_alerts !== false]));
  let users: string[];
  let incName = "";
  if (msg.incident_id) {
    const [{ data: inc }, { data: board }] = await Promise.all([
      admin.from("incidents").select("name, status").eq("id", msg.incident_id).maybeSingle(),
      admin.from("incident_personnel").select("user_id").eq("incident_id", msg.incident_id).not("user_id", "is", null),
    ]);
    if (!inc || inc.status !== "active") return { sent: 0, reason: "incident closed" };
    incName = inc.name;
    users = (board ?? []).map((b) => b.user_id as string).filter((u) => inDept.get(u));
  } else {
    users = [...inDept.entries()].filter(([, on]) => on).map(([u]) => u);
  }
  const mentioned = (msg.mentions ?? []).filter((u) => inDept.has(u));
  users = [...new Set([...users, ...mentioned])].filter((u) => u && u !== msg.user_id);

  const preview = (l: Lang) => {
    const w = CHAT_WORDS[l];
    if (msg.kind === "photo") return `${w.photo}${msg.body ? `: ${msg.body}` : ""}`;
    if (msg.kind === "voice") return `${w.voice}${msg.media_seconds ? ` (${Math.round(msg.media_seconds)}s)` : ""}`;
    if (msg.kind === "location") return w.location;
    return msg.body;
  };
  const thread = msg.incident_id ?? "station";
  const payloadFor = (l: Lang) => ({
    aps: {
      alert: { title: (msg.sender ?? "").slice(0, 60), subtitle: (msg.incident_id ? incName : CHAT_WORDS[l].station).slice(0, 60), body: preview(l).slice(0, 180) },
      sound: "default",
      "thread-id": `chat-${thread}`,
    },
    chat: thread,
    incident_id: msg.incident_id,
    kind: "chat",
  });
  return pushTo(admin, msg.dept_id, users, payloadFor, { collapse: `chat-${msg.id}`, ttl: 3600, quiet: true });
}
