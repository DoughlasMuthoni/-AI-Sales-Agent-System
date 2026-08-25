const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { toolDefinitions } = require('./tools.js');
const { sendLeadNotification, sendCallbackNotification, sendEscalationNotification } = require('../services/email.js');
const { sendTextMessage, sendCatalogMessage, sendProductMessage, sendProductListMessage } = require('../services/whatsapp.js');
const { normalizePhone } = require('../utils/phone.js');
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

// perMetre/pump/defaultDepth rate estimates were removed 2026-07 — they were never validated
// against real costs and gave customers untrustworthy numbers in chat (see CLAUDE.md item 9).
// New-drilling quotes now always defer to schedule_callback instead of a chat estimate.
const BOREHOLE_RATES = {
  rehabilitation: { min: 40000, max: 120000 },
};

// Elevated steel water towers — not in the live product feed (see prompts.js), so this
// pricing is admin-editable via its own DB tables (tower_packages/tower_tank_prices/
// tower_foundation_prices — see schema.sql and the "Tower Pricing" admin tab) instead of the
// product feed. All prices include 16% VAT + installation.

// Internal tankType stays 'plastic' (matches the DB rows) — this is only for customer-facing
// text, since Waterlift specifically uses Jojo-brand plastic tanks.
const TANK_TYPE_DISPLAY = { plastic: 'Jojo', steel: 'steel' };

function normalizeCapacityKey(tankCapacity) {
  return String(tankCapacity || '').toLowerCase().replace(/[\s,]/g, '');
}

function tankPriceLabel(tankType, capacityLabel) {
  const t = TANK_TYPE_DISPLAY[tankType] || tankType;
  const capitalized = t.charAt(0).toUpperCase() + t.slice(1);
  return `${capitalized} tank, ${capacityLabel}`;
}

// Loads all three tower pricing tables from the DB and shapes them into the in-memory form
// the matching logic below expects. Queried fresh each time rather than cached — this is a
// small table (a couple dozen rows) only read when a tower quote/PDF is actually requested,
// not on every chat message, so a live query is cheap and always reflects the latest edit.
async function loadTowerPricing() {
  const [foundationRows, tankRows, packageRows] = await Promise.all([
    db.getTowerFoundationPrices(),
    db.getTowerTankPrices(),
    db.getTowerPackages(),
  ]);

  const foundationPrices = {};
  foundationRows.forEach(r => { foundationPrices[r.foundation_type] = Number(r.price); });

  const tankPrices = {};
  tankRows.forEach(r => {
    tankPrices[`${r.tank_type}:${r.capacity_key}`] = {
      label: tankPriceLabel(r.tank_type, r.capacity_label),
      price: Number(r.price),
    };
  });

  const packages = packageRows.map(r => ({
    height: Number(r.height_m),
    tankCount: Number(r.tank_count),
    tankType: r.tank_type,
    capacityKey: r.capacity_key,
    capacityLabel: r.capacity_label,
    foundation: r.foundation_type.charAt(0).toUpperCase() + r.foundation_type.slice(1),
    fabricationPrice: Number(r.fabrication_price),
  }));

  return { foundationPrices, tankPrices, packages };
}

function matchTowerPackage(packages, height, count, tank_type, capKey) {
  // Multiple packages can share height/count/type (e.g. 12m steel comes in 24m³/48m³/50m³/
  // 100m³), so capacity MUST be given to disambiguate — don't silently fall back to the first.
  const candidates = packages.filter(p =>
    (!height || p.height === height) &&
    (!count || p.tankCount === count) &&
    (!tank_type || p.tankType === tank_type)
  );
  return candidates.length === 1 && !capKey
    ? candidates[0]
    : candidates.find(p => capKey && p.capacityKey === capKey);
}

