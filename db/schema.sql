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
  published       boolean NOT NULL DEFAULT false,  -- legacy; see admin_hidden below
  stripe_account  text,                            -- Stripe Connect account id

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ── Artworks ─────────────────────────────────────────────────────────
-- status: 'draft'     — not visible publicly, does NOT count toward the 10
--         'published' — visible, counts toward the 10
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

-- Shipping: the PACKAGE, not the artwork. A 24x36in canvas crates up
-- bigger than it measures, and that crated size and weight is what a
-- carrier prices on. Kept separate from the `dimensions` text field
-- above, which is the artwork's own size as shown on the placard.
--
-- Added after the table shipped, so these are ALTERs rather than
-- columns in the CREATE above. Nullable on purpose: works uploaded
-- before this existed have no figures, and we'd rather show "shipping
-- quoted separately" than invent a weight and undercharge the artist.
-- Whether the artist will hand this piece over in person. Off by default:
-- an artist in Los Angeles shouldn't be offering Nashville pickup, and
-- pickup is the path that needs a signed document, so it should be a
-- deliberate choice rather than something everyone gets by accident.
ALTER TABLE artworks ADD COLUMN IF NOT EXISTS pickup_ok boolean NOT NULL DEFAULT false;

ALTER TABLE artworks ADD COLUMN IF NOT EXISTS ship_weight_oz int;
ALTER TABLE artworks ADD COLUMN IF NOT EXISTS ship_length_in numeric(6,2);
ALTER TABLE artworks ADD COLUMN IF NOT EXISTS ship_width_in  numeric(6,2);
ALTER TABLE artworks ADD COLUMN IF NOT EXISTS ship_depth_in  numeric(6,2);

-- Two rules, enforced here rather than in the app so no bug can slip past:
--
--   1. At most 10 PUBLISHED works per artist.
--   2. Nothing gets published at all until the artist has connected
--      their own Stripe account. Priced or not — if they can't be paid,
--      their work doesn't go up. Drafts are always allowed, so they can
--      build out a profile before connecting.
CREATE OR REPLACE FUNCTION enforce_publish_limit() RETURNS trigger AS $$
DECLARE
  n         int;
  payout_to text;
BEGIN
  IF NEW.status = 'published' THEN
    SELECT stripe_account INTO payout_to FROM artists WHERE id = NEW.artist_id;
    IF payout_to IS NULL OR payout_to = '' THEN
      RAISE EXCEPTION 'stripe_not_connected';
    END IF;

    SELECT count(*) INTO n
      FROM artworks
     WHERE artist_id = NEW.artist_id
       AND status = 'published'
       AND id <> NEW.id;
    IF n >= 10 THEN
      RAISE EXCEPTION 'publish_limit_reached';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- If an artist disconnects Stripe, everything they have published comes
-- straight back down to draft.
CREATE OR REPLACE FUNCTION unpublish_on_stripe_removal() RETURNS trigger AS $$
BEGIN
  IF (OLD.stripe_account IS NOT NULL AND OLD.stripe_account <> '')
     AND (NEW.stripe_account IS NULL OR NEW.stripe_account = '') THEN
    UPDATE artworks
       SET status = 'draft', updated_at = now()
     WHERE artist_id = NEW.id AND status = 'published';
    UPDATE books
       SET status = 'draft', updated_at = now()
     WHERE artist_id = NEW.id AND status = 'published';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS artists_stripe_removed ON artists;
CREATE TRIGGER artists_stripe_removed
  AFTER UPDATE OF stripe_account ON artists
  FOR EACH ROW EXECUTE FUNCTION unpublish_on_stripe_removal();

DROP TRIGGER IF EXISTS artworks_publish_limit ON artworks;
CREATE TRIGGER artworks_publish_limit
  BEFORE INSERT OR UPDATE ON artworks
  FOR EACH ROW EXECUTE FUNCTION enforce_publish_limit();


