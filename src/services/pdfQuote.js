const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const { getTowerQuoteBreakdown, TANK_TYPE_DISPLAY } = require('../mcp/mcpServer.js');

const LOGO_PATH = path.join(__dirname, '..', '..', 'public', 'logo.png');
const COMPANY_NAME = 'SPIRIT MVS(PTY)LIMITED t/a WATERLIFT';
const COMPANY_TEL = 'Tel: 020 8000 579 / 0768117070';
const FOOTER_TEL = '0768117070';
const COMPANY_VAT = 'VAT PIN: P051394404V';
const COMPANY_EMAIL = 'info@waterlift.co.ke';
// Solar quotes use their own header identity — the real reference quotations show a different
// company name/VAT PIN than the tower/drilling template above (worth a closer look if that
// turns out to be a stale value rather than a deliberate difference between document types).
const SOLAR_COMPANY_NAME = 'WATERLIFT SOLAR LIMITED';
const SOLAR_COMPANY_VAT = 'VAT PIN: P051997086H';
const BAND_COLOR = '#5BC7DB';
const BORDER_COLOR = '#000000';

const TRANSPORT_TERM_EXCLUDED = 'Prices above do not include transport to site. Transport is quoted separately once the client confirms the project location, as it depends on distance from Nairobi and site accessibility.';
const TRANSPORT_TERM_INCLUDED = 'Transport to site is included in the prices above, based on the confirmed project location.';
const TERMS_REST = [
  'A final price is confirmed only after a site visit, which verifies soil condition (Pad vs Raft) and any site-specific installation requirements.',
  'Prices are indicative and valid for 30 days from the date of issue.',
];

const FOUNDATION_ITEMS = [
  'Material & Labour: Fabrication of anchor plates',
  'Material & Labour: Excavation for stub columns',
  'Material & Labour: Casting of slab columns',
  'Material & Labour: Positioning of anchor plate',
  'Material & Labour: Curing of the foundation',
];

function fabricationItems(heightM) {
  return [
    'Material: Marking of stanchions, bracers, beams and plates and cat ladder materials',
    'Materials & Labour: Drilling of stanchions, bracers, beams and plates and cat ladder materials',
    'Materials & Labour: Welding of stanchions, bracers, beams and plates and cat ladder materials',
    'Materials & Labour: Painting of completed material with aluminum silver primer and final coat of aluminum silver gloss',
  ];
}

