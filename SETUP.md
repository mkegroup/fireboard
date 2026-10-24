# Fire Ground Board: setup guide

This takes about an hour the first time. Do the steps in order.

You need accounts at: Supabase, Stripe, GitHub. All under MKE Group Inc.

---

## 1. Supabase project

1. Go to supabase.com and create a new project. Name it `fire-ground-board`. Pick the Canada (Central) region so data stays in Canada.
2. Save the database password somewhere safe. You need it in step 4.
3. Open **Project Settings > API** and copy:
   - Project URL (looks like `https://abcd1234.supabase.co`)
   - `anon` public key
   - `service_role` key (secret, never put this in the app)
4. Note the **project ref**. It's the `abcd1234` part of the URL.

### Auth settings

In **Authentication > URL Configuration**:

- Site URL: `https://fire.mkegroup.ca`
- Redirect URLs: add `https://fire.mkegroup.ca/**` and `http://localhost:8765/**`

People sign in with a 6-digit code sent to their email. No passwords, so no password resets to support.

In **Authentication > Providers > Email**:

- Email provider: on
- Confirm email: on
- Email OTP expiration: `600` seconds (10 minutes)
- Email OTP length: `6`

In **Authentication > Emails > SMTP Settings**: turn on custom SMTP. This is required, not optional. Supabase's built-in email only sends a few messages an hour, so people would stop getting codes. Any provider works (Resend is the easiest, Postmark or Amazon SES also fine). Sender: `Fire Ground Board <noreply@mkegroup.ca>`. Set up SPF and DKIM for mkegroup.ca as the provider tells you, or codes land in spam.

In **Authentication > Emails > Templates**, replace the **Magic Link** template (that's the one sign-in codes use) and the **Confirm signup** template with this. The code is what people type; the link is a backup:

```html
<h2>Your Fire Ground Board code</h2>
<p style="font-size:32px;font-weight:700;letter-spacing:6px">{{ .Token }}</p>
<p>Type this code in the app. It works for 10 minutes.</p>
<p>Didn't ask for it? Ignore this email. Nobody can sign in without the code.</p>
```

Subject for both: `{{ .Token }} is your Fire Ground Board code`

### Security settings

In **Authentication > Rate Limits**: emails sent `30` per hour, token verifications `30` per 5 minutes per IP. The defaults are fine if you're unsure.

In **Authentication > Attack Protection**: turn on **Leaked password protection** (only matters for the App Store review login). Turn on **Captcha** later if you ever see sign-up spam; you won't need it at first.

In **Project Settings > API**: leave "Expose schema" as `public` only.

Turn on **Point in time recovery** or at least daily backups (Pro plan) before your first paying department. That's your undo button if something goes wrong.

Make sure **MFA** is on for your own Supabase, Stripe, GitHub and email accounts. Those are the real keys to everything.

---

## 2. Stripe

Use **test mode** first. Switch to live mode only after a full test run (step 8).

### Product and prices

1. **Product catalog > Add product**. Name: `Fire Ground Board`.
2. Add a price: **Recurring, Per unit, Monthly, $10.00 CAD**, tax behaviour **exclusive**.
3. Add a second price on the same product: **Recurring, Per unit, Yearly, $99.00 CAD**, tax behaviour **exclusive**.
4. Copy both price IDs (`price_...`).

No minimum. A department with 3 people using the app pays for 3.

If you ever change the prices, also change `PRICING` in `web/js/config.js` so the app shows the same numbers.

Seats are counted automatically. A seat is a member who has signed in to the app. Roster-only names (people added by an officer who never made an account) are free.

### Founding department offer (optional)

**Product catalog > Coupons > New**: 50% off, duration "Once", max 20 redemptions. Add a promotion code `FOUNDING`. Departments type it at checkout. For invoice customers, apply the coupon to their subscription in the Stripe dashboard.

### Invoices

**Settings > Billing > Invoices**: add MKE Group Inc. as the business name, your HST number, and payment instructions for cheque or EFT (your bank details or mailing address). Turn on **Email finalized invoices to customers**. Departments that choose "Pay by invoice" get these emails with 30 day terms.

### Customer portal

**Settings > Billing > Customer portal**:

- Turn on: update payment method, view invoices, cancel subscription
- Turn on **switch plans**, and add both prices (monthly and yearly) so departments can switch themselves
- Turn **off**: update quantity. Seats sync on their own.
- Business info: MKE Group Inc., link to `https://fire.mkegroup.ca/terms.html` and `/privacy.html`

### Tax

Turn on **Stripe Tax**, add your HST/GST registration, and set the `STRIPE_TAX=on` secret in step 4 so tax is added to card and invoice bills. Until you're registered (under $30,000 a year in sales you don't have to be), leave `STRIPE_TAX` unset and no tax is charged.

