# Kudzu Arts

Nashville-founded (2021) art consultancy and 501(c)(3) that argues for Southern artists — through advisory work, curation, design, and public programming. Named for the vine.

The practice has two halves: a fee-based consultancy (advisory, curation, identity/design, cultural strategy) and The Vine, the non-profit side that funds workshops, residencies, and public art. Consultancy fees underwrite the non-profit work.

Static site served via Express on Railway.

## Commands

```bash
npm install       # install dependencies
npm run dev       # local dev server → http://localhost:3000
npm start         # production (same as dev — Railway uses this)
```

## Architecture

```
server.js          # Express static server — the only backend file
public/            # All site pages (HTML/CSS/JS)
  index.html
  about.html
  contact.html
  services.html
  work.html
  initiatives.html
  404.html
  work/
    lowndes-collection.html
  css/style.css
  js/main.js
  img/favicon.svg
railway.json       # Railway build/deploy config (Nixpacks, npm start)
```

## URL Routing

`server.js` implements pretty URLs: `/about` → `public/about.html`, `/work/lowndes-collection` → `public/work/lowndes-collection.html`. To add a new page, drop an `.html` file in `public/` — no routing config needed.

## Deployment

- **Platform:** Railway, auto-deploys on push to `main`
- **Live URL:** https://kudzuarts.com
- **Railway URL:** https://kudzu-site-production.up.railway.app
- **Project ID:** `47c3b1cf-d46e-4f4f-91cc-219b62d128aa`
- `PORT` is injected by Railway at runtime; server falls back to 3000 locally

## Design Files (gitignored)

`direction-1-heritage.jsx`, `direction-2-verdant.jsx`, `direction-3-editorial.jsx`, `design-canvas.jsx`, and `design-explorations.html` are design-exploration scratchpads. They are excluded from git (see `.gitignore`).

## MCP / Claude Setup

`.claude/settings.json` configures the Railway MCP server (`https://mcp.railway.com`) for infrastructure operations from within Claude Code.
