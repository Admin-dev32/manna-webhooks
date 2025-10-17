// Plain Vercel Node.js Serverless Function (no Next.js config)
import Stripe from "stripe";
import fetch from "node-fetch";

const readRawBody = (req) =>
  new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (data += c));
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

  try {
    const raw = await readRawBody(req);
    const sig = req.headers["stripe-signature"];
    const event = stripe.webhooks.constructEvent(
      raw,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    // optionally forward to Apps Script
    const gasUrl = (process.env.GAS_URL || "").trim();
    if (event.type === "checkout.session.completed" && gasUrl) {
      try {
        await fetch(gasUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: "stripe", event }),
        });
      } catch (e) {
        console.error("GAS forward failed:", e.message);
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Webhook error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
}
