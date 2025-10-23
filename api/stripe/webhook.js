// /api/stripe/webhook.js
export const config = { api: { bodyParser: false }, runtime: 'nodejs' };

import Stripe from 'stripe';
import { getCalendarClient } from '../_google.js'; // <- ruta correcta desde /api/stripe/

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

// Reglas de agenda
const PREP_HOURS = 1;
const CLEAN_HOURS = 1;
const DAY_CAP = 2; // máximo 2 reservas por día (en ese calendario)

function pkgToHours(pkg) {
  if (pkg === '50-150-5h') return 2;
  if (pkg === '150-250-5h') return 2.5;
  if (pkg === '250-350-6h') return 3;
  return 2; // fallback
}

// Leer el RAW body SIN 'micro'
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function addHours(d, h) { return new Date(d.getTime() + h * 3600e3); }
function blockWindow(startISO, liveHours) {
  const start = new Date(startISO);
  const blockStart = addHours(start, -PREP_HOURS);
  const blockEnd   = addHours(start,  liveHours + CLEAN_HOURS);
  return { blockStart, blockEnd };
}
function overlaps(aStart, aEnd, bStart, bEnd) { return !(aEnd <= bStart || aStart >= bEnd); }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  // 1) Verificar firma de Stripe con RAW body
  let event;
  try {
    const sig = req.headers['stripe-signature'];
    const buf = await readRawBody(req);
    event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[webhook] signature/parse failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // 2) Solo procesamos el checkout.session.completed
  if (event.type !== 'checkout.session.completed') {
    return res.json({ received: true, ignored: event.type });
  }

  const session = event.data.object;
  const md = session.metadata || {};

  try {
    const tz = process.env.TIMEZONE || 'America/Los_Angeles';
    const calId = process.env.CALENDAR_ID || 'primary';
    const calendar = getCalendarClient(); // usa tus GCP_* de _google.js

    // 3) Calcular ventana de bloqueo (prep + servicio + clean)
    const startISO = md.startISO;
    const liveHrs  = Number(md.hours || 0) || pkgToHours(md.pkg);
    if (!startISO || !liveHrs) {
      console.warn('[webhook] missing startISO/hours — skipping calendar insert');
      return res.json({ received: true, skipped: true });
    }
    const { blockStart, blockEnd } = blockWindow(startISO, liveHrs);

    // 4) Cargar eventos del MISMO día (para capacidad y traslape)
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
    const items = (list.data.items || []).filter(e => e.status !== 'cancelled');

    // Idempotencia: si ya existe este pedido, lo actualizamos
    const existing = items.find(e => e.extendedProperties?.private?.orderId === session.id);

    // Capacidad: máximo 2 por día (sin contar el que vamos a actualizar)
    const countToday = items.filter(e => e.id !== existing?.id).length;
    if (!existing && countToday >= DAY_CAP) {
      console.warn('[webhook] capacity full (2/day). Skipping insert.');
      return res.json({ received: true, capacity: 'full' });
    }

    // Traslape: solo 1 bar al mismo tiempo (incluye prep+live+clean)
    const isOverlap = items.some(e => {
      const s = new Date(e.start?.dateTime || e.start?.date);
      const en = new Date(e.end?.dateTime || e.end?.date);
      return overlaps(blockStart, blockEnd, s, en) && e.id !== existing?.id;
    });
    if (!existing && isOverlap) {
      console.warn('[webhook] overlap with another event. Skipping insert.');
      return res.json({ received: true, conflict: 'overlap' });
    }

    // 5) Construir el evento (sin attendees para evitar error de delegación)
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
      // IMPORTANTE: no invitamos asistentes (Service Account sin DWD)
      // attendees: md.email ? [{ email: md.email, displayName: md.fullName || '' }] : [],
      extendedProperties: { private: { orderId: session.id } },
      guestsCanInviteOthers: false,
      guestsCanModify: false,
      guestsCanSeeOtherGuests: false
    };

    if (existing) {
      await calendar.events.patch({
        calendarId: calId,
        eventId: existing.id,
        requestBody,
        sendUpdates: 'none' // no envía invitaciones
      });
      return res.json({ received: true, updated: true });
    } else {
      await calendar.events.insert({
        calendarId: calId,
        requestBody,
        sendUpdates: 'none' // no envía invitaciones
      });
      return res.json({ received: true, created: true });
    }
  } catch (err) {
    console.error('[webhook] handler error:', err);
    return res.status(500).json({ error: 'server_error', detail: err.message });
  }
}
