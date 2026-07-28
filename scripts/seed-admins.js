#!/usr/bin/env node
// Create (or promote) the two admin accounts.
//
//   npm run seed
//
// Reads passwords from the environment so they never land in the repo
// or in your shell history file:
//
//   IAN_PASSWORD=... ANDREW_PASSWORD=... npm run seed
//
// Safe to run more than once — it updates rather than duplicating.

const db = require('../server/db');
const auth = require('../server/auth');

const ADMINS = [
  { name: 'Ian Patrick Cato', email: 'iancatoes@gmail.com',   envKey: 'IAN_PASSWORD' },
  { name: 'Andrew Bubis',     email: 'andrewbubis@gmail.com', envKey: 'ANDREW_PASSWORD' }
];

function randomPassword() {
  return require('crypto').randomBytes(12).toString('base64url');
}

(async function main() {
  if (!db.isConfigured()) {
    console.error('No DATABASE_URL set. Point it at your Postgres and try again.');
    process.exit(1);
  }

  await db.migrate();

  for (const admin of ADMINS) {
    const password = process.env[admin.envKey] || randomPassword();
    const generated = !process.env[admin.envKey];

    if (password.length < 10) {
      console.error(`${admin.envKey} is too short — use at least 10 characters.`);
      process.exit(1);
    }

    const hash = auth.hashPassword(password);
    const slug = auth.slugify(admin.name);

    const { rows } = await db.query(
      `INSERT INTO artists (email, password_hash, name, slug, is_admin, published)
       VALUES ($1,$2,$3,$4,true,false)
       ON CONFLICT (email) DO UPDATE
         SET is_admin = true,
             password_hash = EXCLUDED.password_hash,
             updated_at = now()
       RETURNING id, email, slug`,
      [admin.email.toLowerCase(), hash, admin.name, slug]
    );

    console.log(`✓ ${rows[0].email} — admin`);
    if (generated) {
      console.log(`  generated password: ${password}`);
      console.log('  save it now; it is not stored anywhere in readable form.');
    }
  }

  console.log('\nSign in at /workinprogress/login.html');
  process.exit(0);
})().catch((err) => {
  console.error('seed failed:', err.message);
  process.exit(1);
});
