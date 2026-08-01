const db = require('./db.js');

// Drilling cost/quote calculation — automates what used to be a manual two-step process:
//   1. An internal "costing sheet" (fuel + consumables + casings + gravel) gives a total cost,
//      which divided by depth gives a per-metre "costing rate".
//   2. The customer-facing quote is derived FROM that costing rate, not equal to it: the
//      drilling line is (costing rate - a fixed deduction), and casing is re-itemized
//      separately at its own flat rate — otherwise casing cost would be charged twice (once
//      baked into an inflated drilling rate, once again as its own line).
// Both stages are computed here so the admin never manually works out a costing sheet again.

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Stage 1: internal cost-basis calculation (mirrors the "NICHOLAS DRILLING COSTING" sheet).
// Returns the total cost and the derived costing rate/metre — never shown to the customer,
// only used to derive the drilling line in computeQuote().
function computeCostingSheet(params) {
  const {
    depthM,
    minutesPerRod, rodLengthM,
    flushingFuelLitres, rigFuelLitres, testPumpingFuelLitres,
    fuelRatePerLitre,
    consumables, // [{ name, qty, rate }]
    casingPipeLengthM, plainCasingUnitRate, screenedCasingUnitRate,
    casingPlainSplitPct, casingScreenedSplitPct,
    gravelTonnesPerMetre, gravelBagSizeKg, gravelRatePerBag,
  } = params;

  const compressorFuelLitres = flushingFuelLitres + depthM * (minutesPerRod / rodLengthM);
  const totalFuelLitres = compressorFuelLitres + rigFuelLitres + testPumpingFuelLitres;
  const dieselAmount = round2(totalFuelLitres * fuelRatePerLitre);

  const consumablesBreakdown = consumables.map(c => ({ ...c, amount: round2(c.qty * c.rate) }));
  const consumablesTotal = round2(consumablesBreakdown.reduce((sum, c) => sum + c.amount, 0));

  const plainCasingMetres = depthM * (casingPlainSplitPct / 100);
  const screenedCasingMetres = depthM * (casingScreenedSplitPct / 100);
  const plainCasingUnits = Math.ceil(plainCasingMetres / casingPipeLengthM);
  const screenedCasingUnits = Math.ceil(screenedCasingMetres / casingPipeLengthM);
  const plainCasingCost = round2(plainCasingUnits * plainCasingUnitRate);
  const screenedCasingCost = round2(screenedCasingUnits * screenedCasingUnitRate);

  const gravelBags = Math.ceil((gravelTonnesPerMetre * depthM * 1000) / gravelBagSizeKg);
  const gravelCost = round2(gravelBags * gravelRatePerBag);

  const totalCost = round2(dieselAmount + consumablesTotal + plainCasingCost + screenedCasingCost + gravelCost);
  const ratePerMetre = round2(totalCost / depthM);

  return {
    // Inputs echoed back so a full audit trail (e.g. the CSV costing export) can show the
    // rate used for every line, not just the resulting amount.
    flushingFuelLitres, rigFuelLitres, testPumpingFuelLitres, fuelRatePerLitre,
    minutesPerRod, rodLengthM,
    plainCasingUnitRate, screenedCasingUnitRate, casingPipeLengthM,
    gravelRatePerBag, gravelTonnesPerMetre, gravelBagSizeKg,

    compressorFuelLitres: round2(compressorFuelLitres),
    totalFuelLitres: round2(totalFuelLitres),
    dieselAmount,
    consumablesBreakdown,
    consumablesTotal,
    plainCasingMetres: round2(plainCasingMetres),
    plainCasingUnits,
    plainCasingCost,
    screenedCasingMetres: round2(screenedCasingMetres),
    screenedCasingUnits,
    screenedCasingCost,
    gravelBags,
    gravelCost,
    totalCost,
    ratePerMetre,
  };
}

// Fuel cost for one vehicle's round trip (tarmac + rough road legs), plus whichever
// associated costs (traffic, accommodation, wear & tear, etc.) apply for that job.
function computeMobilizationLeg(params) {
  const {
    tarmacKm, roughKm,
    consumptionTarmacKmPerL, consumptionRoughKmPerL,
    fuelRatePerLitre,
    associatedCosts, // [{ name, qty, rate, included }]
  } = params;

  const tarmacLitres = (tarmacKm / consumptionTarmacKmPerL) * 2;
  const roughLitres = (roughKm / consumptionRoughKmPerL) * 2;
  const tarmacCost = round2(tarmacLitres * fuelRatePerLitre);
  const roughCost = round2(roughLitres * fuelRatePerLitre);
  const fuelCost = round2(tarmacCost + roughCost);

  const associatedBreakdown = associatedCosts.map(c => ({ ...c, amount: c.included ? round2(c.qty * c.rate) : 0 }));
  const associatedTotal = round2(associatedBreakdown.reduce((sum, c) => sum + c.amount, 0));

  return {
    tarmacLitres: round2(tarmacLitres), roughLitres: round2(roughLitres),
    tarmacCost, roughCost, fuelCost,
    associatedBreakdown, associatedTotal,
    total: round2(fuelCost + associatedTotal),
  };
}

