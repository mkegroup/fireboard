// Billing for departments. Called by the web app with the user's session.
// Per member who uses the app: monthly or yearly. No minimum, capped at SEAT_CAP (20) paid users.
// Actions:
//   checkout   (owner)  -> Stripe Checkout URL to pay by card.
//   invoice    (owner)  -> yearly plan billed by emailed invoice (net 30),
//                         for departments that pay by cheque or EFT.
//   portal     (owner)  -> Stripe customer portal URL (card, invoices, cancel).
//   seats      (owner)  -> changes how many seats the department pays for.
//   sync-seats (member) -> pushes the current seat count to Stripe. When someone
//                         joins past what the owner chose, billing grows on its
//                         own and the owner gets an alert.
// The owner picks a number of seats (a floor). Billing is the larger of that and
// the people actually signed in, never more than SEAT_CAP.
// If the free trial is still running, billing starts when it ends.
import { makeStripe } from "../_shared/stripe.ts";
import { adminClient, appUrl as cleanAppUrl, corsHeaders, lockedCors, countSeats, env, getUser, json, membership } from "../_shared/util.ts";
import { SEAT_CAP, isCustom, syncSeats, targetSeats } from "../_shared/seats.ts";
import { pushTo } from "../_shared/push.ts";
import { emails, mailOwnersOnce } from "../_shared/owner-mail.ts";
import { logError } from "../_shared/admin.ts";

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
/** A seat count from the app: a whole number from 1 to the cap, or null. */
const seatsFrom = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= SEAT_CAP ? n : null;
};

type Admin = ReturnType<typeof adminClient>;
const SEAT_WORDS = {
  en: (who: string, n: number) => ({ title: "Seat added", body: `${who} joined. Your plan now covers ${n} people.` }),
  fr: (who: string, n: number) => ({ title: "Place ajoutée", body: `${who} s'est joint. Votre forfait couvre maintenant ${n} personnes.` }),
  es: (who: string, n: number) => ({ title: "Plaza agregada", body: `${who} se unió. Su plan ahora cubre ${n} personas.` }),
};

const JOIN_WORDS = {
  en: (who: string) => ({ title: "Waiting for approval", body: `${who} asked to join. Approve or decline in Department.` }),
  fr: (who: string) => ({ title: "En attente d'approbation", body: `${who} demande à se joindre. Approuvez ou refusez dans Service.` }),
  es: (who: string) => ({ title: "Esperando aprobación", body: `${who} pidió unirse. Apruebe o rechace en Departamento.` }),
};

/** Tells owners and officers someone is waiting to be approved: push to all of them, email to owners. Once per request. */
async function alertJoinRequest(admin: Admin, deptId: string, memberId: string, who: string, email: string) {
  const { data: dept } = await admin.from("departments").select("id, name").eq("id", deptId).maybeSingle();
  if (!dept) return;
  // Claim it first so a second call doesn't alert twice.
  const { error } = await admin.from("owner_emails").insert({ dept_id: deptId, kind: "join_alert", ref: memberId });
  if (error) return;
  const { data: officers } = await admin.from("members").select("user_id").eq("dept_id", deptId).eq("active", true).in("role", ["owner", "officer"]).not("user_id", "is", null);
  await pushTo(admin, deptId, (officers ?? []).map((o) => o.user_id as string), (l) => {
    const w = (JOIN_WORDS[l as keyof typeof JOIN_WORDS] ?? JOIN_WORDS.en)(who);
    return { aps: { alert: { title: w.title, body: w.body.slice(0, 160) }, sound: "default" }, kind: "join" };
  }, { collapse: `join-${memberId}`, ttl: 86400 * 3, quiet: true });
  await mailOwnersOnce(admin, deptId, "join_request", memberId, emails.joinRequest(dept.name, who, email));
}

