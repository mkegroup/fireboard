// Fill these in from Supabase > Project Settings > API.
// The anon key is safe to ship in the app: row level security protects the data.
export const CONFIG = {
  SUPABASE_URL: "",
  SUPABASE_ANON_KEY: "",

  APP_URL: "https://fire.mkegroup.ca",
  SUPPORT_EMAIL: "hello@mkegroup.ca",
  // The App Store link once the iPhone app is live. Empty hides the "Get the iPhone app" card.
  APP_STORE_URL: "https://apps.apple.com/app/fire-ground-board/id6833654518",
  META_PIXEL_ID: "2678746722562802", // Meta Events Manager dataset ID; empty = no pixel
  VERSION: "2.9.0",

  // Pricing shown on the website (never in the iPhone app). One flat price per department, by size.
  // The real prices live in Stripe; keep these in sync with PLANS in supabase/functions/_shared/seats.ts.
  PRICING: {
    plans: [
      { key: "volunteer", name: "Volunteer", max: 25, year: 799, month: 79 },
      { key: "department", name: "Department", max: 50, year: 1299, month: 129 },
      { key: "large", name: "Large", max: 100, year: 1999, month: 199 },
    ],
    currency: "CAD",
    trialDays: 30,
    quoteFrom: 101, // more people than the largest plan: custom quote
    foundingUntil: "2027-03-31", // sign up by then and the price is locked for 3 years
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