function fmtMoney(n) {
  if (n === null || n === undefined) return '-';
  return 'KShs ' + Number(n).toLocaleString('en-KE', { maximumFractionDigits: 2 });
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function drawBand(doc, x, width, text) {
  const y = doc.y;
  doc.rect(x, y, width, 20).fill(BAND_COLOR).stroke(BORDER_COLOR);
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(10).text(text, x + 6, y + 5, { width: width - 12 });
  doc.y = y + 20;
}

function drawKeyValueTable(doc, x, width, rows, labelW = 90) {
  rows.forEach(([label, value]) => {
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(9);
    const labelH = doc.heightOfString(label, { width: labelW - 8 });
    doc.font('Helvetica').fontSize(9);
    const valueH = doc.heightOfString(value || '', { width: width - labelW - 8 });
    const h = Math.max(16, labelH + 8, valueH + 8);
    doc.rect(x, y, labelW, h).stroke(BORDER_COLOR);
    doc.rect(x + labelW, y, width - labelW, h).stroke(BORDER_COLOR);
    doc.font('Helvetica-Bold').fontSize(9).text(label, x + 4, y + 4, { width: labelW - 8 });
    doc.font('Helvetica').fontSize(9).text(value || '', x + labelW + 4, y + 4, { width: width - labelW - 8 });
    doc.y = y + h;
  });
}

// Column widths for the item table: INDEX | SPECIFICATION | QTY | RATE | AMOUNT
function colWidths(width) {
  const index = 40, qty = 40, rate = 90, amount = 90;
  const spec = width - index - qty - rate - amount;
  return { index, spec, qty, rate, amount };
}

function drawTableHeader(doc, x, width) {
  const c = colWidths(width);
  const y = doc.y;
  const h = 18;
  let cx = x;
  [['INDEX', c.index], ['SPECIFICATION', c.spec], ['QTY', c.qty], ['RATE', c.rate], ['AMOUNT', c.amount]].forEach(([label, w]) => {
    doc.rect(cx, y, w, h).stroke(BORDER_COLOR);
    doc.font('Helvetica-Bold').fontSize(8).text(label, cx + 3, y + 5, { width: w - 6 });
    cx += w;
  });
  doc.y = y + h;
}

// Descriptive-only row (sub-items under Foundation Works / Fabrication) — no qty/rate/amount.
function drawDescRow(doc, x, width, index, text) {
  const c = colWidths(width);
  const y = doc.y;
  doc.font('Helvetica').fontSize(8);
  const textH = doc.heightOfString(text, { width: c.spec - 6 });
  const h = Math.max(16, textH + 8);
  let cx = x;
  doc.rect(cx, y, c.index, h).stroke(BORDER_COLOR);
  doc.font('Helvetica-Bold').fontSize(8).text(index, cx + 3, y + 4, { width: c.index - 6 });
  cx += c.index;
  doc.rect(cx, y, c.spec, h).stroke(BORDER_COLOR);
  doc.font('Helvetica').fontSize(8).text(text, cx + 3, y + 4, { width: c.spec - 6 });
  cx += c.spec;
  doc.rect(cx, y, c.qty + c.rate + c.amount, h).stroke(BORDER_COLOR);
  doc.y = y + h;
}

// Priced line item row (1.00, 2.00, ...) with qty/rate/amount filled in ('-' if unknown).
function drawItemRow(doc, x, width, index, spec, qty, rate, amount) {
  const c = colWidths(width);
  const y = doc.y;
  doc.font('Helvetica-Bold').fontSize(8);
  const textH = doc.heightOfString(spec, { width: c.spec - 6 });
  const h = Math.max(18, textH + 8);
  let cx = x;
  doc.rect(cx, y, c.index, h).stroke(BORDER_COLOR);
  doc.text(index, cx + 3, y + 5, { width: c.index - 6 });
  cx += c.index;
  doc.rect(cx, y, c.spec, h).stroke(BORDER_COLOR);
  doc.text(spec, cx + 3, y + 5, { width: c.spec - 6 });
  cx += c.spec;
  doc.rect(cx, y, c.qty, h).stroke(BORDER_COLOR);
  doc.font('Helvetica').text(String(qty), cx + 3, y + 5, { width: c.qty - 6 });
  cx += c.qty;
  doc.rect(cx, y, c.rate, h).stroke(BORDER_COLOR);
  doc.text(fmtMoney(rate), cx + 3, y + 5, { width: c.rate - 6 });
  cx += c.rate;
  doc.rect(cx, y, c.amount, h).stroke(BORDER_COLOR);
  doc.text(fmtMoney(amount), cx + 3, y + 5, { width: c.amount - 6 });
  doc.y = y + h;
}

function drawTotalRow(doc, x, width, label, amount, bold) {
  const c = colWidths(width);
  const y = doc.y;
  const h = 18;
  doc.rect(x, y, c.index + c.spec + c.qty, h).stroke(BORDER_COLOR);
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).text(label, x + 6, y + 5);
  doc.rect(x + c.index + c.spec + c.qty, y, c.rate, h).stroke(BORDER_COLOR);
  doc.rect(x + c.index + c.spec + c.qty + c.rate, y, c.amount, h)
    .fill(bold ? '#eeeeee' : '#ffffff').stroke(BORDER_COLOR);
  doc.fillColor('#000').font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9)
    .text(fmtMoney(amount), x + c.index + c.spec + c.qty + c.rate + 3, y + 5, { width: c.amount - 6 });
  doc.y = y + h;
}

function ensureSpace(doc, needed) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + needed > bottom) doc.addPage();
}

