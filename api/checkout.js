// /api/checkout.js
// Crea una sesión de Stripe Checkout calculando los importes con tu misma lógica.

export const config = { runtime: 'nodejs' };   // valid on Vercel

import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

// Map your package to “live service hours” (matches your UI)
function pkgToHours(pkg) {
  if (pkg === '50-150-5h') return 2;
  if (pkg === '150-250-5h') return 2.5;
  if (pkg === '250-350-6h') return 3;
  return 2;
}

// ====== Tabla de precios (idéntica al widget) ======
const BASE_PRICES = { "50-150-5h": 550, "150-250-5h": 700, "250-350-6h": 900 };
const SECOND_DISCOUNT = { "50-150-5h": 50, "150-250-5h": 75, "250-350-6h": 100 };
const FOUNTAIN_PRICE = { "50": 350, "100": 450, "150": 550 };
const FOUNTAIN_WHITE_UPCHARGE = 50;
const FULL_FLAT_OFF = 20; // $20 off when paying in full (matches frontend)

const BAR_META = {
  pancake:   { title: "🥞 Mini Pancake",  priceAdd: 0 },
  esquites:  { title: "🌽 Esquites",      priceAdd: 0 },
  maruchan:  { title: "🍜 Maruchan",      priceAdd: 0 },
  tostiloco: { title: "🌶️ Tostiloco (Premium)", priceAdd: 50 },
  snack:     { title: "🍭 Manna Snack Bar — “La Clásica”", priceAdd: 0 } // NEW standard bar
};

function usd(n){ return Math.round(n * 100); } // dollars → cents

function computeTotals(pb){
  const base0 = BASE_PRICES[pb.pkg] || 0;
  const addMain = (BAR_META[pb.mainBar]?.priceAdd) || 0;
  const base = base0 + addMain;

  let extras = 0;
  if (pb.secondEnabled){
    const b = BASE_PRICES[pb.secondSize] || 0;
    const d = SECOND_DISCOUNT[pb.secondSize] || 0;
    extras += Math.max(b - d, 0);
  }
  if (pb.fountainEnabled){
    const b = FOUNTAIN_PRICE[pb.fountainSize] || 0;
    const up = (pb.fountainType === 'white' || pb.fountainType === 'mixed') ? FOUNTAIN_WHITE_UPCHARGE : 0;
    extras += (b + up);
  }

  const total = base + extras;

  if (pb.payMode === 'full'){
    const dueNow = Math.max(total - FULL_FLAT_OFF, 0);
    return { total, dueNow, paySavings: FULL_FLAT_OFF };
  } else {
    return { total, dueNow: Math.round(total * 0.25), paySavings: 0 };
  }
}

export default async function handler(req, res){
  // ===== CORS básico =====
  const allowList = (process.env.ALLOWED_ORIGINS || '').split(',').map(s=>s.trim()).filter(Boolean);
  const origin = req.headers.origin || '';
  const okOrigin = allowList.length ? allowList.includes(origin) : true;

  if (req.method === 'OPTIONS'){
    res.setHeader('Access-Control-Allow-Origin', okOrigin ? origin : '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');
    return res.status(204).end();
  }
  res.setHeader('Access-Control-Allow-Origin', okOrigin ? origin : '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try{
    const pb = req.body || {};

    // Validaciones mínimas
    if (!pb.pkg || !pb.mainBar || !pb.payMode) {
      return res.status(400).json({ error: 'Missing fields (pkg, mainBar, payMode)' });
    }

    const { total, dueNow } = computeTotals(pb);

    // Nombre que verá el cliente en Checkout
    const barTitle = (BAR_META[pb.mainBar]?.title) || 'Snack Bar';
    const labels = { "50-150-5h":"50–150 (5 hrs)", "150-250-5h":"150–250 (5 hrs)", "250-350-6h":"250–350 (6 hrs)" };
    const name = `Manna — ${barTitle} • ${labels[pb.pkg] || ''} • ${pb.payMode === 'full' ? 'Pay in full' : '25% deposit'}`;

    // ✅ Always send users to homepage after success/cancel.
    // If PUBLIC_URL exists, use it; otherwise default to your domain.
    const BASE_URL = (process.env.PUBLIC_URL || 'https://mannasnackbars.com').replace(/\/+$/, '');
    const successUrl = `${BASE_URL}/`;
    const cancelUrl  = `${BASE_URL}/`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      allow_promotion_codes: false,
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name },
          unit_amount: usd(dueNow) // show exactly what you charge now
        },
        quantity: 1
      }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        // data needed for webhook -> Google Calendar
        pkg: pb.pkg,
        mainBar: pb.mainBar,
        payMode: pb.payMode,
        secondEnabled: String(!!pb.secondEnabled),
        secondBar: pb.secondBar || '',
        secondSize: pb.secondSize || '',
        fountainEnabled: String(!!pb.fountainEnabled),
        fountainSize: pb.fountainSize || '',
        fountainType: pb.fountainType || '',
        total: String(total),
        dueNow: String(dueNow),

        // customer / booking
        dateISO: pb.dateISO || '',
        startISO: pb.startISO || '',
        fullName: pb.fullName || pb.name || '',
        email: pb.email || '',
        phone: pb.phone || '',
        venue: pb.venue || '',
        setup: pb.setup || '',
        power: pb.power || '',
        hours: String(pkgToHours(pb.pkg)) // used by calendar block length
      }
    });

    return res.status(200).json({ url: session.url });
  }catch(e){
    console.error('checkout error', e);
    return res.status(500).json({ error: 'Checkout failed', detail: e.message });
  }
}
