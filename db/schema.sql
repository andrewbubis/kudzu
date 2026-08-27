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
  payout_ready boolean;
BEGIN
  IF NEW.status = 'published' THEN
    SELECT stripe_ready INTO payout_ready FROM artists WHERE id = NEW.artist_id;
    IF NOT COALESCE(payout_ready, false) THEN
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

-- A painting is one object. Two people can open checkout on the same
-- piece at the same moment, and without this both of them pay: nothing
-- else stands between the two Stripe sessions. The first to reach
-- checkout holds the piece; the second is told plainly that someone is
-- buying it and to try again shortly.
--
-- Held for thirty minutes, matched to the Stripe session's own expiry —
-- which is the shortest Stripe permits. Aligning them matters: a hold
-- shorter than the session would let a lapsed session still pay for a
-- piece somebody else had since started buying, which is the bug this
-- exists to prevent. The hold is released the moment the session is paid
-- or abandoned, so in practice it rarely runs its full length.
ALTER TABLE artworks ADD COLUMN IF NOT EXISTS reserved_until   timestamptz;
ALTER TABLE artworks ADD COLUMN IF NOT EXISTS reserved_session text;

-- Whether Stripe will actually let this artist take a charge and receive
-- a payout, which is not the same as having an account id.
--
-- Split out from `stripe_account` deliberately. The id used to carry
-- both meanings, and readiness was expressed by wiping it — which lost
-- the account. An artist whose ID check was still pending, or whose bank
-- wanted re-verifying, came back to an empty field, and the next click
-- opened a SECOND Express account while their sales history and any
-- pending balance sat in the first one they could no longer reach.
--
-- The id is now permanent once issued. This flag moves.
ALTER TABLE artists ADD COLUMN IF NOT EXISTS stripe_ready boolean NOT NULL DEFAULT false;

-- If an artist's payouts stop working, everything they have published
-- comes straight back down to draft.
CREATE OR REPLACE FUNCTION unpublish_on_stripe_removal() RETURNS trigger AS $$
BEGIN
  IF OLD.stripe_ready AND NOT NEW.stripe_ready THEN
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
  AFTER UPDATE OF stripe_ready ON artists
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
  SELECT stripe_ready
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

-- Has this artist signed the agreement currently in force?
--
-- True when no agreement is published at all. A site with nothing to
-- sign must not lock every artist out of their own work — the gate is
-- meant to hold artists to a document, not to punish them for one that
-- was never written.
--
-- plpgsql rather than sql, deliberately. The agreement tables are
-- defined further down this file, and a LANGUAGE sql body is parsed
-- against the catalog at the moment it is created — on a fresh database
-- that would fail before those tables exist. A plpgsql body resolves its
-- statements at call time, by which point they do.
CREATE OR REPLACE FUNCTION kudzu_agreement_signed(a_id uuid)
RETURNS boolean AS $$
DECLARE cur text;
BEGIN
  SELECT version INTO cur FROM agreement_versions WHERE is_current LIMIT 1;
  IF cur IS NULL THEN
    RETURN true;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM agreement_signatures
     WHERE artist_id = a_id AND version = cur);
