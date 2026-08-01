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

// Serializes pipeline runs per phone so two Claude loops never run concurrently for the same
// conversation (which would race on session/message state), WITHOUT dropping messages that
// arrive while a previous one is still in flight. A customer sending two messages seconds apart
// is normal WhatsApp behavior, not a duplicate — the earlier Set-based "drop if already
// processing" approach silently lost the second message (never saved, never replied to) instead
// of queuing it. True webhook retries are already deduped separately by isDuplicate(messageId)
// in webhook.js, so this only ever needs to order genuinely distinct messages, not filter them.
const chains = new Map(); // phone -> tail promise of its queued pipeline runs

function enqueue(phone, task) {
  const prev = chains.get(phone) || Promise.resolve();
  const next = prev.then(task, task).finally(() => {
    if (chains.get(phone) === next) chains.delete(phone);
  });
  chains.set(phone, next);
  return next;
}

// ── Domain detection ──────────────────────────────────────────────────────


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
Contact: +254 768 117 070 | info@waterlift.co.ke

Customers may also send photos (electricity meter, appliance nameplate, site photos, existing borehole/pump equipment, etc.) — examine them carefully and use what you see to help identify their service interest.

Customers may also send videos. You cannot actually watch a video — you'll see a system note saying one was received. Never pretend to have watched it. Acknowledge it warmly, mention a team member will review it, and continue the conversation.

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

async function processMessage(from, messageBody, messageId, referral = null, replyToWaId = null) {
  await enqueue(from, () => _processMessage(from, messageBody, messageId, referral, replyToWaId));
}

async function processImageMessage(from, media, caption, messageId, replyToWaId = null) {
  await enqueue(from, () => _processImageMessage(from, media, caption, messageId, replyToWaId));
}

async function processVideoMessage(from, video, caption, messageId, replyToWaId = null) {
  await enqueue(from, () => _processVideoMessage(from, video, caption, messageId, replyToWaId));
}

// Looks up the message a customer swiped-to-reply to (if any) and builds a small
// snapshot for the admin dashboard to render — a live DB join isn't worth it since
// this is purely a UI affordance, not something Claude needs to see.
async function buildReplyContext(from, replyToWaId) {
  if (!replyToWaId) return null;
  const target = await db.getMessageByWaId(from, replyToWaId);
  if (!target) return null;
  let preview = '';
  if (typeof target.content === 'string') preview = target.content;
  else if (Array.isArray(target.content)) {
    const textBlock = target.content.find(b => b.type === 'text');
    const docBlock   = target.content.find(b => b.type === 'document');
    const imgBlock    = target.content.find(b => b.type === 'image');
    const vidBlock    = target.content.find(b => b.type === 'video');
    if (textBlock) preview = textBlock.text;
    else if (docBlock) preview = '📄 ' + docBlock.filename;
    else if (imgBlock) preview = '📷 Photo';
    else if (vidBlock) preview = '🎥 Video';
  }
  const sender = target.role === 'user' ? 'customer' : (target.source === 'human' ? 'agent' : 'ai');
  return { waMessageId: replyToWaId, preview: String(preview).slice(0, 120), sender };
}

async function _processMessage(from, messageBody, messageId, referral = null, replyToWaId = null) {
  const now = Date.now();
  const replyContext = await buildReplyContext(from, replyToWaId);

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
    await db.addMessage(from, 'user', messageBody, null, now, messageId, replyContext);
    await db.upsertSession(from, session);
    return;
  }

  // Number is blocked — still log the message (so the admin can see they keep messaging) but
  // never let the AI reply, same effect as human takeover, until explicitly unblocked.
  if (await db.isPhoneBlocked(from)) {
    session.lastSeen = now;
    await db.addMessage(from, 'user', messageBody, null, now, messageId, replyContext);
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
    // Keep first-touch attribution — record which ad brought this customer in, for the admin dashboard
    if (!session.adReferral && (referral.headline || referral.body || productNote)) {
      session.adReferral = {
        headline:   referral.headline || null,
        body:       referral.body || null,
        productId:  referral.product?.product_id || null,
        catalogId:  referral.product?.catalog_id || null,
        capturedAt: now,
      };
    }
  }

  session.lastSeen = now;
  await db.addMessage(from, 'user', messageBody, null, now, messageId, replyContext);
  await db.upsertSession(from, session);

  await sendTypingIndicator(from, messageId);

  const systemPrompt = getSystemPrompt(session.domain);
  await runAgenticLoop(from, session, systemPrompt);
}

// Customer sent an image (with an optional caption) — analyzed via Claude's vision input
async function _processImageMessage(from, media, caption, messageId, replyToWaId = null) {
  const now = Date.now();
  const replyContext = await buildReplyContext(from, replyToWaId);

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
    await db.addMessage(from, 'user', contentBlocks, null, now, messageId, replyContext);
    await db.upsertSession(from, session);
    return;
  }

  // Number is blocked — still log the image but never let the AI reply
  if (await db.isPhoneBlocked(from)) {
    session.lastSeen = now;
    await db.addMessage(from, 'user', contentBlocks, null, now, messageId, replyContext);
    await db.upsertSession(from, session);
    return;
  }

  if (caption) {
    const detected = detectDomain(caption);
    if (detected) session.domain = detected;
  }

  session.lastSeen = now;
  await db.addMessage(from, 'user', contentBlocks, null, now, messageId, replyContext);
  await db.upsertSession(from, session);

  await sendTypingIndicator(from, messageId);

  const systemPrompt = getSystemPrompt(session.domain);
  await runAgenticLoop(from, session, systemPrompt);
}

