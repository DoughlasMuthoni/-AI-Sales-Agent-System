'use strict';
const db = require('./db.js');

const FEED_URL_KEY = 'catalog_feed_url';
const LAST_SYNCED_KEY = 'catalog_last_synced';

function field(chunk, tag) {
  const m = chunk.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>'));
  if (!m) return '';
  return m[1].replace('<![CDATA[', '').replace(']]>', '').trim();
}

// Parses a Google/Facebook-format product feed (the shape WooCommerce's
// CTX Feed / WooCommerce Feed Manager plugins export) into plain product objects.
function parseFeed(xml) {
  const items = xml.split('<item>').slice(1).map(chunk => chunk.split('</item>')[0]);
  return items.map(chunk => {
    const priceRaw = field(chunk, 'g:price');
    const salePriceRaw = field(chunk, 'g:sale_price');
    const regularPrice = parseFloat(priceRaw.replace(/[^0-9.]/g, '')) || 0;
    const salePrice = salePriceRaw ? (parseFloat(salePriceRaw.replace(/[^0-9.]/g, '')) || 0) : 0;
    // Google/Facebook feeds put the discounted price in g:sale_price and leave g:price as the
    // original — when a sale price is present, it's the actual current selling price.
    const price = salePrice > 0 ? salePrice : regularPrice;
    const currencyMatch = (salePriceRaw || priceRaw).match(/[A-Z]{3}/);
    return {
      retailerId:   field(chunk, 'g:id'),
      name:         field(chunk, 'g:title'),
      description:  field(chunk, 'g:description'),
      price,
      currency:     currencyMatch ? currencyMatch[0] : 'KES',
      category:     field(chunk, 'g:product_type'),
      availability: field(chunk, 'g:availability'),
    };
  }).filter(p => p.retailerId);
}

async function getFeedUrl() {
  return db.getSetting(FEED_URL_KEY);
}

async function setFeedUrl(url) {
  await db.setSetting(FEED_URL_KEY, url);
}

async function getLastSynced() {
  const v = await db.getSetting(LAST_SYNCED_KEY);
  return v ? Number(v) : null;
}

async function syncCatalog() {
  const feedUrl = await getFeedUrl();
  if (!feedUrl) throw new Error('No catalog feed URL configured — set one first.');

  const res = await fetch(feedUrl);
  if (!res.ok) throw new Error(`Failed to fetch feed: HTTP ${res.status}`);
  const xml = await res.text();

  const products = parseFeed(xml);
  if (!products.length) throw new Error('Feed fetched successfully but contained no products — check the URL.');

  await db.replaceProducts(products);
  const now = Date.now();
  await db.setSetting(LAST_SYNCED_KEY, String(now));

  return { count: products.length, syncedAt: now };
}

module.exports = { syncCatalog, getFeedUrl, setFeedUrl, getLastSynced, parseFeed };
