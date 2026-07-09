'use strict';
const mysql  = require('mysql2/promise');
const crypto = require('crypto');

const pool = mysql.createPool({
  host:               process.env.DB_HOST     || 'localhost',
  user:               process.env.DB_USER,
  password:           process.env.DB_PASSWORD,
  database:           process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit:    10,
  timezone:           '+00:00',
});

function parseContent(str) {
  try { return JSON.parse(str); } catch (e) { return str; }
}

function serialize(content) {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

// ── Admin auth ────────────────────────────────────────────────────────────────

async function getAdminUserByEmail(email) {
  const [rows] = await pool.query(
    'SELECT id, email, password_hash FROM admin_users WHERE email = ? LIMIT 1',
    [email]
  );
  if (!rows[0]) return null;
  return { id: rows[0].id, email: rows[0].email, passwordHash: rows[0].password_hash };
}

async function createAdminUser(email, passwordHash) {
  const [result] = await pool.query(
    'INSERT INTO admin_users (email, password_hash) VALUES (?, ?)',
    [email, passwordHash]
  );
  return result.insertId;
}

// ── Sessions ──────────────────────────────────────────────────────────────────

async function getSession(phone) {
  const [rows] = await pool.query('SELECT * FROM sessions WHERE phone = ?', [phone]);
  if (!rows[0]) return null;
  const s = rows[0];
  return {
    domain:        s.domain,
    lastSeen:      Number(s.last_seen),
    escalated:     !!s.escalated,
    humanTakeover: !!s.human_takeover,
    adReferral:    s.ad_referral ? parseContent(s.ad_referral) : null,
  };
}

async function upsertSession(phone, session) {
  await pool.query(
    `INSERT INTO sessions (phone, domain, last_seen, escalated, human_takeover, ad_referral)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       domain         = VALUES(domain),
       last_seen      = VALUES(last_seen),
       escalated      = VALUES(escalated),
       human_takeover = VALUES(human_takeover),
       ad_referral    = VALUES(ad_referral)`,
    [
      phone,
      session.domain        || null,
      session.lastSeen,
      session.escalated     ? 1 : 0,
      session.humanTakeover ? 1 : 0,
      session.adReferral    ? serialize(session.adReferral) : null,
    ]
  );
}

// ── Messages ──────────────────────────────────────────────────────────────────

async function addMessage(phone, role, content, source = null, ts = null) {
  const [result] = await pool.query(
    'INSERT INTO messages (phone, role, content, source, ts) VALUES (?, ?, ?, ?, ?)',
    [phone, role, serialize(content), source || null, ts || Date.now()]
  );
  return result.insertId;
}

// Last `limit` messages in chronological order, orphaned tool_result trimmed
async function getApiMessages(phone, limit = 20) {
  const [rows] = await pool.query(
    `SELECT role, content FROM messages
     WHERE phone = ?
     ORDER BY ts DESC, id DESC
     LIMIT ?`,
    [phone, limit]
  );
  rows.reverse();

  let start = 0;
  while (start < rows.length) {
    const c = parseContent(rows[start].content);
    if (rows[start].role === 'user' && Array.isArray(c) && c[0]?.type === 'tool_result') {
      start++;
    } else {
      break;
    }
  }

  return rows.slice(start).map(r => ({
    role:    r.role,
    content: sanitizeForClaude(parseContent(r.content)),
  }));
}

// Claude's Messages API has a reserved native `document` content-block type (for PDF
// understanding) with its own required schema ({type:'document', source:{...}}) — it
// is NOT the same thing as the {type:'document', filename, caption} block this app
// stores when an admin sends a quotation file. Sending our shape under that reserved
// name makes Claude reject the entire request with a 400. Swap it for a plain text
// block here (Claude-facing only — the admin dashboard's own rendering reads from
// getAllSessionsWithMessages/getMessagesSinceId instead, so its rich document bubble is unaffected).
function sanitizeForClaude(content) {
  if (!Array.isArray(content)) return content;
  return content.map(block => {
    if (block?.type === 'document' && !block.source) {
      const label = block.caption ? `${block.filename} — ${block.caption}` : block.filename;
      return { type: 'text', text: `[Sent document: ${label}]` };
    }
    return block;
  });
}

// All messages for a phone (admin dashboard — no limit)
async function getAllMessages(phone) {
  const [rows] = await pool.query(
    'SELECT role, content, source, ts FROM messages WHERE phone = ? ORDER BY ts ASC, id ASC',
    [phone]
  );
  return rows.map(r => ({
    role:    r.role,
    content: parseContent(r.content),
    source:  r.source,
    ts:      Number(r.ts),
  }));
}

// Messages for a phone newer than a given message id (admin polling). Cursoring by
// id rather than ts avoids client/server clock-skew and optimistic-append-vs-poll
// race conditions that caused duplicate/missing messages in the live chat view.
async function getMessagesSinceId(phone, sinceId) {
  const [rows] = await pool.query(
    'SELECT id, role, content, source, ts FROM messages WHERE phone = ? AND id > ? ORDER BY id ASC',
    [phone, Number(sinceId)]
  );
  return rows.map(r => ({
    id:      r.id,
    role:    r.role,
    content: parseContent(r.content),
    source:  r.source,
    ts:      Number(r.ts),
  }));
}

// Lightweight sessions summary for polling (no full message history)
async function getSessionsSummary() {
  const [sessions] = await pool.query('SELECT * FROM sessions ORDER BY last_seen DESC');
  if (!sessions.length) return [];
  const phones = sessions.map(s => s.phone);
  const [lastMsgs] = await pool.query(
    `SELECT m.phone, m.role, m.content, m.source, m.ts
     FROM messages m
     INNER JOIN (SELECT phone, MAX(id) as max_id FROM messages WHERE phone IN (${phones.map(() => '?').join(',')}) GROUP BY phone) t
     ON m.phone = t.phone AND m.id = t.max_id`,
    phones
  );
  const lastMsgMap = {};
  for (const m of lastMsgs) {
    lastMsgMap[m.phone] = { role: m.role, content: parseContent(m.content), source: m.source, ts: Number(m.ts) };
  }
  return sessions.map(s => ({
    phone:         s.phone,
    domain:        s.domain,
    lastSeen:      Number(s.last_seen),
    escalated:     !!s.escalated,
    humanTakeover: !!s.human_takeover,
    adReferral:    s.ad_referral ? parseContent(s.ad_referral) : null,
    lastMessage:   lastMsgMap[s.phone] || null,
  }));
}

// All sessions with their full message history (admin dashboard)
async function getAllSessionsWithMessages() {
  const [sessions] = await pool.query('SELECT * FROM sessions ORDER BY last_seen DESC');
  const [messages] = await pool.query(
    'SELECT id, phone, role, content, source, ts FROM messages ORDER BY ts ASC, id ASC'
  );

  const msgMap = {};
  for (const m of messages) {
    if (!msgMap[m.phone]) msgMap[m.phone] = [];
    msgMap[m.phone].push({
      id:      m.id,
      role:    m.role,
      content: parseContent(m.content),
      source:  m.source,
      ts:      Number(m.ts),
    });
  }

  const result = {};
  for (const s of sessions) {
    result[s.phone] = {
      domain:        s.domain,
      lastSeen:      Number(s.last_seen),
      escalated:     !!s.escalated,
      humanTakeover: !!s.human_takeover,
      adReferral:    s.ad_referral ? parseContent(s.ad_referral) : null,
      messages:      msgMap[s.phone] || [],
    };
  }
  return result;
}

// ── Leads ─────────────────────────────────────────────────────────────────────

async function insertLead(lead) {
  const [result] = await pool.query(
    `INSERT INTO leads (name, phone, location, service, property_type, estimated_budget, notes, status, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?)`,
    [
      lead.name, lead.phone, lead.location, lead.service,
      lead.property_type, lead.estimated_budget || null, lead.notes || null,
      new Date(lead.capturedAt),
    ]
  );
  return result.insertId;
}

async function updateLead(id, lead) {
  await pool.query(
    `UPDATE leads SET name = ?, phone = ?, location = ?, service = ?, property_type = ?,
       estimated_budget = ?, notes = ? WHERE id = ?`,
    [
      lead.name, lead.phone, lead.location, lead.service,
      lead.property_type, lead.estimated_budget || null, lead.notes || null,
      id,
    ]
  );
}

async function updateLeadStatus(id, status) {
  await pool.query(
    'UPDATE leads SET status = ?, status_updated_at = NOW() WHERE id = ?',
    [status, id]
  );
}

async function getAllLeads() {
  const [rows] = await pool.query('SELECT * FROM leads ORDER BY captured_at DESC');
  return rows;
}

// ── Callbacks ─────────────────────────────────────────────────────────────────

async function insertCallback(cb) {
  await pool.query(
    `INSERT INTO callbacks (name, phone, preferred_date, preferred_time, notes, booked_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [cb.name, cb.phone, cb.preferred_date, cb.preferred_time, cb.notes || null, new Date(cb.bookedAt)]
  );
}

async function getAllCallbacks() {
  const [rows] = await pool.query('SELECT * FROM callbacks ORDER BY booked_at DESC');
  return rows;
}

// ── Escalations ───────────────────────────────────────────────────────────────

async function insertEscalation(esc) {
  await pool.query(
    `INSERT INTO escalations (customer_name, urgency, reason, escalated_at)
     VALUES (?, ?, ?, ?)`,
    [esc.customer_name || null, esc.urgency, esc.reason, new Date(esc.escalatedAt)]
  );
}

async function getAllEscalations() {
  const [rows] = await pool.query('SELECT * FROM escalations ORDER BY escalated_at DESC');
  return rows;
}

async function resolveEscalation(id) {
  await pool.query(
    'UPDATE escalations SET resolved = 1, resolved_at = NOW() WHERE id = ?',
    [id]
  );
}

// ── Push subscriptions (admin dashboard notifications) ────────────────────────

function hashEndpoint(endpoint) {
  return crypto.createHash('sha256').update(endpoint).digest('hex');
}

async function savePushSubscription(sub) {
  const endpointHash = hashEndpoint(sub.endpoint);
  await pool.query(
    `INSERT INTO push_subscriptions (endpoint, endpoint_hash, p256dh, auth)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE p256dh = VALUES(p256dh), auth = VALUES(auth)`,
    [sub.endpoint, endpointHash, sub.keys.p256dh, sub.keys.auth]
  );
}

async function getAllPushSubscriptions() {
  const [rows] = await pool.query('SELECT endpoint, p256dh, auth FROM push_subscriptions');
  return rows.map(r => ({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }));
}

async function deletePushSubscriptionByEndpoint(endpoint) {
  await pool.query('DELETE FROM push_subscriptions WHERE endpoint_hash = ?', [hashEndpoint(endpoint)]);
}

module.exports = {
  getAdminUserByEmail,
  createAdminUser,
  getSession,
  upsertSession,
  addMessage,
  getApiMessages,
  getAllMessages,
  getMessagesSinceId,
  getSessionsSummary,
  getAllSessionsWithMessages,
  insertLead,
  updateLead,
  updateLeadStatus,
  getAllLeads,
  insertCallback,
  getAllCallbacks,
  insertEscalation,
  getAllEscalations,
  resolveEscalation,
  savePushSubscription,
  getAllPushSubscriptions,
  deletePushSubscriptionByEndpoint,
};
