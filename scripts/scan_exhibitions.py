#!/usr/bin/env python3
"""
Kudzu Arts — Weekly Exhibition Scanner
Checks each artist's website and Instagram for upcoming/current show announcements,
then rewrites the show-list section of exhibitions.html with discovered shows.

Run: python3 scripts/scan_exhibitions.py
Scheduled: every Monday at 8 AM via Cowork scheduled task
"""

import json
import re
import subprocess
import sys
import datetime
from pathlib import Path

# ── Artist roster ────────────────────────────────────────────────────────────

ARTISTS = [
    {"name": "Alan Chin",             "slug": "alan-chin",             "ig": "alanchinart",        "web": "https://alan-chin.com",                   "city": "Los Angeles"},
    {"name": "Ben Quinn",             "slug": "ben-quinn",             "ig": "ben__quinn",          "web": "https://www.benquinn.info",               "city": "Los Angeles"},
    {"name": "Brandon Donahue-Shipp", "slug": "brandon-donahue-shipp", "ig": "bdonahueshipp",       "web": "https://www.brandonjaquezdonahue.com",    "city": "Nashville"},
    {"name": "Daniel Herr",           "slug": "daniel-herr",           "ig": "_dherr",              "web": "https://dherr.com",                       "city": "Brooklyn"},
    {"name": "Ellie Caudill",         "slug": "ellie-caudill",         "ig": "pinkpizzza",          "web": None,                                       "city": "Nashville"},
    {"name": "Evan Christof Seeling", "slug": "evan-christof-seeling", "ig": "ecsglassdesign",      "web": "https://evanseeling.com",                 "city": "Rochester"},
    {"name": "Hans Wendel",           "slug": "hans-wendel",           "ig": "hans_gretel",         "web": None,                                       "city": "Los Angeles"},
    {"name": "Ian Patrick Cato",      "slug": "ian-patrick-cato",      "ig": "ian.pc",              "web": "https://ianpatrickcato.com",              "city": "Los Angeles"},
    {"name": "Isis Cahuas",           "slug": "isis-cahuas",           "ig": "isiscahuas",          "web": None,                                       "city": "Los Angeles"},
    {"name": "Jennie Lawless",        "slug": "jennie-lawless",        "ig": "lawlesspaint",        "web": None,                                       "city": "Los Angeles"},
    {"name": "Katya Labowe-Stoll",    "slug": "katya-labowe-stoll",    "ig": "katyalabowestoll",    "web": "https://katyalabowestoll.com",            "city": "Los Angeles"},
    {"name": "Marta Lee",             "slug": "marta-lee",             "ig": "martaleeart",         "web": "https://www.martaleeart.com",             "city": "New York"},
    {"name": "Michael Haight",        "slug": "michael-haight",        "ig": "haight.space",        "web": "https://haight.space",                    "city": "Los Angeles"},
    {"name": "Mike Chattem",          "slug": "mike-chattem",          "ig": "mikechattem",         "web": "https://mikechattem.com",                 "city": "Los Angeles"},
    {"name": "Talia Ceravolo",        "slug": "talia-ceravolo",        "ig": "taliaceravolo",       "web": "https://www.taliaceravolo.com",           "city": "Los Angeles"},
    {"name": "Wyatt Mills",           "slug": "wyatt-mills",           "ig": "wyatt.mills",         "web": "https://www.wyattmills.com",              "city": "Los Angeles"},
]

REPO_ROOT = Path(__file__).parent.parent
EXHIBITIONS_HTML = REPO_ROOT / "public" / "workinprogress" / "exhibitions.html"
SHOWS_JSON       = REPO_ROOT / "scripts" / "shows_cache.json"

# ── Show detection helpers ───────────────────────────────────────────────────

SHOW_KEYWORDS = [
    r'\bexhibition\b', r'\bshow\b', r'\bopening\b', r'\bon view\b',
    r'\bgroup show\b', r'\bsolo show\b', r'\bsolo exhibition\b',
    r'\bpresented by\b', r'\bon display\b', r'\binstallation\b',
    r'\bfeatured in\b', r'\bjoin (?:us|me)\b', r'\bnow showing\b',
]
SHOW_RE = re.compile('|'.join(SHOW_KEYWORDS), re.IGNORECASE)