async function getTowerQuote(tower_height_m, tank_count, tank_type, tank_capacity, location, structure_only) {
  const { foundationPrices, tankPrices, packages } = await loadTowerPricing();
  const height = Number(tower_height_m) || null;
  const count  = Number(tank_count) || null;
  const capKey = normalizeCapacityKey(tank_capacity);

  const pkg = matchTowerPackage(packages, height, count, tank_type, capKey);

  if (pkg) {
    if (structure_only) {
      return (
        `Steel structure/fabrication price ONLY (excludes foundation and tank) for a ${pkg.height}m elevated steel water tower${location ? ' (' + location + ')' : ''}:\n` +
        `💰 KShs ${pkg.fabricationPrice.toLocaleString()}\n\n` +
        `This is the tower structure alone — foundation and tank are priced separately (ask for the complete package price to see the full installed total). ` +
        `Final price is confirmed after a site visit. Prices valid 30 days.`
      );
    }
    const foundationPrice = foundationPrices[pkg.foundation.toLowerCase()];
    const tankInfo = tankPrices[`${pkg.tankType}:${pkg.capacityKey}`];
    const total = pkg.fabricationPrice + foundationPrice + tankInfo.price * pkg.tankCount;
    return (
      `Complete package price for a ${pkg.height}m elevated steel water tower with ${pkg.tankCount} x ${pkg.capacityLabel} ${TANK_TYPE_DISPLAY[pkg.tankType] || pkg.tankType} tank(s)${location ? ' (' + location + ')' : ''}:\n` +
      `💰 KShs ${total.toLocaleString()}\n\n` +
      `Includes the steel super structure, ${pkg.foundation} foundation, and the tank(s) — inclusive of 16% VAT and standard installation. ` +
      `Transport to site is quoted separately based on distance and accessibility. ` +
      `Final price is confirmed after a site visit (soil test determines Pad vs Raft foundation). Prices valid 30 days.`
    );
  }

  // No exact standard package match — instead of stalling with no number, give an honest
  // indicative range from whatever standard packages fit the details we DO have (fewer
  // details given = wider range). This lets a customer get a real price signal on the very
  // first ask instead of the agent gating any number behind a full battery of qualifying
  // questions. Narrows to an exact price once height+count+type+capacity all match a package
  // (handled by the pkg branch above).
  const candidates = packages.filter(p =>
    (!height || p.height === height) &&
    (!count || p.tankCount === count) &&
    (!tank_type || p.tankType === tank_type) &&
    (!capKey || p.capacityKey === capKey)
  );

  if (candidates.length) {
    if (structure_only) {
      const fabTotals = candidates.map(p => p.fabricationPrice);
      const fabMin = Math.min(...fabTotals);
      const fabMax = Math.max(...fabTotals);
      const knownBits = [
        height ? `${height}m height` : null,
        tank_type ? `${TANK_TYPE_DISPLAY[tank_type] || tank_type} tank` : null,
      ].filter(Boolean).join(', ');
      return (
        `Steel structure/fabrication price ONLY (excludes foundation and tank)${knownBits ? ' (' + knownBits + ')' : ''}${location ? ' — ' + location : ''}:\n` +
        `💰 KShs ${fabMin.toLocaleString()}${fabMin === fabMax ? '' : ' – KShs ' + fabMax.toLocaleString()}\n\n` +
        `This is the tower structure alone — foundation and tank are priced separately. Prices valid 30 days.`
      );
    }
    const totals = candidates.map(p => {
      const fp = foundationPrices[p.foundation.toLowerCase()];
      const ti = tankPrices[`${p.tankType}:${p.capacityKey}`];
      return p.fabricationPrice + fp + ti.price * p.tankCount;
    });
    const min = Math.min(...totals);
    const max = Math.max(...totals);
    const knownBits = [
      height ? `${height}m height` : null,
      count ? `${count} tank(s)` : null,
      tank_type ? `${TANK_TYPE_DISPLAY[tank_type] || tank_type} tank` : null,
    ].filter(Boolean).join(', ');

    return (
      `Indicative price range for an elevated steel water tower${knownBits ? ' (' + knownBits + ')' : ''}${location ? ' — ' + location : ''}:\n` +
      `💰 KShs ${min.toLocaleString()}${min === max ? '' : ' – KShs ' + max.toLocaleString()}\n\n` +
      (min === max
        ? `Includes the steel super structure, foundation, and tank(s) — inclusive of 16% VAT and standard installation. `
        : `The exact price depends on tank capacity/count and foundation type (confirmed on site visit) — share those and I'll narrow it to a precise figure. `) +
      `Transport to site is quoted separately based on distance and accessibility. Prices valid 30 days.`
    );
  }

  // Truly nothing matches even loosely (e.g. a non-standard height) — build a component
  // estimate instead of guessing a fabrication cost that doesn't scale linearly.
  const tankInfo = tank_type && capKey ? tankPrices[`${tank_type}:${capKey}`] : null;
  const foundationGuess = height && height >= 9 ? 'raft' : 'pad';
  const foundationPrice = foundationPrices[foundationGuess];

  const lines = [`This is a custom tower/tank combination outside our standard packages${location ? ' (' + location + ')' : ''} — here's an indicative breakdown:`];
  if (foundationPrice) lines.push(`Foundation (likely ${foundationGuess === 'raft' ? 'Raft' : 'Pad'}, confirmed on site visit): KShs ${foundationPrice.toLocaleString()}`);
  if (tankInfo) lines.push(`${tankInfo.label}: KShs ${tankInfo.price.toLocaleString()} each${count ? ' x ' + count : ''}`);
  lines.push('The super structure cost also scales with height and tank load — for an exact total, use schedule_callback so our team can prepare a tailored proposal.');
  return lines.join('\n');
}