// Replicates the two-office contact footer + decorative accent bar from the original company
// quote templates (BOREHOLE DRILLING QUOTE.pdf / TOWERS QUOTE TEMPLATE.pdf) — pinned to the
// bottom of the current page rather than wherever doc.y happens to be.
function drawOfficesFooter(doc, x, width) {
  const barH = 10;
  const footerH = 44;
  const pageBottom = doc.page.height - doc.page.margins.bottom;
  const footerY = pageBottom - footerH - barH;
  const half = width / 2;

  doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#333')
    .text('Tel: 0768 117 070 (Nairobi Office)  www.waterlift.africa', x, footerY, { width: half - 10 })
    .font('Helvetica').text('Kenafric Business Park, Babadogo, Office No: B13', x, footerY + 11, { width: half - 10 });

  doc.font('Helvetica-Bold').fontSize(7.5)
    .text('Tel: 020 8000 579 (Nanyuki Office)  Email: info@waterlift.co.ke', x + half, footerY, { width: half - 10 })
    .font('Helvetica').text('WATERLIFT Building, Junction at Kenyatta Road Highway / Equator along Nyeri - Nanyuki Highway, Nanyuki, Kenya', x + half, footerY + 11, { width: half - 10 });

  const barY = pageBottom - barH;
  doc.rect(x, barY, width * 0.6, barH).fill('#1E88C7');
  doc.rect(x + width * 0.55, barY, width * 0.45, barH).fill('#F5A623');
  doc.fillColor('#000');
}

const PROJECTS_DIR = path.join(__dirname, '..', '..', 'public', 'quote-assets', 'projects');
const PROJECT_PHOTOS = [
  { file: 'project-1.jpg', caption: 'Elevated tower with solar canopy and overhead tank' },
  { file: 'project-2.jpg', caption: '12m tower holding a 48m³ steel tank' },
  { file: 'project-3.jpg', caption: 'Solar-powered irrigation for farming' },
  { file: 'project-4.jpg', caption: 'Residential rooftop solar installation' },
  { file: 'project-5.jpg', caption: '12m tower with elevated solar array and tank' },
  { file: 'project-6.jpg', caption: '12m tower and 24m³ steel tank with 32 panels' },
];

// Solar-specific gallery — extracted from a real customer proposal (Bishop Perlo Academy),
// curated to solar-equipment photos only (excludes the same document's borehole-drilling and
// steel-tower photos, which aren't relevant to a solar system quote and already have their own
// gallery on the tower quote PDF).
const SOLAR_PROJECTS_DIR = path.join(__dirname, '..', '..', 'public', 'quote-assets', 'solar-projects');
const SOLAR_PROJECT_PHOTOS = [
  { file: 'solar-1.jpg', caption: 'Borehole solarization — ground-mounted array, Murang’a County' },
  { file: 'solar-2.jpg', caption: 'Solar water heater installation, Nairobi County' },
  { file: 'solar-3.jpg', caption: '5kVA Waterlift solar powered project, Nairobi County' },
  { file: 'solar-4.jpg', caption: 'Solar backup project, Nairobi County' },
  { file: 'solar-5.jpg', caption: '12kVA home solar powered system, Karen' },
  { file: 'solar-6.jpg', caption: '3000L solar water heater, Karen' },
  { file: 'solar-7.jpg', caption: 'Heat pump installation, 300L capacity, Baringo County' },
  { file: 'solar-8.jpg', caption: 'Heat pump installation, 300L capacity, Baringo County' },
];

