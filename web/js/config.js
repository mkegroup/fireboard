// Fill these in from Supabase > Project Settings > API.
// The anon key is safe to ship in the app: row level security protects the data.
export const CONFIG = {
  SUPABASE_URL: "",
  SUPABASE_ANON_KEY: "",

  APP_URL: "https://fire.mkegroup.ca",
  SUPPORT_EMAIL: "hello@mkegroup.ca",
  // The App Store link once the iPhone app is live. Empty hides the "Get the iPhone app" card.
  APP_STORE_URL: "",
  VERSION: "2.7.3",

  // Pricing shown in the app. The real prices live in Stripe; keep these in sync
  // with the two Stripe prices on the billing function.
  PRICING: {
    monthly: 9.99, // per member who uses the app, per month
    annual: 99.99, // per member who uses the app, per year
    currency: "CAD",
    trialDays: 30,
    seatCap: 20, // most seats billed for up to capPer people. Keep in sync with SEAT_CAP.
    capPer: 60, // the cap goes up by seatCap for every this many more people. Keep in sync with PEOPLE_PER_CAP.
    quoteFrom: 60, // departments this size and counties are invited to ask for a quote
    taxNote: "plus tax",
  },

  // Dispatch email domain. Each department gets <code>@<this domain>.
  // Empty until inbound email is set up (see SETUP.md, "Dispatch email").
  INBOX_DOMAIN: "",
  // Public key for call alerts in browsers (Android, computers). Safe to share.
  // Its private half is the VAPID_PRIVATE_KEY secret in Supabase.
  WEB_PUSH_KEY: "BCfdI0UroBa1a92aXpAVDBIa_EpZR0TgfGcieGhvngH4ofZpJzD9Rx3iJZUPgoMq2S9Y5Xn6QVvjN3-NHsmq53w",

  // Google Maps (map, satellite, address lookup). Browser key from Google Cloud,
  // restricted to your site. Filled in by the deploy from the GitHub variable
  // GOOGLE_MAPS_KEY, and by Codemagic for the iPhone app.
  GOOGLE_MAPS_KEY: "",
};

export const IS_NATIVE = typeof window !== "undefined" && !!window.Capacitor?.isNativePlatform?.();
export const HAS_BACKEND = !!(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY);