// Itemized breakdown for the branded PDF quote (src/services/pdfQuote.js). Reuses the same
// DB-backed package/tank/foundation data as getTowerQuote() so the two never drift apart.
async function getTowerQuoteBreakdown(tower_height_m, tank_count, tank_type, tank_capacity) {
  const { foundationPrices, tankPrices, packages } = await loadTowerPricing();
  const height = Number(tower_height_m) || null;
  const count  = Number(tank_count) || null;
  const capKey = normalizeCapacityKey(tank_capacity);

  const pkg = matchTowerPackage(packages, height, count, tank_type, capKey);
  const tankInfo = tank_type && capKey ? tankPrices[`${tank_type}:${capKey}`] : null;

  if (pkg) {
    const foundationPrice = foundationPrices[pkg.foundation.toLowerCase()];
    const pkgTankInfo = tankPrices[`${pkg.tankType}:${pkg.capacityKey}`];
    const tankAmount = pkgTankInfo.price * pkg.tankCount;
    return {
      isStandard: true,
      height: pkg.height,
      tankCount: pkg.tankCount,
      tankType: pkg.tankType,
      capacityLabel: pkg.capacityLabel,
      foundationType: pkg.foundation,
      fabricationPrice: pkg.fabricationPrice,
      foundationPrice,
      tankUnitPrice: pkgTankInfo.price,
      tankAmount,
      grandTotal: pkg.fabricationPrice + foundationPrice + tankAmount,
    };
  }

  // No exact standard package — return what we can compute and leave the rest for a
  // tailored quote rather than guessing a fabrication cost that doesn't scale linearly.
  const foundationGuess = height && height >= 9 ? 'Raft' : 'Pad';
  const foundationPrice = foundationPrices[foundationGuess.toLowerCase()];
  const tankAmount = tankInfo ? tankInfo.price * (count || 1) : null;

  return {
    isStandard: false,
    height, tankCount: count, tankType: tank_type,
    capacityLabel: tankInfo ? tankInfo.label.split(', ').slice(1).join(', ') : (tank_capacity || null),
    foundationType: foundationGuess,
    fabricationPrice: null,
    foundationPrice,
    tankUnitPrice: tankInfo ? tankInfo.price : null,
    tankAmount,
    grandTotal: null,
  };
}

