const db = require('./db.js');

// Solar system quotation calculation. Deliberately simple compared to drillingCalc.js — panel
// count and cable-run lengths are engineered per site rather than derived from a formula (see
// schema.sql's solar_line_items comment), so there's no costing build-up here, just a subtotal /
// VAT split / grand total over whatever line items the admin ends up with for this quote.

function round2(n) {
  return Math.round(n * 100) / 100;
}

// items: [{ name, category: 'exempt'|'taxable', qty, rate }]
function computeSolarQuote(items, vatRatePct) {
  const withAmount = items.map(i => ({ ...i, amount: round2(Number(i.qty) * Number(i.rate)) }));
  const subTotal = round2(withAmount.reduce((sum, i) => sum + i.amount, 0));
  const taxableTotal = round2(withAmount.filter(i => i.category === 'taxable').reduce((sum, i) => sum + i.amount, 0));
  const vatAmount = round2(taxableTotal * (vatRatePct / 100));
  const grandTotal = round2(subTotal + vatAmount);

  return { items: withAmount, subTotal, taxableTotal, vatRatePct, vatAmount, grandTotal };
}

// Loads a tier's default line items, applies any per-quote overrides (matched by name, same
// pattern as drillingCalc.js's overrideByName), and computes the quote. `overrides` can also
// include brand-new rows (no matching default name) and `removedNames` to drop defaults the
// admin deleted for this specific job.
async function generateSolarQuote(input) {
  const [settings, defaults] = await Promise.all([
    db.getSolarSettings(),
    db.getSolarLineItems(input.tierKey),
  ]);

  const vatRatePct = input.vatRatePct !== undefined ? Number(input.vatRatePct) : Number(settings.vat_rate_pct || 16);
  const removedNames = new Set(input.removedNames || []);
  const overrideMap = new Map((input.items || []).filter(o => o.name).map(o => [o.name, o]));

  const items = [];
  defaults.forEach(d => {
    if (removedNames.has(d.name)) return;
    const o = overrideMap.get(d.name);
    items.push({
      name: d.name,
      category: o?.category || d.category,
      qty: o?.qty !== undefined ? Number(o.qty) : Number(d.default_qty),
      rate: o?.rate !== undefined ? Number(o.rate) : Number(d.default_rate),
    });
    overrideMap.delete(d.name);
  });
  // Any override entries left over (no matching default name) are new rows added for this quote.
  overrideMap.forEach(o => {
    items.push({
      name: o.name,
      category: o.category || 'taxable',
      qty: Number(o.qty || 1),
      rate: Number(o.rate || 0),
    });
  });

  return computeSolarQuote(items, vatRatePct);
}

module.exports = { computeSolarQuote, generateSolarQuote };
