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

// Active (non-expired) dashboard login sessions, for the admin "Active Devices" view. Reads the
// raw express-mysql-session table directly — that library doesn't expose a listing API — and
// parses out just the fields this app itself writes into req.session (email/userAgent/loginAt),
// ignoring express-session's own cookie bookkeeping in the same JSON blob.
async function getActiveAdminSessions() {
  const [rows] = await pool.query(
    'SELECT session_id, expires, data FROM admin_sessions WHERE expires > UNIX_TIMESTAMP() ORDER BY expires DESC'
  );
  return rows.map(r => {
    let data = {};
    try { data = JSON.parse(r.data || '{}'); } catch (e) { /* corrupt/legacy row — skip fields */ }
    return {
      sessionId: r.session_id,
      email:     data.email || null,
      userAgent: data.userAgent || null,
      loginAt:   data.loginAt || null,
      expiresAt: r.expires * 1000,
    };
  }).filter(s => s.email); // drop rows from before login (saveUninitialized:false mostly prevents these, but be defensive)
}

async function revokeAdminSession(sessionId) {
  await pool.query('DELETE FROM admin_sessions WHERE session_id = ?', [sessionId]);
}

// ── Blocked numbers ──────────────────────────────────────────────────────────

async function isPhoneBlocked(phone) {
  const [rows] = await pool.query('SELECT 1 FROM blocked_numbers WHERE phone = ? LIMIT 1', [phone]);
  return rows.length > 0;
}

async function blockNumber(phone, reason) {
  await pool.query(
    'INSERT INTO blocked_numbers (phone, reason) VALUES (?, ?) ON DUPLICATE KEY UPDATE reason = VALUES(reason)',
    [phone, reason || null]
  );
}

async function unblockNumber(phone) {
  await pool.query('DELETE FROM blocked_numbers WHERE phone = ?', [phone]);
}

