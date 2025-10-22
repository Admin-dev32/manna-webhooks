// /api/availability.js
export const config = { runtime: 'nodejs' };

/**
 * Ventana de horarios visibles en el selector (hora local)
 * 9 = 9am, 22 = 10pm
 */
const HOURS_RANGE = { start: 9, end: 22 };

/** Buffers globales (deben coincidir con webhook.js) */
const PREP_HOURS  = 1;   // ⏱️ setup antes
const CLEAN_HOURS = 1;   // 🧹 limpieza después

/** Máximo de eventos traslapados permitidos */
const MAX_CONCURRENT = 2;

/** Convierte YYYY-MM-DD + hora local -> ISO en el TZ configurado */
function zonedStartISO(ymd, hour, tz){
  const [y,m,d] = ymd.split('-').map(Number);
  const guessUTC = Date.UTC(y, m-1, d, hour, 0, 0);
  const asUTC = new Date(guessUTC);
  const asTZ  = new Date(asUTC.toLocaleString('en-US', { timeZone: tz }));
  const offsetMs = asTZ.getTime() - asUTC.getTime();
  return new Date(guessUTC - offsetMs).toISOString();
}

export default async function handler(req, res){
  // ===== CORS simple =====
  const allow = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const origin = req.headers.origin || '';
  const okOrigin = allow.length ? allow.includes(origin) : true;

  if (req.method === 'OPTIONS'){
    res.setHeader('Access-Control-Allow-Origin', okOrigin ? origin : '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');
    return res.status(204).end();
  }
  res.setHeader('Access-Control-Allow-Origin', okOrigin ? origin : '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method !== 'GET'){
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try{
    const { date, hours } = req.query || {};
    const tz    = process.env.TIMEZONE   || 'America/Los_Angeles';
    const calId = process.env.CALENDAR_ID || 'primary';
    const liveHours = Math.max(1, parseFloat(hours || '2')); // 2, 2.5, 3…

    if (!date) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });

    // ===== Google Calendar (Service Account) =====
    const { google } = await import('googleapis');
    const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
    if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');

    const jwt = new google.auth.JWT(
      sa.client_email,
      null,
      sa.private_key,
      ['https://www.googleapis.com/auth/calendar']
    );
    const calendar = google.calendar({ version: 'v3', auth: jwt });

    // Carga eventos de TODO el día para revisar traslapes
    const dayStart = zonedStartISO(date, 0,  tz);
    const dayEnd   = zonedStartISO(date, 23, tz);

    const rsp = await calendar.events.list({
      calendarId: calId,
      timeMin: dayStart,
      timeMax: dayEnd,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250
    });

    const events = (rsp.data.items || []).map(e => ({
      start: new Date(e.start?.dateTime || e.start?.date),
      end:   new Date(e.end?.dateTime   || e.end?.date)
    }));

    const slots = [];
    for (let h = HOURS_RANGE.start; h <= HOURS_RANGE.end; h++){
      const startISO = zonedStartISO(date, h, tz);
      const start    = new Date(startISO);

      // No ofrecer horas en el pasado
      if (start < new Date()) continue;

      // Ventana completa: ⏱️ prep + 🍽️ live + 🧹 clean
      const blockStart = new Date(start.getTime() - PREP_HOURS * 3600e3);
      const blockEnd   = new Date(start.getTime() + (liveHours * 3600e3) + CLEAN_HOURS * 3600e3);

      // Cuenta traslapes
      const overlapCount = events.reduce((n, ev) => {
        const overlaps = ev.end > blockStart && ev.start < blockEnd;
        return n + (overlaps ? 1 : 0);
      }, 0);

      if (overlapCount >= MAX_CONCURRENT) continue; // lleno

      slots.push({ startISO });
    }

    return res.json({ slots });
  }catch(e){
    console.error('availability error', e);
    return res.status(500).json({ error: 'availability_failed', detail: e.message });
  }
}
