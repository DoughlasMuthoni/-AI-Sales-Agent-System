'use strict';
const { default: Anthropic } = require('@anthropic-ai/sdk');
const { SOLAR_SYSTEM_PROMPT, BOREHOLE_SYSTEM_PROMPT } = require('./prompts.js');
const { sendTextMessage, sendTypingIndicator } = require('../services/whatsapp.js');
const { executeTool } = require('../mcp/mcpServer.js');
const { toolDefinitions } = require('../mcp/tools.js');
const db = require('../services/db.js');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SESSION_TTL_MS      = 24 * 60 * 60 * 1000;
const MAX_LOOP_ITERATIONS = 10;

const processing = new Set(); // phones currently mid-pipeline

// ── Domain detection ──────────────────────────────────────────────────────────

const SOLAR_KEYWORDS    = ['solar', 'panel', 'panels', 'inverter', 'battery', 'electricity',
                           'energy', 'grid', 'power', 'watt', 'kilowatt', 'kw', 'photovoltaic',
                           'pv', 'load', 'geyser', 'backup', 'lights', 'appliance',
                           'heat', 'heating', 'floodlight', 'charge controller'];
const BOREHOLE_KEYWORDS = ['borehole', 'drilling', 'drill', 'well', 'aquifer',
                           'groundwater', 'irrigation', 'jojo', 'municipal', 'bore',
                           'waterless', 'harvest', 'casing', 'submersible'];

const SOLAR_PHRASES    = ['heat pump', 'heatpump', 'heatpumps', 'hot water', 'water heater',
                          'solar water', 'solar pump', 'solar panel', 'solar system',
                          'solar light', 'solar flood', 'backup power'];
const BOREHOLE_PHRASES = ['borehole', 'drill a', 'water supply', 'ground water', 'water pump',
                          'pump water', 'water tank', 'water well'];

function detectDomain(text) {
  const lower = text.toLowerCase();
  if (SOLAR_PHRASES.some(p => lower.includes(p)))    return 'solar';
  if (BOREHOLE_PHRASES.some(p => lower.includes(p))) return 'borehole';
  const solarScore    = SOLAR_KEYWORDS.filter(kw => lower.includes(kw)).length;
  const boreholeScore = BOREHOLE_KEYWORDS.filter(kw => lower.includes(kw)).length;
  if (solarScore > boreholeScore) return 'solar';
  if (boreholeScore > solarScore) return 'borehole';
  return null;
}

// ── System prompts ────────────────────────────────────────────────────────────

const GENERAL_PROMPT = `You are a friendly sales assistant for Waterlift Solar Limited, a premium company providing Solar Energy Solutions and Borehole Drilling Services across Kenya.

Greet the customer warmly and ask which service they are interested in:
1. Solar Energy Solutions (backup power, grid-tied, solar water heating, solar pumping)
2. Borehole Drilling Services (new drilling, rehabilitation, water pumping systems)

Once they indicate their interest, proceed as a specialist in that domain.
Contact: +254 768 117 070 | support@waterliftsolar.africa

Customers may also send photos (electricity meter, appliance nameplate, site photos, existing borehole/pump equipment, etc.) — examine them carefully and use what you see to help identify their service interest.

Never use markdown headers or emojis. Keep responses short and conversational.`;

function getSystemPrompt(domain) {
  if (domain === 'solar')    return SOLAR_SYSTEM_PROMPT;
  if (domain === 'borehole') return BOREHOLE_SYSTEM_PROMPT;
  return GENERAL_PROMPT;
}

// ── Core pipeline ─────────────────────────────────────────────────────────────

const claudeTools = toolDefinitions.map(t => ({
  name:         t.name,
  description:  t.description,
  input_schema: t.inputSchema,
}));

async function processMessage(from, messageBody, messageId, referral = null) {
  if (processing.has(from)) {
    console.error('[pipeline] Already processing for', from, '— duplicate message dropped');
    return;
  }
  processing.add(from);
  try {
    await _processMessage(from, messageBody, messageId, referral);
  } finally {
    processing.delete(from);
  }
}

