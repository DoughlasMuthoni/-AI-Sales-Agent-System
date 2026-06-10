const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { toolDefinitions } = require('./tools.js');
const { sendLeadNotification, sendCallbackNotification, sendEscalationNotification } = require('../services/email.js');
const { sendTextMessage, sendCatalogMessage, sendProductMessage, sendProductListMessage } = require('../services/whatsapp.js');
const db = require('../services/db.js');

// Pricing in Kenyan Shillings (KShs) — indicative ranges only
const SOLAR_RATES = {
  backup: {
    residential: { ranges: [[1,3,'180,000','350,000'], [3,5,'320,000','650,000'], [5,10,'600,000','1,100,000']] },
    commercial:  { ranges: [[3,5,'400,000','750,000'], [5,10,'700,000','1,300,000'], [10,25,'1,200,000','2,500,000']] },
    agricultural: { ranges: [[1,3,'200,000','380,000'], [3,5,'350,000','700,000'], [5,10,'650,000','1,200,000']] },
  },
  gridtied: {
    residential: { ranges: [[1,3,'140,000','280,000'], [3,5,'220,000','420,000'], [5,10,'380,000','750,000']] },
    commercial:  { ranges: [[5,10,'450,000','850,000'], [10,25,'900,000','1,800,000']] },
    agricultural: { ranges: [[3,5,'250,000','480,000'], [5,10,'420,000','800,000']] },
  },
  pumping: {
    any: { ranges: [[0,2,'80,000','200,000'], [2,5,'180,000','380,000'], [5,11,'350,000','650,000']] },
  },
  heating: {
    any: { '200L': 'KShs 138,600', '300L': 'KShs 194,000', 'heat_pump_300L': 'KShs 291,555' },
  },
};

const BOREHOLE_RATES = {
  perMetre: { min: 1800, max: 3200 },
  pump: { min: 50000, max: 180000 },
  rehabilitation: { min: 40000, max: 120000 },
  defaultDepth: { residential: 80, commercial: 100, agricultural: 90 },
};

function getSolarQuote(system_size_kw, location, property_type, system_type) {
  const kw = system_size_kw || 5;
  const type = (system_type || 'backup').toLowerCase();
  const prop = property_type || 'residential';

  if (type.includes('pump') || type.includes('water')) {
    const ranges = SOLAR_RATES.pumping.any.ranges;
    const range = ranges.find(r => kw >= r[0] && kw <= r[1]) || ranges[ranges.length - 1];
    return (
      `Indicative price range for a ${kw}kW solar water pumping system (${location}):\n` +
      `💰 KShs ${range[2]} – KShs ${range[3]}\n\n` +
      `Includes solar panels, INVT pumping inverter, submersible pump, cabling, and installation. ` +
      `A site assessment is required for a firm quote.`
    );
  }

  if (type.includes('heat') || type.includes('geyser') || type.includes('hot water')) {
    return (
      `Solar water heater pricing:\n` +
      `☀️ 200-litre pressurised system: KShs 138,600\n` +
      `☀️ 300-litre pressurised system: KShs 194,000\n` +
      `💧 300-litre Heat Pump: KShs 291,555\n\n` +
      `Prices include supply and installation. Contact us at +254 768 117 070 to order.`
    );
  }

  const rateTable = type.includes('grid') ? SOLAR_RATES.gridtied : SOLAR_RATES.backup;
  const propRates = rateTable[prop] || rateTable.residential;
  const range = propRates.ranges.find(r => kw >= r[0] && kw <= r[1]) || propRates.ranges[propRates.ranges.length - 1];
  const systemLabel = type.includes('grid') ? 'grid-tied' : 'solar backup (off-grid)';

  return (
    `Indicative price range for a ${kw}kW ${systemLabel} solar system (${prop}, ${location}):\n` +
    `💰 KShs ${range[2]} – KShs ${range[3]}\n\n` +
    `Includes solar panels, inverter, batteries (backup systems), mounting, cabling, and installation. ` +
    `${type.includes('grid') ? 'Grid-tied systems can save over 70% on your electricity bill.' : 'Backup systems provide power independence and average 50% electricity savings.'} ` +
    `A free site survey is conducted before installation. Contact: +254 768 117 070`
  );
}

