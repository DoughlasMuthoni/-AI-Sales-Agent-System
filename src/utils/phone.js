// Coerces a phone number to WhatsApp's wa_id format (digits only, country code, no leading
// '+' or local '0') so numbers entered in different formats — a manually-added lead, a
// number Claude captured mid-conversation, an admin editing a lead — all resolve to the same
// session key WhatsApp itself uses. Without this, a differently-formatted phone silently
// opens a brand-new conversation instead of appending to the customer's real one.
function normalizePhone(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return digits;
  if (digits.startsWith('0')) digits = '254' + digits.slice(1);
  else if (digits.length === 9) digits = '254' + digits;
  return digits;
}

module.exports = { normalizePhone };
