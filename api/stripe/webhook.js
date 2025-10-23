// /api/webhook.js
export const config = { api: { bodyParser: false }, runtime: 'nodejs' };

import Stripe from 'stripe';
import { buffer } from 'micro';
import { getCalendarClient } from './_google.js'; // you already have this helper
// _google.js uses GCP_CLIENT_EMAIL + GCP_PRIVATE_KEY and builds the client. :contentReference[oaicite:6]{index=6}

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

function ymdFromISO(iso, tz) {
  // Convert ISO to Y-M-D in the site timezone to group per-day reliably
  const d = new Date(iso);
  const s = d.toLocaleString('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const [m, day, y] = s.split(/[\/, ]+/).map(Number);
  return `${y}-${String(m).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}

function addHours(date, h) {
  return new Date(date.getTime() + h * 3600e3);
}

function blockWindow(startISO, liveHours) {
  const start = new Date(startISO);
  const blockStart = addHours(start, -PREP_HOURS);
  const blockEnd   = addHours(start, liveHours + CLEAN_HOURS);
  return { blockStart, blockEnd };
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return !(aEnd <= bStart || aStart >= bEnd);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  // 1) Verify Stripe signature with RAW body
  let event;
  try {
    const sig = req.headers['stripe-signature'];
    const buf = await buffer(req);
    event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // 2) Only handle completed checkout
  if (event.type !== 'checkout.session.completed') {
    return res.json({ received: true });
  }

  const session = event.data.object;
  const md = session.metadata || {};

  try {
    const tz = process.env.TIMEZONE || 'America/Los_Angeles';
    const calId = process.env.CALENDAR_ID || 'primary';
    const calendar = getCalendarClient(); // existing helper uses your env vars. :contentReference[oaicite:7]{index=7}

    // 3) Build timing (use hours from metadata, fallback from pkg)
    const startISO = md.startISO;
    const liveHours = Number(md.hours || 0) || pkgToHours(md.pkg);
    if (!startISO || !liveHours) {
      console.warn('Missing startISO/hours — skip calendar insert');
      return res.json({ received: true, skipped: true });
    }
    const { blockStart, blockEnd } = blockWindow(startISO, liveHours);

    // 4) Load same-day events to enforce capacity & overlap
    const ymd = ymdFromISO(startISO, tz);
    const dayStart = new Date(`${ymd}T00:00:00Z`);
    const dayEnd   = new Date(`${ymd}T23:59:59Z`);

    const list = await calendar.events.list({
      calendarId: calId,
      timeMin: dayStart.toISOString(),
      timeMax: dayEnd.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 100
    });
    const items = list.data.items || [];

    // Upsert guard: if we already created for this session.id, patch it instead of adding
    const existing = items.find(e =>
      e.extendedProperties?.private?.orderId === session.id
    );

    // CAPACITY: at most 2 bars in the same day
    // If existing belongs to this order, exclude it from the count.
    const countToday = items.filter(e => e.id !== existing?.id).length;
    if (!existing && countToday >= DAY_CAP) {
      console.warn('Day capacity reached (2). Skipping insert.');
      return res.json({ received: true, capacity: 'full' });
    }

    // OVERLAP: only 1 bar at the same time (block includes prep+live+clean)
    const overlapping = items.some(e => {
      const s = new Date(e.start?.dateTime || e.start?.date);
      const en = new Date(e.end?.dateTime || e.end?.date);
      return overlaps(blockStart, blockEnd, s, en) && e.id !== existing?.id;
    });
    if (!existing && overlapping) {
      console.warn('Time overlap with another event. Skipping insert.');
      return res.json({ received: true, conflict: 'overlap' });
    }

    // 5) Create or update the event (idempotent via orderId)
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
        `Service hours: ${liveHours}`,
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
    console.error('Webhook handler error:', err);
    return res.status(500).send('Webhook handler error');
  }
}