function getBoreholeQuote(borehole_depth_m, location, property_type, is_rehabilitation) {
  if (is_rehabilitation) {
    return (
      `Indicative price range for borehole rehabilitation (${location}):\n` +
      `💰 KShs ${BOREHOLE_RATES.rehabilitation.min.toLocaleString()} – KShs ${BOREHOLE_RATES.rehabilitation.max.toLocaleString()}\n\n` +
      `Includes deep cleaning, unblocking, pump inspection, and flow optimisation. ` +
      `Actual cost depends on borehole condition and depth. A site inspection is required first. ` +
      `Contact: +254 768 117 070`
    );
  }

  const depth = borehole_depth_m || BOREHOLE_RATES.defaultDepth[property_type] || 80;
  const drillLow = depth * BOREHOLE_RATES.perMetre.min;
  const drillHigh = depth * BOREHOLE_RATES.perMetre.max;
  const totalLow = drillLow + BOREHOLE_RATES.pump.min;
  const totalHigh = drillHigh + BOREHOLE_RATES.pump.max;

  return (
    `Indicative price range for a new borehole (~${depth}m depth, ${property_type}, ${location}):\n` +
    `💰 KShs ${totalLow.toLocaleString()} – KShs ${totalHigh.toLocaleString()}\n\n` +
    `Includes hydrogeological survey, drilling, PVC/steel casing, submersible pump, test pumping, and water quality testing. ` +
    `Actual depth depends on site geology — our team serves 40+ counties across Kenya. ` +
    `Typical yield: 1,000–20,000+ litres per hour. A free site assessment is required for a firm quote.\n` +
    `Contact: +254 768 117 070 | support@waterliftsolar.africa`
  );
}

const toolHandlers = {
  async qualify_lead(input) {
    const lead = { ...input, status: 'new', capturedAt: new Date().toISOString() };
    await db.insertLead(lead);
    console.error('[MCP] Lead qualified:', input.name, input.phone);
    sendLeadNotification(lead);
    return `Lead captured for ${input.name} (${input.location}) — ${input.service} / ${input.property_type}. Our team will follow up at ${input.phone}.`;
  },

  async schedule_callback(input) {
    const booking = { ...input, bookedAt: new Date().toISOString() };
    await db.insertCallback(booking);
    console.error('[MCP] Callback scheduled:', input.name, input.preferred_date);
    sendCallbackNotification(booking);
    return `Callback confirmed for ${input.name} on ${input.preferred_date} at ${input.preferred_time}. Our consultant will call ${input.phone}. ${input.notes ? 'Notes: ' + input.notes : ''}`;
  },

  async send_quote(input) {
    const { service, system_size_kw, borehole_depth_m, location, property_type, system_type, is_rehabilitation } = input;
    if (service === 'solar') return getSolarQuote(system_size_kw, location, property_type, system_type);
    if (service === 'borehole') return getBoreholeQuote(borehole_depth_m, location, property_type, is_rehabilitation);
    return 'Unable to generate a quote — please contact us at +254 768 117 070 or support@waterliftsolar.africa';
  },

  async show_products(input) {
    const { type, product_ids, section_title, body_text, _customerPhone } = input;

    if (!_customerPhone) {
      return 'Unable to send catalog — customer phone number not available.';
    }
    if (!process.env.WHATSAPP_CATALOG_ID && type !== 'catalog') {
      return 'WHATSAPP_CATALOG_ID is not set in .env — cannot send product cards. Please add your Catalog ID.';
    }

    try {
      if (type === 'catalog') {
        await sendCatalogMessage(_customerPhone, body_text);
        return 'Product catalog sent to customer. They can now browse all Waterlift products directly inside WhatsApp.';
      }

      if (type === 'single') {
        const id = product_ids && product_ids[0];
        if (!id) return 'No product ID provided. Please specify a product_id to send a single product card.';
        await sendProductMessage(_customerPhone, id, body_text);
        return 'Product card sent to customer.';
      }

      if (type === 'list') {
        if (!product_ids || product_ids.length === 0) {
          return 'No product IDs provided. Please specify product_ids for the list.';
        }
        if (product_ids.length > 30) {
          return 'Too many products — WhatsApp supports a maximum of 30 products per list.';
        }
        await sendProductListMessage(_customerPhone, product_ids, section_title, body_text);
        return `Product list sent with ${product_ids.length} items under "${section_title || 'Products'}".`;
      }

      return 'Unknown product display type. Use: catalog, single, or list.';
    } catch (err) {
      console.error('[MCP] show_products error:', err.message);
      if (_customerPhone) {
        try {
          await sendTextMessage(_customerPhone,
            'You can browse our full product range at waterliftsolar.africa/shop — or tell me what you are looking for and I will share the details and pricing directly.');
        } catch (e) { console.error('[MCP] Fallback text failed:', e.message); }
      }
      return 'SENT_DIRECTLY: catalog unavailable, customer sent website link.';
    }
  },

  async escalate_to_human(input) {
    const record = { ...input, escalatedAt: new Date().toISOString() };
    await db.insertEscalation(record);
    console.error('[MCP] ESCALATION:', input.customer_name, input.urgency);
    sendEscalationNotification(record);
    const urgencyMsg = input.urgency === 'high'
      ? 'A team member will contact you as soon as possible.'
      : 'A team member will follow up with you shortly.';
    return `Thank you${input.customer_name ? `, ${input.customer_name}` : ''}. I have flagged your query for our specialist team — ${urgencyMsg} You can also reach us directly at +254 768 117 070.`;
  },
};

const mcpServer = new Server(
  { name: 'ai-sales-agent-tools', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolDefinitions.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const result = await executeTool(request.params.name, request.params.arguments || {});
  return { content: [{ type: 'text', text: result }] };
});

async function executeTool(name, input) {
  const handler = toolHandlers[name];
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  return await handler(input);
}

module.exports = { mcpServer, executeTool };
