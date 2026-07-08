# Deploy to kudzuarts.com

Paste this into Terminal to push all changes live. Railway auto-deploys within ~2 minutes of a successful push.

```bash
rm -f /Users/andrewbubis/Documents/kudzu/.git/HEAD.lock /Users/andrewbubis/Documents/kudzu/.git/index.lock && cd /Users/andrewbubis/Documents/kudzu && git add -A && git commit -m "Update site" && git push origin main
```

## What it does
1. Clears any git lock files (needed when edits come from Cowork)
2. Stages all changed files
3. Commits with a generic message (edit the `-m "..."` part if you want a specific message)
4. Pushes to main → triggers Railway auto-deploy

## Live URLs
- **Production:** https://kudzuarts.com
- **Railway:** https://kudzu-site-production.up.railway.app
