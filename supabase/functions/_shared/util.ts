import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-dispatch-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function env(name: string, fallback?: string): string {
  const v = Deno.env.get(name) ?? fallback;
  if (v === undefined) throw new Error(`Missing env var ${name}`);
  return v;
}

/** Service role client. Bypasses RLS, so every caller must check permissions itself. */
export function adminClient(): SupabaseClient {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Resolves the signed-in user from the request's bearer token. */
export async function getUser(req: Request) {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await adminClient().auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

export async function membership(admin: SupabaseClient, deptId: string, userId: string) {
  const { data } = await admin.from("members")
    .select("id, role, active")
    .eq("dept_id", deptId).eq("user_id", userId).eq("active", true)
    .maybeSingle();
  return data as { id: string; role: "owner" | "officer" | "member" } | null;
}

export async function countSeats(admin: SupabaseClient, deptId: string): Promise<number> {
  const { count } = await admin.from("members")
    .select("id", { count: "exact", head: true })
    .eq("dept_id", deptId).eq("active", true).not("user_id", "is", null);
  return count ?? 0;
}

/**
 * Wraps a handler so browsers only accept responses on the app's own origins.
 * Bearer tokens already protect these functions; this blocks other websites
 * from calling them with a signed-in user's browser as a second layer.
 * ALLOWED_ORIGINS is a comma list. Defaults to APP_URL plus the iOS app.
 */
export function lockedCors(handler: (req: Request) => Promise<Response>) {
  const allowed = new Set(
    (Deno.env.get("ALLOWED_ORIGINS") ?? `${Deno.env.get("APP_URL") ?? "https://fire.mkegroup.ca"},capacitor://localhost`)
      .split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean),
  );
  return async (req: Request): Promise<Response> => {
    const origin = req.headers.get("origin");
    const ok = !origin || allowed.has(origin);
    if (!ok) return new Response(JSON.stringify({ error: "Origin not allowed" }), { status: 403, headers: { "Content-Type": "application/json" } });
    const res = req.method === "OPTIONS" ? new Response("ok") : await handler(req);
    const headers = new Headers(res.headers);
    headers.delete("Access-Control-Allow-Origin");
    if (origin) {
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Access-Control-Allow-Headers", corsHeaders["Access-Control-Allow-Headers"]);
      headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      headers.set("Vary", "Origin");
    }
    return new Response(res.body, { status: res.status, headers });
  };
}
