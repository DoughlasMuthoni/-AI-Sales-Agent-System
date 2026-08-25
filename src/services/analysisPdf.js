'use strict';
// Renders the AI-generated conversation analysis report (src/services/conversationAnalysis.js)
// into the same branded PDF style used for the manual reports built earlier this project.
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const LOGO_PATH = path.join(__dirname, '..', '..', 'public', 'logo.png');
const NAVY = '#0F2A3E';
const TEAL = '#075E54';
const GREY = '#555555';

// pdfkit's default fonts (Helvetica/Courier) use WinAnsiEncoding — most punctuation Claude might
// write (em/en dash, curly quotes, ellipsis) IS supported and renders fine, but a handful of
// symbols are not and silently render as garbled characters (confirmed with → specifically).
// Since this report's text comes from an LLM rather than hand-written copy, guard against it here
// instead of relying on prompt instructions holding 100% of the time.
const GLYPH_FIXES = {
  '→': '->', '⇒': '=>', '➡': '->', '➔': '->',
  '←': '<-', '⇐': '<=', '↔': '<->',
  '✓': 'Yes', '✔': 'Yes', '✗': 'No', '✘': 'No',
};
function sanitizeText(s) {
  if (s == null) return '';
  let out = String(s);
  for (const [bad, good] of Object.entries(GLYPH_FIXES)) out = out.split(bad).join(good);
  return out;
}

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });
}

