// /api/stripe/webhook.js
export const config = { runtime: 'nodejs', maxDuration: 60 };

import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });

function readBuf(req){
  return new Promise((resolve, reject)=>{
    const chunks=[]; req.on('data', c=>chunks.push(c));
    req.on('end', ()=>resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Live service length by package (hrs)
const SERVICE_HOURS = {
  '50-150-5h': 2,
  '150-250-5h': 2.5,
  '250-350-6h': 3
};

// 1h buffer before + 1h cleaning after
const PREP_HOURS  = 1;
const CLEAN_HOURS = 1;

// Emojis per bar (for calendar summary)
const EMOJI_BY_BAR = {
  pancake: '🥞',
  esquites: '🌽',
  maruchan: '🍜',
  tostiloco: '🌶️'
};

export default async function handler(req, res){
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  let event;
  try{
    const buf = await readBuf(req);
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET);
  }catch(e){
    console.error('[WEBHOOK] Bad signature:', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  try{
    console.log('[WEBHOOK] type =', event.type);

    if (event.type === 'checkout.session.completed'){
      const session = event.data.object;
      const md = session.metadata || {};
      console.log('[WEBHOOK] metadata =', md);

      // Fire-and-forget calendar create (don’t slow Stripe)
      createCalendarEvent(md).then(
        ()=> console.log('[WEBHOOK] calendar created OK'),
        (err)=> console.error('[WEBHOOK] calendar create FAILED:', err?.message || err)
      );

      return res.json({ received: true, ok: true });
    }

    if (event.type === 'checkout.session.expired'){
      return res.json({ received: true, expired: true });
    }

    return res.json({ received: true });
  }catch(e){
    console.error('[WEBHOOK] handler error:', e);
    return res.status(500).send('Webhook handler failed');
  }
}

async function createCalendarEvent(md){
  const { google } = await import('googleapis');

  // Read service account JSON from env; fix \n in private key if needed
  const saRaw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}';
  const sa = JSON.parse(saRaw);
  if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');

  const jwt = new google.auth.JWT(
    sa.client_email,
    null,
    sa.private_key,
    ['https://www.googleapis.com/auth/calendar']
  );
  const calendar = google.calendar({ version: 'v3', auth: jwt });

  const tz = process.env.TIMEZONE || 'America/Los_Angeles';
  const calId = process.env.CALENDAR_ID || 'primary';

  // Build event window: prep + live + clean
  if (!md.startISO) {
    throw new Error('No startISO in metadata (can’t build calendar window)');
  }
  const startLive = new Date(md.startISO);
  const liveHrs   = SERVICE_HOURS[md.pkg] ?? 2;
  const startISO  = new Date(startLive.getTime() - PREP_HOURS * 3600e3).toISOString();
  const endISO    = new Date(startLive.getTime() + (liveHrs * 3600e3) + CLEAN_HOURS * 3600e3).toISOString();

  const emoji   = EMOJI_BY_BAR[md.mainBar] || '🍽️';
  const summary = `Manna — ${emoji} ${md.mainBar || 'Snack Bar'} (${md.pkg || ''})`;

  const lines = [
    `Client: ${md.fullName || ''} (${md.email || ''})${md.phone ? ' • ' + md.phone : ''}`,
    `Venue: ${md.venue || '-'}`,
    `Setup: ${md.setup || '-'} • Power: ${md.power || '-'}`,
    md.payMode ? `Payment: ${md.payMode} — Charged ${md.dueNow || ''} / Total ${md.total || ''}` : null
  ].filter(Boolean);
  const description = lines.join('\n');

  const attendees = md.email ? [{ email: md.email, displayName: md.fullName || '' }] : [];

  // Optional: colorId "11" = bold green, pick what you like (1..11)
 await calendar.events.insert({
  calendarId: process.env.CALENDAR_ID || 'primary',
  requestBody: {
    summary,
    description,
    start: startISO ? { dateTime: startISO, timeZone: tz } : undefined,
    end:   endISO   ? { dateTime: endISO,   timeZone: tz } : undefined,

    // 🔒 Importante: SIN attendees ni sendUpdates
    // (las cuentas de servicio no pueden invitar sin DWD)
    guestsCanInviteOthers: false,
    guestsCanSeeOtherGuests: true
  }
});

}
