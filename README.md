# Fire Ground Board

Live PAR accountability for fire departments. Everyone on scene shows up on one board with their status, unit and time in. Officers call a PAR and see who has confirmed in real time.

By MKE Group Inc.

## What's in here

```
web/                 The app. Plain HTML, CSS and JS. No build step.
  js/api.js          Talks to Supabase
  js/demo.js         Fake department for demo mode (/?demo)
  js/board.js        Incident board, PAR, chat, map
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

## How billing works

- Every new department gets 7 days free. No card needed.
- After that it's $10 CAD a month or $99 CAD a year per member, no minimum. Only people who use the app count. Roster-only names are free.
- The owner pays on the web by card (monthly or yearly), or yearly by emailed invoice (net 30) for departments that pay by cheque or EFT.
- Seats update in Stripe when people join or leave, and a nightly job double checks.
- If the trial ends or a payment is more than 14 days overdue, the department goes read-only. Nothing is deleted. Active incidents can always be closed.

## Security in short

- Sign-in is by one-time email code. No passwords stored for normal accounts.
- Every table has row level security. A department can never see another's data (66 automated checks).
- Medical info is visible only to the person and their officers.
- Billing status can only be changed by Stripe's signed webhook.
- Invite codes can't be guessed (10 wrong tries per hour), and removed people can't rejoin with the code.
- The web app runs under a strict Content Security Policy with no inline scripts, and refuses to load inside other sites.
- Billing functions only answer the app's own address.

## Setup

See [SETUP.md](SETUP.md).
