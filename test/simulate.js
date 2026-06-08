/**
 * Simulates an incoming WhatsApp conversation without any Meta credentials.
 * Only requires ANTHROPIC_API_KEY in your .env file.
 *
 * Usage:
 *   node test/simulate.js
 *   node test/simulate.js borehole
 */

import 'dotenv/config';

// Intercept WhatsApp Graph API calls before importing the pipeline.
// This replaces the global fetch for graph.facebook.com URLs only,
// so the Anthropic SDK (which also uses fetch) is unaffected.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (typeof url === 'string' && url.includes('graph.facebook.com')) {
    const payload = options?.body ? JSON.parse(options.body) : {};

    if (payload.type === 'text') {
      const to = payload.to;
      const text = payload.text?.body ?? '';
      console.log('\n' + '─'.repeat(60));
      console.log(`📲  AGENT REPLY → ${to}`);
      console.log('─'.repeat(60));
      console.log(text);
      console.log('─'.repeat(60) + '\n');
    }
    // Simulate a successful Meta API response
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'sim_msg_001' }] }) };
  }
  return realFetch(url, options);
};

// Import pipeline AFTER patching fetch
const { processMessage } = await import('../src/agent/pipeline.js');

// ─── Conversation scripts ──────────────────────────────────────────────────

const conversations = {
  solar: [
    'Hi, I want to know about solar panels for my home',
    'I spend about $150 a month on electricity. I live in Cape Town.',
    'What would a 5kW system cost me?',
    'Sounds good. My name is John Dlamini, number is 0821234567. Can someone call me on Friday morning?',
  ],
  borehole: [
    'Good day, I need a borehole on my farm',
    'The farm is in Limpopo, about 50 hectares. We need water for livestock and irrigation.',
    'How deep do you normally drill in that area and what does it cost?',
    'Please book a site visit. I am free on Friday morning. Name is Sipho Nkosi.',
  ],
};

const domain = process.argv[2] ?? 'solar';
const messages = conversations[domain] ?? conversations.solar;
const testPhone = '27821234567';

console.log(`\n🧪  Simulating ${domain.toUpperCase()} conversation (${messages.length} turns)\n`);

for (let i = 0; i < messages.length; i++) {
  console.log(`👤  USER [turn ${i + 1}/${messages.length}]: ${messages[i]}`);
  await processMessage(testPhone, messages[i], `sim_msg_${Date.now()}`);
}

console.log('\n✅  Simulation complete.\n');
