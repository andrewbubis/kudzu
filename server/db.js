// Postgres connection + schema bootstrap.
//
// DATABASE_URL is injected by Railway once a Postgres service is attached.
// Without it the site still runs — it just serves static pages and the
// account API reports itself as unavailable, which is what the profile
// page's demo mode expects.

const fs = require('fs');
const path = require('path');

let pool = null;
let ready = false;

function isConfigured() {
  return !!process.env.DATABASE_URL;
}

function getPool() {
  if (!isConfigured()) return null;
  if (pool) return pool;

  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Railway's internal network is already private; its managed Postgres
    // presents a self-signed cert, so verification is relaxed here only.
    ssl: process.env.DATABASE_URL.includes('railway')
      ? { rejectUnauthorized: false }
      : undefined,
    max: 8,
    idleTimeoutMillis: 30000
  });

  pool.on('error', (err) => console.error('postgres pool error:', err.message));
  return pool;
}

async function query(text, params) {
  const p = getPool();
  if (!p) throw Object.assign(new Error('db_not_configured'), { code: 'NO_DB' });
  return p.query(text, params);
}

// Run inside a transaction; rolls back on any throw.
async function tx(fn) {
  const p = getPool();
  if (!p) throw Object.assign(new Error('db_not_configured'), { code: 'NO_DB' });
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// schema.sql is written to be idempotent, so this is safe on every boot.
async function migrate() {
  if (!isConfigured()) {
    console.log('kudzu · no DATABASE_URL — accounts disabled, site runs static');
    return false;
  }
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await query(sql);
  ready = true;
  console.log('kudzu · database ready');
  return true;
}

// Sweep expired sessions and invites. Cheap; runs hourly.
async function sweep() {
  if (!ready) return;
  try {
    await query('DELETE FROM sessions WHERE expires_at < now()');
    await query('DELETE FROM invites WHERE used_at IS NULL AND expires_at < now() - interval \'30 days\'');
  } catch (err) {
    console.error('sweep failed:', err.message);
  }
}

module.exports = { isConfigured, isReady: () => ready, query, tx, migrate, sweep };