-- ── Profile completeness ─────────────────────────────────────────────
-- An artist has to be a finished artist before they can be a selling
-- one. Four things, all of them things a collector expects to find on
-- a page they're about to spend money on:
--
--   · a payout account, or the sale can't reach them
--   · a face, or the page reads like a placeholder
--   · a bio and a C.V., in whatever form they like — the rule is that
--     the fields aren't empty, not that they're any good
--
-- Checked at INSERT on artworks: no work goes in at all until the
-- profile is whole. That's deliberately stricter than gating publish,
-- because a half-built profile with a pile of drafts behind it is how
-- pages rot.
CREATE OR REPLACE FUNCTION kudzu_profile_ready(a_id uuid)
RETURNS boolean AS $$
  SELECT COALESCE(stripe_account, '') <> ''
     AND COALESCE(photo_path,     '') <> ''
     AND btrim(COALESCE(bio,      '')) <> ''
     AND btrim(COALESCE(cv,       '')) <> ''
    FROM artists WHERE id = a_id;
$$ LANGUAGE sql STABLE;

-- ── Who is visible ───────────────────────────────────────────────────
-- There is no approval queue. An artist's page goes public the moment
-- their profile is complete, and comes down by itself if they gut it.
-- The artist decides what the public sees by what they finish and what
-- they leave in draft — nobody waits on Kudzu to be let through.
--
-- `admin_hidden` is the one exception: a manual override for abuse, a
-- departure, or a legal problem. Default false, untouched in the normal
-- flow. The old `published` column is left in place but no longer gates
-- anything, so nothing breaks if something still reads it.
ALTER TABLE artists ADD COLUMN IF NOT EXISTS admin_hidden boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION kudzu_artist_public(a_id uuid)
RETURNS boolean AS $$
  SELECT kudzu_profile_ready(a_id)
     AND NOT COALESCE((SELECT admin_hidden FROM artists WHERE id = a_id), false);
$$ LANGUAGE sql STABLE;

-- ── How we reach an artist ───────────────────────────────────────────
-- Internal only. None of this is ever returned by the public artist
-- endpoint — a collector sees an artist's Instagram and website, never a
-- way to email them directly. This is so Kudzu can tell them a piece
-- sold, or that somebody asked about one, without them having to think
-- to log in and check.
--
-- Defaults to the address they signed up with, so nobody is blocked on a
-- decision they haven't been asked to make yet. Choosing SMS is the only
-- case that needs a new value from them.
ALTER TABLE artists ADD COLUMN IF NOT EXISTS notify_phone text;
ALTER TABLE artists ADD COLUMN IF NOT EXISTS notify_channel text
  NOT NULL DEFAULT 'email' CHECK (notify_channel IN ('email', 'sms'));

-- Reachable means: email always works (an account can't exist without
-- one), and SMS works once there's a number on file.
CREATE OR REPLACE FUNCTION kudzu_artist_reachable(a_id uuid)
RETURNS boolean AS $$
  SELECT CASE
    WHEN notify_channel = 'sms' THEN btrim(COALESCE(notify_phone, '')) <> ''
    ELSE btrim(COALESCE(email, '')) <> ''
  END
  FROM artists WHERE id = a_id;
$$ LANGUAGE sql STABLE;

-- ── Gallery photos ───────────────────────────────────────────────────
-- Not artworks. These are the studio shots, the hands-at-work pictures,
-- the detail crops — the things that make a roster feel like people
-- rather than a catalogue. They carry no price and no shipping figures,
-- so none of the artwork rules apply to them.
--
-- They surface twice: on the artist's own page, and in the pool the rest
-- of the site cycles through. An artist who adds more simply appears in
-- more places, which is the whole incentive.
CREATE TABLE IF NOT EXISTS artist_photos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id   uuid NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  image_path  text NOT NULL,
  caption     text,
  position    int  NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artist_photos_idx ON artist_photos (artist_id, position);

