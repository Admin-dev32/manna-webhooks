// /api/stripe/webhook.js
export const config = { api: { bodyParser: false }, runtime: 'nodejs' };

import Stripe from 'stripe';
import { getCalendarClient } from '../_google.js'; // <- ojo la ruta si estás en /api/stripe/

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

const PREP_HOURS = 1;
const CLEAN_HOURS = 1;
const DAY_CAP = 2;

function pkgToHours(pkg) {
  if (pkg === '50-150-5h') return 2;
  if (pkg === '150-250-5h') return 2.5;
  if (pkg === '250-350-6h') return 3;
  return 2;
}

function addHours(d, h) { return new Date(d.getTime() + h * 3600e3); }
function blockWindow(startISO, liveHours) {
  const start = new Date(startISO);
  const blockStart = addHours(start, -PREP_HOURS);
  const blockEnd   = addHours(start,  liveHours + CLEAN_HOURS);
  return { blockStart, blockEnd };
}
function overlaps(aStart, aEnd, bStart, bEnd) { return !(aEnd <= bStart || aStart >= bEnd); }

// 👇 UTILIDAD para leer el RAW body sin 'micro'
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  // 1) Verificar firma de Stripe con RAW body (Node puro)
  let event;
  try {
    const sig = req.headers['stripe-signature'];
    const buf = await readRawBody(req);
    event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[webhook] signature/parse failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // 2) Solo nos interesa checkout.session.completed
  if (event.type !== 'checkout.session.completed') {
    return res.json({ received: true, ignored: event.type });
  }

  const session = event.data.object;
  const md = session.metadata || {};

  try {
    const tz = process.env.TIMEZONE || 'America/Los_Angeles';
    const calId = process.env.CALENDAR_ID || 'primary';
    const calendar = getCalendarClient(); // usa tus GCP_* de _google.js

    const startISO = md.startISO;
    const liveHrs  = Number(md.hours || 0) || pkgToHours(md.pkg);
    if (!startISO || !liveHrs) {
      console.warn('[webhook] missing startISO/hours — skipping calendar insert');
      return res.json({ received: true, skipped: true });
    }
    const { blockStart, blockEnd } = blockWindow(startISO, liveHrs);

    // Cargar eventos del mismo día (para capacidad/traslape)
    const day = new Date(startISO);
    const dayStart = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 0,0,0));
    const dayEnd   = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 23,59,59));

    const list = await calendar.events.list({
      calendarId: calId,
      timeMin: dayStart.toISOString(),
      timeMax: dayEnd.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 100
    });
    const items = list.data.items || [];

    // Idempotencia por session.id
    const existing = items.find(e => e.extendedProperties?.private?.orderId === session.id);

    // Capacidad: máximo 2 por día (no contar el propio si actualizamos)
    const countToday = items.filter(e => e.id !== existing?.id).length;
    if (!existing && countToday >= DAY_CAP) {
      console.warn('[webhook] capacity full (2/day). Skipping insert.');
      return res.json({ received: true, capacity: 'full' });
    }

    // Traslape: no permitir 2 a la misma hora (considera prep+live+clean)
    const isOverlap = items.some(e => {
      const s = new Date(e.start?.dateTime || e.start?.date);
      const en = new Date(e.end?.dateTime || e.end?.date);
      return overlaps(blockStart, blockEnd, s, en) && e.id !== existing?.id;
    });
    if (!existing && isOverlap) {
      console.warn('[webhook] overlap with another event. Skipping insert.');
      return res.json({ received: true, conflict: 'overlap' });
    }

    const requestBody = {
      summary: `Manna Snack Bars — ${md.mainBar || 'Booking'} (${md.pkg || ''})`,
      description: [
        `Name: ${md.fullName || ''}`,
        md.email ? `Email: ${md.email}` : '',
        md.phone ? `Phone: ${md.phone}` : '',
        `Package: ${md.pkg || ''}`,
        `Bar: ${md.mainBar || ''}`,
        `Date: ${md.dateISO || ''}`,
        `Start: ${startISO}`,
        `Service hours: ${liveHrs}`,
        `Stripe session: ${session.id}`
      ].filter(Boolean).join('\n'),
      location: md.venue || '',
      start: { dateTime: blockStart.toISOString(), timeZone: tz },
      end:   { dateTime: blockEnd.toISOString(),   timeZone: tz },
      attendees: md.email ? [{ email: md.email, displayName: md.fullName || '' }] : [],
      extendedProperties: { private: { orderId: session.id } },
    };

    if (existing) {
      await calendar.events.patch({ calendarId: calId, eventId: existing.id, requestBody });
      return res.json({ received: true, updated: true });
    } else {
      await calendar.events.insert({ calendarId: calId, requestBody });
      return res.json({ received: true, created: true });
    }
  } catch (err) {
    console.error('[webhook] handler error:', err);
    return res.status(500).send('A server error has occurred');
  }
}
