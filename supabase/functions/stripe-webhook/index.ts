// Stripe -> department billing status. The only writer of the billing columns.
import Stripe from "npm:stripe@17";
import { makeStripe } from "../_shared/stripe.ts";
import { adminClient, env } from "../_shared/util.ts";

const stripe = makeStripe(env("STRIPE_SECRET_KEY"));
const crypto = Stripe.createSubtleCryptoProvider();

function periodEnd(sub: Stripe.Subscription): string | null {
  // Newer Stripe API versions moved current_period_end onto the item.
  // deno-lint-ignore no-explicit-any
  const s = sub as any;
  const ts = s.current_period_end ?? s.items?.data?.[0]?.current_period_end;
  return ts ? new Date(ts * 1000).toISOString() : null;
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
    return new Response("error", { status: 500 }); // Stripe will retry
  }
  return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
});