-- ── Shipping figures ─────────────────────────────────────────────────
-- The artist ships the work themselves, so the packed parcel has to be
-- described before the piece exists — all four figures, each positive.
-- A carrier prices the crate, not the canvas.
--
-- Enforced on INSERT, and again on any move to 'published'. NOT applied
-- retroactively: works that predate this rule stay exactly as they are
-- until someone touches them, so nobody logs in to a page that emptied
-- itself overnight.
CREATE OR REPLACE FUNCTION kudzu_has_ship_figures(w artworks)
RETURNS boolean AS $$
  SELECT w.ship_weight_oz  IS NOT NULL AND w.ship_weight_oz  > 0
     AND w.ship_length_in  IS NOT NULL AND w.ship_length_in  > 0
     AND w.ship_width_in   IS NOT NULL AND w.ship_width_in   > 0
     AND w.ship_depth_in   IS NOT NULL AND w.ship_depth_in   > 0;
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION enforce_artwork_requirements() RETURNS trigger AS $$
BEGIN
  -- INSERT is handled entirely here and returns early. OLD is unassigned
  -- during an INSERT, and plpgsql does not promise to short-circuit a
  -- boolean chain before touching it, so OLD must not appear on this path
  -- at all — reading it would abort every upload.
  IF TG_OP = 'INSERT' THEN
    IF NOT kudzu_profile_ready(NEW.artist_id) THEN
      RAISE EXCEPTION 'profile_incomplete';
    END IF;
    IF NOT kudzu_has_ship_figures(NEW) THEN
      RAISE EXCEPTION 'shipping_missing';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE from here down, so OLD is safe to read.
  --
  -- Deliberately narrow: fires when a work is being published, or when
  -- someone strips the figures off one that's already live. It does NOT
  -- fire on an unrelated edit to a work published before this rule
  -- existed — otherwise those pieces couldn't even be dragged into a new
  -- order without the save failing.
  IF NEW.status = 'published'
     AND NOT kudzu_has_ship_figures(NEW)
     AND (OLD.status IS DISTINCT FROM 'published'
          OR kudzu_has_ship_figures(OLD)) THEN
    RAISE EXCEPTION 'shipping_missing';
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS artworks_requirements ON artworks;
CREATE TRIGGER artworks_requirements
  BEFORE INSERT OR UPDATE ON artworks
  FOR EACH ROW EXECUTE FUNCTION enforce_artwork_requirements();

-- ── Books ────────────────────────────────────────────────────────────
-- Zines, catalogues, monographs. No ten-item cap — that limit is for
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

-- ── Enquiries ────────────────────────────────────────────────────────
-- A collector asking about a piece. Goes to the artist it's about, and
-- is visible to admins so Kudzu can follow up if the artist doesn't.
CREATE TABLE IF NOT EXISTS inquiries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id   uuid NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  artwork_id  uuid REFERENCES artworks(id) ON DELETE SET NULL,

  name        text NOT NULL,
  email       text NOT NULL,
  message     text NOT NULL,

  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inquiries_artist_idx
  ON inquiries (artist_id, created_at DESC);

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


