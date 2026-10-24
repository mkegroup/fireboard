// In-app account deletion (required by the App Store).
// Removes the user from every department, deletes departments where they were
// the only person with an account, cancels those subscriptions, then deletes the login.
import { makeStripe } from "../_shared/stripe.ts";
import { adminClient, corsHeaders, lockedCors, countSeats, getUser, json } from "../_shared/util.ts";

const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
const stripe = stripeKey ? makeStripe(stripeKey) : null;

Deno.serve(lockedCors(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const user = await getUser(req);
  if (!user) return json({ error: "Not signed in" }, 401);
  const admin = adminClient();

  const { data: mine } = await admin.from("members")
    .select("id, dept_id, role, departments(name, stripe_subscription_id)")
    .eq("user_id", user.id).eq("active", true);

  // First pass: refuse if they are the last owner of a department other people still use.
  const toDelete: { dept_id: string; sub: string | null }[] = [];
  for (const m of mine ?? []) {
    if (m.role !== "owner") continue;
    const { count: others } = await admin.from("members").select("id", { count: "exact", head: true })
      .eq("dept_id", m.dept_id).eq("active", true).not("user_id", "is", null).neq("user_id", user.id);
    const { count: otherOwners } = await admin.from("members").select("id", { count: "exact", head: true })
      .eq("dept_id", m.dept_id).eq("active", true).eq("role", "owner").neq("user_id", user.id);
    // deno-lint-ignore no-explicit-any
    const d = (m as any).departments;
    if ((others ?? 0) > 0 && (otherOwners ?? 0) === 0) {
      return json({
        error: `You are the only owner of ${d?.name ?? "a department"}. Make someone else an owner first.`,
      }, 409);
    }
    if ((others ?? 0) === 0) toDelete.push({ dept_id: m.dept_id, sub: d?.stripe_subscription_id ?? null });
  }

  for (const d of toDelete) {
    if (d.sub && stripe) {
      try { await stripe.subscriptions.cancel(d.sub); } catch (e) { console.warn("cancel failed", e); }
    }
    await admin.from("departments").delete().eq("id", d.dept_id);
  }

  const remaining = (mine ?? []).filter((m) => !toDelete.some((d) => d.dept_id === m.dept_id));
  for (const m of remaining) {
    await admin.from("members").update({ active: false, role: "member", user_id: null, phone: null })
      .eq("id", m.id);
    await admin.from("member_medical").delete().eq("member_id", m.id);
    const seats = await countSeats(admin, m.dept_id);
    await admin.from("departments").update({ seat_count: seats }).eq("id", m.dept_id);
  }

  const { error } = await admin.auth.admin.deleteUser(user.id);
  if (error) {
    console.error("delete user failed", error);
    return json({ error: "Could not delete account" }, 500);
  }
  return json({ ok: true });
}));
