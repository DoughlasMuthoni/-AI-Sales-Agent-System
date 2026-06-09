const GRAPH_API_BASE = 'https://graph.facebook.com/v21.0';

async function post(phoneNumberId, accessToken, payload) {
  const response = await fetch(`${GRAPH_API_BASE}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(`WhatsApp API error ${response.status}: ${JSON.stringify(error?.error ?? error)}`);
  }
  return response.json();
}

async function sendTextMessage(to, body) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken   = process.env.WHATSAPP_ACCESS_TOKEN;
  return post(phoneNumberId, accessToken, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { body },
  });
}

async function sendTypingIndicator(to, messageId) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken   = process.env.WHATSAPP_ACCESS_TOKEN;
  try {
    await fetch(`${GRAPH_API_BASE}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }),
    });
  } catch (err) {
    console.error('[whatsapp] Typing indicator failed:', err.message);
  }
}

// Sends a button that opens the full product catalog inside WhatsApp
async function sendCatalogMessage(to, bodyText) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken   = process.env.WHATSAPP_ACCESS_TOKEN;
  return post(phoneNumberId, accessToken, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'catalog_message',
      body: { text: bodyText || 'Browse our full product catalog below.' },
      footer: { text: 'Tap "View catalog" to explore all products' },
      action: { name: 'catalog_message' },
    },
  });
}

// Sends a single product card (image, name, price, description)
async function sendProductMessage(to, productRetailerId, bodyText) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken   = process.env.WHATSAPP_ACCESS_TOKEN;
  const catalogId     = process.env.WHATSAPP_CATALOG_ID;
  return post(phoneNumberId, accessToken, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'product',
      body: { text: bodyText || 'Here is the product you asked about.' },
      action: {
        catalog_id: catalogId,
        product_retailer_id: productRetailerId,
      },
    },
  });
}

// Sends a curated list of multiple product cards in one message
async function sendProductListMessage(to, productRetailerIds, sectionTitle, bodyText) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken   = process.env.WHATSAPP_ACCESS_TOKEN;
  const catalogId     = process.env.WHATSAPP_CATALOG_ID;
  return post(phoneNumberId, accessToken, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'product_list',
      header: { type: 'text', text: 'Waterlift Solar Products' },
      body: { text: bodyText || 'Here are some products that may interest you.' },
      footer: { text: 'Prices include installation. Subject to site assessment.' },
      action: {
        catalog_id: catalogId,
        sections: [
          {
            title: sectionTitle || 'Products',
            product_items: productRetailerIds.map(id => ({ product_retailer_id: id })),
          },
        ],
      },
    },
  });
}

module.exports = { sendTextMessage, sendTypingIndicator, sendCatalogMessage, sendProductMessage, sendProductListMessage };
