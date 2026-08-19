# kudzuarts.com — custom domain won't verify on Railway

**Status:** unresolved, ~36 hours. The app is healthy and serving; only the
custom domain is broken.

**Working URL:** https://kudzu-production.up.railway.app
**Broken URL:** https://kudzuarts.com

---

## The one-line version

Railway's Networking panel has said **"Waiting for DNS update"** for over a day.
The DNS it's waiting for is verifiably published worldwide. Railway's check is
either looking at something we can't see, or it's stuck.

---

## Setup

| | |
|---|---|
| Host | Railway |
| Project | `energetic-vibrancy` (workspace: iancatoes's Projects, Hobby plan) |
| Service | `kudzu` — Node/Express, healthy, deploys green |
| Custom domain | `kudzuarts.com`, target port **8080** |
| Railway-issued target | `xw2mwhhq.up.railway.app` |
| Registrar / DNS | Namecheap, **BasicDNS** nameservers |
| DNSSEC | off |

The app itself is fine. Logs on every deploy:

```
kudzu · database ready
kudzu · listening on http://localhost:8080
```

Port 8080 matches the custom domain's target port.

---

## What Railway asks for, and what's published

Railway's "Configure DNS Records" dialog shows:

| Type | Host | Value | Railway's status |
|---|---|---|---|
| CNAME | `@` | `xw2mwhhq.up.railway.app` | ✅ green check |
| TXT | `_railway-verify` | `railway-verify=593c733e5f3fe2dfcf31bba69…` | ⚠️ warning |

**Both are published and confirmed propagated**, verified on dnschecker.org from
Google, OpenDNS, Quad9, Cloudflare, Akamai, CenturyLink, NextDNS, and non-US
resolvers:

- `_railway-verify.kudzuarts.com` TXT returns `railway-verify=593c733e5f3fe2dfcf31bba69` — **all resolvers, green across the board**
- `kudzuarts.com` resolved to `69.46.46.28` — **the same address `xw2mwhhq.up.railway.app` resolves to**, so the apex is pointing at the right place

So the record Railway flags as missing is demonstrably present globally.

---

## Current Namecheap Advanced DNS

Host Records:

| Type | Host | Value |
|---|---|---|
| CNAME | `@` | `xw2mwhhq.up.railway.app` |
| TXT | `@` | `google-site-verification=sPHxCZorKWrs…` |
| TXT | `@` | `v=spf1 include:spf.improvmx.com ~all` |
| TXT | `_railway-verify` | `railway-verify=593c733e5f…` |

Mail Settings: **Custom MX** (ImprovMX, forwarding `info@kudzuarts.com`).

Also being added for Resend (transactional email, working fine): TXT
`resend._domainkey`, MX `send`, TXT `send`, TXT `_dmarc`.

---

## What's been tried

1. **Moved the domain off a stale Railway project.** It was originally attached
   to a different, abandoned project. Removed there, added here. This is when it
   stopped serving.
2. **Removed and re-added the domain in Railway once.** Target changed
   `8ef3wcwo` → `xw2mwhhq`; the CNAME was updated to match.
3. **Switched the apex from CNAME to Namecheap ALIAS**, on the theory that a
   CNAME at the apex conflicts with the coexisting TXT and MX records (invalid
   per RFC 1034 — a CNAME is supposed to be the only record at its name). A
   records then resolved correctly to `69.46.46.28`. **Did not fix it.**
4. **Reverted to CNAME**, since that's what Railway's dialog asks for and Railway
   was already showing a green check against it. Still unverified.
5. TTL lowered to 5 minutes throughout. Waited hours between changes.

---

## The observation that doesn't fit a certificate problem

`http://kudzuarts.com` — **plain HTTP, no TLS** — also returns nothing.

A missing certificate breaks HTTPS only. Port 80 should still answer, even if
only with a Railway "application not found" page. Getting nothing on either port
suggests traffic isn't reaching Railway's edge at all, rather than reaching it
and failing TLS.

**Caveat, and it matters:** those requests were made from a sandboxed environment
with restricted egress. That environment also returns empty for URLs known to
work, so **this observation is soft** and should be re-tested with `curl -v` from
a normal machine before being trusted. Railway's own "Waiting for DNS update"
message is the only hard evidence here.

---

## Commands worth running from a normal machine

```bash
# What the apex actually returns
dig kudzuarts.com +short
dig kudzuarts.com CNAME +short
dig kudzuarts.com A +short

# The record Railway says it can't see
dig _railway-verify.kudzuarts.com TXT +short

# What Railway's own target resolves to — should match the apex
dig xw2mwhhq.up.railway.app +short

# Is anything blocking Let's Encrypt from issuing?  ← never checked
dig kudzuarts.com CAA +short
dig kudzuarts.com CAA @8.8.8.8 +short

# Does anything answer, on either port?
curl -sSv -o /dev/null http://kudzuarts.com 2>&1 | head -40
curl -sSv -o /dev/null https://kudzuarts.com 2>&1 | head -40

# Whose certificate is being presented, if any?
openssl s_client -connect kudzuarts.com:443 -servername kudzuarts.com </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates

# Authoritative answer, bypassing every cache
dig @$(dig NS kudzuarts.com +short | head -1) kudzuarts.com ANY
```

---

## Hypotheses, most to least likely

**1. Railway's verification is stuck.** DNS is provably correct and has been for
a day. Railway may have cached a failure and backed off, or the domain record got
into a bad state during the remove/re-add. Nothing on our side left to fix.

**2. A CAA record is blocking certificate issuance.** Never checked — none is
visible in Namecheap's UI, but Namecheap doesn't always surface CAA there. If one
exists and doesn't include Let's Encrypt, issuance fails silently and forever.
**Cheapest thing to rule out; check this first.**

**3. Apex CNAME coexisting with apex TXT and MX.** Technically invalid DNS.
Namecheap permits it and resolvers mostly cope, but Railway's verifier may not.
ALIAS was tried and didn't help — though it was only in place a short while, and
possibly not long enough for Railway to re-check.

**4. Something between the apex and Railway's edge.** `69.46.46.28` was confirmed
as the address `xw2mwhhq.up.railway.app` resolves to, so this seems unlikely —
but worth confirming that address is genuinely Railway's edge and not something
Namecheap returns.

---

## What would help

- Result of the `CAA` lookup
- `curl -v` output for both http:// and https:// from a real machine
- Whether the certificate presented (if any) is for a different hostname
- A second opinion on whether the apex CNAME alongside MX records is worth
  eliminating properly — moving DNS to Cloudflare would allow CNAME flattening at
  the apex and remove that whole class of problem

---

## Not urgent, but blocking a launch

Artists are being invited now and the invite links point at the
`kudzu-production.up.railway.app` URL, which works. The domain is cosmetic until
someone tries to buy something — at which point sending collectors to a
railway.app address is a real problem.
