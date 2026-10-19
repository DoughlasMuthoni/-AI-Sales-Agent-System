'use strict';
// Powers the Analytics tab's "Generate Conversation Analysis Report" button — the automated
// version of the manual conversion-analysis reports built earlier (compare against real
// transcripts, find why leads aren't converting, write findings + recommendations). Two stages:
//   1. computeStats() — deterministic aggregation, no LLM involved, mirrors getAnalyticsSummary()'s
//      methodology (system-bootstrap messages excluded from counts, leads deduped to latest/phone).
//   2. callClaudeForNarrative() — hands the stats plus a curated pool of REAL transcript excerpts
//      to Claude and forces a structured tool-call response, so the PDF renderer never has to
//      parse freeform prose and Claude never has to invent transcript content from scratch.
const { default: Anthropic } = require('@anthropic-ai/sdk');
const db = require('./db.js');
const { extractMessageText, senderLabel } = require('../utils/messageText.js');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PRICE_OBJECTION_RE = /expensive|too much|too high|pricey|can'?t afford|cannot afford|waaa|high price|reduce|discount|lower the price|out of budget|\bbudget\b/i;

function round1(n) { return Math.round(n * 10) / 10; }
function pct(part, total) { return total > 0 ? round1((part / total) * 100) : 0; }

// ── Stage 1: deterministic aggregation ─────────────────────────────────────────

function groupByPhone(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!r.phone) continue;
    if (!map.has(r.phone)) map.set(r.phone, []);
    map.get(r.phone).push(r);
  }
  return map;
}

