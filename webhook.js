require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs      = require('fs');
const path    = require('path');
const express = require('express');
const { processMessage, pauseSession, resumeSession, appendAdminMessage } = require('./src/agent/pipeline.js');
const { sendTextMessage } = require('./src/services/whatsapp.js');

const DATA_DIR = path.join(__dirname, 'data');
const app      = express();
app.use(express.json());

// ── Health ────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status:         'ok',
    anthropic_key:  process.env.ANTHROPIC_API_KEY        ? 'SET' : 'MISSING',
    whatsapp_token: process.env.WHATSAPP_ACCESS_TOKEN    ? 'SET' : 'MISSING',
    whatsapp_phone: process.env.WHATSAPP_PHONE_NUMBER_ID ? 'SET' : 'MISSING',
    smtp_pass:      process.env.SMTP_PASS                ? 'SET' : 'MISSING',
    model:          process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
    node_version:   process.version,
  });
});

// ── Admin auth ────────────────────────────────────────────────────────────────

function requireAdminAuth(req, res) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) { res.status(503).send('ADMIN_PASSWORD not configured in .env'); return false; }
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Waterlift Admin"');
    res.status(401).send('Login required'); return false;
  }
  const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
  const pass    = decoded.slice(decoded.indexOf(':') + 1);
  if (pass !== password) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Waterlift Admin"');
    res.status(401).send('Invalid password'); return false;
  }
  return true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readJSON(filename, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, filename), 'utf8')); }
  catch (e) { return fallback; }
}