async function generateConversationAnalysisPDF({ stats, narrative, generatedAt }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const PAGE_W = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    function resetX() { doc.x = doc.page.margins.left; }
    function ensureSpace(needed) {
      resetX();
      if (doc.y + needed > doc.page.height - doc.page.margins.bottom) doc.addPage();
    }
    function h1(text) {
      text = sanitizeText(text);
      ensureSpace(60);
      doc.moveDown(0.3);
      doc.font('Helvetica-Bold').fontSize(18).fillColor(NAVY).text(text, { width: PAGE_W });
      doc.moveDown(0.3);
      resetX();
      doc.strokeColor(TEAL).lineWidth(2).moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.margins.left + PAGE_W, doc.y).stroke();
      doc.moveDown(0.6);
      doc.fillColor('#000');
    }
    function h2(text) {
      text = sanitizeText(text);
      ensureSpace(40);
      doc.moveDown(0.5);
      doc.font('Helvetica-Bold').fontSize(13).fillColor(TEAL).text(text, { width: PAGE_W });
      doc.moveDown(0.25);
      doc.fillColor('#000');
    }
    function body(text) {
      text = sanitizeText(text);
      ensureSpace(20);
      doc.font('Helvetica').fontSize(10).fillColor('#000').text(text, { width: PAGE_W, align: 'left' });
      doc.moveDown(0.35);
    }
    function bullet(text) {
      text = sanitizeText(text);
      ensureSpace(16);
      doc.font('Helvetica').fontSize(10).fillColor('#000').text('•  ' + text, { width: PAGE_W });
      doc.moveDown(0.15);
    }
    function stat(label, value) {
      ensureSpace(14);
      doc.font('Helvetica-Bold').fontSize(10).fillColor(NAVY).text(sanitizeText(label) + ': ', { continued: true });
      doc.font('Helvetica').fillColor('#000').text(sanitizeText(value));
    }
    function transcriptBlock(lines) {
      if (!lines || !lines.length) return;
      lines = lines.map(sanitizeText);
      resetX();
      const textHeight = lines.reduce((h, l) => h + doc.font('Courier').fontSize(8).heightOfString(l, { width: PAGE_W - 20 }) + 2, 0);
      if (doc.y + textHeight + 20 > doc.page.height - doc.page.margins.bottom) doc.addPage();
      resetX();
      const boxY = doc.y;
      lines.forEach(l => {
        const line = String(l);
        const isCustomer = /\bCustomer:/i.test(line);
        doc.font(isCustomer ? 'Courier-Bold' : 'Courier').fontSize(8)
          .fillColor(isCustomer ? '#1E5C8C' : '#333')
          .text(line, doc.page.margins.left + 10, doc.y, { width: PAGE_W - 20 });
      });
      const boxH = doc.y - boxY + 6;
      doc.rect(doc.page.margins.left, boxY - 4, PAGE_W, boxH).strokeColor('#ddd').lineWidth(0.5).stroke();
      doc.fillColor('#000');
      doc.moveDown(0.5);
    }

    // ── Title page ──
    if (fs.existsSync(LOGO_PATH)) {
      try { doc.image(LOGO_PATH, doc.page.width / 2 - 35, doc.y, { fit: [70, 70] }); doc.moveDown(4); } catch (e) { /* logo optional */ }
    }
    doc.font('Helvetica-Bold').fontSize(24).fillColor(NAVY).text('Waterlift Solar', { align: 'center' });
    doc.font('Helvetica').fontSize(16).fillColor(TEAL).text('WhatsApp Conversation Analysis', { align: 'center' });
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(10).fillColor(GREY)
      .text(`Why leads aren’t converting — findings from ${stats.totalConversations} real customer conversations`, { align: 'center' });
    doc.moveDown(0.3);
    const range = stats.dateStart && stats.dateEnd ? `${fmtDate(stats.dateStart)} – ${fmtDate(stats.dateEnd)}` : 'all available data';
    doc.fontSize(9).text(`Data: ${range}  |  Report generated: ${fmtDate(generatedAt)}`, { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(8).fillColor('#999').text('Generated automatically by Claude from live conversation data — review before acting on it.', { align: 'center' });
    doc.moveDown(1.5);
    doc.fillColor('#000');

    // ── Executive summary ──
    h1('Executive Summary');
    body(narrative.executive_summary);

    // ── Stats ──
    h1('Conversation Statistics');
    stat('Total conversations analyzed', `${stats.totalConversations} (${range})`);
    stat('Conversations with a captured lead', `${stats.withLeadCount} (${stats.leadCapturePct}%)`);
    stat('Conversations with no lead captured', stats.noLeadCount);
    stat('Lead status breakdown', Object.entries(stats.leadStatusCounts).map(([k, v]) => `${v} "${k}"`).join(', ') || 'none');
    stat('Domain split', `Solar: ${stats.domainCounts.solar}  |  Borehole: ${stats.domainCounts.borehole}  |  Undetected: ${stats.domainCounts.unknown}`);
    stat('Conversations with an escalation', `${stats.escalatedCount} (${stats.escalatedPct}%)`);
    stat('Conversations with human takeover', `${stats.takeoverCount} (${stats.takeoverPct}%)`);
    stat('Escalations with no lead record', `${stats.escalatedNoLeadCount} (${stats.escalatedNoLeadPct}% of escalations)`);
    stat('Avg. messages per conversation (with lead)', stats.avgMsgWithLead);
    stat('Avg. messages per conversation (no lead)', stats.avgMsgNoLead);
    doc.moveDown(0.3);
    const b = stats.noLeadLengthBuckets;
    body(`Message-length distribution for non-converting conversations: 1 message (${b['1']}), 2–3 (${b['2-3']}), 4–6 (${b['4-6']}), 7–10 (${b['7-10']}), 11+ (${b['11+']}).`);
    body(`${stats.priceObjectionConvos} conversations (${stats.priceObjectionPct}%) contain explicit price-objection language.`);

    // ── Findings ──
    (narrative.findings || []).forEach((f, i) => {
      doc.addPage();
      h1(`Finding ${i + 1}: ${f.title}`);
      body(f.body);
      (f.examples || []).forEach(ex => {
        h2(`${ex.label || 'Example'}${ex.phone ? ' (' + ex.phone + ')' : ''}`);
        transcriptBlock(ex.transcript_lines);
      });
    });

    // ── Recommendations ──
    doc.addPage();
    h1('Recommendations');
    (narrative.recommendations || []).forEach((r, i) => {
      h2(`${i + 1}. ${r.title}`);
      (r.bullets || []).forEach(bullet);
    });

    doc.end();
  });
}

module.exports = { generateConversationAnalysisPDF };
