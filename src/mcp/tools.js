const toolDefinitions = [
  {
    name: 'qualify_lead',
    description:
      'Capture and store lead qualification data. Call this as soon as you have name and phone — the two fields the sales team actually needs to follow up — even if location/service/property type aren\'t known yet (e.g. mid-complaint, before a full qualification chat). Include the other fields whenever they are known; do not wait to collect all of them before calling this.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: "Prospect's full name (the contact person)" },
        organization: {
          type: 'string',
          description: 'Name of the school, church, hospital, company or other institution the prospect is enquiring for (e.g. "Uruku Secondary School"). Always include it when known — required in practice for school/institutional leads.',
        },
        phone: { type: 'string', description: "Prospect's phone number with country code" },
        location: { type: 'string', description: 'City, town, or region where the property is located' },
        service: {
          type: 'string',
          enum: ['solar', 'borehole', 'water'],
          description: 'Which service the prospect is interested in — water = swimming pool chemicals or water filtration/treatment',
        },
        property_type: {
          type: 'string',
          enum: ['residential', 'commercial', 'agricultural', 'institutional'],
          description: 'Type of property — use institutional for schools, churches, hospitals and similar',
        },
        estimated_budget: {
          type: 'string',
          description: "Prospect's stated budget range, if mentioned (optional)",
        },
        notes: {
          type: 'string',
          description: 'Any other useful context about the prospect or their request worth passing to the sales team (optional)',
        },
      },
      required: ['name', 'phone'],
    },
  },
  {
    name: 'schedule_callback',
    description:
      'Book a call with one of our technical experts. Use when the prospect is ready to speak to an expert or needs a firm quote. Never use this to book a site visit — our expert decides on (and arranges) any site visit after the call.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: "Prospect's full name" },
        phone: { type: 'string', description: "Prospect's phone number with country code" },
        preferred_date: { type: 'string', description: 'Preferred date for callback (e.g. "Monday 16 June")' },
        preferred_time: { type: 'string', description: 'Preferred time slot (e.g. "10:00 AM")' },
        notes: {
          type: 'string',
          description: 'Any relevant notes — property details, specific questions, access instructions (optional)',
        },
      },
      required: ['name', 'phone', 'preferred_date', 'preferred_time'],
    },
  },
  {
    name: 'send_quote',
    description:
      "Generate an indicative price range for a solar installation or borehole project based on the prospect's requirements. Always use this tool for pricing — never estimate prices in conversation.",
    inputSchema: {
      type: 'object',
      properties: {
        service: {
          type: 'string',
          enum: ['solar', 'borehole'],
          description: 'Which service the quote is for',
        },
        system_size_kw: {
          type: 'number',
          description: 'Solar system size in kilowatts (solar only)',
        },
        system_type: {
          type: 'string',
          description: 'Type of solar system: backup, gridtied, pumping, or heating (solar only)',
        },
        borehole_depth_m: {
          type: 'number',
          description: 'Estimated borehole depth in metres (borehole only)',
        },
        is_rehabilitation: {
          type: 'boolean',
          description: 'Set true if this is a borehole rehabilitation quote, not new drilling (borehole only)',
        },
        is_tower_quote: {
          type: 'boolean',
          description: 'Set true if this is an elevated steel water tower quote, not drilling or rehabilitation (borehole only)',
        },
        tower_height_m: {
          type: 'number',
          description: 'Water tower height in metres: 6, 9, or 12 (tower quotes only)',
        },
        tank_count: {
          type: 'number',
          description: 'Number of tanks on the tower, e.g. 1, 2, or 4 (tower quotes only)',
        },
        tank_type: {
          type: 'string',
          enum: ['plastic', 'steel'],
          description: 'Tank material — plastic (10,000L) or steel (24/48/50/100 m3) (tower quotes only)',
        },
        tank_capacity: {
          type: 'string',
          description: 'Tank capacity, e.g. "10000L" for plastic or "24m3"/"48m3"/"50m3"/"100m3" for steel (tower quotes only)',
        },
        structure_only: {
          type: 'boolean',
          description: 'Set true ONLY if the customer explicitly asks for the steel structure/fabrication price alone, separate from foundation and tank (tower quotes only). Default false returns the complete installed package price (structure + foundation + tank).',
        },
        location: { type: 'string', description: 'County or town in Kenya' },
        property_type: {
          type: 'string',
          enum: ['residential', 'commercial', 'agricultural', 'institutional'],
          description: 'Type of property',
        },
      },
      required: ['service'],
    },
  },
  {
    name: 'show_products',
    description:
      'Send interactive product messages from the Waterlift catalog directly inside WhatsApp. Use when a customer asks to see products, packages, pricing options, or what is available. Prefer type "catalog" for general browsing, "list" for a curated selection, and "single" for one specific product.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['catalog', 'single', 'list'],
          description: 'catalog: opens the full catalog browser in WhatsApp. single: shows one product card. list: shows multiple product cards in one message.',
        },
        product_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Product retailer IDs from the Meta catalog. Required for single and list types. Leave empty for catalog type.',
        },
        section_title: {
          type: 'string',
          description: 'Section heading shown above the product list. Used for list type only (e.g. "Solar Backup Systems", "Borehole Pumps").',
        },
        body_text: {
          type: 'string',
          description: 'Short message to accompany the product display (e.g. "Here are our most popular solar packages").',
        },
      },
      required: ['type'],
    },
  },
  {
    name: 'get_product_info',
    description:
      'Look up a product\'s current price, description, and specs by name or keyword (e.g. "300L heat pump", "borehole casing", "6mm submersible cable"). Always use this for exact pricing instead of relying on memory — the catalog is synced separately from a live feed and prices can change without notice.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Product name or keyword to search for',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'escalate_to_human',
    description:
      'Flag this conversation for immediate human agent takeover. Use for complaints, legal questions, negotiated pricing, large commercial projects, or any situation beyond standard sales consultation. The customer\'s WhatsApp number is captured automatically — but if you don\'t already have their name (e.g. via qualify_lead earlier in this chat), ask for it first before escalating, unless the customer is upset or the situation is urgent enough that asking first would make things worse, in which case escalate immediately and let the human follow-up gather the rest.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Brief description of why escalation is needed' },
        urgency: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Urgency level of the escalation',
        },
        customer_name: { type: 'string', description: "Customer's name if known (optional)" },
      },
      required: ['reason', 'urgency'],
    },
  },
];

module.exports = { toolDefinitions };
