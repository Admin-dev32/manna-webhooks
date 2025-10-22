// /api/stripe/webhook.js
export const config = { runtime: 'nodejs', maxDuration: 60 };

import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });

/** Buffers globales (deben coincidir con availability.js) */
const PREP_HOURS  = 1;   // ⏱️ setup antes
const CLEAN_HOURS = 1;   // 🧹 limpieza después

/** Horas “live” según paquete (ajústalo a tu tabla real) */
const SERVICE_HOURS = {
  '50-150-5h': 2,
  '150-250-5h': 2.5,
  '250-350-6h': 3
};

function readBuf(req){
  return new Promise((resolve, reject)=>{
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res){
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  // ===== Verificar firma Stripe =====
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

      // Crear evento en Calendar en segundo plano (fast 200 a Stripe)
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

  // Service Account desde env (una sola variable JSON)
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

  // Ventana completa a partir del startISO elegido por el cliente
  const startLiveISO = md.startISO ? new Date(md.startISO) : null;
  let startISO, endISO;
  if (startLiveISO){
    const liveHrs = SERVICE_HOURS[md.pkg] ?? 2;
    const start = new Date(startLiveISO.getTime() - PREP_HOURS * 3600e3);
    const end   = new Date(startLiveISO.getTime() + (liveHrs * 3600e3) + CLEAN_HOURS * 3600e3);
    startISO = start.toISOString();
    endISO   = end.toISOString();
  }

  // Título + descripción con emojis
  const summary = `Manna — ${md.mainBar || 'Snack Bar'} (${md.pkg || ''})`;
  const description = [
    `📌 #${md.bookingId || '—'}`,
    `👤 Cliente: ${md.fullName || '—'} (${md.email || '—'}${md.phone ? ' • ' + md.phone : ''})`,
    `🍽️ Servicio: ${md.mainBar || 'Snack Bar'} • ${md.pkg || ''}`,
    md.secondEnabled === 'true' ? `➕ Second Bar: ${md.secondBar || ''} — ${md.secondSize || ''}` : null,
    md.fountainEnabled === 'true' ? `🍫 Fuente: ${md.fountainSize || ''}${md.fountainType ? ' (' + md.fountainType + ')' : ''}` : null,
    `📍 Lugar: ${md.venue || '—'}`,
    `🧰 Setup: ${md.setup || '—'}   🔌 Power: ${md.power || '—'}`,
    md.payMode ? `💳 Pago: ${md.payMode} — Cobrado ${md.dueNow} / Total ${md.total}` : null
  ].filter(Boolean).join('\n');

  // Opcionales: color e invitados (envía invitación al cliente)
  const attendees = md.email ? [{ email: md.email, displayName: md.fullName || '' }] : [];

  await calendar.events.insert({
    calendarId: process.env.CALENDAR_ID || 'primary',
    requestBody: {
      summary,
      description,
      colorId: '11', // opcional: 11 = verde, cambia si quieres
      start: startISO ? { dateTime: startISO, timeZone: tz } : undefined,
      end:   endISO   ? { dateTime: endISO,   timeZone: tz } : undefined,
      attendees,
      sendUpdates: attendees.length ? 'all' : 'none',
      guestsCanInviteOthers: false,
      guestsCanSeeOtherGuests: true
    }
  });
}
