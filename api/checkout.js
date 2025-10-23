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

// ====== Tu tabla de precios (idéntica a la de tu widget) ======
const BASE_PRICES = { "50-150-5h": 550, "150-250-5h": 700, "250-350-6h": 900 };
const SECOND_DISCOUNT = { "50-150-5h": 50, "150-250-5h": 75, "250-350-6h": 100 };
const FOUNTAIN_PRICE = { "50": 350, "100": 450, "150": 550 };
const FOUNTAIN_WHITE_UPCHARGE = 50;
// ⚠️ Si quieres $20 plano (lo que me dijiste), usa:
const FULL_FLAT_OFF = 20;
// (Si te gustara 5%, cambia a: const DISCOUNT_FULL = 0.05)

const BAR_META = {
  pancake:   { title: "🥞 Mini Pancake",  priceAdd: 0 },
  esquites:  { title: "🌽 Esquites",      priceAdd: 0 },
  maruchan:  { title: "🍜 Maruchan",      priceAdd: 0 },
  tostiloco: { title: "🌶️ Tostiloco (Premium)", priceAdd: 50 }
};

function usd(n){ return Math.round(n * 100); } // to cents

function computeTotals(pb){
  // pb: payload del cliente (verificado aquí)
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
    // 💸 Descuento plano de $20 (coincide con “$550 → $530”)
    const dueNow = Math.max(total - FULL_FLAT_OFF, 0);
    return { total, dueNow, paySavings: FULL_FLAT_OFF };
    // 👉 Si prefieres 5%, reemplaza por:
    // const save = Math.round(total * DISCOUNT_FULL);
    // return { total, dueNow: total - save, paySavings: save };
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

    const successUrl = (process.env.PUBLIC_URL || '') + (process.env.SUCCESS_PATH || '/thank-you') + '?booking={CHECKOUT_SESSION_ID}';
    const cancelUrl  = (process.env.PUBLIC_URL || '') + (process.env.CANCEL_PATH  || '/booking-canceled') + '?booking={CHECKOUT_SESSION_ID}';

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      allow_promotion_codes: false,
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name },
          unit_amount: usd(dueNow) // ✅ exactamente lo que muestras (cents)
        },
        quantity: 1
      }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        // guardamos todo lo necesario para finalizar en el webhook
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

        // datos del cliente/booking
        dateISO: pb.dateISO || '',
        startISO: pb.startISO || '',
        fullName: pb.fullName || pb.name || '',
        email: pb.email || '',
        phone: pb.phone || '',
        venue: pb.venue || '',
        setup: pb.setup || '',
        power: pb.power || '',
        // 👇 FIX 1: faltaba la coma; además enviamos las horas para el Calendar.
        hours: String(pkgToHours(pb.pkg))
      }
    });

    return res.status(200).json({ url: session.url });
  }catch(e){
    console.error('checkout error', e);
    return res.status(500).json({ error: 'Checkout failed', detail: e.message });
  }
}