async function getSolarQuote(system_size_kw, location, property_type, system_type) {
  const kw = system_size_kw || 5;
  const type = (system_type || 'backup').toLowerCase();
  const prop = property_type || 'residential';

  if (type.includes('pump') || type.includes('water') && !type.includes('heat')) {
    const ranges = SOLAR_RATES.pumping.any.ranges;
    const range = ranges.find(r => kw >= r[0] && kw <= r[1]) || ranges[ranges.length - 1];
    return (
      `Indicative price range for a ${kw}kW solar water pumping system${location ? ' (' + location + ')' : ''}:\n` +
      `💰 KShs ${range[2]} – KShs ${range[3]}\n\n` +
      `Includes solar panels, INVT pumping inverter, submersible pump, cabling, and installation. ` +
      `A site assessment is required for a firm quote.`
    );
  }

  if (type.includes('heat') || type.includes('geyser') || type.includes('hot water')) {
    // Priced from the live catalog (not hardcoded) — see catalogSync.js. Falls back to a
    // generic message if the catalog hasn't been synced yet rather than showing stale numbers.
    const results = await db.searchProducts('heat pump water heater');
    if (!results.length) {
      return 'Solar water heaters and heat pumps (200L/300L) are available — use get_product_info or contact +254 768 117 070 for current pricing.';
    }
    const lines = results.map(p => `☀️ ${p.name}: KShs ${Number(p.price).toLocaleString()}`);
    return `Solar water heater pricing:\n${lines.join('\n')}\n\nPrices include supply and installation. Contact us at +254 768 117 070 to order.`;
  }

  const rateTable = type.includes('grid') ? SOLAR_RATES.gridtied : SOLAR_RATES.backup;
  const propRates = rateTable[prop] || rateTable.residential;
  const range = propRates.ranges.find(r => kw >= r[0] && kw <= r[1]) || propRates.ranges[propRates.ranges.length - 1];
  const systemLabel = type.includes('grid') ? 'grid-tied' : 'solar backup (off-grid)';

  return (
    `Indicative price range for a ${kw}kW ${systemLabel} solar system (${prop}${location ? ', ' + location : ''}):\n` +
    `💰 KShs ${range[2]} – KShs ${range[3]}\n\n` +
    `Includes solar panels, inverter, batteries (backup systems), mounting, cabling, and installation. ` +
    `${type.includes('grid') ? 'Grid-tied systems can save over 70% on your electricity bill.' : 'Backup systems provide power independence and average 50% electricity savings.'} ` +
    `A free site survey is conducted before installation. Contact: +254 768 117 070`
  );
}

function getBoreholeQuote(borehole_depth_m, location, property_type, is_rehabilitation) {
  if (is_rehabilitation) {
    return (
      `Indicative price range for borehole rehabilitation${location ? ' (' + location + ')' : ''}:\n` +
      `💰 KShs ${BOREHOLE_RATES.rehabilitation.min.toLocaleString()} – KShs ${BOREHOLE_RATES.rehabilitation.max.toLocaleString()}\n\n` +
      `Includes deep cleaning, unblocking, pump inspection, and flow optimisation. ` +
      `Actual cost depends on borehole condition and depth. A site inspection is required first. ` +
      `Contact: +254 768 117 070`
    );
  }

  // New drilling deliberately has NO numeric price/range here — drilling cost genuinely varies
  // too much by site (geology, depth, mobilization distance) to give a trustworthy estimate in
  // chat, and the real pricing tool (src/services/drillingCalc.js, driven by a full costing
  // engine) needs inputs a customer wouldn't naturally provide over WhatsApp. Always defer to
  // schedule_callback so the admin team can prepare an accurate quote from a site assessment.
  return (
    `Borehole drilling cost depends heavily on your specific site — depth, ground geology, and distance from our base all affect the price, so a number given in chat here could be significantly off. ` +
    `What I can do is get one of our drilling engineers to review your location and prepare an accurate written quote for you.\n\n` +
    `Let's book that — use schedule_callback, or share your location${property_type ? ' and confirm this is for a ' + property_type + ' property' : ''} and I'll arrange it. ` +
    `Contact: +254 768 117 070 | info@waterlift.co.ke`
  );
}