// Customer sent a video. Claude has no native video-understanding input (unlike images), so
// the file is stored (viewable in the admin dashboard, same as documents) and the session is
// flagged escalated so a human actually watches it — db.sanitizeForClaude swaps the stored
// `video` block for a plain text marker before it ever reaches the Claude API, and the system
// prompts tell Claude to acknowledge it honestly rather than pretend to have seen it.
async function _processVideoMessage(from, video, caption, messageId, replyToWaId = null) {
  const now = Date.now();
  const replyContext = await buildReplyContext(from, replyToWaId);

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
    { type: 'video', storedAs: video.storedAs, mimeType: video.mimeType, filename: video.filename },
  ];
  if (caption) contentBlocks.push({ type: 'text', text: caption });

  session.escalated = true; // a video needs a human to actually watch it

  // Human has taken over — record the customer's video but don't respond with AI
  if (session.humanTakeover) {
    session.lastSeen = now;
    await db.addMessage(from, 'user', contentBlocks, null, now, messageId, replyContext);
    await db.upsertSession(from, session);
    return;
  }

  // Number is blocked — still log the video but never let the AI reply
  if (await db.isPhoneBlocked(from)) {
    session.lastSeen = now;
    await db.addMessage(from, 'user', contentBlocks, null, now, messageId, replyContext);
    await db.upsertSession(from, session);
    return;
  }

  if (caption) {
    const detected = detectDomain(caption);
    if (detected) session.domain = detected;
  }

  session.lastSeen = now;
  await db.addMessage(from, 'user', contentBlocks, null, now, messageId, replyContext);
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

    const assistantMsgId = await db.addMessage(from, 'assistant', response.content, null, Date.now());

    if (response.stop_reason === 'end_turn' || response.stop_reason === 'max_tokens') {
      // response.content can still contain tool_use blocks here — e.g. Claude hit the
      // max_tokens cap mid-tool-call, or (defensively) end_turn arrived alongside a tool call.
      // We just saved the FULL content (including those blocks) to history above, so if we
      // stopped the loop here without resolving them, they'd sit in the DB as a tool_use with no
      // matching tool_result forever — and Claude's API rejects ANY future call for this
      // conversation outright (400: "tool_use ids were found without tool_result blocks") until
      // enough later messages push the orphaned pair out of the trimmed history window. Always
      // synthesize a tool_result for any leftover tool_use before breaking, so the invariant
      // "every tool_use is immediately followed by tool_result" never gets violated.
      const orphanedToolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      if (orphanedToolUseBlocks.length) {
        console.error('[pipeline]', orphanedToolUseBlocks.length, 'tool_use block(s) left unresolved at stop_reason', response.stop_reason, '— synthesizing tool_result to keep history valid');
        const orphanResultContent = orphanedToolUseBlocks.map(block => ({
          type:        'tool_result',
          tool_use_id: block.id,
          content:     'Response was truncated before this tool call could complete — it was not executed.',
          is_error:    true,
        }));
        await db.addMessage(from, 'user', orphanResultContent, null, Date.now());
      }

      const text = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n')
        .trim();
      console.error('[pipeline] Sending text reply, length:', text.length);
      if (text) {
        try {
          const sendResult = await sendTextMessage(from, text);
          const waId = sendResult?.messages?.[0]?.id;
          if (waId) await db.setMessageWaId(assistantMsgId, waId);
        } catch (err) {
          console.error('[pipeline] sendTextMessage failed:', err.message);
        }
      }
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

async function appendAdminMessage(phone, text, waMessageId = null, replyContext = null) {
  let s = await db.getSession(phone);
  if (!s) {
    s = { domain: null, lastSeen: Date.now(), escalated: false, humanTakeover: true };
    await db.upsertSession(phone, s);
  }
  const id = await db.addMessage(phone, 'assistant', [{ type: 'text', text }], 'human', Date.now(), waMessageId, replyContext);
  s.lastSeen = Date.now();
  await db.upsertSession(phone, s);
  return id;
}

async function appendAdminDocumentMessage(phone, filename, caption, storedAs, waMessageId = null, replyContext = null) {
  let s = await db.getSession(phone);
  if (!s) {
    s = { domain: null, lastSeen: Date.now(), escalated: false, humanTakeover: true };
    await db.upsertSession(phone, s);
  }
  const id = await db.addMessage(phone, 'assistant', [{ type: 'document', filename, caption: caption || null, storedAs: storedAs || null }], 'human', Date.now(), waMessageId, replyContext);
  s.lastSeen = Date.now();
  await db.upsertSession(phone, s);
  return id;
}

// Deliberately has no `source` field (unlike a customer-sent image block, which carries real
// base64 image data for Claude to analyze) — this distinguishes an admin-sent photo from
// Claude's reserved `image` content-block schema. See db.js's sanitizeForClaude for why that
// distinction matters.
async function appendAdminImageMessage(phone, filename, caption, storedAs, waMessageId = null, replyContext = null) {
  let s = await db.getSession(phone);
  if (!s) {
    s = { domain: null, lastSeen: Date.now(), escalated: false, humanTakeover: true };
    await db.upsertSession(phone, s);
  }
  const id = await db.addMessage(phone, 'assistant', [{ type: 'image', filename, caption: caption || null, storedAs: storedAs || null }], 'human', Date.now(), waMessageId, replyContext);
  s.lastSeen = Date.now();
  await db.upsertSession(phone, s);
  return id;
}

module.exports = { processMessage, processImageMessage, processVideoMessage, pauseSession, resumeSession, appendAdminMessage, appendAdminDocumentMessage, appendAdminImageMessage };
