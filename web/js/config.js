// Fill these in from Supabase > Project Settings > API.
// The anon key is safe to ship in the app: row level security protects the data.
export const CONFIG = {
  SUPABASE_URL: "",
  SUPABASE_ANON_KEY: "",

  APP_URL: "https://fire.mkegroup.ca",
  SUPPORT_EMAIL: "hello@mkegroup.ca",
  VERSION: "2.5.0",

  // Pricing shown in the app. The real prices live in Stripe; keep these in sync
  // with the two Stripe prices on the billing function.
  PRICING: {
    monthly: 9.99, // per member who uses the app, per month
    annual: 99.99, // per member who uses the app, per year
    currency: "CAD",
    trialDays: 7,
    taxNote: "plus tax",
  },

  // Dispatch email domain. Each department gets <code>@<this domain>.
  // Empty until inbound email is set up (see SETUP.md, "Dispatch email").
  INBOX_DOMAIN: "",

  // Maps (streets and satellite) and address lookup. Public key from
  // cloud.maptiler.com, restricted to your app's address. Filled in by the
  // deploy from the GitHub variable MAPTILER_KEY.
  MAPTILER_KEY: "",
};

export const IS_NATIVE = typeof window !== "undefined" && !!window.Capacitor?.isNativePlatform?.();
export const HAS_BACKEND = !!(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY);