// Appends a "Previous Projects" photo gallery page after the main quote — reuses the same
// header style so the appendix still reads as part of one document, not a bolted-on extra.
// companyName/companyVat/projectsDir/photos let tower and solar quotes each use their own
// header identity and photo set while sharing this layout.
function drawProjectsPage(doc, x, width, companyName, companyVat, projectsDir, photos, footerReserve = 0) {
  doc.addPage();
  const headerY = doc.y;
  doc.rect(x, headerY, width, 60).stroke(BORDER_COLOR);
  if (fs.existsSync(LOGO_PATH)) {
    try { doc.image(LOGO_PATH, x + 8, headerY + 8, { fit: [70, 44] }); } catch (e) { /* logo optional */ }
  }
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(11)
    .text(companyName, x + 90, headerY + 14, { width: width - 100, align: 'center' });
  doc.font('Helvetica').fontSize(9)
    .text(COMPANY_TEL, x + 90, headerY + 30, { width: width - 100, align: 'center' })
    .text(companyVat, x + 90, headerY + 43, { width: width - 100, align: 'center' });
  doc.y = headerY + 60;

  drawBand(doc, x, width, 'PREVIOUS PROJECTS');
  doc.moveDown(0.5);

  const cols = 2;
  const gap = 14;
  const cellW = (width - gap * (cols - 1)) / cols;
  const imgH = 130;
  let col = 0;
  let rowY = doc.y;
  let rowMaxH = 0;
  // Treat the footer's own height (if the caller wants one drawn right after this gallery) as
  // part of the page boundary throughout layout — otherwise the last photo row can end up
  // sitting flush against the true page bottom with nowhere left for the footer to fit on the
  // same page, forcing it onto an otherwise-empty page of its own.
  const usableBottom = doc.page.height - doc.page.margins.bottom - footerReserve;

  photos.forEach((p, i) => {
    const filePath = path.join(projectsDir, p.file);
    const cellX = x + col * (cellW + gap);
    if (fs.existsSync(filePath)) {
      try { doc.image(filePath, cellX, rowY, { fit: [cellW, imgH], align: 'center', valign: 'center' }); } catch (e) { /* photo optional */ }
    }
    doc.font('Helvetica').fontSize(8).fillColor('#333')
      .text(p.caption, cellX, rowY + imgH + 4, { width: cellW, align: 'center' });
    const capH = doc.heightOfString(p.caption, { width: cellW });
    rowMaxH = Math.max(rowMaxH, imgH + 4 + capH);

    col++;
    if (col >= cols) {
      col = 0;
      rowY += rowMaxH + 18;
      rowMaxH = 0;
      // Only break to a new page if there's actually another photo left to draw on it —
      // otherwise this fires after the very last photo too and leaves a blank trailing page.
      const hasMore = i < photos.length - 1;
      if (hasMore && rowY + imgH + 30 > usableBottom) {
        doc.addPage();
        rowY = doc.page.margins.top;
      }
    }
  });

  // Leave doc.y at the true bottom of the last photo row (not mid-row, and not overshot by a
  // row-advance that never got used) so a caller can reliably ensureSpace()+draw a footer right
  // after the gallery instead of guessing where the content ended.
  doc.y = rowY + rowMaxH + 10;
  doc.fillColor('#000');
}

/**
 * Generates a branded tower/tank quotation PDF matching the TOWERS QUOTE TEMPLATE layout.
 * Returns a Buffer (caller decides whether to stream it back or save+send via WhatsApp).
 */
