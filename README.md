# PJ Garage Promo Spin V3.1

V3.1 fixes wheel/result alignment by using one coordinate system for the visual wedges, labels, pointer, and landing calculation. Prize index 0 is centered at the 12-o'clock pointer and each subsequent result is exactly 45° clockwise.

# Free Promotional Spin Wheel — Manual Credit Granting

A small server-controlled PJ Garage Promo Spin wheel for a **free, no-purchase-required** promotion. A customer opens a signed personal link and enters a first and last name. Their profile is created with **0 credits**. Promotional spin credits are granted manually from the password-protected admin dashboard.

## Current customer flow

1. Customer opens their personal signed link.
2. They enter first name and last name.
3. The backend creates their customer profile with **0 credits**.
4. The administrator opens `/admin` and grants the desired number of PJ Garage Promo Spin credits.
5. The customer can use one spin per available credit.
6. Refreshing or reopening the link never creates credits automatically.

The signed link's unique `userId` is the identity anchor. Names are for display/search only and are not used as the uniqueness check.

## Included

- First-name + last-name registration screen
- Manual administrator-granted promotional credits
- Mobile-friendly animated wheel
- Server-side cryptographic random prize selection
- Plain prize pool display without public odds
- Signed expiring personal spin URLs
- Unique claim codes for winners
- SQLite persistence using Node.js `node:sqlite`
- Password-protected admin dashboard
- Customer names visible beside spin records
- Winner claim tracking
- Messenger webhook verification endpoint
- Optional Messenger `spin` → Spin Now button flow

## Prize configuration

Edit `config.js` to change the server-side prize weights. The customer-facing page displays only the prize pool, not probabilities. Current configured rates are:

- ₱10: 30%
- ₱20: 10%
- ₱50: 2%
- ₱100: 1%
- ₱200: 0.5%
- ₱1,000: 0.1%
- ₱5,000: 0.02%
- Better luck next time: 56.38%

Expected payout is ₱10.00 per completed spin.

## Install and run locally

Requires Node.js 22.5+.

```bash
cp .env.example .env
npm start
```

Set strong values for `TOKEN_SECRET`, `BOT_SECRET`, and `ADMIN_PASSWORD` in `.env`.

## Create a test customer link

```bash
npm run create-link -- test-user-001
```

Open the generated URL. After the user registers a valid first and last name, the profile appears in the admin dashboard with 0 credits. Grant credits from `/admin`.

## Admin dashboard

Open:

```text
http://localhost:3000/admin
```

Basic Auth:

- Username: `admin`
- Password: the `ADMIN_PASSWORD` value

The dashboard shows all registered customers, lets the administrator add 1–100 credits at a time, and shows completed spins, unused credits, winners, total awards, claim codes, names, and claim status.

## Messenger integration

The included `/webhook` route can use a Messenger Page-scoped user ID as the unique `userId`.

When the user messages exactly `spin`:

1. The app receives the Messenger webhook event.
2. It creates a signed URL tied to that Page-scoped ID.
3. Messenger sends a `Spin Now` button.
4. The customer enters their first and last name on the wheel page.
5. The new Messenger user appears in the admin dashboard with 0 credits.
6. The administrator grants the desired PJ Garage Promo Spin credits manually.

Configure:

```text
META_VERIFY_TOKEN=your-own-verification-string
META_PAGE_ACCESS_TOKEN=your-page-access-token
META_PAGE_ID=your-page-id
META_GRAPH_VERSION=vXX.X
PUBLIC_BASE_URL=https://your-public-domain.example
```

## Railway deployment

Deploy the repository as a Node.js service and mount a persistent volume at:

```text
/app/data
```

The SQLite database is stored at `data/spins.sqlite`. Without persistent storage, customer identities and spin history can disappear after redeployments.

## Security and fairness notes

- Prize selection happens only on the server.
- The browser only animates to the result returned by the backend.
- Credits are never created by registration or refresh; only the password-protected admin dashboard can grant them.
- Never expose secrets or Page access tokens in frontend JavaScript.
- Use HTTPS in production.
- Keep the server-side prize configuration in `config.js` backed up and reviewed before deployment.
- Back up the database.
- Review applicable promotion rules and platform policies before public use.


## V3.2 wheel alignment fix
- Uses an explicit 8-position landing-angle table instead of computed normalized angles.
- Waits for `transitionend` before displaying the result.
- Adds `?v=3.2` cache-busting to CSS/JS references so redeployments do not reuse stale front-end assets.


## Short customer links

New links generated from `/admin` use 8-character invite codes, for example:

```text
https://spin.pjgarage.com/s/7K4M9QTX
```

The code is stored in SQLite and maps server-side to the signed invitation token. Existing long `?t=...` links remain valid for backward compatibility. Do not truncate old signed tokens manually.
