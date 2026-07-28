-- Kudzu Arts — artist accounts, profiles, and works.
-- Applied automatically on boot by server/db.js (idempotent).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Artists ──────────────────────────────────────────────────────────
-- One row per artist account. `slug` drives the public URL:
-- /workinprogress/artist-<slug>.html
CREATE TABLE IF NOT EXISTS artists (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text UNIQUE NOT NULL,
  password_hash   text NOT NULL,
  name            text NOT NULL,
  slug            text UNIQUE NOT NULL,

  -- profile
  photo_path      text,
  bio             text,
  cv              text,
  born_year       int,
  born_country    text,
  works_city      text,
  works_country   text,
  link_url        text,

  -- admin
  is_admin        boolean NOT NULL DEFAULT false,
  published       boolean NOT NULL DEFAULT false,  -- Ian flips this to show them publicly
  stripe_account  text,                            -- Stripe Connect account id

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ── Artworks ─────────────────────────────────────────────────────────
-- status: 'draft'     — not visible publicly, does NOT count toward the 6
--         'published' — visible, counts toward the 6
--         'sold'      — sold through the site, shown under the Sold tab
CREATE TABLE IF NOT EXISTS artworks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id   uuid NOT NULL REFERENCES artists(id) ON DELETE CASCADE,

  title       text NOT NULL,
  year        int,
  medium      text,
  dimensions  text,
  price_cents int,
  currency    text NOT NULL DEFAULT 'usd',
  for_sale    boolean NOT NULL DEFAULT true,

  image_path  text NOT NULL,
  image_w     int,
  image_h     int,

  status      text NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft','published','sold')),
  position    int  NOT NULL DEFAULT 0,   -- drag-to-reorder

  sold_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS artworks_artist_idx
  ON artworks (artist_id, status, position);

-- Hard cap: 6 PUBLISHED works per artist. Drafts are unlimited.
-- Enforced in the database so a bug in the app can't get around it.
CREATE OR REPLACE FUNCTION enforce_publish_limit() RETURNS trigger AS $$
DECLARE n int;
BEGIN
  IF NEW.status = 'published' THEN
    SELECT count(*) INTO n
      FROM artworks
     WHERE artist_id = NEW.artist_id
       AND status = 'published'
       AND id <> NEW.id;
    IF n >= 6 THEN
      RAISE EXCEPTION 'publish_limit_reached';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS artworks_publish_limit ON artworks;
CREATE TRIGGER artworks_publish_limit
  BEFORE INSERT OR UPDATE ON artworks
  FOR EACH ROW EXECUTE FUNCTION enforce_publish_limit();

-- ── Books ────────────────────────────────────────────────────────────
-- Zines, catalogues, monographs. No six-item cap — that limit is for
-- original works only.
CREATE TABLE IF NOT EXISTS books (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id   uuid NOT NULL REFERENCES artists(id) ON DELETE CASCADE,

  title       text NOT NULL,
  year        int,
  format      text,          -- Zine · Monograph · Catalogue · Artist book
  publisher   text,
  edition     text,
  price_cents int,
  currency    text NOT NULL DEFAULT 'usd',
  for_sale    boolean NOT NULL DEFAULT true,

  image_path  text NOT NULL,
  status      text NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft','published','sold')),
  position    int  NOT NULL DEFAULT 0,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS books_artist_idx ON books (artist_id, status, position);

-- ── OAuth identities ─────────────────────────────────────────────────
-- Lets one artist sign in with Google, Apple, or a password —
-- all landing on the same account.
CREATE TABLE IF NOT EXISTS identities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id   uuid NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  provider    text NOT NULL CHECK (provider IN ('google','apple')),
  subject     text NOT NULL,          -- the provider's stable user id
  email       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, subject)
);

-- ── Invites ──────────────────────────────────────────────────────────
-- Ian generates a link; it works exactly once, for one person.
-- Only the hash of the token is stored, so a database leak can't be
-- turned back into working invite links.
CREATE TABLE IF NOT EXISTS invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  text UNIQUE NOT NULL,
  email       text,                     -- optional: locks the invite to one address
  note        text,                     -- e.g. the artist's name, for Ian's list
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,              -- non-null = spent, permanently
  used_by     uuid REFERENCES artists(id) ON DELETE SET NULL,
  created_by  uuid REFERENCES artists(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS invites_open_idx
  ON invites (expires_at) WHERE used_at IS NULL;

-- ── Sessions ─────────────────────────────────────────────────────────
-- Server-side sessions. The cookie holds a random id and nothing else,
-- so it carries no information and can be revoked instantly.
CREATE TABLE IF NOT EXISTS sessions (
  id          text PRIMARY KEY,
  artist_id   uuid NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_artist_idx ON sessions (artist_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);