END $$ LANGUAGE plpgsql STABLE;

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
    -- Listing a work is the act that puts it under the agreement
    -- (Section 1.1), so the signature has to exist before the work does.
    IF NOT kudzu_agreement_signed(NEW.artist_id) THEN
      RAISE EXCEPTION 'agreement_unsigned';
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

  -- Same narrowness as the rule above: only the moment a work goes live.
  -- A piece that was already published stays published, and an unrelated
  -- edit to it still saves — reordering a live wall must not fail because
  -- a newer version of the agreement is now in force.
  IF NEW.status = 'published'
     AND OLD.status IS DISTINCT FROM 'published'
     AND NOT kudzu_agreement_signed(NEW.artist_id) THEN
    RAISE EXCEPTION 'agreement_unsigned';
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
-- The artist agreement an artist signs, and every version of it.
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
-- Signed at the handoff on the artist's device: they sign, hand the
-- phone over, the buyer signs. An earlier design had the buyer sign on
-- their own phone via a QR code — stronger evidence in theory, but it
-- asked two strangers to coordinate two devices while holding a
-- painting. The buyer's receipt is emailed to them immediately, which is
-- both their copy and their chance to object if they never signed.
-- ── Orders ───────────────────────────────────────────────────────────
-- What was bought, by whom, and where it has to go.
--
-- This did not exist for a long time, and its absence was a real hole:
-- Stripe collected a shipping address at checkout and the webhook threw
-- it away, so an artist got told their work had sold and had no way to
-- find out where to send it. A sale you cannot fulfil is not a sale.
--
-- Kept separate from `artworks` because a work is a thing and an order is
-- an event. The address is copied in rather than joined, for the same
-- reason the bill of lading copies the title: it is a record of what was
-- true at the time, and it must not change afterwards.
CREATE TABLE IF NOT EXISTS orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artwork_id    uuid REFERENCES artworks(id) ON DELETE SET NULL,
  artist_id     uuid NOT NULL REFERENCES artists(id) ON DELETE CASCADE,

  work_title    text NOT NULL,
  work_details  text,
  price_cents   int  NOT NULL,
  currency      text NOT NULL DEFAULT 'usd',
  payout_cents  int,

  delivery      text NOT NULL DEFAULT 'ship'
                CHECK (delivery IN ('ship','pickup')),

  buyer_name    text NOT NULL,
  buyer_email   text NOT NULL,
  buyer_phone   text,

  -- Flattened rather than a JSON blob: an artist reads this off a screen
  -- while writing on a box, and every one of these lines has to be
  -- separately legible.
  ship_name     text,
  ship_line1    text,
  ship_line2    text,
  ship_city     text,
  ship_state    text,
  ship_postal   text,
  ship_country  text,

  -- The promise. Set when the order is created, ten business days out,
  -- and shown to both of them from that moment. A deadline nobody stated
  -- is a deadline nobody can miss — which sounds forgiving and is in fact
  -- how a buyer ends up filing a chargeback out of pure uncertainty.
  ship_by       date,

  -- Dispatch. The tracking number is required to reach this state, so
  -- `shipped_at IS NOT NULL` always means a real parcel with a real
  -- number behind it — which is what answers a card network months later.
  shipped_at    timestamptz,
  tracking      text,
  carrier       text,

  delivered_at  timestamptz,

  -- Set if the charge is refunded or lost to a dispute.
  refunded_at   timestamptz,
  disputed_at   timestamptz,

  stripe_session_id text UNIQUE,
  confirmation_sent_at timestamptz,
  dispatch_sent_at     timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS orders_artist_idx ON orders (artist_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_artwork_idx ON orders (artwork_id);

-- Tracking is not optional. Marking something shipped without it gives
-- the buyer nothing to look at and gives the artist nothing to prove,
-- so the database refuses the halfway state rather than trusting a form.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_shipped_needs_tracking;
ALTER TABLE orders ADD CONSTRAINT orders_shipped_needs_tracking
  CHECK (shipped_at IS NULL OR (tracking IS NOT NULL AND length(trim(tracking)) > 0));

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
  buyer_phone   text,                      -- collected at checkout

  -- The artist's city at the time of sale, so the introduction email can
  -- say where the work is without either party publishing an address.
  pickup_city   text,

  -- Short code the buyer uses to join the signing on their own phone.
  -- It identifies a session; it is not a secret that proves anything.
  join_code     text NOT NULL UNIQUE,

  -- Two forms of each signature, and both matter. The drawn mark is what
  -- a person actually made with their finger; the name is what makes the
  -- document legible and searchable when nobody can read the scrawl.
  artist_signed_at   timestamptz,
  artist_signature   text,                 -- printed name
  artist_signature_img text,               -- PNG data URL of the drawn mark
  artist_ip          text,

  buyer_signed_at    timestamptz,
  buyer_signature    text,
  buyer_signature_img text,
  buyer_ip           text,

  -- Set when both have signed. Delivery is deemed to occur here. It does
  -- not release anything: the artist was paid at checkout on this route
  -- exactly as on a shipped sale.
  completed_at  timestamptz,

  stripe_session_id  text,

  -- The money, recorded rather than gated. The buyer's payment goes
  -- straight to the artist's own Stripe account with Kudzu's commission
  -- taken as an application fee in transit, on this route exactly as on a
  -- shipped sale; Kudzu holds nothing at any point.
  --
  -- An earlier design did hold pickup payments here until both signatures
  -- existed. Dropped deliberately: it made Kudzu a custodian of artist
  -- funds, and it punished the artist when a buyer simply never turned up
  -- — they would be sitting on the work AND waiting on the money. These
  -- columns are the record of what was paid, kept against the order so a
  -- payout can't be recalculated later. `payout_transfer_id` is Stripe's
  -- id for the transfer; its presence is what stops a retry from paying
  -- twice.
  payout_cents        int,
  payout_transfer_id  text,
  payout_released_at  timestamptz,

  -- Claimed by whichever request gets there first, so a double-submit
  -- can't send two people two copies of the same receipt.
  receipt_sent_at     timestamptz,

  -- The introduction: one email addressed to both of them, which is how
  -- they meet. Claimed the same way as the receipt, because Stripe
  -- retries webhooks and nobody should be introduced twice.
  intro_sent_at       timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Added after the table shipped.
ALTER TABLE bills_of_lading ADD COLUMN IF NOT EXISTS buyer_phone   text;
ALTER TABLE bills_of_lading ADD COLUMN IF NOT EXISTS pickup_city   text;
ALTER TABLE bills_of_lading ADD COLUMN IF NOT EXISTS intro_sent_at timestamptz;

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

-- Splitting readiness out of the account id starts everyone at false.
-- Anyone already connected and selling is marked ready once, here, so the
-- deploy doesn't quietly pull every published work down to draft. From
-- then on Stripe's own webhook is the only thing that moves this flag.
DO $stripe_ready$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM kudzu_migrations WHERE name = 'backfill_stripe_ready') THEN
    UPDATE artists SET stripe_ready = true
     WHERE COALESCE(stripe_account, '') <> '' AND NOT stripe_ready;
    INSERT INTO kudzu_migrations (name) VALUES ('backfill_stripe_ready');
  END IF;
