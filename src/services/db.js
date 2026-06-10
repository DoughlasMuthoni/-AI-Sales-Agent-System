'use strict';
const mysql = require('mysql2/promise');

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
  };
}

async function upsertSession(phone, session) {
  await pool.query(
    `INSERT INTO sessions (phone, domain, last_seen, escalated, human_takeover)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       domain         = VALUES(domain),
       last_seen      = VALUES(last_seen),
       escalated      = VALUES(escalated),
       human_takeover = VALUES(human_takeover)`,
    [
      phone,
      session.domain        || null,
      session.lastSeen,
      session.escalated     ? 1 : 0,
      session.humanTakeover ? 1 : 0,
    ]
  );
}

// ── Messages ──────────────────────────────────────────────────────────────────

async function addMessage(phone, role, content, source = null, ts = null) {
  await pool.query(
    'INSERT INTO messages (phone, role, content, source, ts) VALUES (?, ?, ?, ?, ?)',
    [phone, role, serialize(content), source || null, ts || Date.now()]
  );
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
    content: parseContent(r.content),
  }));
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

// All sessions with their full message history (admin dashboard)
async function getAllSessionsWithMessages() {
  const [sessions] = await pool.query('SELECT * FROM sessions ORDER BY last_seen DESC');
  const [messages] = await pool.query(
    'SELECT phone, role, content, source, ts FROM messages ORDER BY ts ASC, id ASC'
  );

  const msgMap = {};
  for (const m of messages) {
    if (!msgMap[m.phone]) msgMap[m.phone] = [];
    msgMap[m.phone].push({
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
      messages:      msgMap[s.phone] || [],
    };
  }
  return result;
}

// ── Leads ─────────────────────────────────────────────────────────────────────

async function insertLead(lead) {
  const [result] = await pool.query(
    `INSERT INTO leads (name, phone, location, service, property_type, estimated_budget, status, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, 'new', ?)`,
    [
      lead.name, lead.phone, lead.location, lead.service,
      lead.property_type, lead.estimated_budget || null,
      new Date(lead.capturedAt),
    ]
  );
  return result.insertId;
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

module.exports = {
  getSession,
  upsertSession,
  addMessage,
  getApiMessages,
  getAllMessages,
  getAllSessionsWithMessages,
  insertLead,
  updateLeadStatus,
  getAllLeads,
  insertCallback,
  getAllCallbacks,
  insertEscalation,
  getAllEscalations,
};
