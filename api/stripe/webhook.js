// /api/stripe/webhook.js

import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });

function readBuf(req){
  return new Promise((resolve, reject)=>{
    const chunks=[]; req.on('data', c=>chunks.push(c));
    req.on('end', ()=>resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Service duration by package (live hours only)
const SERVICE_HOURS = {
  '50-150-5h': 2,
  '150-250-5h': 2.5,
  '250-350-6h': 3
};

// 1h prep + 1h clean (adjust as needed)
const PREP_HOURS  = 1;
const CLEAN_HOURS = 1;

export default async function handler(req, res){
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  let event;
  try{
    const buf = await readBuf(req);
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET);
  }catch(e){
    console.error('Bad signature', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  try{
    if (event.type === 'checkout.session.completed'){
      const session = event.data.object;
      const md = session.metadata || {};
      // Fire-and-forget calendar (fast 200 to Stripe)
      createCalendarEvent(md).catch(e => console.error('Calendar insert failed', e));
      return res.json({ received: true, ok: true });
    }

    if (event.type === 'checkout.session.expired'){
      return res.json({ received: true, expired: true });
    }

    return res.json({ received: true });
  }catch(e){
    console.error('webhook handler error', e);
    return res.status(500).send('Webhook handler failed');
  }
}

async function createCalendarEvent(md){
  const { google } = await import('googleapis');

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

  // Build window: prep + live + clean
  const startLiveISO = md.startISO ? new Date(md.startISO) : null;
  let startISO, endISO;
  if (startLiveISO){
    const liveHrs = SERVICE_HOURS[md.pkg] ?? 2;
    const start = new Date(startLiveISO.getTime() - PREP_HOURS * 3600e3);
    const end   = new Date(startLiveISO.getTime() + (liveHrs * 3600e3) + CLEAN_HOURS * 3600e3);
    startISO = start.toISOString();
    endISO   = end.toISOString();
  }

  const summary = `Manna — ${md.mainBar || 'Snack Bar'} (${md.pkg || ''})`;
  const description = [
    `Client: ${md.fullName || ''} (${md.email || ''})${md.phone ? ' • ' + md.phone : ''}`,
    `Venue: ${md.venue || '-'}`,
    `Setup: ${md.setup || '-'} • Power: ${md.power || '-'}`,
    md.payMode ? `Payment: ${md.payMode} — Charged ${md.dueNow} / Total ${md.total}` : null
  ].filter(Boolean).join('\n');

  await calendar.events.insert({
    calendarId: process.env.CALENDAR_ID || 'primary',
    requestBody: {
      summary,
      description,
      start: startISO ? { dateTime: startISO, timeZone: tz } : undefined,
      end:   endISO   ? { dateTime: endISO,   timeZone: tz } : undefined,
      guestsCanInviteOthers: false,
      guestsCanSeeOtherGuests: true
    }
  });
}