// Stage 2: the customer-facing quote. Normally derived from the Stage 1 costing rate, but the
// admin can instead skip the whole costing build-up and type a drilling rate directly (e.g.
// when they already know the rate from experience/negotiation and don't need the 20-line
// breakdown) — pass `params.directDrillingRate` to take that shortcut. Everything else (casing,
// surface casing, mobilization, VAT, payment split) is independent of the costing sheet either
// way, so this only changes how the drilling line's rate is arrived at.
function computeQuote(params) {
  const hasDirectRate = params.directDrillingRate !== undefined && params.directDrillingRate !== null && params.directDrillingRate !== '';
  const costing = hasDirectRate ? null : computeCostingSheet(params);

  const {
    depthM,
    drillingRateDeduction, casingRatePerMetre,
    casingPlainSplitPct, casingScreenedSplitPct,
    surfaceCasingIncluded, surfaceCasingQty, surfaceCasingRate,
    mobilizationRig, mobilizationTruck, mobilizationTestPumpingUnit,
    vatRatePct, paymentDepositPct, paymentBeforeTestPumpingFlat,
  } = params;

  const drillingRate = hasDirectRate
    ? round2(Number(params.directDrillingRate))
    : round2(costing.ratePerMetre - drillingRateDeduction);
  const drillingAmount = round2(drillingRate * depthM);

  const plainCasingMetres = round2(depthM * (casingPlainSplitPct / 100));
  const plainCasingAmount = round2(plainCasingMetres * casingRatePerMetre);
  const screenedCasingMetres = round2(depthM * (casingScreenedSplitPct / 100));
  const screenedCasingAmount = round2(screenedCasingMetres * casingRatePerMetre);
  // Customer quote shows plain + screened as ONE combined line (full depth @ the flat casing
  // rate) — the 70/30 split only matters internally for the costing-sheet unit counts, which
  // use different unit costs per type; on the quote both are billed at the same rate, so
  // splitting them into two rows adds no information for the customer.
  const casingMetres = depthM;
  const casingAmount = round2(plainCasingAmount + screenedCasingAmount);

  const surfaceCasingAmount = round2(surfaceCasingQty * surfaceCasingRate);

  // Same shortcut as directDrillingRate — skip the distance/fuel/associated-cost build-up for
  // all vehicles and use one known mobilization total instead (e.g. an already-agreed
  // transport cost). Vehicle breakdowns are null in this mode since they were never computed.
  const hasDirectMobilization = params.directMobilizationTotal !== undefined && params.directMobilizationTotal !== null && params.directMobilizationTotal !== '';
  const rig = hasDirectMobilization ? null : computeMobilizationLeg(mobilizationRig);
  const truck = hasDirectMobilization ? null : computeMobilizationLeg(mobilizationTruck);
  const testPumpingUnit = hasDirectMobilization ? null : computeMobilizationLeg(mobilizationTestPumpingUnit);
  const mobilizationTotal = hasDirectMobilization
    ? round2(Number(params.directMobilizationTotal))
    : round2(rig.total + truck.total + testPumpingUnit.total);

  const subTotal = round2(
    drillingAmount + plainCasingAmount + screenedCasingAmount +
    (surfaceCasingIncluded ? surfaceCasingAmount : 0) +
    mobilizationTotal
  );
  const vatAmount = round2(subTotal * (vatRatePct / 100));
  const grandTotal = round2(subTotal + vatAmount);

  const paymentDeposit = round2(grandTotal * (paymentDepositPct / 100));
  const paymentBeforeTestPumping = paymentBeforeTestPumpingFlat;
  const paymentAfterDrilling = round2(grandTotal - paymentDeposit - paymentBeforeTestPumping);

  return {
    costing,
    isDirectRate: hasDirectRate,
    drillingRate, drillingAmount,
    casingRatePerMetre,
    casingMetres, casingAmount,
    plainCasingMetres, plainCasingAmount,
    screenedCasingMetres, screenedCasingAmount,
    surfaceCasingIncluded, surfaceCasingQty, surfaceCasingRate, surfaceCasingAmount,
    mobilization: { rig, truck, testPumpingUnit, total: mobilizationTotal, isDirect: hasDirectMobilization },
    subTotal, vatAmount, vatRatePct, grandTotal,
    payment: { deposit: paymentDeposit, beforeTestPumping: paymentBeforeTestPumping, afterDrilling: paymentAfterDrilling },
  };
}

