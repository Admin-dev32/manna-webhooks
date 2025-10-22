// /api/debug/create-event.js
// Quick test to insert a calendar event WITHOUT Stripe.
// Example:
// https://YOUR-PROJECT.vercel.app/api/debug/create-event?date=2025-11-06&hour=18&pkg=150-250-5h&bar=pancake&name=Test&email=test@example.com

export const config = { runtime: 'nodejs' };

const SERVICE_HOURS = { '50-150-5h': 2, '150-250-5h': 2.5, '250-350-6h': 3 };
const PREP_HOURS = 1, CLEAN_HOURS = 1;

function zonedStartISO(ymd, hour, tz){
  const [y,m,d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m-1, d, hour, 0, 0);
  const asDate = new Date(guess);
  const inTz = new Date(asDate.toLocaleString('en-US', { timeZone: tz }));
  const offsetMs = inTz.getTime() - asDate.getTime();
  return new Date(guess - offsetMs).toISOString();
}

export default async function handler(req, res){
  try{
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
    const calId = process.env.CALENDAR_ID || 'primary';

    const date = (req.query.date || '').trim();    // YYYY-MM-DD
    const hour = parseFloat(req.query.hour || '18');
    const pkg  = (req.query.pkg  || '150-250-5h').trim();
    const bar  = (req.query.bar  || 'pancake').trim();
    const name = (req.query.name || 'Test').trim();
    const email= (req.query.email|| '').trim();

    if (!date) return res.status(400).json({ ok:false, error:'date required YYYY-MM-DD' });

    const live = SERVICE_HOURS[pkg] ?? 2;
    const startLive = new Date(zonedStartISO(date, hour, tz));
    const startISO = new Date(startLive.getTime() - PREP_HOURS * 3600e3).toISOString();
    const endISO   = new Date(startLive.getTime() + (live * 3600e3) + CLEAN_HOURS * 3600e3).toISOString();

    const attendees = email ? [{ email, displayName: name }] : [];

    const ev = await calendar.events.insert({
      calendarId: calId,
      requestBody: {
        summary: `Manna — test ${bar} (${pkg})`,
        description: `Debug insert from /api/debug/create-event\nClient: ${name} (${email})`,
        colorId: '11',
        start: { dateTime: startISO, timeZone: tz },
        end:   { dateTime: endISO,   timeZone: tz },
        attendees,
        sendUpdates: 'all'
      }
    });

    return res.json({ ok:true, id: ev.data.id, start: startISO, end: endISO });
  }catch(e){
    console.error('debug/create-event error', e);
    return res.status(500).json({ ok:false, error: e.message });
  }
}
