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

// Downloads a WhatsApp media object (image, etc.) and returns it as base64 for Claude's vision input
async function downloadMedia(mediaId) {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

  const metaRes = await fetch(`${GRAPH_API_BASE}/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!metaRes.ok) throw new Error(`WhatsApp media lookup failed: ${metaRes.status}`);
  const meta = await metaRes.json();

  const fileRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!fileRes.ok) throw new Error(`WhatsApp media download failed: ${fileRes.status}`);
  const buf = Buffer.from(await fileRes.arrayBuffer());

  return { base64: buf.toString('base64'), mimeType: meta.mime_type, sizeBytes: buf.length };
}

// Uploads a file (e.g. a quotation PDF) to Meta's Media API so it can be attached to a
// message. Returns the media ID to pass into sendDocumentMessage.
async function uploadMedia(buffer, mimeType, filename) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken   = process.env.WHATSAPP_ACCESS_TOKEN;

  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([buffer], { type: mimeType }), filename);

  const response = await fetch(`${GRAPH_API_BASE}/${phoneNumberId}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(`WhatsApp media upload error ${response.status}: ${JSON.stringify(error?.error ?? error)}`);
  }
  const data = await response.json();
  return data.id;
}

// Sends a previously-uploaded document (see uploadMedia) to a customer
async function sendDocumentMessage(to, mediaId, filename, caption) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken   = process.env.WHATSAPP_ACCESS_TOKEN;
  return post(phoneNumberId, accessToken, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'document',
    document: { id: mediaId, filename, ...(caption ? { caption } : {}) },
  });
}

// In-memory cache for product names — avoids a catalog API call on every order for the same product
const _productNameCache = new Map();

async function lookupProductNames(retailerIds) {
  const catalogId   = process.env.WHATSAPP_CATALOG_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!catalogId || !accessToken || !retailerIds.length) return {};

  const names   = {};
  const toFetch = [];

  for (const id of retailerIds) {
    if (_productNameCache.has(id)) names[id] = _productNameCache.get(id);
    else toFetch.push(id);
  }

  for (const id of toFetch) {
    try {
      const filter = encodeURIComponent(JSON.stringify({ retailer_id: { eq: id } }));
      const url    = `${GRAPH_API_BASE}/${catalogId}/products?filter=${filter}&fields=retailer_id,name&access_token=${accessToken}`;
      const res    = await fetch(url);
      if (!res.ok) { console.error('[catalog] API error for', id, res.status); continue; }
      const data   = await res.json();
      const name   = data.data?.[0]?.name;
      if (name) { _productNameCache.set(id, name); names[id] = name; }
    } catch (err) {
      console.error('[catalog] Failed to fetch product', id, err.message);
    }
  }

  return names;
}

module.exports = { sendTextMessage, sendTypingIndicator, sendCatalogMessage, sendProductMessage, sendProductListMessage, lookupProductNames, downloadMedia, uploadMedia, sendDocumentMessage };
