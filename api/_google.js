// /api/_google.js (o dentro de tu webhook)
import { google } from 'googleapis';

export function getCalendarClient() {
  const auth = new google.auth.JWT(
    process.env.GCP_CLIENT_EMAIL,
    undefined,
    (process.env.GCP_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/calendar']
  );
  return google.calendar({ version: 'v3', auth });
}
