'use strict';
// Provisions a dashboard login account. No public signup route exists for this
// on purpose — run manually with server/DB access.
//
// Usage: node scripts/create-admin-user.js <email> <password>

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const db = require('../src/services/db.js');
const { hashPassword } = require('../src/services/authService.js');

async function main() {
  const [, , email, password] = process.argv;
  if (!email || !password || password.length < 8) {
    console.error('Usage: node scripts/create-admin-user.js <email> <password (8+ chars)>');
    process.exit(1);
  }

  const existing = await db.getAdminUserByEmail(email.toLowerCase());
  if (existing) {
    console.log(`Admin user "${email}" already exists (id=${existing.id}).`);
    process.exit(0);
  }

  const id = await db.createAdminUser(email.toLowerCase(), hashPassword(password));
  console.log(`Created admin user "${email}" (id=${id}). Log in at /login.`);
  process.exit(0);
}

main().catch(err => { console.error('Failed:', err); process.exit(1); });
