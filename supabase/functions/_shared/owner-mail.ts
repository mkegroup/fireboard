// Emails to department owners: welcome, trial ending, trial ended, seat added,
// payment failed. Each one is recorded in owner_emails first so it only goes
// out once, even if two sweeps run at the same time.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { layout, mailConfigured, sendMail } from "./mail.ts";
import { appUrl } from "./util.ts";
import { capFor } from "./seats.ts";

type Dept = {
  id: string; name: string; invite_code: string; trial_ends_at: string; created_at: string;
  seat_count: number | null; subscription_status: string | null; stripe_subscription_id: string | null;
};
type Built = { subject: string; heading: string; paras: string[]; button?: { label: string; url: string } };

const MONTHLY = 9.99, ANNUAL = 99.99;
const money = (n: number) => `$${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
const day = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { weekday: "long", month: "long", day: "numeric", timeZone: "America/Toronto" });

/** Email addresses of the department's owners. */
export async function ownerAddresses(admin: SupabaseClient, deptId: string): Promise<{ email: string; name: string }[]> {
  const { data: owners } = await admin.from("members").select("user_id, name")
    .eq("dept_id", deptId).eq("role", "owner").eq("active", true).not("user_id", "is", null);
  const out: { email: string; name: string }[] = [];
  for (const o of owners ?? []) {
    const { data } = await admin.auth.admin.getUserById(o.user_id as string);
    const email = data?.user?.email;
    if (email) out.push({ email, name: (o.name as string) || "" });
  }
  return out;
}

/** Sends one email to a department's owners, once per (kind, ref). Returns true if it went out now. */
export async function mailOwnersOnce(admin: SupabaseClient, deptId: string, kind: string, ref: string, build: (firstName: string) => Built): Promise<boolean> {
  if (!mailConfigured()) return false;
  const { error } = await admin.from("owner_emails").insert({ dept_id: deptId, kind, ref });
  if (error) return false; // already sent (or being sent by another sweep)
  const owners = await ownerAddresses(admin, deptId);
  let ok = owners.length > 0;
  for (const o of owners) {
    const b = build(o.name.split(/\s+/)[0] || "there");
    const { text, html } = layout({ heading: b.heading, paras: b.paras, button: b.button, footer: "You get these because you own this department on Fire Ground Board." });
    ok = (await sendMail({ to: o.email, subject: b.subject, text, html })) && ok;
  }
  // Didn't go out: forget the claim so the next sweep tries again.
  if (!ok) await admin.from("owner_emails").delete().eq("dept_id", deptId).eq("kind", kind).eq("ref", ref);
  return ok;
}

const priceLine = (people: number) => {
  const n = Math.max(1, Math.min(people, capFor(people)));
  return `With ${people} ${people === 1 ? "person" : "people"} signed in, that's ${money(n * MONTHLY)} a month or ${money(n * ANNUAL)} a year, plus tax.`;
};

