// /api/checkout.js
export const config = { runtime: 'nodejs' };

import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ====== Pricing ======
const BASE_PRICES = { "50-150-5h": 550, "150-250-5h": 700, "250-350-6h": 900 };
const SECOND_DISCOUNT = { "50-150-5h": 50, "150-250-5h": 75, "250-350-6h": 100 };
const FOUNTAIN_PRICE = { "50": 350, "100": 450, "150": 550 };
const FOUNTAIN_WHITE_UPCHARGE = 50;
const DISCOUNT_FULL = 0.05;

const BAR_META = {
  pancake:   { title: "🥞 Mini Pancake Bar",  priceAdd: 0 },
  esquites:  { title: "🌽 Esquite Bar",       priceAdd: 0 },
  maruchan:  { title: "🍜 Maruchan Bar",      priceAdd: 0 },
  tostiloco: { title: "🌶️ Tostiloco Bar (Premium)", priceAdd: 50 }
};

const toCents = n => Math.round(Number(n) * 100);

function computeTotals(pb){
  const base0 = BASE_PRICES[pb.pkg] || 0;
  const addMain = BAR_META[pb.mainBar]?.priceAdd || 0;
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
    const save = Math.round(total * DISCOUNT_FULL);
    return { total, dueNow: total - save, payMethod: 'card' };
  }
  if (pb.payMode === 'pay_later'){
    const add = Math.round(total * 0.03);
    return { total, dueNow: total + add, payMethod: 'affirm' };  // full total + 3% now
  }
  // deposit (25%)
  return { total, dueNow: Math.round(total * 0.25), payMethod: 'card' };
}

export default async function handler(req, res){
  // CORS
  const allow = (process.env.ALLOWED_ORIGINS || '').split(',').map(s=>s.trim()).filter(Boolean);
  const origin = req.headers.origin || '';
  const okOrigin = allow.length ? allow.includes(origin) : true;

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
    if (!pb.pkg || !pb.mainBar || !pb.payMode) {
      return res.status(400).json({ error: 'Missing fields (pkg, mainBar, payMode)' });
    }

    const { total, dueNow, payMethod } = computeTotals(pb);

    const barTitle = BAR_META[pb.mainBar]?.title || 'Snack Bar';
    const labels = {
      "50-150-5h":"50–150 (5 hrs)",
      "150-250-5h":"150–250 (5 hrs)",
      "250-350-6h":"250–350 (6 hrs)"
    };
    const modeLabel =
      pb.payMode === 'deposit' ? '25% deposit' :
      pb.payMode === 'pay_later' ? 'Get Now, Pay Later (+3%)' :
      'Pay in full (5% off)';
    const name = `Manna — ${barTitle} • ${labels[pb.pkg] || ''} • ${modeLabel}`;

    const successUrl = (process.env.PUBLIC_URL || '') + (process.env.SUCCESS_PATH || '/thank-you') + '?booking={CHECKOUT_SESSION_ID}';
    const cancelUrl  = (process.env.PUBLIC_URL || '') + (process.env.CANCEL_PATH  || '/booking-canceled') + '?booking={CHECKOUT_SESSION_ID}';

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      // Coupons only on Stripe page
      allow_promotion_codes: true,
      // Enable Affirm only for pay_later
      payment_method_types: payMethod === 'affirm' ? ['card','affirm'] : ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name },
          unit_amount: toCents(dueNow),
        },
        quantity: 1,
      }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
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
        dateISO: pb.dateISO || '',
        startISO: pb.startISO || '',
        fullName: pb.fullName || pb.name || '',
        email: pb.email || '',
        phone: pb.phone || '',
        venue: pb.venue || '',
        setup: pb.setup || '',
        power: pb.power || ''
      }
    });

    return res.status(200).json({ url: session.url });
  }catch(e){
    console.error('checkout error', e);
    return res.status(500).json({ error: 'Checkout failed', detail: e.message });
  }
}