function computeStats(rows) {
  const convos = groupByPhone(rows);
  const total = convos.size;

  let withLead = 0, escalatedCount = 0, takeoverCount = 0, escalatedNoLead = 0;
  const domainCounts = { solar: 0, borehole: 0, unknown: 0 };
  const leadStatusCounts = {};
  const msgCountsWithLead = [];
  const msgCountsNoLead = [];
  let priceObjectionConvos = 0;
  let dateStart = null, dateEnd = null;

  for (const [, msgs] of convos) {
    // Exclude source='system' bootstrap turns (date-context + "Understood.") from counts —
    // same convention as getAnalyticsSummary(), otherwise every new session's boilerplate
    // inflates message-length averages with content nobody actually wrote.
    const realMsgs = msgs.filter(m => m.source !== 'system');
    const domain = msgs.find(m => m.domain)?.domain || 'unknown';
    domainCounts[domain === 'solar' ? 'solar' : domain === 'borehole' ? 'borehole' : 'unknown']++;

    const escalated = msgs.some(m => m.escalated);
    const takeover = msgs.some(m => m.humanTakeover);
    const leadStatus = msgs.find(m => m.leadStatus)?.leadStatus || '';
    if (escalated) escalatedCount++;
    if (takeover) takeoverCount++;
    if (escalated && !leadStatus) escalatedNoLead++;

    if (leadStatus) {
      withLead++;
      leadStatusCounts[leadStatus] = (leadStatusCounts[leadStatus] || 0) + 1;
      msgCountsWithLead.push(realMsgs.length);
    } else {
      msgCountsNoLead.push(realMsgs.length);
    }

    if (realMsgs.some(m => m.role === 'user' && PRICE_OBJECTION_RE.test(extractMessageText(m.content)))) {
      priceObjectionConvos++;
    }

    for (const m of realMsgs) {
      if (!m.ts) continue;
      if (dateStart === null || m.ts < dateStart) dateStart = m.ts;
      if (dateEnd === null || m.ts > dateEnd) dateEnd = m.ts;
    }
  }

  const avg = arr => arr.length ? round1(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
  const lengthBuckets = { '1': 0, '2-3': 0, '4-6': 0, '7-10': 0, '11+': 0 };
  msgCountsNoLead.forEach(n => {
    if (n <= 1) lengthBuckets['1']++;
    else if (n <= 3) lengthBuckets['2-3']++;
    else if (n <= 6) lengthBuckets['4-6']++;
    else if (n <= 10) lengthBuckets['7-10']++;
    else lengthBuckets['11+']++;
  });

  return {
    totalConversations: total,
    withLeadCount: withLead,
    noLeadCount: total - withLead,
    leadCapturePct: pct(withLead, total),
    leadStatusCounts,
    domainCounts,
    escalatedCount,
    escalatedPct: pct(escalatedCount, total),
    takeoverCount,
    takeoverPct: pct(takeoverCount, total),
    escalatedNoLeadCount: escalatedNoLead,
    escalatedNoLeadPct: pct(escalatedNoLead, escalatedCount),
    avgMsgWithLead: avg(msgCountsWithLead),
    avgMsgNoLead: avg(msgCountsNoLead),
    noLeadLengthBuckets: lengthBuckets,
    priceObjectionConvos,
    priceObjectionPct: pct(priceObjectionConvos, total),
    dateStart, dateEnd,
  };
}

// ── Stage 1b: curated real transcript excerpts for Claude to draw on ──────────

function formatConvoLines(msgs, maxLines = 24, maxCharsPerLine = 220) {
  const real = msgs.filter(m => m.source !== 'system');
  return real.slice(0, maxLines).map(m => {
    const time = new Date(m.ts).toISOString().slice(11, 16);
    const text = extractMessageText(m.content).replace(/\s+/g, ' ').trim().slice(0, maxCharsPerLine);
    return `[${time}] ${senderLabel(m.role, m.source)}: ${text}`;
  });
}

function lastPhoneDigits(phone) { return String(phone).slice(-4); }

// Mechanically (not via LLM) pools conversations into categories worth showing Claude —
// keeps the prompt bounded and grounds every example Claude might quote in something real.
function selectCandidateExamples(rows) {
  const convos = groupByPhone(rows);
  const pools = { priceObjection: [], escalatedNoLead: [], escalatedWithLead: [], longNoLead: [], quoteThenSilence: [] };
  const CAP = { priceObjection: 12, escalatedNoLead: 6, escalatedWithLead: 4, longNoLead: 8, quoteThenSilence: 8 };

  for (const [phone, msgs] of convos) {
    const realMsgs = msgs.filter(m => m.source !== 'system');
    if (!realMsgs.length) continue;
    const escalated = msgs.some(m => m.escalated);
    const leadStatus = msgs.find(m => m.leadStatus)?.leadStatus || '';
    const hasLead = !!leadStatus;
    const entry = () => ({ phone, last4: lastPhoneDigits(phone), lines: formatConvoLines(msgs) });

    if (pools.priceObjection.length < CAP.priceObjection &&
        realMsgs.some(m => m.role === 'user' && PRICE_OBJECTION_RE.test(extractMessageText(m.content)))) {
      pools.priceObjection.push(entry());
    }
    if (escalated && !hasLead && pools.escalatedNoLead.length < CAP.escalatedNoLead) {
      pools.escalatedNoLead.push(entry());
    }
    if (escalated && hasLead && pools.escalatedWithLead.length < CAP.escalatedWithLead) {
      pools.escalatedWithLead.push(entry());
    }
    if (!hasLead && realMsgs.length >= 11 && pools.longNoLead.length < CAP.longNoLead) {
      pools.longNoLead.push(entry());
    }
    // "Quote then silence": last real message was from the agent (not the customer), no lead
    // captured, and the conversation had at least a few exchanges first.
    const lastReal = realMsgs[realMsgs.length - 1];
    if (!hasLead && realMsgs.length >= 4 && lastReal && lastReal.role !== 'user' &&
        pools.quoteThenSilence.length < CAP.quoteThenSilence) {
      pools.quoteThenSilence.push(entry());
    }
  }
  return pools;
}

// ── Stage 2: LLM synthesis (forced structured tool-call output) ───────────────

const REPORT_TOOL = {
  name: 'submit_analysis_report',
  description: 'Submit the structured conversation analysis report.',
  input_schema: {
    type: 'object',
    properties: {
      executive_summary: {
        type: 'string',
        description: '2-4 sentences on the overall picture, grounded only in the stats and examples provided — no invented figures.',
      },
      findings: {
        type: 'array',
        description: '3-5 findings, most important first.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            body: { type: 'string', description: 'Explain the pattern in prose, citing the given stats where relevant.' },
            examples: {
              type: 'array',
              description: 'Up to 3 real examples backing this finding, pulled ONLY from the transcript excerpts provided below — never invent a phone number, quote, or price.',
              items: {
                type: 'object',
                properties: {
                  phone: { type: 'string', description: 'Exact phone value from the provided excerpt.' },
                  label: { type: 'string', description: 'Short context label, e.g. "Bomet: KShs 4.16M quoted, no lead".' },
                  transcript_lines: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'A short excerpt of lines COPIED VERBATIM from the provided transcript for this phone — do not alter wording, prices, or add lines that were not given.',
                  },
                },
                required: ['phone', 'transcript_lines'],
              },
            },
          },
          required: ['title', 'body'],
        },
      },
      recommendations: {
        type: 'array',
        description: '3-5 recommendations, most actionable/highest-impact first.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            bullets: { type: 'array', items: { type: 'string' } },
          },
          required: ['title', 'bullets'],
        },
      },
    },
    required: ['executive_summary', 'findings', 'recommendations'],
  },
};

