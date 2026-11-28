import type Stripe from "npm:stripe@17";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { countSeats } from "./util.ts";

// Flat yearly or monthly price per department, by size (Nov 28, 2026).
// Size = people who sign in to the app. Roster names for people without the app are free.
//   Volunteer   up to 25    $799 a year  or $79 a month
//   Department  up to 50    $1,299 a year or $129 a month
//   Large       up to 100   $1,999 a year or $199 a month
//   Over 100, and counties: custom quote.
// Keep in sync with PRICING.plans in web/js/config.js.
export const PLANS = [
  { key: "volunteer", max: 25, month: 7900, year: 79900 },
  { key: "department", max: 50, month: 12900, year: 129900 },
  { key: "large", max: 100, month: 19900, year: 199900 },
] as const;
export const QUOTE_ABOVE = PLANS[PLANS.length - 1].max;
export type Interval = "month" | "year";

/** The smallest plan that fits this many people (the largest plan past 100). */
export function planFor(people: number) {
  return PLANS.find((p) => people <= p.max) ?? PLANS[PLANS.length - 1];
}
/** A plan from its size limit (25, 50, 100), or null. */
export function planBySize(size: unknown) {
  const n = Number(size);
  return PLANS.find((p) => p.max === n) ?? null;
}
/** The bigger of two plans. */
export function bigger(a: { max: number } | null | undefined, b: { max: number }) {
  return a && a.max > b.max ? planBySize(a.max)! : planBySize(b.max)!;
}

const lookupKey = (key: string, interval: Interval) => `fgb_${key}_${interval}`;
const priceCache = new Map<string, string>();

/** The Stripe price for a plan. Made on first use under the existing Fire Ground Board product, so nothing needs setting up by hand. */
export async function priceFor(stripe: Stripe, key: string, interval: Interval): Promise<string> {
  const lk = lookupKey(key, interval);
  if (priceCache.has(lk)) return priceCache.get(lk)!;
  const found = await stripe.prices.list({ lookup_keys: [lk], active: true, limit: 1 });
  let id = found.data[0]?.id;
  if (!id) {
    const plan = PLANS.find((p) => p.key === key)!;
    const legacy = Deno.env.get("STRIPE_PRICE_ANNUAL") || Deno.env.get("STRIPE_PRICE_MONTHLY");
    let product = Deno.env.get("STRIPE_PRODUCT") || "";
    if (!product && legacy) {
      const p = await stripe.prices.retrieve(legacy);
      product = typeof p.product === "string" ? p.product : p.product.id;
    }
    if (!product) product = (await stripe.products.create({ name: "Fire Ground Board" })).id;
    const names: Record<string, string> = { volunteer: "Volunteer (up to 25)", department: "Department (up to 50)", large: "Large (up to 100)" };
    id = (await stripe.prices.create({
      product,
      currency: "cad",
      unit_amount: interval === "year" ? plan.year : plan.month,
      recurring: { interval },
      lookup_key: lk,
      nickname: `${names[key]} ${interval === "year" ? "yearly" : "monthly"}`,
      tax_behavior: "exclusive",
    })).id;
  }
  priceCache.set(lk, id);
  return id;
}

/** Which plan a Stripe price is, from its lookup key (null for old per-seat prices and custom deals). */
// deno-lint-ignore no-explicit-any
export function planOfPrice(price: any): { key: string; interval: Interval } | null {
  const m = /^fgb_(volunteer|department|large)_(month|year)$/.exec(price?.lookup_key ?? "");
  return m ? { key: m[1], interval: m[2] as Interval } : null;
}

/** Is this subscription anything other than one of the standard department plans? Those are left alone. */
// deno-lint-ignore no-explicit-any
export function isCustom(sub: any): boolean {
  const item = sub?.items?.data?.[0];
  return sub?.metadata?.seats === "fixed" || !planOfPrice(item?.price);
}

export type SeatDept = {
  id: string;
  subscription_status: string | null;
  stripe_subscription_id: string | null;
  seats_paid?: number | null; // the plan size the owner picked (25, 50 or 100)
};

/** The plan a department should be on: the one the owner picked, or bigger if more people signed in. */
export function targetPlan(people: number, chosenSize: number | null | undefined) {
  return bigger(planBySize(chosenSize), planFor(people));
}

export type SyncResult = { seats: number; billed: number | null; before: number | null; custom: boolean };

/** Counts signed-in people and moves the subscription to the right plan size.
 *  A change of size takes effect at the next renewal: no surprise mid-term charges.
 *  `billed`/`before` are plan sizes (25, 50, 100). Custom and old per-seat deals are left alone. */
export async function syncSeats(stripe: Stripe, admin: SupabaseClient, dept: SeatDept, _minSeats = 1): Promise<SyncResult> {
  const seats = await countSeats(admin, dept.id);
  await admin.from("departments").update({ seat_count: seats }).eq("id", dept.id);
  const out: SyncResult = { seats, billed: null, before: null, custom: false };
  if (dept.stripe_subscription_id && ["active", "trialing", "past_due"].includes(dept.subscription_status ?? "")) {
    const sub = await stripe.subscriptions.retrieve(dept.stripe_subscription_id);
    const item = sub.items.data[0];
    const cur = planOfPrice(item?.price);
    if (!cur || isCustom(sub)) return { ...out, custom: true };
    const want = targetPlan(seats, dept.seats_paid);
    out.before = PLANS.find((p) => p.key === cur.key)!.max;
    out.billed = want.max;
    if (item && want.key !== cur.key) {
      const price = await priceFor(stripe, want.key, cur.interval);
      await stripe.subscriptions.update(sub.id, {
        items: [{ id: item.id, price, quantity: 1 }],
        proration_behavior: "none",
        metadata: { ...sub.metadata, plan_size: String(want.max) },
      });
    }
    await admin.from("departments").update({ seats_billed: want.max }).eq("id", dept.id);
  }
  return out;
}

/** Kept for older callers: every standard plan price we know of (only used for display flags). */
export function standardPrices(): string[] {
  return [];
}