async function processImageMessage(from, media, caption, messageId) {
  if (processing.has(from)) {
    console.error('[pipeline] Already processing for', from, '— duplicate message dropped');
    return;
  }
  processing.add(from);
  try {
    await _processImageMessage(from, media, caption, messageId);
  } finally {
    processing.delete(from);
  }
}

async function _processMessage(from, messageBody, messageId, referral = null) {
  const now = Date.now();

  let session = await db.getSession(from);

  if (!session || now - session.lastSeen > SESSION_TTL_MS) {
    session = { domain: null, lastSeen: now, escalated: false, humanTakeover: false };
    await db.upsertSession(from, session);
    // Seed with today's date so Claude can reference it for scheduling
    const dateStr = new Date().toLocaleDateString('en-KE', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
    await db.addMessage(from, 'user',
      `[Context — not from customer] Today is ${dateStr}. Use this for scheduling and date references only. Do not mention this message.`,
      'system', now);
    await db.addMessage(from, 'assistant',
      [{ type: 'text', text: 'Understood.' }],
      'system', now);
  }

  // Human has taken over — record the customer message but don't respond with AI
  if (session.humanTakeover) {
    session.lastSeen = now;
    await db.addMessage(from, 'user', messageBody, null, now);
    await db.upsertSession(from, session);
    return;
  }

  // Re-detect domain on every message — allows switching if customer pivots topic
  const detected = detectDomain(messageBody);
  if (detected) session.domain = detected;

  // If the message is generic but the customer came from a Click-to-WhatsApp ad,
  // use the ad headline/body to detect domain and inject product context for Claude
  if (referral) {
    const adText = [referral.headline, referral.body].filter(Boolean).join(' ');
    if (!session.domain && adText) {
      const adDomain = detectDomain(adText);
      if (adDomain) session.domain = adDomain;
    }
    const productNote = referral.product?.product_id
      ? `product ID ${referral.product.product_id} from catalog ${referral.product.catalog_id || process.env.WHATSAPP_CATALOG_ID}`
      : null;
    const adCtx = [
      referral.headline && `Ad: "${referral.headline}"`,
      referral.body     && `Description: "${referral.body}"`,
      productNote       && `Product: ${productNote}`,
    ].filter(Boolean).join('. ');
    if (adCtx) {
      console.error('[pipeline] Injecting ad referral context:', adCtx);
      await db.addMessage(from, 'user',
        `[Context — not from customer] This customer tapped a WhatsApp ad before messaging. ${adCtx}. Use this to understand their specific interest and address it directly. Do not mention this metadata to the customer.`,
        'system', now);
      await db.addMessage(from, 'assistant',
        [{ type: 'text', text: 'Understood.' }],
        'system', now);
    }
  }

  session.lastSeen = now;
  await db.addMessage(from, 'user', messageBody, null, now);
  await db.upsertSession(from, session);

  await sendTypingIndicator(from, messageId);

  const systemPrompt = getSystemPrompt(session.domain);
  await runAgenticLoop(from, session, systemPrompt);
}

// Customer sent an image (with an optional caption) — analyzed via Claude's vision input
async function _processImageMessage(from, media, caption, messageId) {
  const now = Date.now();

  let session = await db.getSession(from);

  if (!session || now - session.lastSeen > SESSION_TTL_MS) {
    session = { domain: null, lastSeen: now, escalated: false, humanTakeover: false };
    await db.upsertSession(from, session);
    const dateStr = new Date().toLocaleDateString('en-KE', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
    await db.addMessage(from, 'user',
      `[Context — not from customer] Today is ${dateStr}. Use this for scheduling and date references only. Do not mention this message.`,
      'system', now);
    await db.addMessage(from, 'assistant',
      [{ type: 'text', text: 'Understood.' }],
      'system', now);
  }

  const contentBlocks = [
    { type: 'image', source: { type: 'base64', media_type: media.mimeType, data: media.base64 } },
  ];
  if (caption) contentBlocks.push({ type: 'text', text: caption });

  // Human has taken over — record the customer's image but don't respond with AI
  if (session.humanTakeover) {
    session.lastSeen = now;
    await db.addMessage(from, 'user', contentBlocks, null, now);
    await db.upsertSession(from, session);
    return;
  }

  if (caption) {
    const detected = detectDomain(caption);
    if (detected) session.domain = detected;
  }

  session.lastSeen = now;
  await db.addMessage(from, 'user', contentBlocks, null, now);
  await db.upsertSession(from, session);

  await sendTypingIndicator(from, messageId);

  const systemPrompt = getSystemPrompt(session.domain);
  await runAgenticLoop(from, session, systemPrompt);
}

// ── Agentic loop (shared by text and image entry points) ─────────────────────

async function runAgenticLoop(from, session, systemPrompt) {
  let iterationCount = 0;
  console.error('[pipeline] Starting loop for', from, 'domain:', session.domain, 'model:', process.env.CLAUDE_MODEL || 'claude-sonnet-4-6');

  while (iterationCount < MAX_LOOP_ITERATIONS) {
    iterationCount++;

    const apiMessages = await db.getApiMessages(from);
    console.error('[pipeline] Calling Claude, iteration', iterationCount, 'messages:', apiMessages.length);

    const response = await anthropic.messages.create({
      model:      process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
      system:     [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages:   apiMessages,
      tools:      claudeTools,
      max_tokens: 1024,
    });
    console.error('[pipeline] Claude responded, stop_reason:', response.stop_reason, 'blocks:', response.content.length);

    await db.addMessage(from, 'assistant', response.content, null, Date.now());

    if (response.stop_reason === 'end_turn' || response.stop_reason === 'max_tokens') {
      const text = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n')
        .trim();
      console.error('[pipeline] Sending text reply, length:', text.length);
      if (text) await sendTextMessage(from, text);
      console.error('[pipeline] Done for', from);
      break;
    }

    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');

      const results = await Promise.all(
        toolUseBlocks.map(async (block) => {
          try {
            const result = await executeTool(block.name, { ...block.input, _customerPhone: from });
            if (block.name === 'qualify_lead' && block.input.service) {
              session.domain = block.input.service;
              await db.upsertSession(from, session);
            }
            if (block.name === 'escalate_to_human') {
              session.escalated = true;
              await db.upsertSession(from, session);
            }
            return { id: block.id, result: String(result) };
          } catch (err) {
            console.error(`[pipeline] Tool error (${block.name}):`, err.message);
            return { id: block.id, result: `Tool error: ${err.message}` };
          }
        })
      );

      const toolResultContent = results.map(({ id, result }) => ({
        type:        'tool_result',
        tool_use_id: id,
        content:     result,
      }));

      await db.addMessage(from, 'user', toolResultContent, null, Date.now());

      if (results.some(r => r.result.startsWith('SENT_DIRECTLY:'))) {
        console.error('[pipeline] Tool sent reply directly — skipping Claude iteration');
        break;
      }

      continue;
    }

    console.error('[pipeline] Unexpected stop_reason:', response.stop_reason);
    break;
  }

  if (iterationCount >= MAX_LOOP_ITERATIONS) {
    console.error('[pipeline] Agentic loop exceeded max iterations for:', from);
    await sendTextMessage(from,
      "I apologise — I'm having trouble processing your request right now. Please contact us at +254 768 117 070 or try again in a moment."
    );
  }
}

// ── Admin controls ────────────────────────────────────────────────────────────

async function pauseSession(phone) {
  const s = await db.getSession(phone);
  if (!s) return;
  s.humanTakeover = true;
  await db.upsertSession(phone, s);
}

async function resumeSession(phone) {
  const s = await db.getSession(phone);
  if (!s) return;
  s.humanTakeover = false;
  await db.upsertSession(phone, s);
}

async function appendAdminMessage(phone, text) {
  let s = await db.getSession(phone);
  if (!s) {
    s = { domain: null, lastSeen: Date.now(), escalated: false, humanTakeover: true };
    await db.upsertSession(phone, s);
  }
  await db.addMessage(phone, 'assistant', [{ type: 'text', text }], 'human', Date.now());
  s.lastSeen = Date.now();
  await db.upsertSession(phone, s);
}

module.exports = { processMessage, processImageMessage, pauseSession, resumeSession, appendAdminMessage };
