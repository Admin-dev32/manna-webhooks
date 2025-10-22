// /api/checkout.js
export const config = { runtime: 'nodejs' };

import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ====== Your price table (unchanged) ======
const BASE_PRICES = { "50-150-5h": 550, "150-250-5h": 700, "250-350-6h": 900 };
const SECOND_DISCOUNT = { "50-150-5h": 50, "150-250-5h": 75, "250-350-6h": 100 };
const FOUNTAIN_PRICE = { "50": 350, "100": 450, "150": 550 };
const FOUNTAIN_WHITE_UPCHARGE = 50;
const DISCOUNT_FULL = 0.05;

const BAR_META = {
  pancake:   { title: "🥞 Mini Pancake",  priceAdd: 0 },
  esquites:  { title: "🌽 Esquites",      priceAdd: 0 },
  maruchan:  { title: "🍜 Maruchan",      priceAdd: 0 },
  tostiloco: { title: "🌶️ Tostiloco (Premium)", priceAdd: 50 }
};

function usd(n){ return Math.round(n * 100); } // cents

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
    const save = Math.round(total * DISCOUNT_FULL);
    return { total, dueNow: total - save, paySavings: save };
  } else {
    return { total, dueNow: Math.round(total * 0.25), paySavings: 0 };
  }
}

export default async function handler(req, res){
  // CORS basic
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

    if (!pb.pkg || !pb.mainBar || !pb.payMode) {
      return res.status(400).json({ error: 'Missing fields (pkg, mainBar, payMode)' });
    }

    const { total, dueNow } = computeTotals(pb);

    const barTitle = (BAR_META[pb.mainBar]?.title) || 'Snack Bar';
    const labels = { "50-150-5h":"50–150 (5 hrs)", "150-250-5h":"150–250 (5 hrs)", "250-350-6h":"250–350 (6 hrs)" };
    const name = `Manna — ${barTitle} • ${labels[pb.pkg] || ''} • ${pb.payMode === 'full' ? 'Pay in full' : '25% deposit'}`;

    const successUrl = (process.env.PUBLIC_URL || '') + (process.env.SUCCESS_PATH || '/thank-you') + '?booking={CHECKOUT_SESSION_ID}';
    const cancelUrl  = (process.env.PUBLIC_URL || '') + (process.env.CANCEL_PATH  || '/booking-canceled') + '?booking={CHECKOUT_SESSION_ID}';

    // Try to pre-apply a promotion code if provided
    let discounts = undefined;
    if (pb.coupon && String(pb.coupon).trim()){
      const code = String(pb.coupon).trim();
      try{
        const found = await stripe.promotionCodes.list({ code, active: true, limit: 1 });
        if (found.data && found.data[0]) {
          discounts = [{ promotion_code: found.data[0].id }];
        }
      }catch(e){
        // silently ignore; Checkout still shows its own promo box
        console.warn('promo lookup failed', e.message);
      }
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      allow_promotion_codes: true,     // show "Add promotion code" box in Checkout
      discounts,                       // pre-apply if we found one
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name },
          unit_amount: usd(dueNow)
        },
        quantity: 1
      }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        // keep for webhook
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
        coupon: pb.coupon || '',

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