function esc(s) {
  return String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function timeAgo(ts) {
  const d = Date.now() - Number(ts), m = Math.floor(d / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

function fmtTime(ts) {
  if (!ts) return '';
  try {
    const d = new Date(Number(ts));
    const isToday = d.toDateString() === new Date().toDateString();
    return isToday
      ? d.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Nairobi' })
      : d.toLocaleDateString('en-KE', { month: 'short', day: 'numeric', timeZone: 'Africa/Nairobi' });
  } catch(e) { return ''; }
}

function fmtFull(iso) {
  try { return new Date(iso).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', dateStyle: 'medium', timeStyle: 'short' }); }
  catch(e) { return iso || '—'; }
}

function getInitials(phone) {
  const d = String(phone).replace(/\D/g, '');
  return d.slice(-2) || '??';
}

function lastMsg(messages) {
  if (!messages || !messages.length) return 'No messages';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (typeof m.content === 'string') return m.content.slice(0, 45);
    if (Array.isArray(m.content)) {
      const t = m.content.find(b => b.type === 'text');
      if (t) return (m.source === 'human' ? '👤 ' : m.role === 'assistant' ? '🤖 ' : '') + t.text.slice(0, 42);
    }
  }
  return 'Message';
}

function renderMessages(messages) {
  return (messages || []).map(msg => {
    const t = fmtTime(msg.ts);
    if (typeof msg.content === 'string') {
      return '<div class="wa-row wa-row-in">' +
        '<div class="wa-bubble wa-in">' + esc(msg.content) +
        '<span class="wa-ts">' + t + '</span></div></div>';
    }
    if (!Array.isArray(msg.content)) return '';
    return msg.content.map(block => {
      if (block.type === 'text' && msg.role === 'assistant') {
        const human = msg.source === 'human';
        return '<div class="wa-row wa-row-out">' +
          '<div class="wa-bubble wa-out' + (human ? ' wa-human' : '') + '">' +
          '<span class="wa-sender">' + (human ? '&#128100; Human Agent' : '&#129302; AI Agent') + '</span>' +
          esc(block.text) +
          '<span class="wa-ts">' + t + ' <span class="wa-tick">&#10003;&#10003;</span></span>' +
          '</div></div>';
      }
      if (block.type === 'tool_use') {
        return '<div class="wa-row wa-row-center">' +
          '<div class="wa-system">&#128295; ' + esc(block.name) + '</div></div>';
      }
      return '';
    }).join('');
  }).join('');
}

// ── Admin page ────────────────────────────────────────────────────────────────

function buildAdminPage(sessions, leads, callbacks, escalations) {
  const entries = Object.entries(sessions).sort((a, b) => b[1].lastSeen - a[1].lastSeen);
  const now     = new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });

  // Left panel: contact list
  const contactsHTML = entries.length === 0
    ? '<div class="wa-empty-contacts"><p>No conversations yet</p></div>'
    : entries.map(([phone, s]) => {
        const pid    = phone.replace(/\D/g,'');
        const domain = s.domain || 'general';
        const paused = !!s.humanTakeover;
        return (
          '<div class="wa-contact" id="contact-' + pid + '" data-phone="' + esc(phone) + '" onclick="openChat(\'' + pid + '\')">' +
            '<div class="wa-av wa-av-' + domain + '">' + getInitials(phone) + '</div>' +
            '<div class="wa-ct-info">' +
              '<div class="wa-ct-row1">' +
                '<span class="wa-ct-name">' + esc(phone) + '</span>' +
                '<span class="wa-ct-time">' + timeAgo(s.lastSeen) + '</span>' +
              '</div>' +
              '<div class="wa-ct-row2">' +
                '<span class="wa-ct-prev">' + esc(lastMsg(s.messages)) + '</span>' +
                (paused ? '<span class="wa-ct-badge">&#128100;</span>' : '') +
                '<span class="wa-domain-chip wa-chip-' + domain + '">' + domain + '</span>' +
              '</div>' +
            '</div>' +
          '</div>'
        );
      }).join('');

  // Right panel: individual chat windows
  const chatsHTML = entries.map(([phone, s]) => {
    const pid    = phone.replace(/\D/g,'');
    const domain = s.domain || 'general';
    const paused = !!s.humanTakeover;
    return (
      '<div class="wa-chat" id="chat-' + pid + '">' +
        '<div class="wa-chat-hdr">' +
          '<button class="wa-back" onclick="backToContacts()">&#8592;</button>' +
          '<div class="wa-av wa-av-' + domain + ' wa-av-sm">' + getInitials(phone) + '</div>' +
          '<div class="wa-hdr-info">' +
            '<div class="wa-hdr-name">' + esc(phone) + '</div>' +
            '<div class="wa-hdr-sub ' + (paused ? 'sub-paused' : 'sub-active') + '" id="hsub-' + pid + '">' +
              (paused ? '&#128100; Human Mode' : '&#129302; AI Active') +
            '</div>' +
          '</div>' +
          '<button class="wa-action-btn ' + (paused ? 'wa-btn-resume' : 'wa-btn-pause') + '" id="pbtn-' + pid + '" data-phone="' + esc(phone) + '" data-pid="' + pid + '" data-paused="' + paused + '" onclick="handlePause(this)">' +
            (paused ? '&#9654; Resume AI' : '&#9646;&#9646; Pause AI') +
          '</button>' +
        '</div>' +
        '<div class="wa-msgs" id="chatmsgs-' + pid + '">' +
          renderMessages(s.messages) +
        '</div>' +
        '<div class="wa-input-area' + (paused ? '' : ' wa-input-locked') + '" id="wa-input-' + pid + '">' +
          (!paused ? '<div class="wa-lock-notice">&#9888;&#65039; Pause AI to reply directly</div>' : '') +
          '<div class="wa-input-row">' +
            '<textarea id="rinput-' + pid + '" class="wa-ta" rows="1" placeholder="' + (paused ? 'Type a message...' : 'Pause AI to reply') + '" ' + (paused ? '' : 'disabled') + ' oninput="autoResize(this)" onkeydown="if(event.key===\'Enter\'&&!event.shiftKey){event.preventDefault();handleSend(\'' + esc(phone) + '\',\'' + pid + '\')}"></textarea>' +
            '<button class="wa-send' + (paused ? '' : ' wa-send-disabled') + '" id="sbtn-' + pid + '" onclick="handleSend(\'' + esc(phone) + '\',\'' + pid + '\')" ' + (paused ? '' : 'disabled') + '>&#10148;</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }).join('');

  // Tables for leads / callbacks / escalations
  const tbl = (cols, rows, emptyIcon, emptyText) => rows.length === 0
    ? '<div class="tbl-empty"><div>' + emptyIcon + '</div><p>' + emptyText + '</p></div>'
    : '<div class="tbl-wrap"><table><thead><tr>' + cols.map(c=>'<th>'+c+'</th>').join('') + '</tr></thead><tbody>' + rows + '</tbody></table></div>';

  const leadsHTML = tbl(
    ['Name','Phone','Service','Location','Property','Budget','Captured'],
    leads.slice().reverse().map(l =>
      '<tr><td><strong>' + esc(l.name) + '</strong></td>' +
      '<td class="mono">' + esc(l.phone) + '</td>' +
      '<td><span class="chip chip-' + esc(l.service) + '">' + esc(l.service) + '</span></td>' +
      '<td>' + esc(l.location) + '</td><td>' + esc(l.property_type) + '</td>' +
      '<td>' + esc(l.estimated_budget||'—') + '</td>' +
      '<td class="muted">' + fmtFull(l.capturedAt) + '</td></tr>'
    ).join(''), '&#127919;', 'No leads captured yet.');

  const cbHTML = tbl(
    ['Name','Phone','Date','Time','Notes','Booked At'],
    callbacks.slice().reverse().map(c =>
      '<tr><td><strong>' + esc(c.name) + '</strong></td>' +
      '<td class="mono">' + esc(c.phone) + '</td>' +
      '<td>' + esc(c.preferred_date) + '</td><td>' + esc(c.preferred_time) + '</td>' +
      '<td>' + esc(c.notes||'—') + '</td>' +
      '<td class="muted">' + fmtFull(c.bookedAt) + '</td></tr>'
    ).join(''), '&#128197;', 'No callbacks booked yet.');

  const urgCls = u => u==='high'?'danger':u==='medium'?'warning':'general';
  const escTbl = tbl(
    ['Customer','Urgency','Reason','Time'],
    escalations.slice().reverse().map(e =>
      '<tr><td><strong>' + esc(e.customer_name||'Unknown') + '</strong></td>' +
      '<td><span class="chip chip-' + urgCls(e.urgency) + '">' + esc(e.urgency) + '</span></td>' +
      '<td>' + esc(e.reason) + '</td>' +
      '<td class="muted">' + fmtFull(e.escalatedAt) + '</td></tr>'
    ).join(''), '&#128680;', 'No escalations yet.');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Waterlift Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f0f4f8;color:#111;height:100vh;display:flex;flex-direction:column;overflow:hidden}

/* ── Top bar ── */
.topbar{background:linear-gradient(135deg,#054a3a,#075E54);color:#fff;padding:12px 20px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;box-shadow:0 2px 8px rgba(0,0,0,.25)}
.topbar h1{font-size:1rem;font-weight:700;letter-spacing:-.2px}
.topbar p{font-size:.7rem;opacity:.75;margin-top:1px}
.top-right{display:flex;align-items:center;gap:10px}
.live{display:flex;align-items:center;gap:5px;font-size:.75rem;opacity:.9}
.live-dot{width:7px;height:7px;background:#25D366;border-radius:50%;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(37,211,102,.4)}70%{box-shadow:0 0 0 5px rgba(37,211,102,0)}}
.refresh-btn{background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.25);color:#fff;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:.8rem;transition:background .15s}
.refresh-btn:hover{background:rgba(255,255,255,.25)}

/* ── Stats ── */
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;padding:12px 16px;background:#fff;border-bottom:1px solid #e2e8f0;flex-shrink:0}
@media(max-width:640px){.stats{grid-template-columns:repeat(2,1fr);padding:10px 12px}}
.stat{text-align:center;padding:8px}
.stat-n{font-size:1.5rem;font-weight:700;line-height:1}
.stat-l{font-size:.7rem;color:#64748b;margin-top:2px;font-weight:500}
.s-conv .stat-n{color:#075E54} .s-leads .stat-n{color:#d97706}
.s-cb .stat-n{color:#dc2626} .s-esc .stat-n{color:#8b5cf6}

/* ── Tabs ── */
.tabs{display:flex;background:#075E54;flex-shrink:0;overflow-x:auto;scrollbar-width:none}
.tabs::-webkit-scrollbar{display:none}
.tab{padding:11px 20px;border:none;background:transparent;color:rgba(255,255,255,.65);cursor:pointer;font-size:.85rem;font-weight:500;white-space:nowrap;border-bottom:3px solid transparent;transition:all .15s}
.tab:hover{color:#fff;background:rgba(255,255,255,.08)}
.tab.active{color:#fff;border-bottom-color:#25D366;background:rgba(255,255,255,.1)}

/* ── Panes ── */
.pane{display:none;flex:1;overflow:hidden}
.pane.active{display:flex;flex-direction:column}
.pane-scroll{flex:1;overflow-y:auto;padding:16px}

/* ── WhatsApp layout ── */
.wa-layout{display:flex;flex:1;overflow:hidden;background:#fff}
.wa-left{width:360px;min-width:280px;border-right:1px solid #e2e8f0;display:flex;flex-direction:column;background:#fff;flex-shrink:0}
@media(max-width:768px){
  .wa-left{width:100%;min-width:0}
  .wa-left.wa-hidden{display:none}
  .wa-right{width:100%}
  .wa-chat:not(.wa-active){display:none}
}
.wa-right{flex:1;display:flex;flex-direction:column;overflow:hidden;position:relative}

/* Left panel header */
.wa-lhdr{background:#075E54;color:#fff;padding:14px 16px;font-size:.9rem;font-weight:600;display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
.wa-lcount{background:rgba(255,255,255,.2);border-radius:12px;padding:2px 8px;font-size:.75rem}

/* Search */
.wa-search{padding:8px 12px;background:#f0f2f5;border-bottom:1px solid #e2e8f0;flex-shrink:0}
.wa-search input{width:100%;border:none;background:#fff;padding:8px 14px;border-radius:20px;font-size:.85rem;outline:none;color:#111;box-shadow:0 1px 2px rgba(0,0,0,.08)}
.wa-search input:focus{box-shadow:0 0 0 2px rgba(7,94,84,.2)}

/* Contacts */
.wa-contacts{flex:1;overflow-y:auto}
.wa-contact{display:flex;align-items:center;gap:12px;padding:12px 16px;cursor:pointer;border-bottom:1px solid #f0f2f5;transition:background .1s}
.wa-contact:hover,.wa-contact.active{background:#f0f2f5}
.wa-empty-contacts{padding:40px 20px;text-align:center;color:#94a3b8;font-size:.875rem}

/* Avatars */
.wa-av{width:46px;height:46px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.85rem;font-weight:700;color:#fff;flex-shrink:0;text-transform:uppercase}
.wa-av-sm{width:38px;height:38px;font-size:.75rem}
.wa-av-solar{background:linear-gradient(135deg,#d97706,#f59e0b)}
.wa-av-borehole{background:linear-gradient(135deg,#1d4ed8,#3b82f6)}
.wa-av-general{background:linear-gradient(135deg,#075E54,#128C7E)}

/* Contact info */
.wa-ct-info{flex:1;min-width:0}
.wa-ct-row1{display:flex;justify-content:space-between;align-items:center;margin-bottom:3px}
.wa-ct-name{font-size:.88rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0;margin-right:8px}
.wa-ct-time{font-size:.72rem;color:#128C7E;flex-shrink:0;font-weight:500}
.wa-ct-row2{display:flex;align-items:center;gap:6px}
.wa-ct-prev{font-size:.8rem;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
.wa-ct-badge{font-size:.85rem;flex-shrink:0}
.wa-domain-chip,.wa-chip-solar,.wa-chip-borehole,.wa-chip-general{font-size:.65rem;padding:1px 6px;border-radius:8px;font-weight:600;flex-shrink:0}
.wa-chip-solar{background:#fef3c7;color:#92400e}
.wa-chip-borehole{background:#dbeafe;color:#1e40af}
.wa-chip-general{background:#e2e8f0;color:#475569}

/* Right: no-chat */
.wa-no-chat{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#f0f2f5;color:#94a3b8;text-align:center;padding:40px}
.wa-no-chat-icon{font-size:3rem;margin-bottom:12px;opacity:.4}
.wa-no-chat p{font-size:.9rem}

/* Chat window */
.wa-chat{display:none;flex-direction:column;flex:1;overflow:hidden}
.wa-chat.wa-active{display:flex}

/* Chat header */
.wa-chat-hdr{background:#075E54;color:#fff;padding:10px 14px;display:flex;align-items:center;gap:10px;flex-shrink:0;box-shadow:0 2px 4px rgba(0,0,0,.2)}
.wa-back{background:none;border:none;color:#fff;font-size:1.2rem;cursor:pointer;padding:4px 8px;border-radius:4px;display:none;flex-shrink:0}
@media(max-width:768px){.wa-back{display:block}}
.wa-hdr-info{flex:1;min-width:0}
.wa-hdr-name{font-size:.9rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wa-hdr-sub{font-size:.72rem;margin-top:1px;opacity:.85}
.sub-active{color:#25D366}
.sub-paused{color:#fb923c}
.wa-action-btn{padding:6px 12px;border:none;border-radius:6px;cursor:pointer;font-size:.75rem;font-weight:600;white-space:nowrap;transition:all .15s;flex-shrink:0}
.wa-btn-pause{background:rgba(255,255,255,.15);color:#fff;border:1px solid rgba(255,255,255,.3)}
.wa-btn-pause:hover{background:rgba(255,255,255,.25)}
.wa-btn-resume{background:#25D366;color:#fff;border:1px solid #1ebe5a}
.wa-btn-resume:hover{background:#1ebe5a}
.wa-action-btn:disabled{opacity:.5;cursor:not-allowed}

/* Messages area */
.wa-msgs{flex:1;overflow-y:auto;padding:12px 16px;display:flex;flex-direction:column;gap:4px;
  background-color:#ECE5DD;
  background-image:url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23000000' fill-opacity='0.03'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E");
}

/* Message rows */
.wa-row{display:flex;margin-bottom:2px}
.wa-row-in{justify-content:flex-start}
.wa-row-out{justify-content:flex-end}
.wa-row-center{justify-content:center;margin:6px 0}

/* Bubbles */
.wa-bubble{max-width:72%;padding:8px 12px 22px;border-radius:8px;font-size:.875rem;line-height:1.5;white-space:pre-wrap;word-break:break-word;position:relative;box-shadow:0 1px 2px rgba(0,0,0,.12)}
@media(max-width:480px){.wa-bubble{max-width:88%}}
.wa-in{background:#fff;border-radius:0 8px 8px 8px}
.wa-in::before{content:'';position:absolute;left:-7px;top:0;border:7px solid transparent;border-right-color:#fff;border-top-color:#fff}
.wa-out{background:#DCF8C6;border-radius:8px 0 8px 8px}
.wa-out::after{content:'';position:absolute;right:-7px;top:0;border:7px solid transparent;border-left-color:#DCF8C6;border-top-color:#DCF8C6}
.wa-human{background:#C8F7DC}
.wa-human::after{border-left-color:#C8F7DC;border-top-color:#C8F7DC}
.wa-sender{display:block;font-size:.68rem;font-weight:700;color:#075E54;margin-bottom:3px;opacity:.8}
.wa-human .wa-sender{color:#16a34a}
.wa-ts{position:absolute;bottom:4px;right:8px;font-size:.65rem;color:rgba(0,0,0,.38);white-space:nowrap;display:flex;align-items:center;gap:3px}
.wa-tick{color:#53bdeb}
.wa-system{background:rgba(0,0,0,.06);border-radius:12px;padding:4px 12px;font-size:.72rem;color:#475569;text-align:center;max-width:80%}

/* Input area */
.wa-input-area{background:#f0f2f5;padding:8px 12px;border-top:1px solid #e2e8f0;flex-shrink:0}
.wa-input-locked{background:#f8f9fa}
.wa-lock-notice{font-size:.78rem;color:#d97706;background:#fef9c3;border:1px solid #fde68a;padding:6px 12px;border-radius:6px;margin-bottom:8px;text-align:center;font-weight:500}
.wa-input-row{display:flex;align-items:flex-end;gap:8px}
.wa-ta{flex:1;border:none;background:#fff;padding:10px 14px;border-radius:22px;font-size:.875rem;font-family:inherit;resize:none;outline:none;line-height:1.4;max-height:120px;overflow-y:auto;box-shadow:0 1px 2px rgba(0,0,0,.08);color:#111}
.wa-ta:disabled{background:#f1f5f9;color:#94a3b8;cursor:not-allowed}
.wa-send{width:44px;height:44px;border-radius:50%;background:#25D366;border:none;color:#fff;font-size:1.1rem;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:background .15s;box-shadow:0 2px 4px rgba(37,211,102,.4)}
.wa-send:hover:not(:disabled){background:#1ebe5a}
.wa-send-disabled{background:#94a3b8;box-shadow:none;cursor:not-allowed}

/* Tables */
.tbl-wrap{overflow-x:auto;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,.08);border:1px solid #e2e8f0}
table{width:100%;border-collapse:collapse;background:#fff}
th{background:#f8fafc;padding:11px 14px;text-align:left;font-size:.72rem;text-transform:uppercase;letter-spacing:.5px;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0;white-space:nowrap}
td{padding:12px 14px;border-top:1px solid #f1f5f9;font-size:.875rem;vertical-align:top}
tr:hover td{background:#fafbfd}
.mono{font-family:'SF Mono','Fira Code',monospace;font-size:.8rem}
.muted{color:#64748b;font-size:.8rem}
.chip{display:inline-block;padding:3px 9px;border-radius:20px;font-size:.72rem;font-weight:700;text-transform:capitalize}
.chip-solar{background:#fef3c7;color:#92400e}
.chip-borehole{background:#dbeafe;color:#1e40af}
.chip-general{background:#f1f5f9;color:#475569}
.chip-danger{background:#fee2e2;color:#991b1b}
.chip-warning{background:#fef3c7;color:#92400e}
.tbl-empty{text-align:center;padding:48px 24px;color:#94a3b8;background:#fff;border-radius:10px}
.tbl-empty div{font-size:2.5rem;margin-bottom:10px}
.tbl-empty p{font-size:.9rem}

/* Toast */
#toasts{position:fixed;top:16px;right:16px;z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none}
.toast{background:#1e293b;color:#fff;padding:11px 16px;border-radius:8px;font-size:.83rem;font-weight:500;box-shadow:0 4px 12px rgba(0,0,0,.2);animation:toastIn .25s ease;max-width:260px;pointer-events:auto}
.toast.ok{background:#16a34a}
.toast.err{background:#dc2626}
@keyframes toastIn{from{transform:translateX(110%);opacity:0}to{transform:translateX(0);opacity:1}}
@keyframes toastOut{to{transform:translateX(110%);opacity:0}}
</style>
</head>
<body>

<div id="toasts"></div>

<div class="topbar">
  <div>
    <h1>&#127754; Waterlift AI Sales Agent &mdash; Admin Dashboard</h1>
    <p>Last refreshed: ${now}</p>
  </div>
  <div class="top-right">
    <div class="live"><span class="live-dot"></span>Live</div>
    <button class="refresh-btn" onclick="location.reload()">&#8635; Refresh</button>
  </div>
</div>

<div class="stats">
  <div class="stat s-conv"><div class="stat-n">${entries.length}</div><div class="stat-l">&#128172; Sessions</div></div>
  <div class="stat s-leads"><div class="stat-n">${leads.length}</div><div class="stat-l">&#127919; Leads</div></div>
  <div class="stat s-cb"><div class="stat-n">${callbacks.length}</div><div class="stat-l">&#128222; Callbacks</div></div>
  <div class="stat s-esc"><div class="stat-n">${escalations.length}</div><div class="stat-l">&#128680; Escalations</div></div>
</div>

<div class="tabs">
  <button class="tab active" onclick="showTab('conv',this)">&#128172; Chats (${entries.length})</button>
  <button class="tab" onclick="showTab('leads',this)">&#127919; Leads (${leads.length})</button>
  <button class="tab" onclick="showTab('cb',this)">&#128222; Callbacks (${callbacks.length})</button>
  <button class="tab" onclick="showTab('esc',this)">&#128680; Escalations (${escalations.length})</button>
</div>

<!-- Conversations pane -->
<div id="pane-conv" class="pane active">
  <div class="wa-layout">
    <div class="wa-left" id="wa-left">
      <div class="wa-lhdr">
        Conversations
        <span class="wa-lcount">${entries.length}</span>
      </div>
      <div class="wa-search">
        <input type="text" placeholder="&#128269; Search by number..." oninput="filterContacts(this.value)">
      </div>
      <div class="wa-contacts">${contactsHTML}</div>
    </div>
    <div class="wa-right" id="wa-right">
      <div class="wa-no-chat" id="wa-no-chat">
        <div class="wa-no-chat-icon">&#128172;</div>
        <p>Select a conversation to view</p>
      </div>
      ${chatsHTML}
    </div>
  </div>
</div>

<!-- Leads pane -->
<div id="pane-leads" class="pane">
  <div class="pane-scroll">${leadsHTML}</div>
</div>

<!-- Callbacks pane -->
<div id="pane-cb" class="pane">
  <div class="pane-scroll">${cbHTML}</div>
</div>

<!-- Escalations pane -->
<div id="pane-esc" class="pane">
  <div class="pane-scroll">${escTbl}</div>
</div>

<script>
var activeChat = null;

function showTab(name, btn) {
  document.querySelectorAll('.pane').forEach(function(p){p.classList.remove('active')});
  document.querySelectorAll('.tab').forEach(function(t){t.classList.remove('active')});
  document.getElementById('pane-' + name).classList.add('active');
  btn.classList.add('active');
}

function openChat(pid) {
  // Update contacts active state
  document.querySelectorAll('.wa-contact').forEach(function(c){c.classList.remove('active')});
  var contact = document.getElementById('contact-' + pid);
  if (contact) contact.classList.add('active');

  // Show selected chat
  document.querySelectorAll('.wa-chat').forEach(function(c){c.classList.remove('wa-active')});
  document.getElementById('wa-no-chat').style.display = 'none';
  var chat = document.getElementById('chat-' + pid);
  if (chat) { chat.classList.add('wa-active'); }
  activeChat = pid;

  // Scroll to bottom of messages
  var msgs = document.getElementById('chatmsgs-' + pid);
  if (msgs) setTimeout(function(){ msgs.scrollTop = msgs.scrollHeight; }, 60);

  // Mobile: hide left panel
  if (window.innerWidth <= 768) {
    document.getElementById('wa-left').classList.add('wa-hidden');
  }
}

function backToContacts() {
  document.querySelectorAll('.wa-chat').forEach(function(c){c.classList.remove('wa-active')});
  document.getElementById('wa-no-chat').style.display = 'flex';
  document.getElementById('wa-left').classList.remove('wa-hidden');
  activeChat = null;
}

function filterContacts(q) {
  var query = q.toLowerCase();
  document.querySelectorAll('.wa-contact').forEach(function(c) {
    var phone = (c.dataset.phone || '').toLowerCase();
    c.style.display = (query === '' || phone.includes(query)) ? '' : 'none';
  });
}

function autoResize(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
}

function toast(msg, type) {
  var el = document.createElement('div');
  el.className = 'toast' + (type === 'ok' ? ' ok' : type === 'err' ? ' err' : '');
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(function(){
    el.style.animation = 'toastOut .3s ease forwards';
    setTimeout(function(){ el.remove(); }, 300);
  }, 3000);
}

async function handlePause(btn) {
  var phone  = btn.dataset.phone;
  var pid    = btn.dataset.pid;
  var paused = btn.dataset.paused === 'true';
  var action = paused ? 'resume' : 'pause';
  btn.disabled = true; btn.textContent = '...';
  try {
    var r = await fetch('/admin/api/session/' + encodeURIComponent(phone) + '/' + action, { method: 'POST' });
    if (!r.ok) throw new Error('Failed');
    var nowPaused = !paused;
    btn.dataset.paused = String(nowPaused);
    btn.innerHTML = nowPaused ? '&#9654; Resume AI' : '&#9646;&#9646; Pause AI';
    btn.className = 'wa-action-btn ' + (nowPaused ? 'wa-btn-resume' : 'wa-btn-pause');

    var sub = document.getElementById('hsub-' + pid);
    sub.innerHTML = nowPaused ? '&#128100; Human Mode' : '&#129302; AI Active';
    sub.className = 'wa-hdr-sub ' + (nowPaused ? 'sub-paused' : 'sub-active');

    var wrap  = document.getElementById('wa-input-' + pid);
    var ta    = document.getElementById('rinput-' + pid);
    var sbtn  = document.getElementById('sbtn-' + pid);
    var note  = wrap.querySelector('.wa-lock-notice');
    if (nowPaused) {
      wrap.classList.remove('wa-input-locked');
      ta.disabled = false; ta.placeholder = 'Type a message...';
      sbtn.disabled = false; sbtn.className = 'wa-send';
      if (note) note.remove();
    } else {
      wrap.classList.add('wa-input-locked');
      ta.disabled = true; ta.placeholder = 'Pause AI to reply';
      sbtn.disabled = true; sbtn.className = 'wa-send wa-send-disabled';
      if (!note) {
        var n = document.createElement('div');
        n.className = 'wa-lock-notice';
        n.innerHTML = '&#9888;&#65039; Pause AI to reply directly';
        wrap.insertBefore(n, wrap.querySelector('.wa-input-row'));
      }
    }
    // Update contact badge
    var badge = document.querySelector('#contact-' + pid + ' .wa-ct-badge');
    if (nowPaused && !badge) {
      var row2 = document.querySelector('#contact-' + pid + ' .wa-ct-row2');
      if (row2) { var b = document.createElement('span'); b.className='wa-ct-badge'; b.textContent='&#128100;'; row2.appendChild(b); }
    } else if (!nowPaused && badge) { badge.remove(); }
    toast(nowPaused ? 'AI paused — you can now reply' : 'AI resumed', 'ok');
  } catch(e) { toast('Error: ' + e.message, 'err'); }
  finally { btn.disabled = false; }
}

async function handleSend(phone, pid) {
  var ta   = document.getElementById('rinput-' + pid);
  var btn  = document.getElementById('sbtn-' + pid);
  var text = ta.value.trim();
  if (!text) return;
  btn.disabled = true; btn.innerHTML = '...';
  try {
    var r = await fetch('/admin/api/session/' + encodeURIComponent(phone) + '/send', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ message: text })
    });
    if (!r.ok) { var e = await r.json(); throw new Error(e.error || 'Failed'); }
    var msgs = document.getElementById('chatmsgs-' + pid);
    var d    = document.createElement('div');
    d.className = 'wa-row wa-row-out';
    var escaped = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    var now  = new Date().toLocaleTimeString('en-KE',{hour:'2-digit',minute:'2-digit',timeZone:'Africa/Nairobi'});
    d.innerHTML = '<div class="wa-bubble wa-out wa-human"><span class="wa-sender">&#128100; Human Agent</span>' + escaped + '<span class="wa-ts">' + now + ' <span class="wa-tick">&#10003;&#10003;</span></span></div>';
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
    ta.value = ''; ta.style.height = 'auto';
    // Update contact preview
    var prev = document.querySelector('#contact-' + pid + ' .wa-ct-prev');
    if (prev) prev.textContent = '\\u{1F464} ' + text.slice(0, 42);
    toast('Message sent', 'ok');
  } catch(e) { toast('Send failed: ' + e.message, 'err'); }
  finally { btn.disabled = false; btn.innerHTML = '&#10148;'; }
}

// Auto-open first chat on desktop if available
window.addEventListener('DOMContentLoaded', function() {
  if (window.innerWidth > 768) {
    var first = document.querySelector('.wa-contact');
    if (first) { var pid = first.id.replace('contact-',''); openChat(pid); }
  }
});

setTimeout(function(){ location.reload(); }, 60000);
</script>
</body>
</html>`;
}

// ── Admin routes ──────────────────────────────────────────────────────────────

app.get('/admin', (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  const sessions    = readJSON('sessions.json', {});
  const leads       = readJSON('leads.json', []);
  const callbacks   = readJSON('callbacks.json', []);
  const escalations = readJSON('escalations.json', []);
  res.send(buildAdminPage(sessions, leads, callbacks, escalations));
});

app.post('/admin/api/session/:phone/pause', (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  pauseSession(req.params.phone);
  res.json({ ok: true });
});

app.post('/admin/api/session/:phone/resume', (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  resumeSession(req.params.phone);
  res.json({ ok: true });
});

app.post('/admin/api/session/:phone/send', async (req, res) => {
  if (!requireAdminAuth(req, res)) return;
  const { message } = req.body || {};
  if (!message || !message.trim()) return res.status(400).json({ error: 'message is required' });
  try {
    await sendTextMessage(req.params.phone, message.trim());
    appendAdminMessage(req.params.phone, message.trim());
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin] Send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── WhatsApp webhook ──────────────────────────────────────────────────────────

const recentMessageIds = new Map();
const DEDUP_TTL_MS     = 60_000;

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
  const mode = req.query['hub.mode'], token = req.query['hub.verify_token'], challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('[webhook] Verified'); return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
  res.sendStatus(200);
  try {
    const body  = req.body;
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    if (!value?.messages?.length) return;
    const message   = value.messages[0];
    const from      = message.from;
    const messageId = message.id;
    if (message.type !== 'text' || !message.text?.body) {
      processMessage(from, 'I sent a non-text message. Please let me know how I can help you via text.', messageId)
        .catch(err => console.error('[webhook] processMessage error:', err));
      return;
    }
    const body2 = message.text.body.trim();
    if (!body2 || isDuplicate(messageId)) return;
    console.log('[webhook] From', from + ':', body2.slice(0, 80));
    processMessage(from, body2, messageId).catch(err => console.error('[webhook] processMessage error:', err));
  } catch (err) { console.error('[webhook] Parse error:', err); }
});

// ── Boot ──────────────────────────────────────────────────────────────────────

module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log('[server] Running on port', PORT));
}