async function generateTowerQuotePDF({ client, project, siteLocation, quoteRef, date, towerHeightM, tankCount, tankType, tankCapacity, transportCost, vatIncluded = true }) {
  const breakdown = await getTowerQuoteBreakdown(towerHeightM, tankCount, tankType, tankCapacity);
  return new Promise((resolve, reject) => {
    const transportAmount = transportCost !== undefined && transportCost !== null && transportCost !== ''
      ? Number(transportCost)
      : null;
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const x = doc.page.margins.left;

    // Header
    const headerY = doc.y;
    doc.rect(x, headerY, width, 60).stroke(BORDER_COLOR);
    if (fs.existsSync(LOGO_PATH)) {
      try { doc.image(LOGO_PATH, x + 8, headerY + 8, { fit: [70, 44] }); } catch (e) { /* logo optional */ }
    }
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(11)
      .text(COMPANY_NAME, x + 90, headerY + 14, { width: width - 100, align: 'center' });
    doc.font('Helvetica').fontSize(9)
      .text(COMPANY_TEL, x + 90, headerY + 30, { width: width - 100, align: 'center' })
      .text(COMPANY_VAT, x + 90, headerY + 43, { width: width - 100, align: 'center' });
    doc.y = headerY + 60;

    drawBand(doc, x, width, 'QUOTATION');

    drawKeyValueTable(doc, x, width, [
      ['Client', client],
      ['Project', project],
      ['Quote Ref', quoteRef],
      ['Date', date],
    ]);
    doc.moveDown(0.5);

    const tankWord = breakdown.tankCount === 1 ? 'TANK' : 'TANKS';
    const sectionTitle = `${breakdown.height}M STEEL TOWER HOLDING ${breakdown.tankCount} ${tankWord}`;
    drawBand(doc, x, width, sectionTitle);

    drawTableHeader(doc, x, width);

    drawDescRow(doc, x, width, '', 'FOUNDATION WORKS');
    FOUNDATION_ITEMS.forEach((t, i) => drawDescRow(doc, x, width, String.fromCharCode(65 + i), t));

    drawDescRow(doc, x, width, '', `FABRICATION OF ${breakdown.height}M HIGH TOWER STEEL TANK`);
    fabricationItems(breakdown.height).forEach((t, i) => drawDescRow(doc, x, width, String.fromCharCode(65 + i), t));

    ensureSpace(doc, 100);
    drawItemRow(doc, x, width, '1.00', `FABRICATION AND ASSEMBLING OF ${breakdown.height}M STEEL TOWER`, 1,
      breakdown.fabricationPrice, breakdown.fabricationPrice);
    drawItemRow(doc, x, width, '2.00', 'FOUNDATION WORKS', 1, breakdown.foundationPrice, breakdown.foundationPrice);
    const tankTypeDisplay = breakdown.tankType ? (TANK_TYPE_DISPLAY[breakdown.tankType] || breakdown.tankType) : '';
    const tankLabel = `${tankTypeDisplay.toUpperCase()} TANK — ${breakdown.capacityLabel || ''}`.trim();
    drawItemRow(doc, x, width, '3.00', tankLabel, breakdown.tankCount || 1, breakdown.tankUnitPrice, breakdown.tankAmount);
    const transportLabel = siteLocation && siteLocation.trim()
      ? `TRANSPORT OF TOWER & TANK FROM NAIROBI TO ${siteLocation.trim().toUpperCase()}`
      : 'TRANSPORT OF TOWER & TANK FROM NAIROBI TO SITE';
    drawItemRow(doc, x, width, '4.00', transportLabel, 1, transportAmount, transportAmount);

    // For custom (non-standard) configurations, the fabrication cost is unknown and doesn't
    // scale linearly — showing a summed "total" that silently excludes it would understate
    // the real price on a document a customer might treat as final. Show TBD instead.
    // Transport is only folded into the total once a real figure is supplied — otherwise it
    // stays excluded (and flagged below) rather than silently treated as KShs 0.
    const subTotal = breakdown.isStandard
      ? breakdown.grandTotal + (transportAmount || 0)
      : null;

    // Stored fabrication/foundation/tank prices are VAT-exclusive — VAT is a genuine line added
    // here, not baked into those figures, so it's toggleable per quote (e.g. a VAT-exempt
    // customer or a negotiated VAT-inclusive deal) same as the Solar Quote's VAT toggle.
    const vatAmount = (vatIncluded && subTotal !== null) ? round2(subTotal * 0.16) : 0;
    const grandTotal = subTotal !== null ? round2(subTotal + vatAmount) : null;

    drawTotalRow(doc, x, width, 'SUB TOTAL', subTotal, false);
    if (vatIncluded && subTotal !== null) {
      drawTotalRow(doc, x, width, 'VAT (16%)', vatAmount, false);
    }
    drawTotalRow(doc, x, width, breakdown.isStandard ? 'GRAND TOTAL' : 'GRAND TOTAL (pending fabrication cost)', grandTotal, true);

    doc.moveDown(0.5);
    const vatPhrase = vatIncluded ? 'inclusive of 16% VAT and standard installation' : 'exclusive of VAT, inclusive of standard installation';
    const transportNote = transportAmount !== null
      ? `All prices above are ${vatPhrase}, and include transport to site.`
      : `All prices above are ${vatPhrase}. Transport is quoted separately (see Terms & Conditions).`;
    doc.font('Helvetica-Oblique').fontSize(8).text(transportNote, x, doc.y, { width });

    if (!breakdown.isStandard) {
      doc.moveDown(0.5);
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#b02a2a')
        .text('This is a custom tower/tank configuration outside our standard packages — fabrication cost and grand total are confirmed by our engineering team after review. Contact us to finalise.', x, doc.y, { width });
      doc.fillColor('#000');
    }

    ensureSpace(doc, 120);
    doc.moveDown(1);
    drawBand(doc, x, width, 'TERMS & CONDITIONS');
    doc.font('Helvetica').fontSize(8.5);
    const terms = [transportAmount !== null ? TRANSPORT_TERM_INCLUDED : TRANSPORT_TERM_EXCLUDED, ...TERMS_REST];
    terms.forEach((t) => {
      doc.text('•  ' + t, x, doc.y, { width });
      doc.moveDown(0.3);
    });

    doc.moveDown(1);
    doc.font('Helvetica').fontSize(8.5).fillColor('#333')
      .text(`Questions about this quote? Contact us at ${COMPANY_EMAIL} or ${FOOTER_TEL}.`, x, doc.y, { width, align: 'center' });

    drawProjectsPage(doc, x, width, COMPANY_NAME, COMPANY_VAT, PROJECTS_DIR, PROJECT_PHOTOS);

    doc.end();
  });
}