-- ── Agreements ───────────────────────────────────────────────────────
-- The consignment agreement an artist signs, and every version of it.
--
-- Versioned deliberately. When the document is revised, an artist stays
-- bound to the text they actually read — nobody is retroactively held to
-- terms they never saw. Asking them to sign a new version is a new row,
-- not an edit to an old one.
CREATE TABLE IF NOT EXISTS agreement_versions (
  version     text PRIMARY KEY,           -- e.g. 'v3-2026-08'
  title       text NOT NULL,
  body        text NOT NULL,              -- the full text, markdown
  effective   date NOT NULL DEFAULT current_date,
  is_current  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Only one version can be the one we ask new artists to sign.
CREATE UNIQUE INDEX IF NOT EXISTS agreement_one_current
  ON agreement_versions (is_current) WHERE is_current;

CREATE TABLE IF NOT EXISTS agreement_signatures (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id    uuid NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  version      text NOT NULL REFERENCES agreement_versions(version),

  -- Typed by the artist at signing. Their legal name and address are
  -- what makes the agreement binding, and are collected here rather than
  -- at signup — a contract needs them, an account doesn't.
  legal_name   text NOT NULL,
  address      text NOT NULL,

  signed_at    timestamptz NOT NULL DEFAULT now(),
  ip           text,
  user_agent   text,

  UNIQUE (artist_id, version)
);

CREATE INDEX IF NOT EXISTS agreement_sig_artist_idx
  ON agreement_signatures (artist_id, signed_at DESC);

-- ── Bills of lading ──────────────────────────────────────────────────
-- The record of a hand-to-hand delivery. A shipped work has the
-- carrier's signature as independent proof; a local pickup has nothing
-- unless we make it, and without proof of delivery a chargeback is
-- simply lost.
--
-- Signed on two devices, not one. If both signatures came from the
-- seller's phone, the first thing anyone contesting it would ask is
-- whether the seller signed for the buyer. Two devices, two addresses,
-- two timestamps answers that before it's asked.
CREATE TABLE IF NOT EXISTS bills_of_lading (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artwork_id    uuid REFERENCES artworks(id) ON DELETE SET NULL,
  artist_id     uuid NOT NULL REFERENCES artists(id) ON DELETE CASCADE,

  -- Copied at creation rather than joined later: this is a record of what
  -- was agreed at the time, and it must not change if a title is edited
  -- or a work is deleted afterwards.
  work_title    text NOT NULL,
  work_details  text,                      -- medium, year, dimensions
  price_cents   int  NOT NULL,
  currency      text NOT NULL DEFAULT 'usd',
  condition     text,

  buyer_name    text NOT NULL,
  buyer_email   text NOT NULL,

  -- Short code the buyer uses to join the signing on their own phone.
  -- It identifies a session; it is not a secret that proves anything.
  join_code     text NOT NULL UNIQUE,

  artist_signed_at   timestamptz,
  artist_signature   text,                 -- typed name
  artist_ip          text,

  buyer_signed_at    timestamptz,
  buyer_signature    text,
  buyer_ip           text,

  -- Set when both have signed. Delivery is deemed to occur here, and
  -- this is what releases the held payout.
  completed_at  timestamptz,

  stripe_session_id  text,

  -- The money. For a pickup sale the payment lands in Kudzu's Stripe
  -- balance rather than going straight to the artist, and sits there
  -- until both signatures exist. `payout_transfer_id` is Stripe's id for
  -- the transfer that released it — its presence is what stops a retry
  -- from paying twice.
  payout_cents        int,
  payout_transfer_id  text,
  payout_released_at  timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bol_artist_idx ON bills_of_lading (artist_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bol_code_idx   ON bills_of_lading (join_code);

-- Both signatures present means the handoff is done. Enforced here so a
-- half-signed document can never be treated as proof of delivery.
CREATE OR REPLACE FUNCTION bol_mark_complete() RETURNS trigger AS $$
BEGIN
  IF NEW.artist_signed_at IS NOT NULL
     AND NEW.buyer_signed_at IS NOT NULL
     AND NEW.completed_at IS NULL THEN
    NEW.completed_at := now();
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bol_complete ON bills_of_lading;
CREATE TRIGGER bol_complete
  BEFORE INSERT OR UPDATE ON bills_of_lading
  FOR EACH ROW EXECUTE FUNCTION bol_mark_complete();

-- ── One-off data fixes ───────────────────────────────────────────────
-- schema.sql runs on every boot, so anything that changes data rather
-- than shape needs a marker or it repeats forever.
CREATE TABLE IF NOT EXISTS kudzu_migrations (
  name       text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- Removing the publish button left existing drafts stranded: there is no
-- longer any control that could bring one out. Put up every draft that
-- would pass today's rules — complete packed figures, a finished profile
-- behind it, and room under the cap. Anything failing those stays a draft
-- and is left alone.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM kudzu_migrations WHERE name = 'publish_stranded_drafts') THEN
    UPDATE artworks w
       SET status = 'published', updated_at = now()
     WHERE w.status = 'draft'
       AND kudzu_has_ship_figures(w)
       AND kudzu_profile_ready(w.artist_id)
       AND (SELECT count(*) FROM artworks o
             WHERE o.artist_id = w.artist_id AND o.status = 'published') < 10;

    INSERT INTO kudzu_migrations (name) VALUES ('publish_stranded_drafts');
  END IF;
END $$;
