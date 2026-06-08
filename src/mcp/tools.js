const toolDefinitions = [
  {
    name: 'qualify_lead',
    description:
      'Capture and store lead qualification data after the prospect has shared their key details. Call this once you have collected name, phone, location, service interest, and property type.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: "Prospect's full name" },
        phone: { type: 'string', description: "Prospect's phone number with country code" },
        location: { type: 'string', description: 'City, town, or region where the property is located' },
        service: {
          type: 'string',
          enum: ['solar', 'borehole'],
          description: 'Which service the prospect is interested in',
        },
        property_type: {
          type: 'string',
          enum: ['residential', 'commercial', 'agricultural'],
          description: 'Type of property',
        },
        estimated_budget: {
          type: 'string',
          description: "Prospect's stated budget range, if mentioned (optional)",
        },
      },
      required: ['name', 'phone', 'location', 'service', 'property_type'],
    },
  },
  {
    name: 'schedule_callback',
    description:
      'Book a callback or site visit with a technical consultant. Use when the prospect is ready to speak to an expert or schedule an on-site assessment.',
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
        location: { type: 'string', description: 'County or town in Kenya' },
        property_type: {
          type: 'string',
          enum: ['residential', 'commercial', 'agricultural'],
          description: 'Type of property',
        },
      },
      required: ['service', 'location', 'property_type'],
    },
  },
  {
    name: 'escalate_to_human',
    description:
      'Flag this conversation for immediate human agent takeover. Use for complaints, legal questions, negotiated pricing, large commercial projects, or any situation beyond standard sales consultation.',
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
