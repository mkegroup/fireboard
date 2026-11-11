// Posts a short message to a department's group chat: Slack, Microsoft Teams,
// Discord or Google Chat, using the incoming webhook link the owner pasted in.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { appUrl } from "./util.ts";

export type ChatEvent = "incident" | "par" | "missing" | "closed";

/** Refuses links that point inside a private network. */
export function safeWebhook(url: string | null | undefined): URL | null {
  if (!url) return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (Deno.env.get("CHAT_ALLOW_INSECURE") === "1") return u; // local tests only
  if (u.protocol !== "https:") return null;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(":")) return null;
  return u;
}

export function chatBody(url: URL, text: string, link: string) {
  const h = url.hostname;
  if (h.endsWith("discord.com") || h.endsWith("discordapp.com")) return { content: `${text}\n${link}` };
  if (h.endsWith("slack.com")) return { text: `${text}\n<${link}|Open the board>` };
  if (h === "chat.googleapis.com") return { text: `${text}\n${link}` };
  if (h.endsWith("webhook.office.com") || h.endsWith("logic.azure.com") || h.endsWith("powerplatform.com") || h.endsWith("powerautomate.com")) {
    return {
      type: "message",
      attachments: [{
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [{ type: "TextBlock", text, wrap: true, weight: "Bolder" }],
          actions: [{ type: "Action.OpenUrl", title: "Open the board", url: link }],
        },
      }],
    };
  }
  return { text: `${text}\n${link}`, content: `${text}\n${link}` };
}

/** Never throws. A broken chat link must not stop an alert. */
export async function postToChat(admin: SupabaseClient, deptId: string, event: ChatEvent | "test", text: string, incidentId: string | null): Promise<boolean> {
  try {
    const { data } = await admin.from("dept_integrations").select("chat_webhook_url, chat_events").eq("dept_id", deptId).maybeSingle();
    const url = safeWebhook(data?.chat_webhook_url);
    if (!url || (event !== "test" && !(data?.chat_events ?? []).includes(event))) return false;
    const app = appUrl();
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chatBody(url, text, incidentId ? `${app}/#/incident/${incidentId}` : `${app}/#/`)),
      redirect: "manual",
      signal: AbortSignal.timeout(6000),
    });
    await res.body?.cancel();
    if (!res.ok) console.warn("chat webhook answered", res.status);
    return res.ok;
  } catch (e) {
    console.warn("chat webhook failed", e);
    return false;
  }
}
