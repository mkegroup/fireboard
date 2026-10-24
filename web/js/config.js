// Fill these in from Supabase > Project Settings > API.
// The anon key is safe to ship in the app: row level security protects the data.
export const CONFIG = {
  SUPABASE_URL: "",
  SUPABASE_ANON_KEY: "",

  APP_URL: "https://fire.mkegroup.ca",
  SUPPORT_EMAIL: "hello@mkegroup.ca",
  VERSION: "2.2.0",

  // Pricing shown in the app. The real prices live in Stripe; keep these in sync
  // with the two Stripe prices on the billing function.
  PRICING: {
    monthly: 10, // per member who uses the app, per month
    annual: 99, // per member who uses the app, per year
    currency: "CAD",
    trialDays: 7,
    taxNote: "plus tax",
  },

  // Map tiles. OpenStreetMap's free tiles are fine for testing; switch to a
  // paid provider (MapTiler, Stadia, Mapbox) before charging customers.
  TILE_URL: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  TILE_ATTRIBUTION: "&copy; OpenStreetMap contributors",
};

export const IS_NATIVE = typeof window !== "undefined" && !!window.Capacitor?.isNativePlatform?.();
export const HAS_BACKEND = !!(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY);
