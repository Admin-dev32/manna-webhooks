export const config = { runtime: 'nodejs' };

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
    const calId = process.env.CALENDAR_ID || 'primary';

    // Try to list 1 event (will 200 if permission is OK)
    const rsp = await calendar.events.list({
      calendarId: calId,
      maxResults: 1,
      singleEvents: true
    });

    return res.json({ ok: true, serviceAccount: sa.client_email, calendarId: calId, items: (rsp.data.items || []).length });
  }catch(e){
    console.error('health error', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
