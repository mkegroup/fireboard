import type Stripe from "npm:stripe@17";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { countSeats } from "./util.ts";

// Most a department pays for: 20 seats for up to 60 people, then 20 more for
// every 60 more people. So a 40-person department pays for 20 seats, and a
// 150-person county pays for 60. 20 x $9.99 = $199.80 a month.
export const SEAT_CAP = Math.max(1, Number(Deno.env.get("SEAT_CAP") ?? "20"));
export const PEOPLE_PER_CAP = Math.max(1, Number(Deno.env.get("PEOPLE_PER_CAP") ?? "60"));

/** The most seats billed for this many people signed in. */
export function capFor(people: number): number {
  return SEAT_CAP * Math.max(1, Math.ceil(people / PEOPLE_PER_CAP));
}

/** Seats billed for `seats` people: at least the minimum, never more than the cap for that many people. */
export function billedSeats(seats: number, minSeats: number): number {
  return Math.min(Math.max(seats, minSeats), Math.max(capFor(seats), minSeats));
}

/** The two standard per-user prices. Anything else is a custom deal set up by hand in Stripe. */
export function standardPrices(): string[] {
  return [Deno.env.get("STRIPE_PRICE_MONTHLY"), Deno.env.get("STRIPE_PRICE_ANNUAL")].filter((p): p is string => !!p);
}

export type SeatDept = {
  id: string;
  subscription_status: string | null;
  stripe_subscription_id: string | null;
  seats_paid?: number | null;
};

/** What Stripe should bill: the seats the owner chose, or more if more people signed in. */
export function targetSeats(used: number, chosen: number | null | undefined, minSeats: number): number {
  return Math.max(minSeats, Math.min(Math.max(used, chosen ?? 0), Math.max(capFor(used), minSeats)));
}

/** Is this subscription a hand-built custom deal we must not touch? */
// deno-lint-ignore no-explicit-any
export function isCustom(sub: any): boolean {
  const item = sub?.items?.data?.[0];
  const priceId = typeof item?.price === "string" ? item.price : item?.price?.id;
  const std = standardPrices();
  return sub?.metadata?.seats === "fixed" || (!!priceId && std.length > 0 && !std.includes(priceId));
}

export type SyncResult = { seats: number; billed: number | null; before: number | null; custom: boolean };

/** Counts signed-in active members and pushes the billed quantity to the Stripe subscription:
 *  the seats the owner chose, or more if more people signed in, never past the cap.
 *  Custom deals (a price that isn't one of the standard two, or metadata seats=fixed) are left alone. */
export async function syncSeats(stripe: Stripe, admin: SupabaseClient, dept: SeatDept, minSeats: number): Promise<SyncResult> {
  const seats = await countSeats(admin, dept.id);
  await admin.from("departments").update({ seat_count: seats }).eq("id", dept.id);
  const out: SyncResult = { seats, billed: null, before: null, custom: false };
  if (dept.stripe_subscription_id && ["active", "trialing", "past_due"].includes(dept.subscription_status ?? "")) {
    const sub = await stripe.subscriptions.retrieve(dept.stripe_subscription_id);
    const item = sub.items.data[0];
    if (isCustom(sub)) return { ...out, custom: true };
    const qty = targetSeats(seats, dept.seats_paid, minSeats);
    out.before = item?.quantity ?? null;
    out.billed = qty;
    if (item && item.quantity !== qty) {
      // More people: charged for the rest of the period. Fewer: the next bill is lower, no credit back.
      await stripe.subscriptions.update(sub.id, {
        items: [{ id: item.id, quantity: qty }],
        proration_behavior: qty > (item.quantity ?? 0) ? "create_prorations" : "none",
      });
    }
    await admin.from("departments").update({ seats_billed: qty }).eq("id", dept.id);
  }
  return out;
}