function fmtStatsBlock(stats) {
  const range = stats.dateStart && stats.dateEnd
    ? `${new Date(stats.dateStart).toISOString().slice(0, 10)} to ${new Date(stats.dateEnd).toISOString().slice(0, 10)}`
    : 'unknown';
  return [
    `Total conversations: ${stats.totalConversations} (${range})`,
    `Conversations with a captured lead: ${stats.withLeadCount} (${stats.leadCapturePct}%)`,
    `Conversations with no lead captured: ${stats.noLeadCount}`,
    `Lead status breakdown: ${JSON.stringify(stats.leadStatusCounts)}`,
    `Domain split: ${JSON.stringify(stats.domainCounts)}`,
    `Escalations: ${stats.escalatedCount} (${stats.escalatedPct}% of conversations)`,
    `Human takeovers: ${stats.takeoverCount} (${stats.takeoverPct}%)`,
    `Escalations with NO lead record: ${stats.escalatedNoLeadCount} (${stats.escalatedNoLeadPct}% of escalations)`,
    `Avg. messages per conversation, WITH lead: ${stats.avgMsgWithLead}`,
    `Avg. messages per conversation, NO lead: ${stats.avgMsgNoLead}`,
    `No-lead conversation length distribution: ${JSON.stringify(stats.noLeadLengthBuckets)}`,
    `Conversations containing explicit price-objection language: ${stats.priceObjectionConvos} (${stats.priceObjectionPct}%)`,
  ].join('\n');
}

function fmtExamplePool(title, entries) {
  if (!entries.length) return `${title}: none found in this data.`;
  return `${title} (${entries.length} found):\n` + entries.map(e =>
    `--- Conversation ...${e.last4} (phone: ${e.phone}) ---\n${e.lines.join('\n')}`
  ).join('\n\n');
}

async function callClaudeForNarrative(stats, pools) {
  const promptText = [
    'You are analyzing real WhatsApp sales conversations for Waterlift Solar (solar energy + borehole drilling services in Kenya) to explain why leads aren\'t converting. Below is (1) pre-computed statistics you must treat as ground truth, and (2) pools of REAL transcript excerpts grouped by pattern. Write a findings-and-recommendations report by calling submit_analysis_report.',
    '',
    'Rules:',
    '- Never invent a statistic — use only the numbers given below.',
    '- Never invent a transcript line, phone number, or price — every example must be copied from the excerpts provided, verbatim.',
    '- If a pool is empty, do not fabricate an example for it — just skip that angle or note the absence.',
    '- Do not claim this is a follow-up to or comparison against any "previous report" — treat this as a standalone analysis of the current data.',
    '- Prefer concrete, specific findings backed by real numbers/quotes over generic sales advice.',
    '',
    '=== STATISTICS ===',
    fmtStatsBlock(stats),
    '',
    '=== TRANSCRIPT EXCERPT POOLS ===',
    fmtExamplePool('Price-objection conversations', pools.priceObjection),
    '',
    fmtExamplePool('Escalated conversations with NO lead record', pools.escalatedNoLead),
    '',
    fmtExamplePool('Escalated conversations WITH a lead record (well-handled examples)', pools.escalatedWithLead),
    '',
    fmtExamplePool('Long conversations (11+ messages) that never captured a lead', pools.longNoLead),
    '',
    fmtExamplePool('Conversations where the agent sent the last message and the customer never replied again', pools.quoteThenSilence),
  ].join('\n');

  // Observed in production: this single call occasionally fails and then succeeds on a manual
  // retry (data volume has grown well past what this was last tested against, so the call is
  // slower/heavier now) — retry automatically here instead of making the admin click twice.
  const MAX_ATTEMPTS = 3;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await anthropic.messages.create({
        model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
        max_tokens: 6000,
        tools: [REPORT_TOOL],
        tool_choice: { type: 'tool', name: 'submit_analysis_report' },
        messages: [{ role: 'user', content: promptText }],
      });
      const toolUse = response.content.find(b => b.type === 'tool_use' && b.name === 'submit_analysis_report');
      if (!toolUse) throw new Error('Claude did not return a structured report.');
      return toolUse.input;
    } catch (err) {
      lastErr = err;
      console.error(`[conversationAnalysis] Attempt ${attempt}/${MAX_ATTEMPTS} failed:`, err.message);
      if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, attempt * 1500));
    }
  }
  throw new Error(`Report generation failed after ${MAX_ATTEMPTS} attempts: ${lastErr.message}`);
}

// ── Orchestrator ────────────────────────────────────────────────────────────

async function generateFullReport() {
  const rows = await db.getAllMessagesForExport();
  if (!rows.length) throw new Error('No conversations to analyze yet.');

  const stats = computeStats(rows);
  const pools = selectCandidateExamples(rows);
  const narrative = await callClaudeForNarrative(stats, pools);

  return { stats, narrative, generatedAt: Date.now() };
}

module.exports = { computeStats, selectCandidateExamples, generateFullReport };
