# *Kudzu*

> An art consultancy and 501(c)(3) rooted in the American South.

A small, fast, content-editable static frontend served by a tiny Express
server. No build step — edit the HTML files in `public/` and refresh.

---

## Quick start (local)

```bash
# requires Node 18+
npm install
npm start
# → http://localhost:3000
```

That's the whole thing. Every page is a real HTML file in `public/` and a
shared stylesheet in `public/css/style.css`. Edit, save, refresh.

---

## Project structure

```
.
├── public/                    ← everything that gets served
│   ├── index.html             ← home
│   ├── about.html
│   ├── services.html          ← "The Practice"
│   ├── work.html              ← portfolio index
│   ├── work/
│   │   └── lowndes-collection.html   ← sample case study
│   ├── initiatives.html       ← "The Vine" non-profit
│   ├── contact.html           ← inquiry form
│   ├── 404.html
│   ├── css/style.css          ← all design tokens & components
│   ├── js/main.js             ← nav, scroll-reveal, form handling
│   └── img/favicon.svg
├── server.js                  ← Express static server + pretty URLs
├── package.json
├── railway.json               ← Railway deploy config
├── .gitignore
└── README.md
```

---

## Deploying to Railway

1. **Push to GitHub** (see below).
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy
   from GitHub repo**, and pick this repository.
3. Railway will auto-detect Node, run `npm install`, then `npm start`.
   The `railway.json` in this repo locks that behavior in.
4. **Generate a domain** (Settings → Networking → Generate Domain), or
   point your own domain at it via CNAME.

That's it. No env vars required for the basic site.

### Setting environment variables

If/when you wire the contact form to a backend (see below), add the
relevant secrets under **Variables** in your Railway service.

---

## Pushing to GitHub

```bash
git init
git add .
git commit -m "Initial commit: kudzu site"
git branch -M main
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```

The `.gitignore` excludes `node_modules/`, env files, and the design
exploration scratchpad files at the project root. If you want the design
explorations in the repo too, remove their entries from `.gitignore`.

---

## Editing content

Every page is a self-contained HTML file. Find a heading or paragraph,
change the text, save. Repeat. No framework, no JSX, no compile step.

### Adding a new case study

1. Duplicate `public/work/lowndes-collection.html`
2. Update title, content, and image labels
3. Add a link to it from `public/work.html` and (optionally)
   `public/index.html`

### Replacing placeholder images

The striped boxes you see are CSS placeholders (`<div class="ph ...">`).
To use a real image:

```html
<!-- before -->
<div class="ph r-4x5" data-label="Studio portrait"></div>

<!-- after -->
<img src="/img/studio-portrait.jpg" alt="Studio portrait" style="width:100%; aspect-ratio: 4/5; object-fit: cover;">
```

Put real images in `public/img/` and reference them with absolute paths
(`/img/your-image.jpg`).

### Color, type, spacing

All design tokens are CSS variables at the top of `public/css/style.css`:

```css
:root {
  --forest:        #1d2a22;
  --gold:          #c8a558;
  --serif: "Spectral", …;
  --sans:  "Albert Sans", …;
  …
}
```

Change them in one place, the whole site updates.

---

## Wiring up the contact form

The inquiry form on `/contact` is built but not yet pointed at a backend.
Two easy paths:

### Option A — Use a hosted form service (no backend code)

Sign up at [Formspree](https://formspree.io), [Basin](https://usebasin.com),
or [Web3Forms](https://web3forms.com); they all give you a POST endpoint.
Then edit `public/contact.html`:

```html
<form class="form"
      data-endpoint="https://formspree.io/f/YOUR_FORM_ID"
      …>
```

The form JS will POST the form data as JSON and show the success state.

### Option B — Add a POST handler to server.js

If you want to handle submissions yourself (e.g. forward to your own
email via SendGrid/Postmark/Resend), add to `server.js`:

```js
app.use(express.json());
app.post('/api/contact', async (req, res) => {
  const { name, email, organization, topic, message } = req.body;
  // … send email, store in db, etc.
  res.json({ ok: true });
});
```

Then in `public/contact.html`, set `data-endpoint="/api/contact"`.

---

## What's placeholder vs real

This site ships with **placeholder copy** so you can see the structure.
Tour these before publishing:

- [ ] **Founding year, location, EIN** — currently "Atlanta, 2021, EIN
      pending." Update across all pages.
- [ ] **Phone, email, address** — currently `hello@kudzu.studio` /
      `(404) 555-0118`. Search/replace.
- [ ] **Team bios** on `/about` — three placeholder cards.
- [ ] **Press list** on `/about#press` — invented outlets and headlines.
- [ ] **Selected work** — invented project names; replace with real
      engagements and add case study pages for the ones you want to
      feature.
- [ ] **Statistics on `/initiatives`** — invented numbers; replace with
      your actuals.
- [ ] **Patronage tiers and pricing** on `/initiatives#patrons`.
- [ ] **Images** — every `<div class="ph">` is a placeholder; swap with
      real photography.
- [ ] **Social links** in the footer.

---

## Browser support

Modern evergreen browsers (Chrome, Safari, Firefox, Edge). Uses CSS
custom properties, `aspect-ratio`, `clamp()`, IntersectionObserver, and
modest backdrop-filter. No polyfills shipped.

### License

All rights reserved by Kudzu (replace with your actual license/copyright
notice when ready).