DATE_RE = re.compile(
    r'\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|'
    r'Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)'
    r'\s+\d{1,2}(?:st|nd|rd|th)?(?:\s*[–\-–]\s*(?:\d{1,2}(?:st|nd|rd|th)?\s*,?\s*)?\d{0,4})?\b'
    r'|\b20\d{2}\b',
    re.IGNORECASE
)

GALLERY_RE = re.compile(
    r'\b(?:Gallery|Museum|Foundation|Center|Space|Room|Studio|Institute|Arts Center)\b',
    re.IGNORECASE
)

def fetch_text(url: str, timeout: int = 15) -> str:
    """Fetch URL text via curl (available in Railway/sandbox env)."""
    try:
        result = subprocess.run(
            ["curl", "-sL", "--max-time", str(timeout),
             "-A", "Mozilla/5.0 (compatible; KudzuArtsBot/1.0; +https://kudzuarts.com)",
             url],
            capture_output=True, text=True, timeout=timeout + 5
        )
        return result.stdout
    except Exception:
        return ""


def extract_shows_from_text(text: str, artist_name: str) -> list[dict]:
    """Find show-like mentions in plain text."""
    shows = []
    # Split into sentence-ish chunks
    chunks = re.split(r'[\n•·|]{1,}|(?<=[.!?])\s+', text)
    for chunk in chunks:
        chunk = chunk.strip()
        if len(chunk) < 20 or len(chunk) > 400:
            continue
        if not SHOW_RE.search(chunk):
            continue
        show = {
            "artist": artist_name,
            "title": None,
            "venue": None,
            "date": None,
            "city": None,
            "raw": chunk[:200],
            "status": "upcoming",
        }
        dates = DATE_RE.findall(chunk)
        if dates:
            show["date"] = dates[0]
        # Try to extract venue
        venue_m = GALLERY_RE.search(chunk)
        if venue_m:
            # grab surrounding words
            start = max(0, venue_m.start() - 40)
            show["venue"] = chunk[start:venue_m.end()].strip()
        shows.append(show)
    return shows


def scan_website(artist: dict) -> list[dict]:
    """Fetch the artist's website and look for show announcements."""
    if not artist.get("web"):
        return []
    text = fetch_text(artist["web"])
    if not text:
        return []
    # Strip HTML tags
    text = re.sub(r'<[^>]+>', ' ', text)
    text = re.sub(r'\s+', ' ', text)
    return extract_shows_from_text(text, artist["name"])


def scan_instagram_page(artist: dict) -> list[dict]:
    """
    Instagram blocks scrapers. We fetch the public profile page and extract
    whatever text appears in the initial HTML (bio, recent post previews).
    This is limited but doesn't require authentication.
    """
    ig = artist.get("ig")
    if not ig:
        return []
    url = f"https://www.instagram.com/{ig}/"
    text = fetch_text(url)
    if not text:
        return []
    # IG puts some data in JSON blobs within <script> tags
    # Extract text from those blobs
    script_texts = re.findall(r'<script[^>]*>(.*?)</script>', text, re.DOTALL)
    combined = ' '.join(script_texts[:5])  # first few scripts have metadata
    combined = re.sub(r'\\n|\\t|\\r', ' ', combined)
    combined = re.sub(r'\\u[0-9a-fA-F]{4}', '', combined)
    return extract_shows_from_text(combined, artist["name"])


def load_cache() -> dict:
    if SHOWS_JSON.exists():
        try:
            return json.loads(SHOWS_JSON.read_text())
        except Exception:
            pass
    return {"shows": [], "last_run": None}


def save_cache(data: dict):
    SHOWS_JSON.write_text(json.dumps(data, indent=2))


# ── HTML builder ─────────────────────────────────────────────────────────────

