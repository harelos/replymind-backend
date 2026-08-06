// routes/payments.js — Paddle Billing webhook -> plan fulfillment by account email
//
// Flow:
//   checkout.html passes customData { account_email, plan } into Paddle.
//   On payment, Paddle POSTs a signed webhook here. We verify the signature,
//   read the account email + plan, and flip that user's `plan` in the DB.
//   If the account doesn't exist yet, we park a pending_upgrade keyed by email
//   (applied the next time they register/log in with that email).
//
// server.js mounts express.raw() for this path so req.body is the raw Buffer
// (required for signature verification).

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../db/database');

// One account can hold a plan per product, so a price id must resolve to BOTH the
// product it belongs to and the plan it grants. Without the product, a ConvertIQ
// purchase would silently upgrade the buyer's ReplyMind plan instead.
const PRICE_MAP = {
  // ── ReplyMind ── legacy tiers (kept so existing subscriptions still resolve)
  pri_01kpnydyt2tcgbcv0cnwytqv4t: { product: 'replymind', plan: 'basic' },
  pri_01kx148b91n3kc71e0j7m15zmd: { product: 'replymind', plan: 'basic' },
  pri_01kpnz9bvwq834wcsp4zfgjm9e: { product: 'replymind', plan: 'pro' },
  pri_01kx148bm7kty2pw7hyf85810p: { product: 'replymind', plan: 'pro' },
  pri_01kpnza9qe17p8y271g9605n2q: { product: 'replymind', plan: 'premium' },
  pri_01kx148bz875cy7gkkvdaavdn7: { product: 'replymind', plan: 'premium' },
  // ── ReplyMind ── current tiers (2026-07-12): Pro $19, Business $49
  pri_01kxcm80r76x68s6j9ca9sxezh: { product: 'replymind', plan: 'pro' },      // $19/mo
  pri_01kxcm80zff1am9sb9yw0c7hfq: { product: 'replymind', plan: 'pro' },      // $180/yr
  pri_01kxcm816skn0hxmh5m462rmc3: { product: 'replymind', plan: 'business' }, // $49/mo
  pri_01kxcm81e427764yr1jm810xw3: { product: 'replymind', plan: 'business' }, // $468/yr
  // ── ConvertIQ ── (2026-07-12): Operator $99, Studio $299
  pri_01kxcn55d65maasr0keyypbczf: { product: 'convertiq', plan: 'operator' }, // $99/mo
  pri_01kxcn55mhmpz5b6120015h01k: { product: 'convertiq', plan: 'operator' }, // $948/yr
  pri_01kxcn55w6srn0df6h1894xpy8: { product: 'convertiq', plan: 'studio' },   // $299/mo
  pri_01kxcn5637qsqer3pf7vptrrxd: { product: 'convertiq', plan: 'studio' },   // $2868/yr
};

function verifySignature(rawBody, sigHeader, secret) {
  if (!secret || !sigHeader) return false;
  const parts = {};
  for (const kv of sigHeader.split(';')) {
    const i = kv.indexOf('=');
    if (i > 0) parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  const ts = parts.ts;
  const h1 = parts.h1;
  if (!ts || !h1) return false;
  const digest = crypto.createHmac('sha256', secret).update(`${ts}:${rawBody}`).digest('hex');
  const a = Buffer.from(digest);
  const b = Buffer.from(h1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function firstPriceId(data) {
  const lists = [data.items, data.line_items];
  for (const list of lists) {
    if (Array.isArray(list)) {
      for (const it of list) {
        const id = it && it.price && it.price.id;
        if (id) return id;
      }
    }
  }
  return null;
}

function extract(data) {
  const cd = data.custom_data || {};
  const email = (cd.account_email || cd.email || (data.customer && data.customer.email) || '')
    .toString()
    .toLowerCase()
    .trim();

  // The price id is the source of truth: it is set by Paddle, not by our own page,
  // so it cannot be tampered with by whoever opened the checkout.
  const priceId = firstPriceId(data);
  const byPrice = PRICE_MAP[priceId];
  return {
    email,
    plan: byPrice?.plan || null,
    product: byPrice?.product || null,
    priceId
  };
}

function requireKnownPurchase(purchase) {
  if (!purchase.plan || !purchase.product) {
    throw new Error(`Unknown Paddle price: ${purchase.priceId || 'missing'}`);
  }
  return purchase;
}

async function fulfill(email, product, plan, meta) {
  if (!email) {
    console.warn('paddle_fulfill_no_email', JSON.stringify(meta));
    return;
  }
  const user = await db.getUserByEmail(email);
  if (user) {
    await db.setEntitlement(user.id, product, plan);
    if (product === 'replymind') {
      await db.updateUser(user.id, { activated_at: new Date().toISOString() });
    }
    await db.logEvent(user.id, 'plan_activated', { method: 'paddle', product, plan, ...meta });
    console.log('paddle_plan_activated', JSON.stringify({ email, product, plan }));
  } else {
    await db.setPendingUpgrade(email, plan, product);
    await db.logEvent(null, 'pending_upgrade_stored', { product, plan });
    console.log('paddle_pending_upgrade', JSON.stringify({ email, product, plan }));
  }
}

async function downgrade(email, product, meta) {
  if (!email) return;
  const user = await db.getUserByEmail(email);
  if (user) {
    await db.setEntitlement(user.id, product || 'replymind', 'free');
    await db.logEvent(user.id, 'plan_downgraded', { method: 'paddle', product, ...meta });
    console.log('paddle_plan_downgraded', JSON.stringify({ email, product }));
  }
  await db.deletePendingUpgrade(email);
}

// POST /api/payments/webhook
router.post('/webhook', async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  const sig = req.headers['paddle-signature'] || '';

  if (!verifySignature(raw, sig, process.env.PADDLE_WEBHOOK_SECRET)) {
    console.warn('paddle_signature_invalid');
    return res.status(401).json({ error: 'invalid_signature' });
  }

  let evt;
  try {
    evt = JSON.parse(raw);
  } catch {
    return res.status(400).json({ error: 'bad_json' });
  }

  const type = evt.event_type;
  const data = evt.data || {};

  try {
    if (type === 'transaction.completed' || type === 'subscription.activated' || type === 'subscription.created') {
      const { email, product, plan } = requireKnownPurchase(extract(data));
      await fulfill(email, product, plan, { event: type });
    } else if (type === 'subscription.updated' || type === 'subscription.resumed') {
      const { email, product, plan } = requireKnownPurchase(extract(data));
      const status = data.status;
      if (status === 'canceled' || status === 'paused') {
        await downgrade(email, product, { event: type, status });
      } else {
        await fulfill(email, product, plan, { event: type, status });
      }
    } else if (type === 'subscription.canceled' || type === 'subscription.paused') {
      const { email, product } = requireKnownPurchase(extract(data));
      await downgrade(email, product, { event: type });
    }
    // Other events acknowledged and ignored.
  } catch (err) {
    console.error('paddle_webhook_error', err.message);
    // A non-2xx response asks Paddle to retry instead of silently losing a paid
    // activation when the database is temporarily unavailable or a price is unmapped.
    return res.status(500).json({ error: 'fulfillment_failed' });
  }

  res.json({ received: true });
});

module.exports = router;