END $stripe_ready$;

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
       -- The trigger would raise on any row that fails this, and a raise
       -- here aborts the whole boot. Filter rather than risk it.
       AND kudzu_agreement_signed(w.artist_id)
       AND (SELECT count(*) FROM artworks o
             WHERE o.artist_id = w.artist_id AND o.status = 'published') < 10;

    INSERT INTO kudzu_migrations (name) VALUES ('publish_stranded_drafts');
  END IF;
END $$;

-- Track when the one-time incomplete-profile reminder was sent to an artist.
ALTER TABLE artists ADD COLUMN IF NOT EXISTS profile_reminder_sent_at timestamptz;

-- ── Page views ───────────────────────────────────────────────────────
-- Lightweight first-party analytics. No cookies, no fingerprinting —
-- just a path and an optional referrer, recorded each time the tracker
-- fires. Admin-only queries aggregate these; they are never exposed
-- publicly.
CREATE TABLE IF NOT EXISTS page_views (
  id          bigserial PRIMARY KEY,
  path        text NOT NULL,
  referrer    text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS page_views_path_idx ON page_views (path, created_at DESC);
CREATE INDEX IF NOT EXISTS page_views_created_at_idx ON page_views (created_at DESC);

-- ── Geo columns on page_views ────────────────────────────────────────
ALTER TABLE page_views ADD COLUMN IF NOT EXISTS city    text;
ALTER TABLE page_views ADD COLUMN IF NOT EXISTS region  text;
ALTER TABLE page_views ADD COLUMN IF NOT EXISTS country text;


-- ── The agreement in force ───────────────────────────────────────────
-- The document itself, published from here rather than typed into the
-- production database by hand. Two reasons: the text an artist is bound
-- to should be reviewable in the repo alongside the code that enforces
-- it, and a database that gets rebuilt should come back with the same
-- agreement rather than none.
--
-- Versioned, per the design of the table above: an artist stays bound to
-- the text they actually read. REVISING THE AGREEMENT MEANS ADDING A NEW
-- BLOCK WITH A NEW VERSION STRING — never editing the body below. Editing
-- it in place would silently rewrite what people have already signed.
DO $seed$
DECLARE v CONSTANT text := 'v1-2026-08';
BEGIN
  INSERT INTO agreement_versions (version, title, body, effective, is_current)
  VALUES (
    v,
    'Kudzu Arts LLC — Artist Sales Agreement',
    $agreement$KUDZU ARTS LLC

Artist Sales Agreement

An Arts Consultancy

――――――――――――――――――――――――――――――――――――――――――――

PARTIES

This Artist Sales Agreement (“Agreement”) is entered into as of the date of the Artist’s electronic signature below (“Effective Date”) by and between:

Kudzu Arts LLC, a Tennessee limited liability company located in Nashville, Tennessee (“Kudzu Arts” or “Gallery”); and

The individual artist identified in the signature block below, whose full legal name and address are typed by the Artist at the moment of signing and recorded with this Agreement under Section 12.7, together with the email address on the Artist’s kudzuarts.com account (“Artist”).

Kudzu Arts and Artist are each a “Party” and together the “Parties.”

RECITALS

Artist creates original works of art and fine-art prints and wishes to offer them for sale. Kudzu Arts LLC advocates for artists and wishes to promote and sell Artist’s original works and prints on the terms set out below. This Agreement governs both categories. No separate agreement is required for either.

1.  SCOPE & AUTHORIZED LISTINGS

1.1  Original Works.  This Agreement applies to each original, one-of-a-kind work the Artist uploads and lists for sale on kudzuarts.com. The act of listing an Original Work adds it to this Agreement. No separate exhibit, amendment, or countersignature is required.

1.2  Fine-Art Prints.  This Agreement also applies to each fine-art print the Artist uploads and lists for sale on kudzuarts.com. Original Works and Prints are referred to collectively as “Works.” The act of listing a Print adds it to this Agreement. No separate exhibit, amendment, or countersignature is required.

1.3  Pricing.  The Artist sets the retail price for each Work at the time of listing (“Retail Price”). That price is the authorized price. No Work shall be offered, discounted, or sold at any other price without the Artist’s agreement.

1.4  Removal.  The Artist may remove any Work from listing at any time. A removed Work ceases to be subject to this Agreement, except as provided in Section 3.5.

2.  REVENUE SPLIT & PAYMENT

Split — unchanged from prior agreements. Artist 75% of the Retail Price. Kudzu Arts 25%, retained to cover promotion, sales facilitation, and operational costs, and to underwrite Kudzu Arts’ programming.

Note: The industry standard gallery commission is typically 40–50%. Kudzu Arts’ 25% rate reflects its mission to keep the majority of proceeds with the Artist.

2.1  Method.  All payments are processed through Stripe. The Artist maintains a connected Stripe account; the Artist’s share is transferred directly to it, and Kudzu Arts’ 25% is taken in transit. Kudzu Arts does not invoice the Artist and the Artist has nothing to chase.

2.2  Shipped Works & Prints.  The buyer pays in full before the Work ships or is fulfilled. The Artist’s 75% transfers upon successful payment. Kudzu Arts does not hold these funds at any point.

2.3  Local Pickup (Original Works).  The buyer pays in full at the time of purchase, and the Artist’s 75% transfers upon successful payment exactly as with a shipped Work. Kudzu Arts does not hold these funds at any point, and is not a stakeholder or custodian of them. The Bill of Lading described in Section 4.2(a) is signed at the handoff as the Parties’ record of delivery; it is not a condition of payment.

2.4  Statements.  Kudzu Arts shall provide a sales statement for any month in which a sale occurs.

3.  EXCLUSIVITY

3.1  Scope.  While a Work is listed on kudzuarts.com, Kudzu Arts has the exclusive right to market and sell that Work. The Artist shall not offer that Work for sale through any other gallery, dealer, marketplace (including online platforms such as Etsy, Saatchi Art, or similar), or direct-to-buyer channel while it remains listed.

3.2  Removal Ends Exclusivity.  The Artist may remove a Work at any time and for any reason. Exclusivity as to that Work ends on removal.

3.3  Renewal.  Either Party may request amendment of listing terms or pricing in writing at any time. Any amendment requires written agreement of both Parties.

3.4  Post-Term.  Upon expiration or termination of this Agreement, exclusivity lapses immediately. Provisions regarding payment for sales made during the Agreement, the Good Faith obligations for Introduced Buyers in Section 7.2, and any dispute-resolution obligations survive termination.

3.5  Good Faith on Removal.  The Artist may remove a Work from listing at any time and for any reason. If a Work is removed and subsequently sold within six (6) months to a buyer who first encountered that Work through Kudzu Arts, the Artist agrees in good faith to notify Kudzu Arts and to complete the sale through Kudzu Arts, with Kudzu Arts receiving its 25% share. This obligation rests on good faith and mutual respect rather than on surveillance; Kudzu Arts trusts the Artist to honor it, as Kudzu Arts undertakes to honor its own obligations to the Artist.

4.  POSSESSION & DELIVERY — ORIGINAL WORKS

4.1  Artist Retains Possession.  Artist shall retain physical possession and title to each Original Work until a sale is fully confirmed and payment has been received in full. No Original Work is consigned to or held by Kudzu Arts at any time.

4.2  Delivery

(a) Local Pickup.  Buyer and Artist arrange the handoff directly. Kudzu Arts provides a pre-filled Bill of Lading for the sale, stating the Work, the Artist, the buyer, the Retail Price, the order number, the date, and the condition of the Work, with signature blocks for both parties. The Artist prints it; both parties sign at the handoff; the buyer keeps a copy; the Artist files a photograph or scan of the signed document against the order. Delivery is deemed to occur upon signature. The Artist has already been paid under Section 2.3; the signed document is the Parties’ record of delivery and their evidence in the event of a chargeback, not a condition of payment.

(b) Shipping.  Where local pickup is impracticable, the Work ships to the buyer. All Original Works ship signature-required and insured for the Retail Price, and the tracking number is recorded against the order. Delivery is deemed to occur upon the carrier’s confirmed signature. The Parties shall agree in writing on carrier, packaging, and cost allocation before the Work leaves the Artist’s possession.

(c) No Third Path.  An Original Work shall not change hands other than by (a) or (b). A sale with neither a signed Bill of Lading nor a carrier signature record leaves both Parties without proof of delivery and protects neither.

(d) Risk of Loss.  Risk passes to the buyer on delivery as defined above.

4.3  Artist’s Care While in Possession.  While each Original Work remains in Artist’s possession, Artist shall store and maintain it in a manner appropriate for fine art, protecting it from damage, deterioration, and theft.

4.4  Photographs & Documentation.  Artist shall provide Kudzu Arts with high-quality photographs and written descriptions of each Original Work sufficient for marketing purposes. Artist warrants that the photographs accurately represent the Work’s current condition.

5.  PRINT PRODUCTION & QUALITY

5.1  Artist’s Responsibility.  Artist is responsible for authorizing the production of, Prints of professional quality. Prints shall be produced by a pre-approved online print shop or drop-ship fulfillment service connected to kudzuarts.com. Artist shall ensure that each Print accurately reproduces the underlying original work, meets the specifications listed on kudzuarts.com and is consistent with the platform’s stated requirements.

5.2  Edition Accuracy.  Where an edition size is stated in the listing, Artist warrants that the total number of prints of that image produced in that edition does not and will not exceed the stated edition size. Artist shall number and sign each print where specified in the listing.

6.  CONDITION

6.1  Upload Warranty.  The Artist warrants that the photographs and description provided at upload accurately represent each Original Work’s current condition, including any pre-existing damage, framing, and special handling requirements. No separate written Condition Report is required.

6.2  Condition of Record.  The condition stated on the Bill of Lading or shipping record at the point of delivery is the condition of record for that sale. Any material change in condition between listing and sale shall be disclosed to the buyer before the sale is finalized.

7.  GOOD FAITH OBLIGATIONS

7.1  Kudzu Arts’ Good Faith Commitment.  Kudzu Arts agrees to promote Artist’s works in good faith and in a manner consistent with Artist’s stated artistic vision, brand, and community values. Kudzu Arts shall not misrepresent the Artist’s work, pricing, or availability, and shall act in the Artist’s best interest in all sales and marketing activities.

7.2  Artist’s Non-Circumvention Commitment.  If Kudzu Arts introduces a buyer or collector (“Introduced Buyer”) to Artist’s work and that Introduced Buyer expresses intent to purchase a Work, Artist agrees not to circumvent Kudzu Arts by completing the sale outside of kudzuarts.com for a period of six (6) months following the introduction. This commitment applies to both Original Works and Prints.

7.3  Mutual Good Faith.  Both Parties agree to deal with each other honestly, communicate promptly, and resolve disputes in the spirit of mutual respect before pursuing formal remedies.

8.  REPRESENTATIONS & WARRANTIES

Each Party represents and warrants that: (a) it has full legal authority to enter into this Agreement; (b) this Agreement does not conflict with any other agreement to which it is a party; and (c) it will perform its obligations in compliance with all applicable laws and regulations.

Artist additionally warrants that: (i) Artist is the sole creator and owner of each Work; (ii) each Work is free and clear of any liens, encumbrances, or third-party claims; (iii) the sale of each Work does not infringe any third party’s intellectual property rights; and (iv) for Prints, no third party holds any claim that would prevent Artist from granting the rights described in Section 9 below.

9.  INTELLECTUAL PROPERTY

9.1  Artist Retains Copyright.  Artist retains all copyright and intellectual property rights in each Work, notwithstanding the sale of the physical object or a Print. Sale of an Original Work conveys only the physical object to the buyer and does not transfer any reproduction rights. Sale of a Print conveys only that physical print to the buyer.

9.2  License to Kudzu Arts.  Kudzu Arts is granted a limited, non-exclusive license to use photographs and images of the Works provided by Artist solely for marketing, promotional, and sales purposes on kudzuarts.com and associated channels during the period in which those Works are listed. This license terminates when the Work is removed from listing.

9.3  No Further Exploitation.  Kudzu Arts shall not reproduce, sublicense, or commercially exploit Artist’s images beyond the scope of this Agreement without Artist’s prior written consent.

10.  DISPUTE RESOLUTION

10.1  Informal Resolution.  Before initiating any formal proceeding, the Parties agree to attempt to resolve any dispute in good faith through direct negotiation for at least thirty (30) days after written notice of the dispute.

10.2  Mediation.  If informal resolution fails, either Party may submit the dispute to non-binding mediation in Nashville, Tennessee, with costs split equally, before pursuing arbitration or litigation.

10.3  Governing Law.  This Agreement is governed by the laws of the State of Tennessee without regard to conflict-of-law principles. Venue for any legal proceeding shall lie exclusively in Nashville, Davidson County, Tennessee.

10.4  Attorney’s Fees.  In any action to enforce this Agreement, the prevailing Party shall be entitled to reasonable attorney’s fees and costs.

11.  TERMINATION

11.1  For Cause.  Either Party may terminate this Agreement immediately upon written notice if the other Party materially breaches this Agreement and fails to cure such breach within seven (7) days of receiving written notice.

11.2  For Convenience.  Either Party may terminate this Agreement without cause by providing thirty (30) days’ prior written notice, or immediately upon mutual written agreement of both Parties. Termination does not affect any sale already in process.

11.3  Effect of Termination.  Because Artist retains physical possession of all Original Works throughout the term of this Agreement, no return of works is required upon termination. On termination, Kudzu Arts shall promptly cancel any pending unfulfilled Print orders as of the termination date. Any sale in process at the time of termination shall be completed on the terms of this Agreement.

12.  GENERAL PROVISIONS

12.1  Entire Agreement.  This Agreement constitutes the entire agreement between the Parties regarding its subject matter and supersedes all prior discussions, representations, and agreements, including any separate Original Work Sales Agreement or Print Sales Agreement previously signed.

12.2  Amendments.  No amendment is effective unless in writing and signed by authorized representatives of both Parties.

12.3  No Waiver.  Failure to enforce any provision shall not constitute a waiver of the right to enforce it in the future.

12.4  Severability.  If any provision is held unenforceable, the remaining provisions continue in full force.

12.5  Notices.  All notices under this Agreement shall be in writing and delivered by email with read-receipt confirmation or by certified mail to the addresses set out in the signature block below.

12.6  Independent Contractor.  The Parties are independent contractors. Nothing in this Agreement creates an employment, partnership, or joint-venture relationship.

12.7  Electronic Signature.  This Agreement may be executed in counterparts, including electronic or PDF signature, each of which shall be deemed an original. The Artist’s act of typing their full legal name into the signature field on kudzuarts.com and submitting the agreement form constitutes a valid and binding electronic signature to the same extent as a handwritten signature. Kudzu Arts records the Artist’s full legal name, address, the exact version of the agreement, timestamp, IP address, and browser at the moment of signing. Existing artists remain bound to the version they signed and may be asked to sign a revised version when this Agreement is updated.

SIGNATURES

By signing below, the Parties agree to the terms of this Agreement as of the Effective Date.

Kudzu Arts LLC · Nashville, Tennessee · kudzuarts.com

KUDZU ARTS LLC — executed
Signature: /s/ Ian Cato
Name: Ian Cato
Title: Member, Kudzu Arts LLC
Date: August 26, 2026
Email: andrewbubis@gmail.com and iancatoes@gmail.com

Executed by Kudzu Arts LLC as of the effective date of this version and
standing for every Artist who countersigns it. Kudzu Arts LLC is
member-managed; the signatory above is a Member with authority to bind
the Company.

ARTIST — completed at signing on kudzuarts.com
Full legal name: [typed by Artist]
Address: [typed by Artist]
Email: [from account]
Signature: [typed full legal name]
Date: [recorded automatically]$agreement$,
    DATE '2026-08-26',
    false
  )
  ON CONFLICT (version) DO NOTHING;

  -- Exactly one row may carry is_current (agreement_one_current), so the
  -- old one has to be stood down before the new one is raised.
  UPDATE agreement_versions SET is_current = false
   WHERE is_current AND version <> v;
  UPDATE agreement_versions SET is_current = true
   WHERE version = v AND NOT is_current;
END $seed$;
