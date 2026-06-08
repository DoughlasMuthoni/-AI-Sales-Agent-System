const fs   = require('fs');
const path = require('path');
const { default: Anthropic } = require('@anthropic-ai/sdk');
const { SOLAR_SYSTEM_PROMPT, BOREHOLE_SYSTEM_PROMPT } = require('./prompts.js');
const { sendTextMessage, sendTypingIndicator } = require('../services/whatsapp.js');
const { executeTool } = require('../mcp/mcpServer.js');
const { toolDefinitions } = require('../mcp/tools.js');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SESSION_TTL_MS    = 24 * 60 * 60 * 1000;
const MAX_LOOP_ITERATIONS = 10;
const SESSIONS_FILE     = path.join(__dirname, '../../data/sessions.json');

// ── Persistent session store ──────────────────────────────────────────────────

function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const raw  = fs.readFileSync(SESSIONS_FILE, 'utf8');
      const data = JSON.parse(raw);
      const now  = Date.now();
      const map  = new Map();
      for (const [phone, session] of Object.entries(data)) {
        if (now - session.lastSeen < SESSION_TTL_MS) map.set(phone, session);
      }
      console.log(`[sessions] Loaded ${map.size} active sessions from disk`);
      return map;
    }
  } catch (err) {
    console.error('[sessions] Failed to load sessions:', err.message);
  }
  return new Map();
}

function saveSessions(map) {
  try {
    fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(map), null, 2));
  } catch (err) {
    console.error('[sessions] Failed to save sessions:', err.message);
  }
}

const sessions = loadSessions();

// ── Domain detection ──────────────────────────────────────────────────────────

const SOLAR_KEYWORDS    = ['solar', 'panel', 'panels', 'inverter', 'battery', 'electricity',
                           'energy', 'grid', 'power', 'watt', 'kilowatt', 'kw', 'photovoltaic',
                           'pv', 'load', 'geyser', 'backup', 'lights', 'appliance'];
const BOREHOLE_KEYWORDS = ['borehole', 'water', 'drilling', 'drill', 'pump', 'well', 'aquifer',
                           'groundwater', 'irrigation', 'tank', 'jojo', 'municipal', 'bore',
                           'waterless', 'harvest', 'supply'];

function detectDomain(text) {
  const lower        = text.toLowerCase();
  const solarScore   = SOLAR_KEYWORDS.filter((kw) => lower.includes(kw)).length;
  const boreholeScore = BOREHOLE_KEYWORDS.filter((kw) => lower.includes(kw)).length;
  if (solarScore > boreholeScore) return 'solar';
  if (boreholeScore > solarScore) return 'borehole';
  return null;
}

// ── System prompts ────────────────────────────────────────────────────────────

const GENERAL_PROMPT = `You are a friendly sales assistant for Waterlift Solar Limited, a premium company providing Solar Energy Solutions and Borehole Drilling Services across Kenya.

Greet the customer warmly and ask which service they are interested in:
1. ☀️ Solar Energy Solutions (backup power, grid-tied, solar water heating, solar pumping)
2. 💧 Borehole Drilling Services (new drilling, rehabilitation, water pumping systems)

Once they indicate their interest, proceed as a specialist in that domain.
Contact: +254 768 117 070 | support@waterliftsolar.africa`;

function getSystemPrompt(domain) {
  if (domain === 'solar')    return SOLAR_SYSTEM_PROMPT;
  if (domain === 'borehole') return BOREHOLE_SYSTEM_PROMPT;
  return GENERAL_PROMPT;
}

// ── Core pipeline ─────────────────────────────────────────────────────────────

const claudeTools = toolDefinitions.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.inputSchema,
}));

async function processMessage(from, messageBody, messageId) {
  const now = Date.now();
  // Load or create session
  let session = sessions.get(from);
  if (!session || now - session.lastSeen > SESSION_TTL_MS) {
    session = { domain: null, messages: [], lastSeen: now, escalated: false };
  }

  // Only detect domain if not yet established
  if (!session.domain) {
    session.domain = detectDomain(messageBody);
  }

  session.lastSeen = now;
  session.messages.push({ role: 'user', content: messageBody });
  sessions.set(from, session);
  saveSessions(sessions);

  await sendTypingIndicator(from, messageId);

  const systemPrompt    = getSystemPrompt(session.domain);
  let   iterationCount  = 0;
  while (iterationCount < MAX_LOOP_ITERATIONS) {
    iterationCount++;

    const response = await anthropic.messages.create({
      model:      process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
      system:     systemPrompt,
      messages:   session.messages,
      tools:      claudeTools,
      max_tokens: 1024,
    });

    session.messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn' || response.stop_reason === 'max_tokens') {
      const text = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();

      if (text) await sendTextMessage(from, text);
      break;
    }

    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');

      const results = await Promise.all(
        toolUseBlocks.map(async (block) => {
          try {
            const result = await executeTool(block.name, block.input);

            if (block.name === 'qualify_lead' && block.input.service) {
              session.domain = block.input.service;
            }
            if (block.name === 'escalate_to_human') {
              session.escalated = true;
            }

            return { id: block.id, result: String(result) };
          } catch (err) {
            console.error(`[pipeline] Tool error (${block.name}):`, err.message);
            return { id: block.id, result: `Tool error: ${err.message}` };
          }
        })
      );

      session.messages.push({
        role:    'user',
        content: results.map(({ id, result }) => ({
          type:        'tool_result',
          tool_use_id: id,
          content:     result,
        })),
      });

      continue;
    }

    console.warn('[pipeline] Unexpected stop_reason:', response.stop_reason);
    break;
  }

  if (iterationCount >= MAX_LOOP_ITERATIONS) {
    console.error('[pipeline] Agentic loop exceeded max iterations for:', from);
    await sendTextMessage(from,
      "I apologise — I'm having trouble processing your request right now. Please contact us at +254 768 117 070 or try again in a moment."
    );
  }

  sessions.set(from, session);
  saveSessions(sessions);
}

module.exports = { processMessage };
