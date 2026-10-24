// Billing for departments. Called by the web app with the user's session.
// Per member who uses the app: monthly or yearly. No minimum.
// Actions:
//   checkout   (owner)  -> Stripe Checkout URL to pay by card.
//   invoice    (owner)  -> yearly plan billed by emailed invoice (net 30),
//                         for departments that pay by cheque or EFT.
//   portal     (owner)  -> Stripe customer portal URL (card, invoices, cancel).
//   sync-seats (member) -> pushes the current seat count to Stripe.
// If the free trial is still running, billing starts when it ends.
import { makeStripe } from "../_shared/stripe.ts";
import { adminClient, corsHeaders, lockedCors, countSeats, env, getUser, json, membership } from "../_shared/util.ts";
import { syncSeats } from "../_shared/seats.ts";

const stripe = makeStripe(env("STRIPE_SECRET_KEY"));

const PRICES: Record<string, string | undefined> = {
  monthly: Deno.env.get("STRIPE_PRICE_MONTHLY"),
  annual: Deno.env.get("STRIPE_PRICE_ANNUAL"),
};
// Stripe needs a quantity of at least 1. The owner always counts, so this never bills extra.
const MIN_SEATS = Math.max(1, Number(Deno.env.get("MIN_SEATS") ?? "1"));
const TAX = Deno.env.get("STRIPE_TAX") === "on";
const LIVE = ["active", "trialing", "past_due"];

const clean = (v: unknown, max = 120) => (typeof v === "string" ? v.trim().slice(0, max) : "");

Deno.serve(lockedCors(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const user = await getUser(req);
    if (!user) return json({ error: "Not signed in" }, 401);

    const body = await req.json().catch(() => ({}));
    const { action, dept_id } = body;
    if (!dept_id || typeof dept_id !== "string") return json({ error: "dept_id required" }, 400);

    const admin = adminClient();
    const me = await membership(admin, dept_id, user.id);
    if (!me) return json({ error: "Not a member of this department" }, 403);

    const { data: dept, error } = await admin.from("departments")
      .select("id, name, trial_ends_at, subscription_status, stripe_customer_id, stripe_subscription_id")
      .eq("id", dept_id).single();
    if (error || !dept) return json({ error: "Department not found" }, 404);

    const appUrl = env("APP_URL", "https://fire.mkegroup.ca").replace(/\/$/, "");

    if (action === "sync-seats") {
      const seats = await syncSeats(stripe, admin, dept, MIN_SEATS);
      return json({ seats });
    }

    if (me.role !== "owner") return json({ error: "Only the department owner can manage billing" }, 403);

    if (action === "portal") {
      if (!dept.stripe_customer_id) return json({ error: "No billing account yet" }, 400);
      const session = await stripe.billingPortal.sessions.create({
        customer: dept.stripe_customer_id,
        return_url: `${appUrl}/?billing=portal#/dept`,
      });
      return json({ url: session.url });
    }

    if (action !== "checkout" && action !== "invoice") return json({ error: "Unknown action" }, 400);
    // Invoices are yearly only. Monthly invoices for a few dollars aren't worth anyone's time.
    const plan = action === "invoice" ? "annual" : body.plan === "monthly" ? "monthly" : "annual";
    const PRICE = PRICES[plan];
    if (!PRICE) return json({ error: "Billing is not set up yet. Contact support." }, 500);

    // Already subscribed: send them to the portal instead of a second subscription.
    if (dept.stripe_subscription_id && LIVE.includes(dept.subscription_status)) {
      if (action === "invoice") return json({ error: "This department already has a plan." }, 400);
      const session = await stripe.billingPortal.sessions.create({
        customer: dept.stripe_customer_id!,
        return_url: `${appUrl}/?billing=portal#/dept`,
      });
      return json({ url: session.url });
    }

    const seats = Math.max(await countSeats(admin, dept_id), MIN_SEATS);
    // Stripe needs trial_end at least 48h out. Inside that window we bill now.
    const trialEnd = Math.floor(new Date(dept.trial_ends_at).getTime() / 1000);
    const keepTrial = trialEnd > Math.floor(Date.now() / 1000) + 49 * 3600;

    // ---------- pay by invoice ----------
    if (action === "invoice") {
      const email = clean(body.email, 200);
      const org = clean(body.org) || dept.name;
      const address = {
        line1: clean(body.line1),
        city: clean(body.city, 60),
        state: clean(body.province, 30),
        postal_code: clean(body.postal, 12).toUpperCase(),
        country: "CA",
      };
      if (!/^\S+@\S+\.\S+$/.test(email)) return json({ error: "Enter the email where invoices should go." }, 400);
      if (!address.line1 || !address.city || !address.postal_code) return json({ error: "Enter the full billing address." }, 400);
      const po = clean(body.po, 40);

      const fields = {
        name: org,
        email,
        address,
        metadata: { dept_id },
        ...(po ? { invoice_settings: { custom_fields: [{ name: "PO number", value: po }] } } : {}),
      };
      let customer = dept.stripe_customer_id as string | null;
      if (customer) await stripe.customers.update(customer, fields);
      else {
        customer = (await stripe.customers.create(fields)).id;
        await admin.from("departments").update({ stripe_customer_id: customer }).eq("id", dept_id);
      }

      const sub = await stripe.subscriptions.create({
        customer,
        items: [{ price: PRICE, quantity: seats }],
        collection_method: "send_invoice",
        days_until_due: 30,
        metadata: { dept_id },
        ...(keepTrial ? { trial_end: trialEnd } : {}),
        ...(TAX ? { automatic_tax: { enabled: true } } : {}),
      });
      // The webhook does this too. Doing it here means the app updates right away.
      await admin.from("departments").update({
        stripe_subscription_id: sub.id,
        subscription_status: sub.status,
        seat_count: await countSeats(admin, dept_id),
      }).eq("id", dept_id);
      return json({ ok: true, status: sub.status });
    }

    // ---------- pay by card ----------
    let customer = dept.stripe_customer_id as string | null;
    if (!customer) {
      const c = await stripe.customers.create({
        name: dept.name,
        email: user.email ?? undefined,
        metadata: { dept_id },
      });
      customer = c.id;
      await admin.from("departments").update({ stripe_customer_id: customer }).eq("id", dept_id);
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer,
      client_reference_id: dept_id,
      line_items: [{ price: PRICE, quantity: seats }],
      allow_promotion_codes: true,
      billing_address_collection: "required",
      ...(TAX ? { automatic_tax: { enabled: true }, customer_update: { address: "auto", name: "auto" } } : {}),
      subscription_data: {
        metadata: { dept_id },
        ...(keepTrial ? { trial_end: trialEnd } : {}),
      },
      success_url: `${appUrl}/?billing=success#/dept`,
      cancel_url: `${appUrl}/?billing=cancel#/dept`,
    });
    return json({ url: session.url });
  } catch (e) {
    console.error("billing error", e);
    const err = e as { type?: string; message?: string };
    const msg = err?.type === "StripeInvalidRequestError" && err.message ? err.message : "Billing error. Please try again.";
    return json({ error: msg }, 500);
  }
}));
