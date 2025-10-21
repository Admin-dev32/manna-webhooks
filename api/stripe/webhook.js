// /api/stripe/webhook.js
export const config = {
  api: { bodyParser: false },
  runtime: 'nodejs'
};

import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function readBuf(req){
  return new Promise((resolve, reject)=>{
    const chunks=[]; req.on('data', c=>chunks.push(c));
    req.on('end', ()=>resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Duración “live” de servicio por paquete (ajústalo a tu lógica)
const SERVICE_HOURS = {
  "50-150-5h": 2,       // servicio en vivo (el título “5h” es nombre comercial)
  "150-250-5h": 2.5,
  "250-350-6h": 3
};

// Si quieres bloquear 1h antes + 1h limpieza, cámbialo aquí:
const PREP_HOURS   = 1;
const CLEAN_HOURS  = 1;

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

      // ===== Crea evento en Google Calendar (Service Account) =====
      try{
        const { google } = await import('googleapis');
        const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
        const jwt = new google.auth.JWT(
          sa.client_email,
          null,
          sa.private_key,
          ['https://www.googleapis.com/auth/calendar']
        );
        const calendar = google.calendar({ version: 'v3', auth: jwt });

        const tz = process.env.TIMEZONE || 'America/Los_Angeles';

        // Construye ventana: 1h antes + live + 1h limpieza
        const startLiveISO = md.startISO ? new Date(md.startISO) : null;
        let startISO = null, endISO = null;
        if (startLiveISO){
          const live = SERVICE_HOURS[md.pkg] || 2;
          const start = new Date(startLiveISO.getTime() - PREP_HOURS * 3600e3);
          const end   = new Date(startLiveISO.getTime() + (live * 3600e3) + CLEAN_HOURS * 3600e3);
          startISO = start.toISOString();
          endISO   = end.toISOString();
        }

        const summary = `Manna — ${md.mainBar || 'Snack Bar'} (${md.pkg || ''})`;
        const description = [
          `Client: ${md.fullName} (${md.email}) ${md.phone ? '• ' + md.phone : ''}`,
          `Venue: ${md.venue || '-'}`,
          `Setup: ${md.setup || '-'} • Power: ${md.power || '-'}`,
          `Payment: ${md.payMode} — Charged ${md.dueNow} / Total ${md.total}`
        ].join('\n');

        await calendar.events.insert({
          calendarId: process.env.CALENDAR_ID || 'primary',
          requestBody: {
            summary,
            description,
            start: startISO ? { dateTime: startISO, timeZone: tz } : undefined,
            end:   endISO   ? { dateTime: endISO,   timeZone: tz } : undefined,
            guestsCanInviteOthers: false,
            guestsCanSeeOtherGuests: true,
          }
        });
      }catch(e){
        console.error('Calendar insert failed', e.message);
      }

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