### API key

**Developers > API keys**: copy the secret key (`sk_test_...`).

The webhook comes in step 5, after the functions are live.

---

## 3. GitHub repo

1. Create a repo, for example `mkegroup/fire-ground-board`. A private repo needs GitHub Pro (about $4 US a month) to host the site. A public repo is free and safe, since no keys or secrets are in the code, but anyone could read it.
2. Get the code in. From a phone:
   - **Add file > Create new file**. Name it `.github/workflows/fireground.yml` and paste the contents of that file. Commit.
   - **Add file > Upload files**. Upload `fire-ground-board.zip`. Commit.
   - The workflow unpacks the zip into the repo and deletes it. Takes about a minute. Later updates work the same way: upload a new zip.

   From a computer, push the unzipped folder with git or GitHub Desktop instead.

### Repo secrets

**Settings > Secrets and variables > Actions > Secrets**:

| Name | Value |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | Create at supabase.com/dashboard/account/tokens |
| `SUPABASE_DB_PASSWORD` | From step 1 |
| `SUPABASE_PROJECT_REF` | From step 1 |
| `RECONCILE_SECRET` | Any long random string. Run `openssl rand -hex 32` |

### Repo variables

Same page, **Variables** tab:

| Name | Value |
|---|---|
| `SUPABASE_URL` | Project URL from step 1 |
| `SUPABASE_ANON_KEY` | anon key from step 1 |
| `APP_DOMAIN` | `fire.mkegroup.ca` |

---

## 4. Deploy the backend

Set the function secrets once, from your computer. Install the Supabase CLI first (`brew install supabase/tap/supabase`).

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF

supabase secrets set \
  STRIPE_SECRET_KEY=sk_test_... \
  STRIPE_PRICE_MONTHLY=price_... \
  STRIPE_PRICE_ANNUAL=price_... \
  APP_URL=https://fire.mkegroup.ca \
  RECONCILE_SECRET=the-same-random-string-as-github
```

`STRIPE_WEBHOOK_SECRET` gets added in step 5.

The billing and delete-account functions only answer requests from `APP_URL` and the iOS app. If you ever serve the app from another address too, add `ALLOWED_ORIGINS=https://fire.mkegroup.ca,https://other.address,capacitor://localhost`.

Add `STRIPE_TAX=on` once Stripe Tax is set up.

Then in GitHub go to **Actions > Fire Ground Board > Run workflow**. It creates every table and deploys the five functions. After this, every push redeploys on its own. Until the secrets are set, the deploy steps skip themselves with a note instead of failing.

Check it worked: in Supabase, **Table Editor** should show `departments`, `members`, `incidents` and the rest. **Edge Functions** should list `billing`, `stripe-webhook`, `dispatch`, `delete-account`, `reconcile-seats`.

---

## 5. Stripe webhook

1. Stripe **Developers > Webhooks > Add endpoint**.
2. URL: `https://YOUR_PROJECT_REF.supabase.co/functions/v1/stripe-webhook`
3. Events:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `customer.subscription.paused`
   - `customer.subscription.resumed`
4. Copy the signing secret (`whsec_...`) and set it:

```bash
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
```

The webhook is the only thing that can mark a department as paid. The app itself can't, so nobody can fake a subscription.

---

## 6. Deploy the web app

1. GitHub repo **Settings > Pages > Source: GitHub Actions**.
2. **Actions > Fire Ground Board > Run workflow**.
3. In your DNS (wherever mkegroup.ca is managed), add a CNAME record: `fire` pointing to `mkegroup.github.io`.
4. Back in **Settings > Pages**, enter `fire.mkegroup.ca` as the custom domain and tick **Enforce HTTPS** once it's available (can take up to an hour).

Every push that changes `web/` redeploys automatically. The service worker cache name changes on each deploy, so phones pick up updates the next time they open the app.

---

## 7. Map tiles

The map uses free OpenStreetMap tiles. Their rules don't allow commercial apps with real traffic. Before you charge anyone:

1. Sign up at MapTiler (or Stadia Maps). The free tier covers early customers.
2. Get a key and restrict it to `fire.mkegroup.ca`.
3. In `web/js/config.js` change:

