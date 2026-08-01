'use strict';
// Standalone entry point for cPanel Cron Jobs — re-syncs the product catalog from
// the feed URL saved via the admin dashboard. Add a cron job (cPanel → Cron Jobs)
// that runs this script on whatever schedule you want (e.g. nightly):
//
//   cd /home/<user>/<app-path> && /path/to/node scripts/sync-catalog-cron.js
//
// (cPanel's Cron Jobs page shows the exact node path/command for your app.)

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { syncCatalog } = require('../src/services/catalogSync.js');

syncCatalog()
  .then(result => {
    console.log(`[catalog-sync] Synced ${result.count} products at ${new Date(result.syncedAt).toISOString()}`);
    process.exit(0);
  })
  .catch(err => {
    console.error('[catalog-sync] Failed:', err.message);
    process.exit(1);
  });