const toolHandlers = {
  async qualify_lead(input) {
    // Claude captures the phone as the customer typed it (e.g. "0712345678", "+254 712 345 678"),
    // which won't match the wa_id-format session key WhatsApp uses — normalizing here keeps the
    // Leads tab's phone in sync with the real conversation so admin actions (like sending a
    // quote) append to the existing chat instead of silently opening a new one.
    const lead = { ...input, phone: normalizePhone(input.phone), status: 'new', capturedAt: new Date().toISOString() };
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
    const {
      service, system_size_kw, borehole_depth_m, location, property_type, system_type, is_rehabilitation,
      is_tower_quote, tower_height_m, tank_count, tank_type, tank_capacity, structure_only,
    } = input;
    if (service === 'solar') return await getSolarQuote(system_size_kw, location, property_type, system_type);
    if (service === 'borehole') {
      if (is_tower_quote) return await getTowerQuote(tower_height_m, tank_count, tank_type, tank_capacity, location, structure_only);
      return getBoreholeQuote(borehole_depth_m, location, property_type, is_rehabilitation);
    }
    return 'Unable to generate a quote — please contact us at +254 768 117 070 or info@waterlift.co.ke';
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
      // "catalog" (browse-everything) has no specific product to fall back to describing,
      // so keep sending the website link directly for that case.
      if (type === 'catalog') {
        try {
          await sendTextMessage(_customerPhone,
            'You can browse our full product range at waterliftsolar.africa/shop — or tell me what you are looking for and I will share the details and pricing directly.');
        } catch (e) { console.error('[MCP] Fallback text failed:', e.message); }
        return 'SENT_DIRECTLY: catalog unavailable, customer sent website link.';
      }
      // "single"/"list" failures are usually one product not yet enabled for WhatsApp
      // even though it exists in the catalog (Meta returns 400 "not found" for it).
      // Claude already has this product's name/price/specs in its system prompt, so
      // let it compose a normal reply instead of a generic fallback — do NOT prefix
      // with SENT_DIRECTLY: so the pipeline loops back to Claude with this tool_result.
      return 'The interactive product card could not be sent — the product is not currently available through the WhatsApp API, even though it exists in the catalog (this can happen for items pending review or not yet enabled for WhatsApp). Describe the product to the customer directly in your reply instead, using its name, price, and key specs from get_product_info. Do not mention any technical error to the customer.';
    }
  },

  async get_product_info(input) {
    const { query } = input;
    if (!query || !query.trim()) return 'No search term provided.';
    const results = await db.searchProducts(query.trim());
    if (!results.length) {
      return `No products found matching "${query}". Ask the customer for more detail, or offer to check with the team directly.`;
    }
    return results.map(p => {
      const price = 'KShs ' + Number(p.price).toLocaleString('en-KE');
      const desc = p.description ? ' — ' + p.description.replace(/\s+/g, ' ').slice(0, 220).trim() : '';
      return `${p.name} — ${price} (ID: ${p.retailer_id})${desc}`;
    }).join('\n');
  },

  async escalate_to_human(input) {
    // _customerPhone is the real WhatsApp wa_id, injected by the pipeline on every tool call —
    // always store it here so the escalation is linkable to the conversation even when the
    // model didn't also call qualify_lead (previously the only way a phone got recorded).
    const record = { ...input, phone: input._customerPhone || null, escalatedAt: new Date().toISOString() };
    await db.insertEscalation(record);
    console.error('[MCP] ESCALATION:', input.customer_name || '(no name given)', record.phone, input.urgency);
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

module.exports = { mcpServer, executeTool, getTowerQuoteBreakdown, TANK_TYPE_DISPLAY };