```js
TILE_URL: "https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key=YOUR_KEY",
TILE_ATTRIBUTION: '&copy; MapTiler &copy; OpenStreetMap contributors',
```

---

## 8. Test the whole thing before going live

Do this in Stripe test mode with two phones or two browsers.

1. Open `https://fire.mkegroup.ca`. Enter your email, type the code from the email.
2. Create a department. You should see "Free trial, 7 days left" and the setup checklist.
3. On the second device, open the invite link from Department, Share link. Enter a different email, type the code, then just your name.
4. Start an incident. Both devices should see each other's status changes within a second or two.
5. Call a PAR. Confirm on the second device. Close it.
6. Close the incident. Check the report downloads.
7. **Department > Pay monthly by card**. Pay with card `4242 4242 4242 4242`, any future date, any CVC. You should land back in the app showing "Plan set up, billing starts in 7 days". Stripe should show quantity 2 at $10.
8. On a second test department, try **Pay yearly by invoice** with your own email. The subscription shows up in Stripe with "Send invoice" at $99.
9. Remove the second member. Within a few seconds Stripe should show quantity 1. Try rejoining with the invite code on the removed device: it should be refused until you tap **Allow back**.
10. **Manage plan, card and receipts** should open the Stripe portal, where you can switch monthly and yearly.
11. Dispatch test (optional): **Department > Dispatch connection > Show connection details**, copy the address, then run:

```bash
curl -X POST 'PASTE_ADDRESS_HERE' -H 'content-type: application/json' \
  -d '{"name":"Test call","address":"1 Main St","call_type":"Alarm"}'
```

A new incident should appear on both phones.

To test what happens when a trial runs out, run this in the Supabase SQL editor:

```sql
update departments set trial_ends_at = now() - interval '1 day' where name = 'YOUR TEST DEPT';
```

The app should go read-only with a "Your free trial has ended" banner. Active incidents can still be closed.

When everything works: switch Stripe to live mode, create the same product and prices in live mode, add the live webhook, and re-run `supabase secrets set` with the live keys.

---

## 9. Running it locally

```bash
npm run serve
```

Open `http://localhost:8765`. Without keys in `config.js` it runs in demo mode only. To point it at your real project, paste the URL and anon key into `web/js/config.js` (don't commit them; the deploy fills them in).

Demo mode is always available at `/?demo`. Use it for sales calls.

### Tests

- `npm run test:db` runs 49 security checks against a local Postgres (needs `PGHOST`, `PGPORT`, `PGPASSWORD` set). They prove one department can never see or change another department's data, members can't promote themselves, medical info stays private, and expired departments can't write.
- `npm run check:fn` type-checks the edge functions (needs Deno).

GitHub runs all of these on every push.

---

## 10. Customers on the old app

The old version kept each department's data in its own Firebase project. There's no automatic move. Departments create a fresh account and department in the new app and invite their members with the new code. Old incident history stays in their Firebase console if they need it.

---

## 11. Things to decide before you charge

- **Price.** $10 CAD a month or $99 CAD a year per member with the app, no minimum, 7 day trial. It lives in Stripe and in `PRICING` in `web/js/config.js`. The trial length is in `supabase/migrations/20261023000000_pricing.sql` and `trialDays` in config. Change them together.
- **Terms and privacy.** `web/terms.html` and `web/privacy.html` are written for MKE Group Inc. in Ontario. Have a lawyer read them once. Pay attention to the safety disclaimer: this is an aid to accountability, not a replacement for a department's own PAR procedure.
- **Pilot first.** Run one real department (Combermere or similar) for a few weeks of real calls before selling to anyone else.

---

## 12. iOS app (next step)

Not built yet. The plan:

- Wrap `web/` with Capacitor, bundle ID `ca.mkegroup.fireground`.
- Build and upload with Codemagic, same as Scrub Club, under the MKE Group Inc. Apple developer account.
- No in-app purchase. The iOS app is sign-in only. The plan and billing screens are already hidden when the app runs inside Capacitor, so departments subscribe on the web. Apple allows this for business software sold to organizations, but the app must not link to or mention the web checkout.
- App Store review needs a demo login, and reviewers can't read your email codes. Make one account with a password for them: in Supabase **Authentication > Users > Add user**, set an email and password, tick "Auto confirm". Give it a test department with a paid status (`update departments set subscription_status = 'active' where name = 'App Review FD';`). The sign-in screen has a small "Password sign-in" link for this.
