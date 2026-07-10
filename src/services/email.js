const nodemailer = require('nodemailer');

function createTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '465'),
    secure: process.env.SMTP_PORT !== '587',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

const FROM = '"Waterlift AI Agent" <info@waterlift.co.ke>';
const TO   = process.env.NOTIFICATION_EMAIL || 'info@waterlift.co.ke';

function timestamp() {
  return new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });
}

async function sendLeadNotification(lead) {
  const subject = `🟡 New Lead — ${lead.name} (${lead.service === 'solar' ? 'Solar' : 'Borehole'}, ${lead.location})`;

  const html = `
    <h2 style="color:#f59e0b;">🟡 New Qualified Lead</h2>
    <table style="border-collapse:collapse;width:100%;font-family:sans-serif;">
      <tr><td style="padding:8px;background:#f9f9f9;font-weight:bold;">Name</td><td style="padding:8px;">${lead.name}</td></tr>
      <tr><td style="padding:8px;background:#f9f9f9;font-weight:bold;">Phone</td><td style="padding:8px;">${lead.phone}</td></tr>
      <tr><td style="padding:8px;background:#f9f9f9;font-weight:bold;">Service</td><td style="padding:8px;">${lead.service === 'solar' ? '☀️ Solar' : '💧 Borehole'}</td></tr>
      <tr><td style="padding:8px;background:#f9f9f9;font-weight:bold;">Location</td><td style="padding:8px;">${lead.location}</td></tr>
      <tr><td style="padding:8px;background:#f9f9f9;font-weight:bold;">Property</td><td style="padding:8px;">${lead.property_type}</td></tr>
      ${lead.estimated_budget ? `<tr><td style="padding:8px;background:#f9f9f9;font-weight:bold;">Budget</td><td style="padding:8px;">${lead.estimated_budget}</td></tr>` : ''}
      ${lead.notes ? `<tr><td style="padding:8px;background:#f9f9f9;font-weight:bold;">Notes</td><td style="padding:8px;">${lead.notes}</td></tr>` : ''}
      <tr><td style="padding:8px;background:#f9f9f9;font-weight:bold;">Time</td><td style="padding:8px;">${timestamp()}</td></tr>
    </table>
    <p style="color:#666;font-size:13px;margin-top:16px;">Follow up with this prospect to close the deal.</p>
  `;

  await send(subject, html);
}

async function sendCallbackNotification(booking) {
  const subject = `🔴 Callback Requested — ${booking.name} | ${booking.preferred_date} at ${booking.preferred_time}`;

  const html = `
    <h2 style="color:#ef4444;">🔴 Hot Lead — Callback Requested</h2>
    <table style="border-collapse:collapse;width:100%;font-family:sans-serif;">
      <tr><td style="padding:8px;background:#f9f9f9;font-weight:bold;">Name</td><td style="padding:8px;">${booking.name}</td></tr>
      <tr><td style="padding:8px;background:#f9f9f9;font-weight:bold;">Phone</td><td style="padding:8px;">${booking.phone}</td></tr>
      <tr><td style="padding:8px;background:#f9f9f9;font-weight:bold;">Preferred Date</td><td style="padding:8px;">${booking.preferred_date}</td></tr>
      <tr><td style="padding:8px;background:#f9f9f9;font-weight:bold;">Preferred Time</td><td style="padding:8px;">${booking.preferred_time}</td></tr>
      ${booking.notes ? `<tr><td style="padding:8px;background:#f9f9f9;font-weight:bold;">Notes</td><td style="padding:8px;">${booking.notes}</td></tr>` : ''}
      <tr><td style="padding:8px;background:#f9f9f9;font-weight:bold;">Booked At</td><td style="padding:8px;">${timestamp()}</td></tr>
    </table>
    <p style="color:#ef4444;font-weight:bold;margin-top:16px;">⚡ This prospect is ready to talk — call them back at the requested time.</p>
  `;

  await send(subject, html);
}

async function sendEscalationNotification(record) {
  const urgencyColor = record.urgency === 'high' ? '#dc2626' : record.urgency === 'medium' ? '#f59e0b' : '#6b7280';
  const urgencyIcon  = record.urgency === 'high' ? '🚨' : record.urgency === 'medium' ? '⚠️' : 'ℹ️';
  const subject = `${urgencyIcon} Escalation [${record.urgency.toUpperCase()}] — ${record.customer_name || 'Unknown'} needs human support`;

  const html = `
    <h2 style="color:${urgencyColor};">${urgencyIcon} Human Takeover Required</h2>
    <table style="border-collapse:collapse;width:100%;font-family:sans-serif;">
      <tr><td style="padding:8px;background:#f9f9f9;font-weight:bold;">Customer</td><td style="padding:8px;">${record.customer_name || 'Not captured'}</td></tr>
      <tr><td style="padding:8px;background:#f9f9f9;font-weight:bold;">Urgency</td><td style="padding:8px;color:${urgencyColor};font-weight:bold;">${record.urgency.toUpperCase()}</td></tr>
      <tr><td style="padding:8px;background:#f9f9f9;font-weight:bold;">Reason</td><td style="padding:8px;">${record.reason}</td></tr>
      <tr><td style="padding:8px;background:#f9f9f9;font-weight:bold;">Time</td><td style="padding:8px;">${timestamp()}</td></tr>
    </table>
    <p style="color:${urgencyColor};font-weight:bold;margin-top:16px;">A salesperson should take over this conversation immediately.</p>
  `;

  await send(subject, html);
}

async function send(subject, html) {
  try {
    const transporter = createTransport();
    await transporter.sendMail({ from: FROM, to: TO, subject, html });
    console.log('[email] Notification sent:', subject);
  } catch (err) {
    console.error('[email] Failed to send notification:', err.message);
  }
}

module.exports = { sendLeadNotification, sendCallbackNotification, sendEscalationNotification };