/** Push to the department's owners when billing grew because someone joined. */
async function alertOwners(admin: Admin, dept: { id: string; name: string; plan_interval?: string | null }, joinerId: string, billed: number, memberId: string | null = null) {
  // memberId: an officer just approved this person. Otherwise the caller is the person who joined.
  const { data: joiner } = memberId
    ? await admin.from("members").select("name").eq("dept_id", dept.id).eq("id", memberId).maybeSingle()
    : await admin.from("members").select("name").eq("dept_id", dept.id).eq("user_id", joinerId).maybeSingle();
  const { data: owners } = await admin.from("members").select("user_id").eq("dept_id", dept.id).eq("role", "owner").eq("active", true).not("user_id", "is", null);
  const users = (owners ?? []).map((o) => o.user_id as string).filter((u) => u && u !== joinerId);
  const who = joiner?.name || "Someone";
  await pushTo(admin, dept.id, users, (l) => {
    const w = (SEAT_WORDS[l as keyof typeof SEAT_WORDS] ?? SEAT_WORDS.en)(who, billed);
    return { aps: { alert: { title: w.title, body: w.body.slice(0, 160) }, sound: "default" }, kind: "seats" };
  }, { collapse: `seats-${dept.id}`, ttl: 86400, quiet: true });
  await mailOwnersOnce(admin, dept.id, "seat_added", `${billed}:${new Date().toISOString().slice(0, 10)}`,
    emails.seatAdded(dept.name, who, billed, dept.plan_interval ?? null));
}

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
    if (!me) {
      // Someone who just asked to join a department that approves new people.
      // The app calls this right after joining, so this is where officers hear about it.
      if (action === "sync-seats") {
        const { data: req } = await admin.from("members").select("id, name, pending_at")
          .eq("dept_id", dept_id).eq("user_id", user.id).eq("active", false).not("pending_at", "is", null).is("removed_at", null).maybeSingle();
        if (req) {
          await alertJoinRequest(admin, dept_id, req.id as string, (req.name as string) || "Someone", user.email ?? "").catch((e) => console.error("join alert failed", e));
          return json({ pending: true });
        }
      }
      return json({ error: "Not a member of this department" }, 403);
    }

    const { data: dept, error } = await admin.from("departments")
      .select("id, name, trial_ends_at, subscription_status, stripe_customer_id, stripe_subscription_id, seats_paid, plan_interval")
      .eq("id", dept_id).single();
    if (error || !dept) return json({ error: "Department not found" }, 404);

    // Stripe refuses return links with a # in them, so these come back to /?billing=... and the app opens Plan.
    const appUrl = cleanAppUrl();

    if (action === "sync-seats") {
      // An officer just approved someone: tell that person they're in.
      if (typeof body.member_id === "string" && me.role !== "member") {
        const { data: m } = await admin.from("members").select("user_id, active").eq("id", body.member_id).eq("dept_id", dept_id).maybeSingle();
        if (m?.active && m.user_id) {
          await pushTo(admin, dept_id, [m.user_id as string], (l) => ({
            aps: { alert: { title: dept.name, body: l === "fr" ? "Vous êtes approuvé. Ouvrez l'appli pour voir le tableau." : l === "es" ? "Fue aprobado. Abra la app para ver el tablero." : "You're approved. Open the app to see the board." }, sound: "default" },
            kind: "approved",
          }), { collapse: `approved-${body.member_id}`, ttl: 86400 * 3, quiet: true }).catch(() => {});
        }
      }
      const r = await syncSeats(stripe, admin, dept, MIN_SEATS);
      // Someone joined past what the owner chose: billing grew. Tell the owner.
      if (r.billed !== null && r.before !== null && r.billed > r.before && r.seats > (dept.seats_paid ?? 0)) {
        await alertOwners(admin, dept, user.id, r.billed, typeof body.member_id === "string" ? body.member_id : null).catch((e) => console.error("seat alert failed", e));
      }
      return json({ seats: r.seats, billed: r.billed });
    }

    if (me.role !== "owner") return json({ error: "Only the department owner can manage billing" }, 403);

    if (action === "portal") {
      if (!dept.stripe_customer_id) return json({ error: "No billing account yet" }, 400);
      const session = await stripe.billingPortal.sessions.create({
        customer: dept.stripe_customer_id,
        return_url: `${appUrl}/?billing=portal`,
      });
      return json({ url: session.url });
    }

    // ---------- change seats ----------
    if (action === "seats") {
      if (!dept.stripe_subscription_id || !LIVE.includes(dept.subscription_status)) {
        return json({ error: "Choose a plan first." }, 400);
      }
      const chosen = seatsFrom(body.seats);
      if (!chosen) return json({ error: `Pick between 1 and ${SEAT_CAP} seats.` }, 400);
      const sub = await stripe.subscriptions.retrieve(dept.stripe_subscription_id);
      if (isCustom(sub)) return json({ error: "You're on a custom plan. Email us and we'll change it for you." }, 400);
      const item = sub.items.data[0];
      const used = await countSeats(admin, dept_id);
      const qty = targetSeats(used, chosen, MIN_SEATS);
      if (item && (item.quantity !== qty || sub.metadata?.seats_paid !== String(chosen))) {
        // More seats: charged for the rest of this period on the next bill.
        // Fewer seats: no refund mid-period, the next bill is lower.
        await stripe.subscriptions.update(sub.id, {
          items: [{ id: item.id, quantity: qty }],
          proration_behavior: qty > (item.quantity ?? 0) ? "create_prorations" : "none",
          // Kept on the subscription so the webhook never puts back an old number.
          metadata: { ...sub.metadata, seats_paid: String(chosen) },
        });
      }
      await admin.from("departments").update({ seats_paid: chosen, seats_billed: qty, seat_count: used }).eq("id", dept_id);
      return json({ seats_paid: chosen, billed: qty, used });
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
        return_url: `${appUrl}/?billing=portal`,
      });
      return json({ url: session.url });
    }

    // The owner picks how many people to pay for. Never less than who's already signed in.
    const used = await countSeats(admin, dept_id);
    const chosen = seatsFrom(body.seats) ?? dept.seats_paid ?? Math.max(1, Math.min(used, SEAT_CAP));
    const seats = targetSeats(used, chosen, MIN_SEATS);
    await admin.from("departments").update({ seats_paid: chosen }).eq("id", dept_id);
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
        metadata: { dept_id, seats_paid: String(chosen) },
        ...(keepTrial ? { trial_end: trialEnd } : {}),
        ...(TAX ? { automatic_tax: { enabled: true } } : {}),
      });
      // The webhook does this too. Doing it here means the app updates right away.
      await admin.from("departments").update({
        stripe_subscription_id: sub.id,
        subscription_status: sub.status,
        seat_count: used,
        seats_billed: seats,
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
        metadata: { dept_id, seats_paid: String(chosen) },
        ...(keepTrial ? { trial_end: trialEnd } : {}),
      },
      success_url: `${appUrl}/?billing=success`,
      cancel_url: `${appUrl}/?billing=cancel`,
    });
    return json({ url: session.url });
  } catch (e) {
    console.error("billing error", e);
    await logError(adminClient(), "billing", e);
    const err = e as { type?: string; message?: string };
    const msg = err?.type === "StripeInvalidRequestError" && err.message ? err.message : "Billing error. Please try again.";
    return json({ error: msg }, 500);
  }
}));