// ---------------- the emails ----------------
export const emails = {
  welcome: (d: Dept) => (first: string): Built => ({
    subject: `${d.name} is set up on Fire Ground Board`,
    heading: `Welcome, ${first}. ${d.name} is ready.`,
    paras: [
      `Your free trial runs until ${day(d.trial_ends_at)}. No card needed until then.`,
      "Three things to do this week so your crew sees it work on a real call:",
      [
        "- Add your trucks: Department, Trucks. They become one-tap choices on every call.",
        "- Bring in your roster: Records, then the upload arrow. There's a spreadsheet template.",
        `- Send your crew the invite code ${d.invite_code}. They sign in and enter it once.`,
      ].join("\n"),
      "Then run your next call or training night on the board and call a PAR from your phone. That's when it clicks.",
      "Stuck on anything? Reply here and we'll help you set it up.",
    ],
    button: { label: "Open Fire Ground Board", url: appUrl() },
  }),

  trialSoon: (d: Dept) => (first: string): Built => ({
    subject: `Your Fire Ground Board trial ends ${day(d.trial_ends_at)}`,
    heading: `${first}, your free trial ends in 3 days`,
    paras: [
      `${d.name}'s trial ends ${day(d.trial_ends_at)}. To keep the board running on calls, pick a plan before then. Nothing is charged until the trial ends.`,
      priceLine(d.seat_count ?? 1),
      "Paying by cheque or EFT? Choose yearly, then Pay by invoice, and we'll email your treasurer an invoice due in 30 days.",
      "Need more time to get it approved? Reply and let us know.",
    ],
    button: { label: "Choose a plan", url: `${appUrl()}/#/plan` },
  }),

  trialLast: (d: Dept) => (first: string): Built => ({
    subject: "Your Fire Ground Board trial ends tomorrow",
    heading: `${first}, your trial ends tomorrow`,
    paras: [
      `After ${day(d.trial_ends_at)}, ${d.name} can't start new incidents until a plan is chosen. Your records stay safe and readable.`,
      priceLine(d.seat_count ?? 1),
    ],
    button: { label: "Choose a plan", url: `${appUrl()}/#/plan` },
  }),

  trialEnded: (d: Dept) => (first: string): Built => ({
    subject: "Your Fire Ground Board trial has ended",
    heading: `${first}, new incidents are paused`,
    paras: [
      `${d.name}'s free trial has ended. Your roster, training and records are all still there and readable, and nothing is deleted.`,
      "Choose a plan and everything turns back on right away.",
      priceLine(d.seat_count ?? 1),
      "If it wasn't the right fit, we'd really like to know why. Just reply.",
    ],
    button: { label: "Choose a plan", url: `${appUrl()}/#/plan` },
  }),

  seatAdded: (deptName: string, who: string, billed: number, interval: string | null) => (first: string): Built => {
    const each = interval === "year" ? ANNUAL : MONTHLY;
    const cost = `${money(billed * each)} ${interval === "year" ? "a year" : "a month"}`;
    return {
      subject: `${who} joined ${deptName}`,
      heading: `${first}, a seat was added`,
      paras: [
        `${who} joined ${deptName} on Fire Ground Board. You now have more people signed in than the seats you chose, so we added a seat. Nobody gets locked out of the board.`,
        `Your plan now covers ${billed} ${billed === 1 ? "seat" : "seats"}: ${cost}, plus tax. The extra seat is charged for the rest of this period on your next bill.`,
        "Not expected? Remove people in Department, then lower your seats in Plan.",
      ],
      button: { label: "Review seats", url: `${appUrl()}/#/plan` },
    };
  },

  joinRequest: (deptName: string, who: string, email: string) => (first: string): Built => ({
    subject: `${who} asked to join ${deptName}`,
    heading: `${first}, someone is waiting for approval`,
    paras: [
      `${who}${email ? ` (${email})` : ""} used your invite code to join ${deptName}. You have "New people need approval" turned on, so they can't see anything yet and they don't use a seat.`,
      "Approve them if they're on your crew. If you don't know them, decline, then make a new invite code in Department so the old one stops working.",
    ],
    button: { label: "Review in Department", url: `${appUrl()}/#/dept` },
  }),

  paymentFailed: (deptName: string, invoice: boolean) => (first: string): Built => ({
    subject: `Payment problem for ${deptName}`,
    heading: `${first}, a payment didn't go through`,
    paras: [
      invoice ? `The Fire Ground Board invoice for ${deptName} is overdue.` : `The last card payment for ${deptName} didn't go through.`,
      "The board keeps working for 14 days. After that, new incidents pause until it's paid. Records are never deleted.",
      invoice ? "Pay the invoice from the email Stripe sent, or open billing to see it." : "Open billing to update your card or pay the open invoice.",
    ],
    button: { label: "Open billing", url: `${appUrl()}/#/plan` },
  }),
};

/**
 * Sends any welcome and trial emails that are due. Safe to call often:
 * each email is claimed in owner_emails before it's sent.
 */
export async function sweepOwnerEmails(admin: SupabaseClient): Promise<{ sent: number }> {
  if (!mailConfigured()) return { sent: 0 };
  const now = Date.now();
  const H = 3600_000, D = 24 * H;
  let sent = 0;
  const cols = "id, name, invite_code, trial_ends_at, created_at, seat_count, subscription_status, stripe_subscription_id";

  // Welcome: departments made in the last 3 days.
  const { data: fresh } = await admin.from("departments").select(cols).gte("created_at", new Date(now - 3 * D).toISOString());
  for (const d of (fresh ?? []) as Dept[]) if (await mailOwnersOnce(admin, d.id, "welcome", "", emails.welcome(d))) sent++;

  // Trial emails: only departments that never set up a plan.
  const { data: trials } = await admin.from("departments").select(cols)
    .is("stripe_subscription_id", null)
    .gte("trial_ends_at", new Date(now - 3 * D).toISOString())
    .lte("trial_ends_at", new Date(now + 3 * D).toISOString());
  for (const d of (trials ?? []) as Dept[]) {
    if (["active", "trialing", "past_due"].includes(d.subscription_status ?? "")) continue;
    const left = new Date(d.trial_ends_at).getTime() - now;
    const ref = d.trial_ends_at.slice(0, 10); // a trial extended to a new date gets new reminders
    let ok = false;
    if (left <= 0) ok = await mailOwnersOnce(admin, d.id, "trial_ended", ref, emails.trialEnded(d));
    else if (left <= 30 * H) ok = await mailOwnersOnce(admin, d.id, "trial_last", ref, emails.trialLast(d));
    else ok = await mailOwnersOnce(admin, d.id, "trial_soon", ref, emails.trialSoon(d));
    if (ok) sent++;
  }
  return { sent };
}