// Loads all admin-configured defaults from the DB and merges them with per-quote overrides
// (anything the admin typed for this specific job) before running computeQuote(). Consumables
// and mobilization associated-cost items are matched by name so an override only needs to
// supply the fields that changed for this quote.
async function generateDrillingQuote(input) {
  const [settingsRows, penetrationRates, consumableDefaults, mobilizationDefaults] = await Promise.all([
    db.getDrillingSettings(),
    db.getDrillingPenetrationRates(),
    db.getDrillingLineItems('consumable'),
    db.getDrillingLineItems('mobilization'),
  ]);
  const s = settingsRows;
  const num = (key) => Number(s[key]);

  const preset = penetrationRates.find(p => p.id === Number(input.penetrationRateId)) || penetrationRates[0];
  const minutesPerRod = input.minutesPerRod !== undefined ? Number(input.minutesPerRod) : Number(preset?.minutes_per_rod || 50);
  const rodLengthM = input.rodLengthM !== undefined ? Number(input.rodLengthM) : Number(preset?.rod_length_m || 5);

  const overrideByName = (list, overrides) => {
    const overrideMap = new Map((overrides || []).map(o => [o.name, o]));
    return list.map(item => {
      const o = overrideMap.get(item.name);
      return {
        name: item.name,
        qty: o?.qty !== undefined ? Number(o.qty) : Number(item.default_qty),
        rate: o?.rate !== undefined ? Number(o.rate) : Number(item.default_rate),
      };
    });
  };

  const overrideAssociated = (list, overrides) => {
    const overrideMap = new Map((overrides || []).map(o => [o.name, o]));
    return list.map(item => {
      const o = overrideMap.get(item.name);
      return {
        name: item.name,
        qty: o?.qty !== undefined ? Number(o.qty) : Number(item.default_qty),
        rate: o?.rate !== undefined ? Number(o.rate) : Number(item.default_rate),
        included: o?.included !== undefined ? !!o.included : Number(item.default_qty) > 0,
      };
    });
  };

  const depthM = Number(input.depthM);
  const fuelRatePerLitre = input.fuelRatePerLitre !== undefined ? Number(input.fuelRatePerLitre) : num('fuel_rate_per_litre');

  const params = {
    depthM,
    directDrillingRate: input.directDrillingRate,
    directMobilizationTotal: input.directMobilizationTotal,
    minutesPerRod, rodLengthM,
    flushingFuelLitres: input.flushingFuelLitres !== undefined ? Number(input.flushingFuelLitres) : num('flushing_fuel_litres_default'),
    rigFuelLitres: input.rigFuelLitres !== undefined ? Number(input.rigFuelLitres) : num('rig_fuel_litres_default'),
    testPumpingFuelLitres: input.testPumpingFuelLitres !== undefined ? Number(input.testPumpingFuelLitres) : num('test_pumping_fuel_litres_default'),
    fuelRatePerLitre,
    consumables: overrideByName(consumableDefaults, input.consumables),
    casingPipeLengthM: input.casingPipeLengthM !== undefined ? Number(input.casingPipeLengthM) : num('casing_pipe_length_m'),
    plainCasingUnitRate: input.plainCasingUnitRate !== undefined ? Number(input.plainCasingUnitRate) : num('plain_casing_unit_rate'),
    screenedCasingUnitRate: input.screenedCasingUnitRate !== undefined ? Number(input.screenedCasingUnitRate) : num('screened_casing_unit_rate'),
    casingPlainSplitPct: input.casingPlainSplitPct !== undefined ? Number(input.casingPlainSplitPct) : num('casing_plain_split_pct'),
    casingScreenedSplitPct: input.casingScreenedSplitPct !== undefined ? Number(input.casingScreenedSplitPct) : num('casing_screened_split_pct'),
    gravelTonnesPerMetre: input.gravelTonnesPerMetre !== undefined ? Number(input.gravelTonnesPerMetre) : num('gravel_tonnes_per_metre'),
    gravelBagSizeKg: input.gravelBagSizeKg !== undefined ? Number(input.gravelBagSizeKg) : num('gravel_bag_size_kg'),
    gravelRatePerBag: input.gravelRatePerBag !== undefined ? Number(input.gravelRatePerBag) : num('gravel_rate_per_bag'),

    drillingRateDeduction: input.drillingRateDeduction !== undefined ? Number(input.drillingRateDeduction) : num('drilling_rate_deduction'),
    casingRatePerMetre: input.casingRatePerMetre !== undefined ? Number(input.casingRatePerMetre) : num('casing_rate_per_metre'),
    surfaceCasingIncluded: !!input.surfaceCasingIncluded,
    surfaceCasingQty: input.surfaceCasingQty !== undefined ? Number(input.surfaceCasingQty) : 1,
    surfaceCasingRate: input.surfaceCasingRate !== undefined ? Number(input.surfaceCasingRate) : num('surface_casing_rate'),

    mobilizationRig: {
      tarmacKm: Number(input.mobilizationRig?.tarmacKm || 0),
      roughKm: Number(input.mobilizationRig?.roughKm || 0),
      consumptionTarmacKmPerL: input.mobilizationRig?.consumptionTarmacKmPerL !== undefined ? Number(input.mobilizationRig.consumptionTarmacKmPerL) : num('fuel_consumption_tarmac_km_per_l'),
      consumptionRoughKmPerL: input.mobilizationRig?.consumptionRoughKmPerL !== undefined ? Number(input.mobilizationRig.consumptionRoughKmPerL) : num('fuel_consumption_rough_km_per_l'),
      fuelRatePerLitre: input.mobilizationRig?.fuelRatePerLitre !== undefined ? Number(input.mobilizationRig.fuelRatePerLitre) : fuelRatePerLitre,
      associatedCosts: overrideAssociated(mobilizationDefaults, input.mobilizationRig?.associatedCosts),
    },
    mobilizationTruck: {
      tarmacKm: Number(input.mobilizationTruck?.tarmacKm || 0),
      roughKm: Number(input.mobilizationTruck?.roughKm || 0),
      consumptionTarmacKmPerL: input.mobilizationTruck?.consumptionTarmacKmPerL !== undefined ? Number(input.mobilizationTruck.consumptionTarmacKmPerL) : num('fuel_consumption_tarmac_km_per_l'),
      consumptionRoughKmPerL: input.mobilizationTruck?.consumptionRoughKmPerL !== undefined ? Number(input.mobilizationTruck.consumptionRoughKmPerL) : num('fuel_consumption_rough_km_per_l'),
      fuelRatePerLitre: input.mobilizationTruck?.fuelRatePerLitre !== undefined ? Number(input.mobilizationTruck.fuelRatePerLitre) : fuelRatePerLitre,
      associatedCosts: overrideAssociated(mobilizationDefaults, input.mobilizationTruck?.associatedCosts),
    },
    mobilizationTestPumpingUnit: {
      tarmacKm: Number(input.mobilizationTestPumpingUnit?.tarmacKm || 0),
      roughKm: Number(input.mobilizationTestPumpingUnit?.roughKm || 0),
      consumptionTarmacKmPerL: input.mobilizationTestPumpingUnit?.consumptionTarmacKmPerL !== undefined ? Number(input.mobilizationTestPumpingUnit.consumptionTarmacKmPerL) : num('fuel_consumption_tarmac_km_per_l'),
      consumptionRoughKmPerL: input.mobilizationTestPumpingUnit?.consumptionRoughKmPerL !== undefined ? Number(input.mobilizationTestPumpingUnit.consumptionRoughKmPerL) : num('fuel_consumption_rough_km_per_l'),
      fuelRatePerLitre: input.mobilizationTestPumpingUnit?.fuelRatePerLitre !== undefined ? Number(input.mobilizationTestPumpingUnit.fuelRatePerLitre) : fuelRatePerLitre,
      associatedCosts: overrideAssociated(mobilizationDefaults, input.mobilizationTestPumpingUnit?.associatedCosts),
    },

    vatRatePct: input.vatRatePct !== undefined ? Number(input.vatRatePct) : num('vat_rate_pct'),
    paymentDepositPct: input.paymentDepositPct !== undefined ? Number(input.paymentDepositPct) : num('payment_deposit_pct'),
    paymentBeforeTestPumpingFlat: input.paymentBeforeTestPumpingFlat !== undefined ? Number(input.paymentBeforeTestPumpingFlat) : num('payment_before_test_pumping_flat'),
  };

  return computeQuote(params);
}

module.exports = { computeCostingSheet, computeMobilizationLeg, computeQuote, generateDrillingQuote };
