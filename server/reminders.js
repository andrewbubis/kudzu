// Scheduled jobs that nudge artists to finish their profiles.
//
// Called once per day from server.js. Using daily checks (not a 7-day
// timer) means a server restart within the window never causes a miss,
// and profile_reminder_sent_at prevents double-sends regardless of how
// often this runs.

const db   = require('./db');
const mail = require('./mail');

// Artists who registered 7+ days ago but are still missing bio, CV,
// published works, or a signed agreement, and haven't been reminded yet.
async function sendProfileReminders() {
  if (!db.isReady()) return;
  let rows;
  try {
    const { rows: r } = await db.query(`
      SELECT a.id, a.name, a.email
        FROM artists a
       WHERE a.created_at < now() - interval '7 days'
         AND a.profile_reminder_sent_at IS NULL
         AND a.is_admin = false
         AND (
               a.bio IS NULL OR trim(a.bio) = ''
            OR a.cv  IS NULL OR trim(a.cv)  = ''
            OR NOT EXISTS (
                 SELECT 1 FROM artworks w
                  WHERE w.artist_id = a.id
                    AND w.status IN ('published','draft')
               )
            -- An unsigned agreement blocks selling outright, so it is the
            -- most worth chasing of anything on this list.
            OR NOT kudzu_agreement_signed(a.id)
         )
    `);
    rows = r;
  } catch (err) {
    console.error('[reminders] query failed:', err.message);
    return;
  }

  if (!rows.length) return;
  console.log(`[reminders] sending profile nudge to ${rows.length} artist(s)`);

  for (const artist of rows) {
    try {
      await mail.notifyArtistIncompleteProfile({ name: artist.name, email: artist.email });
      await db.query(
        'UPDATE artists SET profile_reminder_sent_at = now() WHERE id = $1',
        [artist.id]
      );
      console.log('[reminders] nudged:', artist.email);
    } catch (err) {
      console.error('[reminders] failed for', artist.email, ':', err.message);
      // Continue to next artist — don't abort the whole batch.
    }
  }
}

module.exports = { sendProfileReminders };
