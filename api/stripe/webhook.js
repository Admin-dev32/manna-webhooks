// /api/checkout.js
// Creates a Stripe Checkout session. Supports:
// - payMode: 'deposit' (25%), 'full' (100%), 'affirm' (full + 3% fee)
// - Promotion codes on Stripe page (allow_promotion_codes: true)
// - Not embedded: your frontend redirects the top window (see section 2)

export const config = { runtime: 'nodejs' };

import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ===== PRICING =====
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

function usd(n){ return Math.round(n * 100); }

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
    return { total, dueNow: total - save, paySavings: save, mode: 'full' };
  }
  if (pb.payMode === 'affirm'){
    // Full total + 3% fee
    const fee = Math.round(total * 0.03);
    return { total: total + fee, dueNow: total + fee, paySavings: 0, mode: 'affirm' };
  }
  // default: deposit 25%
  return { total, dueNow: Math.round(total * 0.25), paySavings: 0, mode: 'deposit' };
}

export default async function handler(req, res){
  // CORS
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

    const { total, dueNow, mode } = computeTotals(pb);

    const barTitle = (BAR_META[pb.mainBar]?.title) || 'Snack Bar';
    const labels = { "50-150-5h":"50–150 (5 hrs)", "150-250-5h":"150–250 (5 hrs)", "250-350-6h":"250–350 (6 hrs)" };

    let paymentLabel = '25% deposit';
    if (mode === 'full') paymentLabel = 'Pay in full (5% off)';
    if (mode === 'affirm') paymentLabel = 'Pay over time (Affirm)';

    const name = `Manna — ${barTitle} • ${labels[pb.pkg] || ''} • ${paymentLabel}`;

    const successUrl = (process.env.PUBLIC_URL || '') + (process.env.SUCCESS_PATH || '/thank-you') + '?booking={CHECKOUT_SESSION_ID}';
    const cancelUrl  = (process.env.PUBLIC_URL || '') + (process.env.CANCEL_PATH  || '/booking-canceled') + '?booking={CHECKOUT_SESSION_ID}';

    // Payment method types
    // For Affirm we force show Affirm (plus card fallback).
    const methodTypes = mode === 'affirm' ? ['affirm', 'card'] : ['card'];

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      // customer_creation could be 'always' if you want a customer created.
      payment_method_types: methodTypes,
      allow_promotion_codes: true, // user applies coupon at Stripe
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
      // Pass everything your webhook needs:
      metadata: {
        pkg: pb.pkg,
        mainBar: pb.mainBar,
        payMode: pb.payMode,         // 'deposit' | 'full' | 'affirm'
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
