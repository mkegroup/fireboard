// Nightly safety net for per-seat billing. The app syncs seats whenever someone
// joins or leaves, but this makes sure Stripe always matches the real roster.
// Called by the scheduled GitHub Action with the RECONCILE_SECRET header.
import { makeStripe } from "../_shared/stripe.ts";
import { adminClient, env, json } from "../_shared/util.ts";
import { syncSeats } from "../_shared/seats.ts";
import { logError, logEvent, sweepAdminEvents } from "../_shared/admin.ts";

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
    catch (e) { failed++; console.error("reconcile failed", d.id, e); await logError(admin, "nightly seat check", e, d.id); }
  }

  // Trials worth a phone call: ending in the next day, or ended in the last day without a plan.
  const day = 86400_000;
  const now = Date.now();
  const { data: trials } = await admin.from("departments").select("id, name, trial_ends_at, subscription_status, seat_count")
    .in("subscription_status", ["none", "incomplete"])
    .gte("trial_ends_at", new Date(now - day).toISOString()).lte("trial_ends_at", new Date(now + day).toISOString());
  for (const d of trials ?? []) {
    const ending = new Date(d.trial_ends_at).getTime() > now;
    const kind = ending ? "trial_ending" : "trial_ended";
    const { data: dup } = await admin.from("platform_events").select("id").eq("kind", kind).eq("dept_id", d.id).limit(1);
    if (dup?.length) continue;
    await logEvent(admin, {
      kind, dept_id: d.id, notify: true,
      title: `${ending ? "Trial ends tomorrow" : "Trial ended with no plan"}: ${d.name}`,
      detail: `${d.seat_count} ${d.seat_count === 1 ? "person uses" : "people use"} the app. ${ending ? "A quick call could close it." : "Worth a follow-up."}`,
    });
  }
  await sweepAdminEvents(admin);
  return json({ checked, failed }, failed ? 207 : 200);
});
