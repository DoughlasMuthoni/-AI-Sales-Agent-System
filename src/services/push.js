'use strict';
const webpush = require('web-push');
const db      = require('./db.js');

let configured = false;

function ensureConfigured() {
  if (configured) return true;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(VAPID_SUBJECT || 'mailto:support@waterliftsolar.africa', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  configured = true;
  return true;
}

// Pushes a "new message" alert to every device subscribed on the admin dashboard
async function notifyNewMessage(from, preview) {
  if (!ensureConfigured()) return;

  const subs = await db.getAllPushSubscriptions();
  if (!subs.length) return;

  const payload = JSON.stringify({
    title: 'New WhatsApp message',
    body:  `${from}: ${preview}`.slice(0, 140),
    url:   '/admin',
  });

  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(sub, payload);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await db.deletePushSubscriptionByEndpoint(sub.endpoint).catch(() => {});
      } else {
        console.error('[push] Send failed:', err.statusCode, err.message);
      }
    }
  }));
}

module.exports = { notifyNewMessage };
