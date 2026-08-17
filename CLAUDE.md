# Kudzu Arts

Nashville-founded (2021) art consultancy and 501(c)(3) that argues for Southern artists — through advisory work, curation, design, and public programming. Named for the vine.

The practice has two halves: a fee-based consultancy (advisory, curation, identity/design, cultural strategy) and The Vine, the non-profit side that funds workshops, residencies, and public art. Consultancy fees underwrite the non-profit work.

Express app with a Postgres database, on Railway. It began as a static site;
the artist platform on top of it is real software — accounts, invites, uploads,
and Stripe payouts.

## Commands

```bash
npm install       # install dependencies
npm run dev       # local dev server → http://localhost:3000
npm start         # production (same as dev — Railway uses this)
npm run seed      # create/promote the admin accounts
```

## Architecture

```
server.js              # wiring, security headers, static serving
server/
  db.js                # pool; applies db/schema.sql on every boot
  auth.js              # scrypt passwords, sessions, single-use invites
  api.js               # the REST API
  commerce.js          # Stripe Connect, checkout, webhook, Buttondown
  oauth.js             # Google sign-in
  storage.js           # image intake — re-encodes and strips EXIF
  lumaprints.js        # print fulfilment
db/schema.sql          # tables, constraints, and the business rules
public/
  workinprogress/      # the current site (v3) — THIS IS THE LIVE ONE
  *.html               # older static pages, still served
railway.json           # Railway build/deploy config
```

`db/schema.sql` is idempotent and runs automatically on boot — there is no
migration step, but a syntax error in it will stop the server from starting.

## Business rules (enforced in the database, not just the UI)

- At most **10 published** works per artist.
- Nothing publishes unless the artist has **connected Stripe**. Disconnecting
  Stripe drops all their published work back to draft.
- No artwork can be **inserted** until the profile is complete: Stripe, profile
  photo, bio, and C.V. all present.
- Every work needs **packed weight and box size** (`ship_*` columns) to be
  uploaded, and again to be published. Not applied retroactively to works
  published before the rule existed.
- Whether an artist's *page* is public is an admin decision, separate from
  whether any individual piece is published.

## URL Routing

`server.js` implements pretty URLs: `/about` → `public/about.html`, `/work/lowndes-collection` → `public/work/lowndes-collection.html`. To add a new page, drop an `.html` file in `public/` — no routing config needed.

## Deployment

**The live site is Ian's Railway project. Use this one and only this one.**

- **Platform:** Railway, auto-deploys on push to `main`
- **Live URL:** https://kudzuarts.com
- **Workspace:** `iancatoes's Projects`
- **Project:** `energetic-vibrancy` — `f1c0b1a3-a4ab-44ea-889e-351e54884c13`
- **Environment:** production — `07ee0549-197f-48b3-af5a-38f366b428cf`
- **Services:**
  - `kudzu` — `3e355792-99f6-403a-a4a1-4ee9c708d25d` (the app; volume `kudzu-volume-cxJB` holds artwork uploads)
  - `Postgres` — `f37e571e-aa5d-4b77-9f1f-cd2422ebacde` (volume `postgres-volume`)
- **Railway URL:** https://kudzu-production.up.railway.app
- `PORT` is injected by Railway at runtime; server falls back to 3000 locally.
  `kudzuarts.com` is attached to the `kudzu` service on target port 8080.

### Do not use Andrew's project

There is a second Railway project named `kudzu` under `andrewbubis's Projects`
(`47c3b1cf-d46e-4f4f-91cc-219b62d128aa`, service `kudzu-site`). It builds from
this same repo but has no `DATABASE_URL`, no Google keys, no volume, and a dead
Postgres. It used to hold the `kudzuarts.com` domain, which is why the live site
appeared to have no working login — the domain was pointed at a gutted copy.

The domain was moved to Ian's project. **Andrew's project is abandoned. Never
read from it, deploy to it, or diagnose against it.**

## Design Files (gitignored)

`direction-1-heritage.jsx`, `direction-2-verdant.jsx`, `direction-3-editorial.jsx`, `design-canvas.jsx`, and `design-explorations.html` are design-exploration scratchpads. They are excluded from git (see `.gitignore`).

## MCP / Claude Setup

`.claude/settings.json` configures the Railway MCP server (`https://mcp.railway.com`) for infrastructure operations from within Claude Code.