// Same row shape as drawItemRow, but the amount column can be a literal string (e.g. "RATE
// ONLY") instead of a number — used for the optional 10" surface casing line, which is quoted
// as a reference rate but not charged unless the site assessment determines it's needed.
function drawItemRowAmountText(doc, x, width, index, spec, qty, rate, amountText) {
  const c = colWidths(width);
  const y = doc.y;
  doc.font('Helvetica-Bold').fontSize(8);
  const textH = doc.heightOfString(spec, { width: c.spec - 6 });
  const h = Math.max(18, textH + 8);
  let cx = x;
  doc.rect(cx, y, c.index, h).stroke(BORDER_COLOR);
  doc.text(index, cx + 3, y + 5, { width: c.index - 6 });
  cx += c.index;
  doc.rect(cx, y, c.spec, h).stroke(BORDER_COLOR);
  doc.text(spec, cx + 3, y + 5, { width: c.spec - 6 });
  cx += c.spec;
  doc.rect(cx, y, c.qty, h).stroke(BORDER_COLOR);
  doc.font('Helvetica').text(String(qty), cx + 3, y + 5, { width: c.qty - 6 });
  cx += c.qty;
  doc.rect(cx, y, c.rate, h).stroke(BORDER_COLOR);
  doc.text(fmtMoney(rate), cx + 3, y + 5, { width: c.rate - 6 });
  cx += c.rate;
  doc.rect(cx, y, c.amount, h).stroke(BORDER_COLOR);
  doc.font('Helvetica-Oblique').text(amountText, cx + 3, y + 5, { width: c.amount - 6 });
  doc.y = y + h;
}

/**
 * Generates a branded borehole drilling quotation PDF matching the BOREHOLE DRILLING QUOTE.pdf
 * template layout. `quote` is the output of drillingCalc.js's generateDrillingQuote() — this
 * function only renders it, all the cost/quote math already happened upstream.
 * Returns a Buffer (caller decides whether to stream it back or save+send via WhatsApp).
 */
