require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const { processMessage } = require('./src/agent/pipeline.js');


const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    anthropic_key: process.env.ANTHROPIC_API_KEY ? 'SET' : 'MISSING',
    whatsapp_token: process.env.WHATSAPP_ACCESS_TOKEN ? 'SET' : 'MISSING',
    whatsapp_phone_id: process.env.WHATSAPP_PHONE_NUMBER_ID ? 'SET' : 'MISSING',
    smtp_pass: process.env.SMTP_PASS ? 'SET' : 'MISSING',
    smtp_user: process.env.SMTP_USER || 'MISSING',
    model: process.env.CLAUDE_MODEL || '(default: claude-sonnet-4-6)',
    dotenv_path: require('path').join(__dirname, '.env'),
    node_version: process.version,
  });
});

const recentMessageIds = new Map();
const DEDUP_TTL_MS = 60_000;

function isDuplicate(messageId) {
  const now = Date.now();
  if (recentMessageIds.has(messageId)) return true;
  recentMessageIds.set(messageId, now);
  for (const [id, ts] of recentMessageIds) {
    if (now - ts > DEDUP_TTL_MS) recentMessageIds.delete(id);
  }
  return false;
}

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('[webhook] Verification successful');
    return res.status(200).send(challenge);
  }

  console.warn('[webhook] Verification failed — token mismatch');
  res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    const value = body && body.entry && body.entry[0] &&
                  body.entry[0].changes && body.entry[0].changes[0] &&
                  body.entry[0].changes[0].value;

    if (!value || !value.messages || !value.messages.length) return;

    const message = value.messages[0];
    const from = message.from;
    const messageId = message.id;

    if (message.type !== 'text' || !message.text || !message.text.body) {
      processMessage(from, 'I sent a non-text message. Please let me know how I can help you via text.', messageId)
        .catch((err) => console.error('[webhook] processMessage error:', err));
      return;
    }

    const messageBody = message.text.body.trim();
    if (!messageBody) return;

    if (isDuplicate(messageId)) {
      console.log('[webhook] Duplicate message ignored:', messageId);
      return;
    }

    console.log(`[webhook] Incoming message from ${from}: ${messageBody.slice(0, 80)}`);

    processMessage(from, messageBody, messageId)
      .catch((err) => console.error('[webhook] processMessage error:', err));
  } catch (err) {
    console.error('[webhook] Failed to parse webhook payload:', err);
  }
});

// Export app for LiteSpeed LSAPI
module.exports = app;

// Listen when run directly (local testing)
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`[server] AI Sales Agent running on port ${PORT}`);
  });
}
