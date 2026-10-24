import type Stripe from "npm:stripe@17";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { countSeats } from "./util.ts";

type Dept = { id: string; subscription_status: string | null; stripe_subscription_id: string | null };

/** Counts signed-in active members and pushes that quantity to the Stripe subscription. */
export async function syncSeats(stripe: Stripe, admin: SupabaseClient, dept: Dept, minSeats: number): Promise<number> {
  const seats = await countSeats(admin, dept.id);
  await admin.from("departments").update({ seat_count: seats }).eq("id", dept.id);
  if (dept.stripe_subscription_id && ["active", "trialing", "past_due"].includes(dept.subscription_status ?? "")) {
    const sub = await stripe.subscriptions.retrieve(dept.stripe_subscription_id);
    const item = sub.items.data[0];
    const qty = Math.max(seats, minSeats);
    if (item && item.quantity !== qty) {
      await stripe.subscriptions.update(sub.id, {
        items: [{ id: item.id, quantity: qty }],
        proration_behavior: "create_prorations",
      });
    }
  }
  return seats;
}