async function getBlockedNumbers() {
  const [rows] = await pool.query('SELECT * FROM blocked_numbers ORDER BY blocked_at DESC');
  return rows;
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

async function addMessage(phone, role, content, source = null, ts = null, waMessageId = null, replyContext = null) {
  const [result] = await pool.query(
    'INSERT INTO messages (phone, role, content, source, ts, wa_message_id, reply_context) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [phone, role, serialize(content), source || null, ts || Date.now(), waMessageId || null, replyContext ? JSON.stringify(replyContext) : null]
  );
  return result.insertId;
}

// Backfills a message's WhatsApp id after the send API call returns (addMessage is
// often called before the send completes, so the id isn't known at insert time)
async function setMessageWaId(id, waMessageId) {
  if (!waMessageId) return;
  await pool.query('UPDATE messages SET wa_message_id = ? WHERE id = ?', [waMessageId, id]);
}

// Looks up a message by WhatsApp's id — used to build a reply-context snapshot when
// a customer swipes-to-reply to a specific earlier message on their end
async function getMessageByWaId(phone, waMessageId) {
  const [rows] = await pool.query(
    'SELECT role, content, source FROM messages WHERE phone = ? AND wa_message_id = ? LIMIT 1',
    [phone, waMessageId]
  );
  if (!rows[0]) return null;
  return { role: rows[0].role, content: parseContent(rows[0].content), source: rows[0].source };
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

// Claude's Messages API has reserved native `document` and `image` content-block types with
// their own required schemas ({type:'document'|'image', source:{...}}) — neither is the same
// thing as the {type:'document'|'image', filename, caption} blocks this app stores when an
// admin sends a quotation file or photo (no `source`, since there's no image/PDF data to hand
// back to Claude for those). Sending our shape under a reserved name makes Claude reject the
// whole request with a 400. Swap both for a plain text block here (Claude-facing only — the
// admin dashboard's own rendering reads from getAllSessionsWithMessages/getMessagesSinceId
// instead, so its rich document/photo bubble is unaffected). A customer-sent image block
// always has `source` (real base64 data), so it passes through untouched.
function sanitizeForClaude(content) {
  if (!Array.isArray(content)) return content;
  return content.map(block => {
    if (block?.type === 'document' && !block.source) {
      const label = block.caption ? `${block.filename} — ${block.caption}` : block.filename;
      return { type: 'text', text: `[Sent document: ${label}]` };
    }
    if (block?.type === 'image' && !block.source) {
      const label = block.caption ? `${block.filename} — ${block.caption}` : block.filename;
      return { type: 'text', text: `[Sent photo: ${label}]` };
    }
    // Claude has no native video content-block type at all (unlike image/document) — a `video`
    // block must never reach the API in any form. Swapped for text regardless of source.
    if (block?.type === 'video') {
      return { type: 'text', text: '[Customer sent a video — flagged for human review, not visible to you]' };
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

// Every message across every conversation, joined with session (domain/escalated) and the
// most recently captured lead for that phone (if any) — for bulk conversation-analysis export.
// A phone can have more than one lead row (e.g. re-qualified later); the subquery picks only
// the latest one per phone so this doesn't duplicate message rows.
async function getAllMessagesForExport() {
  const [rows] = await pool.query(`
    SELECT m.phone, m.role, m.content, m.source, m.ts,
           s.domain, s.escalated, s.human_takeover, s.ad_referral,
           l.status AS lead_status, l.service AS lead_service, l.property_type AS lead_property_type
    FROM messages m
    LEFT JOIN sessions s ON s.phone = m.phone
    LEFT JOIN leads l ON l.phone = m.phone AND l.captured_at = (
      SELECT MAX(l2.captured_at) FROM leads l2 WHERE l2.phone = m.phone
    )
    ORDER BY m.phone, m.ts ASC, m.id ASC
  `);
  return rows.map(r => ({
    phone: r.phone,
    role: r.role,
    content: parseContent(r.content),
    source: r.source,
    ts: Number(r.ts),
    domain: r.domain,
    escalated: !!r.escalated,
    humanTakeover: !!r.human_takeover,
    adReferral: r.ad_referral,
    leadStatus: r.lead_status,
    leadService: r.lead_service,
    leadPropertyType: r.lead_property_type,
  }));
}

// Powers the admin dashboard's Analytics tab — all-time totals computed via SQL aggregation
// (not pulled into JS and reduced) since the messages/leads tables only grow over time. Mirrors
// the same methodology used for the one-off conversion analysis this was built to replace:
// leads deduped to the latest status per phone (see getAllMessagesForExport above), and
// system-injected bootstrap messages (source='system' — the "[Context — not from customer]"
// date-seed / "Understood." pairs) excluded from message counts since they'd inflate averages
// with content no customer or AI actually composed.
async function getAnalyticsSummary() {
  const [[{ totalConversations }]] = await pool.query('SELECT COUNT(*) AS totalConversations FROM sessions');
  const [[{ totalLeads }]] = await pool.query('SELECT COUNT(DISTINCT phone) AS totalLeads FROM leads');
  const [[{ escalatedCount }]] = await pool.query('SELECT COUNT(*) AS escalatedCount FROM sessions WHERE escalated = 1');

  const [domainRows] = await pool.query(
    "SELECT COALESCE(domain, 'undetected') AS domain, COUNT(*) AS count FROM sessions GROUP BY domain ORDER BY count DESC"
  );

  const [statusRows] = await pool.query(`
    SELECT l.status, COUNT(*) AS count
    FROM leads l
    INNER JOIN (SELECT phone, MAX(captured_at) AS max_captured FROM leads GROUP BY phone) latest
      ON latest.phone = l.phone AND latest.max_captured = l.captured_at
    GROUP BY l.status
    ORDER BY count DESC
  `);

  const [convoRows] = await pool.query(`
    SELECT (lp.phone IS NOT NULL) AS hasLead, COUNT(DISTINCT m.phone) AS conversations, COUNT(*) AS totalMessages
    FROM messages m
    LEFT JOIN (SELECT DISTINCT phone FROM leads) lp ON lp.phone = m.phone
    WHERE m.source IS NULL OR m.source = 'human'
    GROUP BY hasLead
  `);
  const withLead    = convoRows.find(r => r.hasLead === 1) || { conversations: 0, totalMessages: 0 };
  const withoutLead = convoRows.find(r => r.hasLead === 0) || { conversations: 0, totalMessages: 0 };

  return {
    totalConversations,
    totalLeads,
    conversionRatePct: totalConversations > 0 ? round2(totalLeads / totalConversations * 100) : 0,
    escalation: {
      count: escalatedCount,
      total: totalConversations,
      pct: totalConversations > 0 ? round2(escalatedCount / totalConversations * 100) : 0,
    },
    domainSplit: domainRows.map(r => ({ domain: r.domain, count: r.count })),
    leadsByStatus: statusRows.map(r => ({ status: r.status, count: r.count })),
    messagesPerConversation: {
      withLead:    { conversations: withLead.conversations, avgMessages: withLead.conversations > 0 ? round2(withLead.totalMessages / withLead.conversations) : 0 },
      withoutLead: { conversations: withoutLead.conversations, avgMessages: withoutLead.conversations > 0 ? round2(withoutLead.totalMessages / withoutLead.conversations) : 0 },
    },
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Messages for a phone newer than a given message id (admin polling). Cursoring by
// id rather than ts avoids client/server clock-skew and optimistic-append-vs-poll
// race conditions that caused duplicate/missing messages in the live chat view.
async function getMessagesSinceId(phone, sinceId) {
  const [rows] = await pool.query(
    'SELECT id, role, content, source, ts, wa_message_id, reply_context FROM messages WHERE phone = ? AND id > ? ORDER BY id ASC',
    [phone, Number(sinceId)]
  );
  return rows.map(r => ({
    id:           r.id,
    role:         r.role,
    content:      parseContent(r.content),
    source:       r.source,
    ts:           Number(r.ts),
    waMessageId:  r.wa_message_id || null,
    replyContext: r.reply_context ? parseContent(r.reply_context) : null,
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
    'SELECT id, phone, role, content, source, ts, wa_message_id, reply_context FROM messages ORDER BY ts ASC, id ASC'
  );

  const msgMap = {};
  for (const m of messages) {
    if (!msgMap[m.phone]) msgMap[m.phone] = [];
    msgMap[m.phone].push({
      id:           m.id,
      role:         m.role,
      content:      parseContent(m.content),
      source:       m.source,
      ts:           Number(m.ts),
      waMessageId:  m.wa_message_id || null,
      replyContext: m.reply_context ? parseContent(m.reply_context) : null,
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

// ── App settings (key/value) ────────────────────────────────────────────────────

async function getSetting(key) {
  const [rows] = await pool.query('SELECT setting_value FROM app_settings WHERE setting_key = ?', [key]);
  return rows[0] ? rows[0].setting_value : null;
}

async function setSetting(key, value) {
  await pool.query(
    'INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
    [key, value]
  );
}

// ── Product catalog ──────────────────────────────────────────────────────────────

// Replaces the whole catalog in one go — feed is the single source of truth, so
// products no longer present in the feed are removed rather than left stale.
async function replaceProducts(products) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM products');
    if (products.length) {
      const values = products.map(p => [
        p.retailerId, p.name, p.description || null, p.price, p.currency || 'KES',
        p.category || null, p.vertical || null, p.availability || null,
      ]);
      await conn.query(
        `INSERT INTO products (retailer_id, name, description, price, currency, category, vertical, availability)
         VALUES ?`,
        [values]
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function searchProducts(query, limit = 8) {
  const [rows] = await pool.query(
    `SELECT retailer_id, name, description, price, currency, category, availability
     FROM products
     WHERE MATCH(name, category) AGAINST (? IN NATURAL LANGUAGE MODE)
        OR name LIKE ? OR category LIKE ?
     LIMIT ?`,
    [query, `%${query}%`, `%${query}%`, limit]
  );
  return rows;
}

async function getAllProducts() {
  const [rows] = await pool.query('SELECT * FROM products ORDER BY category, name');
  return rows;
}

async function getProductCount() {
  const [rows] = await pool.query('SELECT COUNT(*) AS count FROM products');
  return rows[0].count;
}

// ── Tower pricing (admin-editable, not part of the synced product feed) ─────────

async function getTowerFoundationPrices() {
  const [rows] = await pool.query('SELECT foundation_type, price FROM tower_foundation_prices');
  return rows;
}

async function upsertTowerFoundationPrice(foundationType, price) {
  await pool.query(
    'INSERT INTO tower_foundation_prices (foundation_type, price) VALUES (?, ?) ON DUPLICATE KEY UPDATE price = VALUES(price)',
    [foundationType, price]
  );
}

async function deleteTowerFoundationPrice(foundationType) {
  await pool.query('DELETE FROM tower_foundation_prices WHERE foundation_type = ?', [foundationType]);
}

async function getTowerTankPrices() {
  const [rows] = await pool.query('SELECT * FROM tower_tank_prices ORDER BY tank_type, capacity_key');
  return rows;
}

async function upsertTowerTankPrice(tank) {
  if (tank.id) {
    await pool.query(
      'UPDATE tower_tank_prices SET tank_type = ?, capacity_key = ?, capacity_label = ?, price = ? WHERE id = ?',
      [tank.tank_type, tank.capacity_key, tank.capacity_label, tank.price, tank.id]
    );
    return tank.id;
  }
  const [result] = await pool.query(
    'INSERT INTO tower_tank_prices (tank_type, capacity_key, capacity_label, price) VALUES (?, ?, ?, ?)',
    [tank.tank_type, tank.capacity_key, tank.capacity_label, tank.price]
  );
  return result.insertId;
}

async function deleteTowerTankPrice(id) {
  await pool.query('DELETE FROM tower_tank_prices WHERE id = ?', [id]);
}

async function getTowerPackages() {
  const [rows] = await pool.query('SELECT * FROM tower_packages ORDER BY height_m, tank_type, capacity_key');
  return rows;
}

async function upsertTowerPackage(pkg) {
  if (pkg.id) {
    await pool.query(
      `UPDATE tower_packages SET height_m = ?, tank_count = ?, tank_type = ?, capacity_key = ?,
         capacity_label = ?, foundation_type = ?, fabrication_price = ? WHERE id = ?`,
      [pkg.height_m, pkg.tank_count, pkg.tank_type, pkg.capacity_key, pkg.capacity_label, pkg.foundation_type, pkg.fabrication_price, pkg.id]
    );
    return pkg.id;
  }
  const [result] = await pool.query(
    `INSERT INTO tower_packages (height_m, tank_count, tank_type, capacity_key, capacity_label, foundation_type, fabrication_price)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [pkg.height_m, pkg.tank_count, pkg.tank_type, pkg.capacity_key, pkg.capacity_label, pkg.foundation_type, pkg.fabrication_price]
  );
  return result.insertId;
}

async function deleteTowerPackage(id) {
  await pool.query('DELETE FROM tower_packages WHERE id = ?', [id]);
}

// ── Drilling quotation pricing (admin-editable inputs for drillingCalc.js) ──────

async function getDrillingSettings() {
  const [rows] = await pool.query('SELECT setting_key, setting_value FROM drilling_settings');
  const settings = {};
  rows.forEach(r => { settings[r.setting_key] = r.setting_value; });
  return settings;
}

async function setDrillingSetting(key, value) {
  await pool.query(
    'INSERT INTO drilling_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
    [key, value]
  );
}

async function getDrillingPenetrationRates() {
  const [rows] = await pool.query('SELECT * FROM drilling_penetration_rates ORDER BY minutes_per_rod');
  return rows;
}

async function upsertDrillingPenetrationRate(rate) {
  if (rate.id) {
    await pool.query(
      'UPDATE drilling_penetration_rates SET label = ?, minutes_per_rod = ?, rod_length_m = ? WHERE id = ?',
      [rate.label, rate.minutes_per_rod, rate.rod_length_m, rate.id]
    );
    return rate.id;
  }
  const [result] = await pool.query(
    'INSERT INTO drilling_penetration_rates (label, minutes_per_rod, rod_length_m) VALUES (?, ?, ?)',
    [rate.label, rate.minutes_per_rod, rate.rod_length_m]
  );
  return result.insertId;
}

async function deleteDrillingPenetrationRate(id) {
  await pool.query('DELETE FROM drilling_penetration_rates WHERE id = ?', [id]);
}

async function getDrillingLineItems(category) {
  const [rows] = category
    ? await pool.query('SELECT * FROM drilling_line_items WHERE category = ? ORDER BY sort_order, id', [category])
    : await pool.query('SELECT * FROM drilling_line_items ORDER BY category, sort_order, id');
  return rows;
}

async function upsertDrillingLineItem(item) {
  if (item.id) {
    await pool.query(
      'UPDATE drilling_line_items SET category = ?, name = ?, default_qty = ?, default_rate = ?, sort_order = ? WHERE id = ?',
      [item.category, item.name, item.default_qty, item.default_rate, item.sort_order || 0, item.id]
    );
    return item.id;
  }
  const [result] = await pool.query(
    'INSERT INTO drilling_line_items (category, name, default_qty, default_rate, sort_order) VALUES (?, ?, ?, ?, ?)',
    [item.category, item.name, item.default_qty, item.default_rate, item.sort_order || 0]
  );
  return result.insertId;
}

async function deleteDrillingLineItem(id) {
  await pool.query('DELETE FROM drilling_line_items WHERE id = ?', [id]);
}

// ── Solar quotation pricing (admin-editable BOQ templates for solarQuote.js) ────

async function getSolarSettings() {
  const [rows] = await pool.query('SELECT setting_key, setting_value FROM solar_settings');
  const settings = {};
  rows.forEach(r => { settings[r.setting_key] = r.setting_value; });
  return settings;
}

async function setSolarSetting(key, value) {
  await pool.query(
    'INSERT INTO solar_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
    [key, value]
  );
}

async function getSolarKvaTiers() {
  const [rows] = await pool.query('SELECT * FROM solar_kva_tiers ORDER BY sort_order, tier_key');
  return rows;
}

async function upsertSolarKvaTier(tier) {
  await pool.query(
    'INSERT INTO solar_kva_tiers (tier_key, label, sort_order) VALUES (?, ?, ?) ' +
    'ON DUPLICATE KEY UPDATE label = VALUES(label), sort_order = VALUES(sort_order)',
    [tier.tier_key, tier.label, tier.sort_order || 0]
  );
  return tier.tier_key;
}

async function deleteSolarKvaTier(tierKey) {
  await pool.query('DELETE FROM solar_line_items WHERE tier_key = ?', [tierKey]);
  await pool.query('DELETE FROM solar_kva_tiers WHERE tier_key = ?', [tierKey]);
}

async function getSolarLineItems(tierKey) {
  const [rows] = tierKey
    ? await pool.query('SELECT * FROM solar_line_items WHERE tier_key = ? ORDER BY sort_order, id', [tierKey])
    : await pool.query('SELECT * FROM solar_line_items ORDER BY tier_key, sort_order, id');
  return rows;
}

async function upsertSolarLineItem(item) {
  if (item.id) {
    await pool.query(
      'UPDATE solar_line_items SET tier_key = ?, category = ?, name = ?, default_qty = ?, default_rate = ?, sort_order = ? WHERE id = ?',
      [item.tier_key, item.category, item.name, item.default_qty, item.default_rate, item.sort_order || 0, item.id]
    );
    return item.id;
  }
  const [result] = await pool.query(
    'INSERT INTO solar_line_items (tier_key, category, name, default_qty, default_rate, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
    [item.tier_key, item.category, item.name, item.default_qty, item.default_rate, item.sort_order || 0]
  );
  return result.insertId;
}

async function deleteSolarLineItem(id) {
  await pool.query('DELETE FROM solar_line_items WHERE id = ?', [id]);
}

module.exports = {
  getAdminUserByEmail,
  createAdminUser,
  getActiveAdminSessions,
  revokeAdminSession,
  isPhoneBlocked,
  blockNumber,
  unblockNumber,
  getBlockedNumbers,
  getSession,
  upsertSession,
  addMessage,
  setMessageWaId,
  getMessageByWaId,
  getApiMessages,
  getAllMessages,
  getAllMessagesForExport,
  getAnalyticsSummary,
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
  getSetting,
  setSetting,
  replaceProducts,
  searchProducts,
  getAllProducts,
  getProductCount,
  getTowerFoundationPrices,
  upsertTowerFoundationPrice,
  deleteTowerFoundationPrice,
  getTowerTankPrices,
  upsertTowerTankPrice,
  deleteTowerTankPrice,
  getTowerPackages,
  upsertTowerPackage,
  deleteTowerPackage,
  getDrillingSettings,
  setDrillingSetting,
  getDrillingPenetrationRates,
  upsertDrillingPenetrationRate,
  deleteDrillingPenetrationRate,
  getDrillingLineItems,
  upsertDrillingLineItem,
  deleteDrillingLineItem,
  getSolarSettings,
  setSolarSetting,
  getSolarKvaTiers,
  upsertSolarKvaTier,
  deleteSolarKvaTier,
  getSolarLineItems,
  upsertSolarLineItem,
  deleteSolarLineItem,
};
