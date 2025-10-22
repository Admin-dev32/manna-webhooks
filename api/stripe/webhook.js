// /api/stripe/webhook.js
export const config = { runtime: 'nodejs', maxDuration: 60 };

import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// horas “en vivo” por paquete (igual que antes)
const SERVICE_HOURS = {
  '50-150-5h': 2,
  '150-250-5h': 2.5,
  '250-350-6h': 3,
};

const PREP_HOURS = 1;
const CLEAN_HOURS = 1;

// ——— helpers ———
function readBuf(req){
  return new Promise((resolve, reject)=>{
    const chunks=[]; req.on('data', c=>chunks.push(c));
    req.on('end', ()=>resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function titleFor(key){
  return ({
    pancake: 'Mini Pancake',
    esquites: 'Esquites',
    maruchan: 'Maruchan',
    tostiloco: 'Tostiloco (Premium)'
  }[key]) || 'Snack Bar';
}
function emojiFor(key){
  return ({
    pancake: '🥞',
    esquites: '🌽',
    maruchan: '🍜',
    tostiloco: '🌶️'
  }[key]) || '🍽️';
}

export default async function handler(req, res){
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  // Verificar firma de Stripe con body crudo
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
    if (event.type === 'checkout.session.completed'){
      const session = event.data.object;
      const md = session.metadata || {};

      // Requisitos mínimos
      if (!md.startISO || !md.pkg){
        console.error('[WEBHOOK] missing startISO/pkg in metadata');
        return res.json({ received: true, missingMetadata: true });
      }

      // Google service account listo
      if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON){
        console.error('[WEBHOOK] GOOGLE_SERVICE_ACCOUNT_JSON missing');
        return res.json({ received: true, noGoogle: true });
      }

      // === Calendar insert (esperamos a que termine para ver errores en logs) ===
      await createCalendarEvent(md);

      return res.json({ received: true, ok: true });
    }

    if (event.type === 'checkout.session.expired'){
      return res.json({ received: true, expired: true });
    }

    return res.json({ received: true });
  }catch(e){
    console.error('[WEBHOOK] error:', e);
    return res.status(500).send('Webhook handler failed');
  }
}

async function createCalendarEvent(md){
  const { google } = await import('googleapis');

  // Parse y normaliza el service account
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

  // Ventana: 1h antes + live + 1h limpieza
  const startLive = new Date(md.startISO);
  const live = SERVICE_HOURS[md.pkg] ?? 2;
  const start = new Date(startLive.getTime() - PREP_HOURS * 3600e3);
  const end   = new Date(startLive.getTime() + live * 3600e3 + CLEAN_HOURS * 3600e3);

  // 👇 ÚNICO cambio visible: emojis en el summary
  const summary = `${emojiFor(md.mainBar)} Manna — ${titleFor(md.mainBar)} (${md.pkg})`;

  const description = [
    `Cliente: ${md.fullName || ''} (${md.email || ''})${md.phone ? ' • ' + md.phone : ''}`,
    `Venue: ${md.venue || '-'}`,
    `Setup: ${md.setup || '-'} • Power: ${md.power || '-'}`,
    md.payMode ? `Pago: ${md.payMode} — Cobrado ${md.dueNow} / Total ${md.total}` : null
  ].filter(Boolean).join('\n');

  // Sin colorId, sin attendees, sin sendUpdates (máxima compatibilidad)
  return calendar.events.insert({
    calendarId: calId,
    requestBody: {
      summary,
      description,
      start: { dateTime: start.toISOString(), timeZone: tz },
      end:   { dateTime: end.toISOString(),   timeZone: tz }
    }
  });
}