function generateDrillingQuotePDF({ client, location, quoteRef, date, depthM, quote, preparedBy, reviewedBy, approvedBy }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const x = doc.page.margins.left;

    const headerY = doc.y;
    doc.rect(x, headerY, width, 60).stroke(BORDER_COLOR);
    if (fs.existsSync(LOGO_PATH)) {
      try { doc.image(LOGO_PATH, x + 8, headerY + 8, { fit: [70, 44] }); } catch (e) { /* logo optional */ }
    }
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(11)
      .text(COMPANY_NAME, x + 90, headerY + 14, { width: width - 100, align: 'center' });
    doc.font('Helvetica').fontSize(9)
      .text(COMPANY_TEL, x + 90, headerY + 30, { width: width - 100, align: 'center' })
      .text(COMPANY_VAT, x + 90, headerY + 43, { width: width - 100, align: 'center' });
    doc.y = headerY + 60;

    drawBand(doc, x, width, 'QUOTATION');

    drawKeyValueTable(doc, x, width, [
      ['Client', client],
      ['Location', location],
      ['Quote Ref', quoteRef],
      ['Date', date],
      ['Borehole Depth', `${depthM}m`],
    ]);
    doc.moveDown(0.5);

    drawBand(doc, x, width, 'DRILLING QUOTATION');
    drawTableHeader(doc, x, width);

    drawItemRow(doc, x, width, '1.1',
      `Drilling of borehole 8.5" DIA with air drilling to a depth of ${depthM}m`,
      depthM, quote.drillingRate, quote.drillingAmount);

    drawDescRow(doc, x, width, '', '6" STEEL PIPE CASINGS');
    drawItemRow(doc, x, width, '2.1', 'Supply and installation of 6" DIA steel casing (plain & screened, gravel packing, Borehole development by means of flushing, cap, testpumping for 24 hours, water analysis, preparation and submission of Borehole Completion Report)',
      quote.casingMetres, quote.casingRatePerMetre, quote.casingAmount);

    ensureSpace(doc, 100);
    if (quote.surfaceCasingIncluded) {
      drawItemRow(doc, x, width, '3.1', 'Supply and installation of 10" permanent surface casings',
        quote.surfaceCasingQty, quote.surfaceCasingRate, quote.surfaceCasingAmount);
    } else {
      drawItemRowAmountText(doc, x, width, '3.1', 'Supply and installation of 10" permanent surface casings',
        quote.surfaceCasingQty, quote.surfaceCasingRate, 'RATE ONLY');
    }

    drawItemRow(doc, x, width, '3.2',
      'Mobilization of drilling rig, support truck, test pumping unit truck and transport of materials, camp set-up and demobilization after project completion',
      1, quote.mobilization.total, quote.mobilization.total);

    drawTotalRow(doc, x, width, 'SUB TOTAL', quote.subTotal, false);
    drawTotalRow(doc, x, width, 'V.A.T (' + quote.vatRatePct + '%)', quote.vatAmount, false);
    drawTotalRow(doc, x, width, 'GRAND TOTAL', quote.grandTotal, true);

    ensureSpace(doc, 140);
    doc.moveDown(1);
    drawBand(doc, x, width, 'PAYMENT BREAKDOWN');
    drawKeyValueTable(doc, x, width, [
      ['1. Deposit of Works', fmtMoney(quote.payment.deposit)],
      ['2. After Drilling, Before Casing', fmtMoney(quote.payment.afterDrilling)],
      ['3. Before Test Pumping', fmtMoney(quote.payment.beforeTestPumping)],
    ], 200);

    doc.moveDown(1);
    doc.font('Helvetica-Oblique').fontSize(8).fillColor('#333')
      .text('Kindly note: drilling rate is KShs ' + Number(quote.drillingRate).toLocaleString('en-KE', { maximumFractionDigits: 2 }) + ' per metre. All prices above are inclusive of VAT as itemized. Prices are indicative and valid for 30 days from the date of issue — a final price is confirmed after a site assessment.',
        x, doc.y, { width });
    doc.fillColor('#000');

    doc.moveDown(1.5);
    const signW = width / 3;
    const signY = doc.y;
    [['PREPARED BY', preparedBy], ['REVIEWED BY', reviewedBy], ['APPROVED BY', approvedBy]].forEach(([label, name], i) => {
      const cx = x + i * signW;
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#000').text(label + ':', cx, signY, { width: signW - 10 });
      doc.font('Helvetica').fontSize(8).text(name && name.trim() ? name.trim() : '_______________________', cx, signY + 12, { width: signW - 10 });
    });
    doc.y = signY + 26;

    drawOfficesFooter(doc, x, width);

    doc.end();
  });
}

