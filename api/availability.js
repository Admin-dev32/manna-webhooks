// /api/availability.js
export const config = { runtime: 'nodejs' };

const HOURS_RANGE = { start: 9, end: 22 }; // 9am–10pm

// make these configurable, but default to 1h + 1h
const PREP_HOURS  = Number(process.env.PREP_HOURS  ?? 1);
const CLEAN_HOURS = Number(process.env.CLEAN_HOURS ?? 1);

function zonedStartISO(ymd, hour, tz){
  const [y,m,d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m-1, d, hour, 0, 0);
  const asDate = new Date(guess);
  const inTz = new Date(asDate.toLocaleString('en-US', { timeZone: tz }));
  const offsetMs = inTz.getTime() - asDate.getTime();
  return new Date(guess - offsetMs).toISOString();
}

export default async function handler(req, res){
  // CORS
  const allow = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s=>s.trim())
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
  if (req.method !== 'GET'){
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Access-Control-Allow-Origin', okOrigin ? origin : '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  try{
    const { date, hours } = req.query || {};
    if (!date) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });

    const tz   = process.env.TIMEZONE || 'America/Los_Angeles';
    const calId = process.env.CALENDAR_ID || 'primary';
    const liveHours = Math.max(1, parseFloat(hours || '2'));

    // Auth service account
    const { google } = await import('googleapis');
    const saRaw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}';
    const sa = JSON.parse(saRaw);
    if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');

    const jwt = new google.auth.JWT(
      sa.client_email, null, sa.private_key,
      ['https://www.googleapis.com/auth/calendar']
    );
    const calendar = google.calendar({ version: 'v3', auth: jwt });

    // Load day events
    const dayStart = zonedStartISO(date, 0,  tz);
    const dayEnd   = zonedStartISO(date, 23, tz);
    const rsp = await calendar.events.list({
      calendarId: calId,
      timeMin: dayStart,
      timeMax: dayEnd,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 50
    });
    const events = (rsp.data.items || []).map(e => ({
      start: new Date(e.start?.dateTime || e.start?.date),
      end:   new Date(e.end?.dateTime   || e.end?.date)
    }));

    const slots = [];
    for (let h = HOURS_RANGE.start; h <= HOURS_RANGE.end; h++){
      const startIso = zonedStartISO(date, h, tz);
      const start = new Date(startIso);

      // skip past times
      if (start < new Date()) continue;

      // Window to check: prep + live + clean
      const blockStart = new Date(start.getTime() - PREP_HOURS * 3600e3);
      const blockEnd   = new Date(start.getTime() + (liveHours * 3600e3) + CLEAN_HOURS * 3600e3);

      const overlaps = events.some(ev => !(ev.end <= blockStart || ev.start >= blockEnd));
      if (!overlaps) slots.push({ startISO: startIso });
    }

    return res.json({ slots });
  }catch(e){
    console.error('availability error', e);
    return res.status(500).json({ error: 'availability_failed', detail: e.message });
  }
}
