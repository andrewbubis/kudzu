# Kudzo

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

## Deploying to Railway

1. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**, pick this repo.
2. Railway auto-detects Node, runs `npm install`, then `npm start`.
3. Generate a domain under Settings → Networking → Generate Domain.
