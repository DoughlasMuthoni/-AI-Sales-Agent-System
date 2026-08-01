'use strict';
// Standalone entry point for cPanel Cron Jobs — deletes files in data/uploads/ older than the
// retention period. That folder holds customer photos/videos and quotation PDFs sent/received
// via the admin dashboard (see saveDocumentToDisk in webhook.js) — it has no automatic cleanup
// otherwise, so it grows unbounded and can eventually hit a cPanel disk quota. Age is based on
// each file's own filesystem mtime (set once at upload time and never touched again), not a
// database timestamp — simpler, and every file in this folder is write-once.
//
// Add a cron job (cPanel → Cron Jobs) that runs this script periodically (e.g. weekly):
//
//   cd /home/<user>/<app-path> && /path/to/node scripts/cleanup-uploads-cron.js
//
// (cPanel's Cron Jobs page shows the exact node path/command for your app.)
//
// Known tradeoff: a deleted file's storedAs reference may still exist in old chat history
// (a document/photo bubble whose "re-open" link will 404 once its file is gone) — that's the
// intended effect of a retention policy, not a bug.

const fs   = require('fs');
const path = require('path');

const UPLOADS_DIR    = path.join(__dirname, '..', 'data', 'uploads');
const RETENTION_DAYS = Number(process.env.UPLOADS_RETENTION_DAYS) || 180; // ~6 months

function cleanup() {
  if (!fs.existsSync(UPLOADS_DIR)) {
    console.log('[cleanup-uploads] No uploads directory found — nothing to do.');
    return { deleted: 0, kept: 0, errors: 0 };
  }

  const cutoffMs = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const entries = fs.readdirSync(UPLOADS_DIR);
  let deleted = 0, kept = 0, errors = 0;

  entries.forEach(name => {
    const filePath = path.join(UPLOADS_DIR, name);
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return;
      if (stat.mtimeMs < cutoffMs) {
        fs.unlinkSync(filePath);
        deleted++;
      } else {
        kept++;
      }
    } catch (err) {
      console.error('[cleanup-uploads] Error processing', name, '-', err.message);
      errors++;
    }
  });

  return { deleted, kept, errors };
}

const result = cleanup();
console.log(`[cleanup-uploads] Done. Deleted ${result.deleted} file(s) older than ${RETENTION_DAYS} days, kept ${result.kept}, ${result.errors} error(s).`);
process.exit(result.errors > 0 ? 1 : 0);
