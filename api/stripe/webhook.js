// /api/stripe/webhook.js
import Stripe from "stripe";
import fetch from "node-fetch";

export const config = {
  api: {
    bodyParser: false, // we need the raw body for Stripe signature verification
  },
};

const textBody = async (req) =>
  new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: "2024-06-20",
  });
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const gasUrl = (process.env.GAS_URL || "").trim(); // optional Google Apps Script URL

  let event;
  try {
    const raw = await textBody(req);
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(raw, sig, webhookSecret);

    // --- Example routing: only forward the ones you care about ---
    if (event.type === "checkout.session.completed") {
      // Optionally forward to Google Apps Script to finalize booking
      if (gasUrl) {
        try {
          await fetch(gasUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ source: "stripe", event }),
          });
        } catch (e) {
          console.error("GAS forward failed:", e.message);
          // We still ack 2xx to Stripe to avoid retries unless you want retries
        }
      }
    }

    // Always ACK quickly
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Webhook error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
}
