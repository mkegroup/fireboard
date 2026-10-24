// Nightly safety net for per-seat billing. The app syncs seats whenever someone
// joins or leaves, but this makes sure Stripe always matches the real roster.
// Called by the scheduled GitHub Action with the RECONCILE_SECRET header.
import { makeStripe } from "../_shared/stripe.ts";
import { adminClient, env, json } from "../_shared/util.ts";
import { syncSeats } from "../_shared/seats.ts";

const stripe = makeStripe(env("STRIPE_SECRET_KEY"));
const MIN_SEATS = Math.max(1, Number(Deno.env.get("MIN_SEATS") ?? "1"));

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const secret = env("RECONCILE_SECRET", "");
  if (!secret || req.headers.get("x-reconcile-secret") !== secret) return json({ error: "Unauthorized" }, 401);

  const admin = adminClient();
  const { data: depts, error } = await admin.from("departments")
    .select("id, subscription_status, stripe_subscription_id")
    .not("stripe_subscription_id", "is", null)
    .in("subscription_status", ["active", "trialing", "past_due"]);
  if (error) return json({ error: error.message }, 500);

  let checked = 0, failed = 0;
  for (const d of depts ?? []) {
    try { await syncSeats(stripe, admin, d, MIN_SEATS); checked++; }
    catch (e) { failed++; console.error("reconcile failed", d.id, e); }
  }
  return json({ checked, failed }, failed ? 207 : 200);
});
