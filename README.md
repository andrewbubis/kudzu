# *Kudzu Arts*

> An art consultancy and 501(c)(3) rooted in the American South.

Kudzu started as a static site. It is now a small Express application with
a Postgres database behind it, because artists need to log in, upload work,
and get paid.

The public pages are still plain HTML files you can edit and refresh. The
artist platform on top of them is real software.

---

## What this repo actually contains

```
.
├── public/
│   ├── workinprogress/        ← the current site (v3) — this is the live one
│   │   ├── index.html            home
│   │   ├── artists.html          grid; swaps in real artists from the database
│   │   ├── artist.html           dynamic artist page — artist.html?a=<slug>
│   │   ├── gallery.html          virtual gallery, hung to scale
│   │   ├── printshop.html        curated print shop
│   │   ├── login.html            artist login (email, Google, Apple)
│   │   ├── signup.html           invite redemption
│   │   ├── profile.html          the artist's own dashboard
│   │   ├── invites.html          admin only — issue invite links
│   │   ├── css/                  v3.css (site), pages.css (per-page), account.css
│   │   ├── fonts/                Cardinal Alternate — print shop headline only
│   │   └── js/                   main.js, account.js, live-works.js, fields.js
│   └── *.html                 ← the older static pages, still served
├── db/schema.sql              ← tables, constraints, and the business rules
├── server/
│   ├── db.js                     pool + applies schema.sql on boot
│   ├── auth.js                   scrypt passwords, sessions, single-use invites
│   ├── api.js                    the REST API
│   ├── commerce.js               Stripe Connect, checkout, webhook, Buttondown
│   ├── oauth.js                  Google sign-in
│   ├── storage.js                image intake — re-encodes and strips EXIF
│   └── lumaprints.js             print fulfilment
├── scripts/seed-admins.js     ← creates the two admin accounts
├── server.js                  ← wiring, security headers, static serving
└── railway.json               ← deploy config
```

---

## Running it locally

```bash
npm install
cp .env.example .env      # then fill in DATABASE_URL at minimum
npm start                 # → http://localhost:3000
```

`db/schema.sql` is idempotent and runs automatically on every boot, so there
is no migration step. Starting the server against an empty database creates
the tables.

Without a `DATABASE_URL` the server still boots and serves every public page —
logins and uploads are simply switched off. That is deliberate: you can work
on the front end without running Postgres.

### Creating the admin accounts

```bash
IAN_PASSWORD=... ANDREW_PASSWORD=... npm run seed
```

Creates (or promotes) Ian and Andrew as admins. Safe to re-run; it updates
rather than duplicating. Passwords come from the environment so they never
land in the repo or your shell history.

If you skip this, the first person to sign up on an empty install becomes
admin automatically, and the server prints a one-time signup link to the
deploy logs on boot.

---

## Environment variables

Every one of these is optional except `DATABASE_URL`. Missing keys switch off
just that feature and log a line saying so — nothing crashes.

| Variable | Needed for |
| --- | --- |
| `DATABASE_URL` | **Everything.** Accounts, uploads, sales. |
| `PUBLIC_BASE_URL` | Absolute links in invites and Stripe redirects. |
| `UPLOAD_DIR` | Where artwork is written. On Railway this is the volume mount. |
| `MAX_UPLOAD_MB` | Upload ceiling. Defaults to a sane value. |
| `STRIPE_SECRET_KEY` | Payouts and checkout. |
| `STRIPE_WEBHOOK_SECRET` | Marking work sold when a payment lands. |
| `KUDZU_COMMISSION_PCT` | Kudzu's cut. Plain number, e.g. `25`. Defaults to 25. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | "Continue with Google". |
| `BUTTONDOWN_API_KEY` | Newsletter signups. |
| `LUMAPRINTS_API_KEY` / `_SECRET` / `_STORE_ID` / `_API_BASE` | Print fulfilment. |
| `PORT`, `NODE_ENV` | Set by Railway. |

---

## How the artist platform works

**It is invite only.** There is no public signup and no password reset. An
admin issues a link from `/workinprogress/invites.html`; it works exactly
once and then it is spent. Only a SHA-256 hash of each invite is stored, and
redemption happens inside a transaction with a row lock, so two people
clicking the same link cannot both get an account.

**An artist cannot list work until Stripe is connected.** This is enforced by
a Postgres trigger, not by application code, so no bug in the API can get
around it. Buyers pay the artist directly through Stripe Connect and Kudzu's
commission is taken in transit as an application fee — Kudzu never holds an
artist's money. If an artist later disconnects Stripe, everything they have
published drops back to draft automatically.

**Six published works per artist.** Also a database trigger. Drafts are
unlimited.

**Uploads are re-encoded on arrival.** Every image is decoded and re-written
through sharp, which strips EXIF — including the GPS coordinates phone
cameras attach — resizes the longest edge to 2200px, and rejects anything
that is not really an image. Nothing is ever cropped.

---

## Deploying

Railway builds from `main` and deploys within a couple of minutes of a
successful push. See `DEPLOY.md` for the one-liner.

The service needs two things beyond the environment variables above:

1. **A Postgres database** — use Railway's one-click Postgres, which comes
   with its own volume. Do not attach a bare `postgres` image with no volume;
   the data will not survive a redeploy.
2. **A separate volume for uploads**, mounted at the path you set as
   `UPLOAD_DIR`. Artwork lives on disk, not in the database.

---

## Type and colour

Design tokens are CSS variables at the top of `public/workinprogress/css/v3.css`:

```css
:root {
  --paper:  #fbfaf7;
  --ink:    #211c2a;
  --olive:  #5f5a2c;
  --serif:  "EB Garamond", Georgia, "Times New Roman", serif;
  --sans:   "EB Garamond", Georgia, "Times New Roman", serif;
}
```

The whole site is set in EB Garamond. Cardinal Alternate appears on exactly
one heading — the print shop `<h1>` — and is self-hosted from
`public/workinprogress/fonts/`. It is licensed for commercial use including
webfont embedding; see the README in that folder before adding any other face.

---

## Still outstanding

- [ ] `public/workinprogress/img/gallery-wall.jpg` — the virtual gallery wants
      a real photograph of an empty gallery wall, shot straight on, ≥2400px,
      even light, a little floor visible. It falls back gracefully until then.
- [ ] Lumaprints API credentials.
- [ ] Print shop prices are hard-coded at $40–$400; they should come from
      Lumaprints once those keys exist.
- [ ] End-to-end test of invite → signup → Stripe → upload → sale.

---

### License

All rights reserved by Kudzu Arts.
