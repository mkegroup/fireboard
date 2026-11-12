// Stripe -> department billing status. The only writer of the billing columns.
import Stripe from "npm:stripe@17";
import { makeStripe } from "../_shared/stripe.ts";
import { adminClient, env } from "../_shared/util.ts";
import { standardPrices } from "../_shared/seats.ts";
import { logError, logEvent, sweepAdminEvents } from "../_shared/admin.ts";

const stripe = makeStripe(env("STRIPE_SECRET_KEY"));
const crypto = Stripe.createSubtleCryptoProvider();

function periodEnd(sub: Stripe.Subscription): string | null {
  // Newer Stripe API versions moved current_period_end onto the item.
  // deno-lint-ignore no-explicit-any
  const s = sub as any;
  const ts = s.current_period_end ?? s.items?.data?.[0]?.current_period_end;
  return ts ? new Date(ts * 1000).toISOString() : null;
}

/** Monthly or yearly, card or invoice, what it costs before tax, whether it's a
 *  custom deal, and the end date if it's set to cancel. */
function planDetails(sub: Stripe.Subscription) {
  // deno-lint-ignore no-explicit-any
  const s = sub as any;
  const interval = s.items?.data?.[0]?.price?.recurring?.interval ?? s.items?.data?.[0]?.plan?.interval ?? null;
  const cancelTs = s.cancel_at ?? (s.cancel_at_period_end ? (s.current_period_end ?? s.items?.data?.[0]?.current_period_end) : null);
  // deno-lint-ignore no-explicit-any
  const items: any[] = s.items?.data ?? [];
  const cents = items.reduce((t, i) => t + (Number(i.price?.unit_amount ?? i.plan?.amount ?? 0) * Number(i.quantity ?? 1)), 0);
  const std = standardPrices();
  const custom = s.metadata?.seats === "fixed" || items.some((i) => (i.price?.id ?? i.plan?.id) && !std.includes(i.price?.id ?? i.plan?.id));
  return {
    plan_interval: interval === "month" || interval === "year" ? interval : null,
    plan_amount: items.length ? Math.round(cents) / 100 : null,
    plan_custom: std.length > 0 && custom,
    plan_invoice: s.collection_method === "send_invoice",
    plan_cancel_at: cancelTs && sub.status !== "canceled" ? new Date(cancelTs * 1000).toISOString() : null,
    // How many seats Stripe bills, and how many the owner chose (kept in metadata).
    seats_billed: items.length ? Number(items[0].quantity ?? 1) : null,
    ...(Number.isInteger(Number(s.metadata?.seats_paid)) && Number(s.metadata.seats_paid) > 0 ? { seats_paid: Number(s.metadata.seats_paid) } : {}),
  };
}

async function applySubscription(sub: Stripe.Subscription) {
  const admin = adminClient();
  const customer = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  let deptId = sub.metadata?.dept_id;
  if (!deptId) {
    const { data } = await admin.from("departments").select("id").eq("stripe_customer_id", customer).maybeSingle();
    deptId = data?.id;
  }
  if (!deptId) {
    console.warn("subscription with no department", sub.id);
    return;
  }
  const status = sub.status === "canceled" ? "canceled" : sub.status;
  // Start the grace clock the first time a payment goes past due. Clear it once paid.
  const { data: cur } = await admin.from("departments").select("past_due_since").eq("id", deptId).maybeSingle();
  const pastDueSince = status === "past_due" ? (cur?.past_due_since ?? new Date().toISOString()) : null;
  const { error } = await admin.from("departments").update({
    stripe_customer_id: customer,
    stripe_subscription_id: sub.id,
    subscription_status: status,
    current_period_end: periodEnd(sub),
    past_due_since: pastDueSince,
    ...planDetails(sub),
  }).eq("id", deptId);
  if (error) throw error;
}

Deno.serve(async (req) => {
  const sig = req.headers.get("stripe-signature");
  if (!sig) return new Response("missing signature", { status: 400 });
  const body = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig, env("STRIPE_WEBHOOK_SECRET"), undefined, crypto);
  } catch (e) {
    console.error("bad signature", e);
    return new Response("bad signature", { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session;
        if (s.mode === "subscription" && s.subscription) {
          const sub = await stripe.subscriptions.retrieve(s.subscription as string);
          if (!sub.metadata?.dept_id && s.client_reference_id) {
            sub.metadata = { ...sub.metadata, dept_id: s.client_reference_id };
          }
          await applySubscription(sub);
        }
        break;
      }
      case "invoice.paid":
      case "invoice.payment_failed": {
        // For the owner's console: money in, and money that didn't come in.
        const inv = event.data.object as Stripe.Invoice;
        const customer = typeof inv.customer === "string" ? inv.customer : inv.customer?.id;
        const paid = event.type === "invoice.paid";
        const cents = paid ? inv.amount_paid : inv.amount_due;
        if (!customer || !cents) break; // $0 trial invoices aren't news
        const admin = adminClient();
        const { data: d } = await admin.from("departments").select("id, name").eq("stripe_customer_id", customer).maybeSingle();
        const { data: dup } = await admin.from("platform_events").select("id").eq("kind", paid ? "payment" : "payment_failed").contains("meta", { invoice: inv.id }).limit(1);
        if (dup?.length) break; // Stripe sometimes sends the same event twice
        const amount = cents / 100;
        await logEvent(admin, {
          kind: paid ? "payment" : "payment_failed",
          title: `${paid ? "Payment received" : "Payment failed"}: ${d?.name ?? inv.customer_name ?? inv.customer_email ?? "unknown customer"}`,
          detail: `$${amount.toFixed(2)} ${(inv.currency ?? "cad").toUpperCase()}${inv.collection_method === "send_invoice" ? " by invoice" : " by card"}`,
          dept_id: d?.id ?? null, amount: paid ? amount : null, meta: { invoice: inv.id }, notify: paid,
        });
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.paused":
      case "customer.subscription.resumed":
        await applySubscription(event.data.object as Stripe.Subscription);
        break;
      default:
        break;
    }
  } catch (e) {
    console.error("webhook handling failed", event.type, e);
    await logError(adminClient(), `Stripe webhook (${event.type})`, e);
    await sweepAdminEvents(adminClient());
    return new Response("error", { status: 500 }); // Stripe will retry
  }
  await sweepAdminEvents(adminClient());
  return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
});
