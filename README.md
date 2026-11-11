# Fire Ground Board

Live PAR accountability for fire departments. Everyone on scene shows up on one board with their status, unit and time in. Officers call a PAR and see who has confirmed in real time.

By MKE Group Inc.

## What's in here

```
web/                 The app. Plain HTML, CSS and JS. No build step.
  js/api.js          Talks to Supabase
  js/demo.js         Fake department for demo mode (/?demo)
  js/board.js        Incident board, PAR, map
  js/chat.js         Station chat and incident chat: photos, voice notes, reactions, replies, mentions
  js/maps.js         Google Maps, address suggestions, directions
  js/records.js      Roster, training, equipment
  js/app.js          Sign in, routing, home, department, profile
supabase/
  migrations/        Database tables and security rules
  functions/         Billing, Stripe webhook, dispatch intake, push alerts, account deletion, seat reconcile
  tests/             Security tests
.github/workflows/   fireground.yml: unpacks uploaded zips, tests, deploys, nightly seat check
ios/                 iPhone app (Capacitor). Built by Codemagic from codemagic.yaml
design/             Logo files (light, dark-screen version, badge) and old icon source
```

## Connections

- Dispatch email: forward pages to the department's address and calls start on their own, with address, call type and trucks filled in.
- Dispatch webhook for CAD systems, Zapier and Make. Messy text is read the same way.
- Group chat: new calls, PAR checks, Missing alerts and closed calls posted to Slack, Teams, Discord or Google Chat.
- Training calendar feed for Google, Outlook and Apple Calendar.
- Spreadsheet export of every incident.

## Languages

English, French and Spanish. Table in `tools/translations.py`.

## How billing works

- Every new department gets 7 days free. No card needed.
- After that it's $9.99 CAD a month or $99.99 CAD a year per member, no minimum. Only people who use the app count. Roster-only names are free.
- Capped at 20 paid members ($199.80 a month or $1,999.80 a year). Everyone after 20 is free. Change with the `SEAT_CAP` secret and `seatCap` in `web/js/config.js`.
- Counties and big departments use Get a quote on the Plan page. To set up a custom deal: in Stripe make a price for the deal, create a subscription for the department's customer with that price and metadata `dept_id` = the department id from the quote email. The webhook links it, shows "Custom plan" with the real amount, and seat syncing leaves it alone.
- The owner picks a plan on the Plan page and pays on the web by card (monthly or yearly), or yearly by emailed invoice (net 30) for departments that pay by cheque or EFT.
- Seats update in Stripe when people join or leave, and a nightly job double checks.
- If the trial ends or a payment is more than 14 days overdue, the department goes read-only. Nothing is deleted. Active incidents can always be closed.

## Security in short

- Sign-in is by one-time email code. No passwords stored for normal accounts.
- Every table has row level security. A department can never see another's data (71 automated checks).
- Medical info is visible only to the person and their officers.
- Billing status can only be changed by Stripe's signed webhook.
- Invite codes can't be guessed (10 wrong tries per hour), and removed people can't rejoin with the code.
- The web app runs under a strict Content Security Policy with no inline scripts, and refuses to load inside other sites.
- Billing functions only answer the app's own address.
- iPhone alerts go straight to Apple. No Firebase, no OneSignal. Alert tokens can't be read by anyone but the server.

## Setup

See [SETUP.md](SETUP.md).