def show_row_html(show: dict) -> str:
    """Render one <a class="show-row"> from a show dict."""
    artist    = show.get("artist", "")
    title     = show.get("title") or show.get("raw", "")[:80]
    venue     = show.get("venue", "")
    date_str  = show.get("date", "—")
    city      = show.get("city") or show.get("_city", "")
    status_dot = "●" if show.get("status") == "current" else "○"
    slug      = show.get("slug", "artists.html")

    display = title if title else venue
    if venue and title and venue not in title:
        display = f"{title} — {venue}"

    return (
        f'      <a href="artist-{slug}.html" class="show-row">'
        f'<h3>{artist}</h3>'
        f'<span class="ar">{display}</span>'
        f'<span class="dt">{date_str}</span>'
        f'<span class="ci">{city}</span>'
        f'<span class="st">{status_dot}</span>'
        f'</a>'
    )


def rebuild_exhibitions_html(all_shows: list[dict]):
    """Rewrite the show-list section of exhibitions.html."""
    html = EXHIBITIONS_HTML.read_text(encoding="utf-8")

    # Build the new show rows
    rows = []
    for show in all_shows:
        rows.append(show_row_html(show))

    if not rows:
        # Keep existing rows if scan turned up nothing new
        print("No shows found this scan — keeping existing HTML unchanged.")
        return

    new_block = "\n".join(rows)
    today = datetime.date.today().strftime("%B %d, %Y")

    # Replace between the sentinel comments (or the show-list div)
    pattern = r'(<div class="show-list">)(.*?)(</div>)'
    replacement = (
        r'\1\n'
        + f'      <!-- Auto-updated {today} by scan_exhibitions.py -->\n'
        + new_block + '\n    '
        + r'\3'
    )
    new_html = re.sub(pattern, replacement, html, count=1, flags=re.DOTALL)

    if new_html == html:
        print("WARNING: show-list div not found — HTML unchanged.")
        return

    EXHIBITIONS_HTML.write_text(new_html, encoding="utf-8")
    print(f"exhibitions.html updated with {len(rows)} show rows.")


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    print(f"=== Kudzu Arts Exhibition Scanner — {datetime.datetime.now().isoformat()} ===")

    cache = load_cache()
    # Keep shows from the last 90 days as baseline
    cutoff = (datetime.date.today() - datetime.timedelta(days=90)).isoformat()
    surviving = [s for s in cache.get("shows", []) if s.get("found_date", "") >= cutoff]

    new_shows = []
    for artist in ARTISTS:
        print(f"  Scanning {artist['name']}...")
        found = []
        found += scan_website(artist)
        found += scan_instagram_page(artist)
        for s in found:
            s["slug"]       = artist["slug"]
            s["_city"]      = artist["city"]
            s["found_date"] = datetime.date.today().isoformat()
            s["source"]     = "website" if s not in found[len(scan_website(artist)):] else "instagram"
        new_shows.extend(found)
        print(f"    → {len(found)} mention(s) found")

    # Merge: de-dupe by artist+raw snippet
    seen = {(s["artist"], s.get("raw", "")[:60]) for s in surviving}
    for s in new_shows:
        key = (s["artist"], s.get("raw", "")[:60])
        if key not in seen:
            surviving.append(s)
            seen.add(key)

    # Sort: current first, then by artist name
    surviving.sort(key=lambda s: (s.get("status") != "current", s["artist"]))

    cache["shows"]    = surviving
    cache["last_run"] = datetime.datetime.now().isoformat()
    save_cache(cache)

    rebuild_exhibitions_html(surviving)

    # Commit the updated file
    try:
        subprocess.run(
            ["git", "-C", str(REPO_ROOT), "add",
             "public/workinprogress/exhibitions.html", "scripts/shows_cache.json"],
            check=True
        )
        subprocess.run(
            ["git", "-C", str(REPO_ROOT), "commit", "-m",
             f"[auto] Weekly exhibition scan — {datetime.date.today().isoformat()}"],
            check=True
        )
        subprocess.run(
            ["git", "-C", str(REPO_ROOT), "push", "origin", "main"],
            check=True
        )
        print("Git commit + push complete — site will auto-deploy.")
    except subprocess.CalledProcessError as e:
        print(f"Git step failed (manual push may be needed): {e}")

    print(f"Done. {len(surviving)} total shows in cache.")


if __name__ == "__main__":
    main()
