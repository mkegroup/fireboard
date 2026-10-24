import Stripe from "npm:stripe@17";

/**
 * One Stripe client setup for every function.
 * STRIPE_API_BASE is only for local tests (points at a mock Stripe server). Never set it in production.
 */
export function makeStripe(key: string): Stripe {
  const base = Deno.env.get("STRIPE_API_BASE");
  const local = base ? new URL(base) : null;
  return new Stripe(key, {
    httpClient: Stripe.createFetchHttpClient(),
    ...(local ? { host: local.hostname, port: Number(local.port), protocol: local.protocol.replace(":", "") as "http" | "https" } : {}),
  });
}
