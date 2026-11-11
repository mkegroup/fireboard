import type Stripe from "npm:stripe@17";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { countSeats } from "./util.ts";

type Dept = { id: string; subscription_status: string | null; stripe_subscription_id: string | null };

// Most a department ever pays for. Everyone after this is free.
// 20 x $9.99 = $199.80 a month, 20 x $99.99 = $1,999.80 a year.
export const SEAT_CAP = Math.max(1, Number(Deno.env.get("SEAT_CAP") ?? "20"));

/** Seats billed for a roster of `seats` people: at least the minimum, never more than the cap. */
export function billedSeats(seats: number, minSeats: number): number {
  return Math.min(Math.max(seats, minSeats), Math.max(SEAT_CAP, minSeats));
}

/** The two standard per-user prices. Anything else is a custom deal set up by hand in Stripe. */
export function standardPrices(): string[] {
  return [Deno.env.get("STRIPE_PRICE_MONTHLY"), Deno.env.get("STRIPE_PRICE_ANNUAL")].filter((p): p is string => !!p);
}

/** Counts signed-in active members and pushes the billed quantity to the Stripe subscription.
 *  Custom deals (a price that isn't one of the standard two, or metadata seats=fixed) are left alone. */
export async function syncSeats(stripe: Stripe, admin: SupabaseClient, dept: Dept, minSeats: number): Promise<number> {
  const seats = await countSeats(admin, dept.id);
  await admin.from("departments").update({ seat_count: seats }).eq("id", dept.id);
  if (dept.stripe_subscription_id && ["active", "trialing", "past_due"].includes(dept.subscription_status ?? "")) {
    const sub = await stripe.subscriptions.retrieve(dept.stripe_subscription_id);
    const item = sub.items.data[0];
    const priceId = typeof item?.price === "string" ? item.price : item?.price?.id;
    const custom = sub.metadata?.seats === "fixed" || (priceId && !standardPrices().includes(priceId));
    if (custom) return seats;
    const qty = billedSeats(seats, minSeats);
    if (item && item.quantity !== qty) {
      await stripe.subscriptions.update(sub.id, {
        items: [{ id: item.id, quantity: qty }],
        proration_behavior: "create_prorations",
      });
    }
  }
  return seats;
}