// quote is a computeSolarQuote()/generateSolarQuote() result: { items, subTotal, vatAmount,
// vatRatePct, grandTotal } — items already carry qty/rate/amount/category per line.
function generateSolarQuotePDF({ client, project, quoteRef, date, systemLabel, quote, preparedBy, reviewedBy, approvedBy }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const x = doc.page.margins.left;

    const headerY = doc.y;
    doc.rect(x, headerY, width, 60).stroke(BORDER_COLOR);
    if (fs.existsSync(LOGO_PATH)) {
      try { doc.image(LOGO_PATH, x + 8, headerY + 8, { fit: [70, 44] }); } catch (e) { /* logo optional */ }
    }
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(11)
      .text(SOLAR_COMPANY_NAME, x + 90, headerY + 14, { width: width - 100, align: 'center' });
    doc.font('Helvetica').fontSize(9)
      .text(COMPANY_TEL, x + 90, headerY + 30, { width: width - 100, align: 'center' })
      .text(SOLAR_COMPANY_VAT, x + 90, headerY + 43, { width: width - 100, align: 'center' });
    doc.y = headerY + 60;

    drawBand(doc, x, width, systemLabel || 'SOLAR SYSTEM QUOTATION');

    drawKeyValueTable(doc, x, width, [
      ['Client', client],
      ['Project', project],
      ['Quote Ref', quoteRef],
      ['Date', date],
    ]);
    doc.moveDown(0.5);

    drawBand(doc, x, width, `QUOTE FOR ${systemLabel || 'SOLAR INSTALLATION'}`);
    drawTableHeader(doc, x, width);
    drawDescRow(doc, x, width, '1.0', 'SOLAR PANELS & ACCESSORIES');

    quote.items.forEach((item, i) => {
      ensureSpace(doc, 60);
      drawItemRow(doc, x, width, `1.${i + 1}`, item.name, item.qty, item.rate, item.amount);
    });

    ensureSpace(doc, 80);
    drawTotalRow(doc, x, width, 'SUB TOTAL', quote.subTotal, false);
    // VAT is optional per quote — line item rates are always VAT-exclusive either way, but some
    // quotes (e.g. VAT-exempt customers, or a negotiated VAT-inclusive deal) skip charging it.
    // When excluded, the row is omitted entirely rather than shown as a confusing "(0%): KShs 0".
    const vatIncluded = quote.vatRatePct > 0;
    if (vatIncluded) {
      drawTotalRow(doc, x, width, 'VAT ON NON-SOLAR (' + quote.vatRatePct + '%)', quote.vatAmount, false);
    }
    drawTotalRow(doc, x, width, 'TOTAL', quote.grandTotal, true);

    doc.moveDown(0.5);
    doc.font('Helvetica-Oblique').fontSize(8).fillColor('#333')
      .text(vatIncluded
        ? 'Solar panels, battery, and inverter are VAT-exempt under Kenya’s solar equipment exemption; VAT above applies only to accessories, mounting, and labour. This quote is valid for 30 days from the date of issue.'
        : 'Prices above exclude VAT. This quote is valid for 30 days from the date of issue.',
        x, doc.y, { width });
    doc.fillColor('#000');

    // Reserve room for the sign-off block itself (label + name lines) so it doesn't get split
    // across a page boundary. The gallery that follows always starts its own fresh page anyway,
    // and the footer is drawn after the gallery now — not immediately after sign-off — so this
    // no longer needs to additionally reserve room for the footer here.
    ensureSpace(doc, 50);
    doc.moveDown(1);
    const signW = width / 3;
    const signY = doc.y;
    [['PREPARED BY', preparedBy], ['REVIEWED BY', reviewedBy], ['APPROVED BY', approvedBy]].forEach(([label, name], i) => {
      const cx = x + i * signW;
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#000').text(label + ':', cx, signY, { width: signW - 10 });
      doc.font('Helvetica').fontSize(8).text(name && name.trim() ? name.trim() : '_______________________', cx, signY + 12, { width: signW - 10 });
    });
    doc.y = signY + 26;

    drawProjectsPage(doc, x, width, SOLAR_COMPANY_NAME, SOLAR_COMPANY_VAT, SOLAR_PROJECTS_DIR, SOLAR_PROJECT_PHOTOS, 70);

    drawOfficesFooter(doc, x, width);

    doc.end();
  });
}

module.exports = { generateTowerQuotePDF, generateDrillingQuotePDF, generateSolarQuotePDF };
