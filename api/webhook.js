// ============================================================
// @drgregshow — Unified Webhook Receiver
// Handles: Stripe, PayPal, Patreon, Venmo
// POST /api/webhook?source=stripe|paypal|patreon|venmo
// ============================================================

import crypto from 'crypto';

// ── Vercel KV (Redis) ─────────────────────────────────────────
// Set these in Vercel env vars:
// KV_REST_API_URL, KV_REST_API_TOKEN
// STRIPE_WEBHOOK_SECRET
// PATREON_WEBHOOK_SECRET
// PAYPAL_WEBHOOK_ID

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvSet(key, value, exSeconds = 86400) {
  await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: JSON.stringify(value), ex: exSeconds }),
  });
}

async function kvGet(key) {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  const j = await r.json();
  try { return JSON.parse(j.result); } catch { return j.result; }
}

async function kvLPush(key, value) {
  await fetch(`${KV_URL}/lpush/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ element: JSON.stringify(value) }),
  });
  // Keep last 100
  await fetch(`${KV_URL}/ltrim/${encodeURIComponent(key)}/0/99`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
}

// ── Stripe Verification ───────────────────────────────────────
function verifyStripe(rawBody, sigHeader, secret) {
  const parts = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')));
  const payload = `${parts.t}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(parts.v1), Buffer.from(expected));
}

// ── Patreon Verification ──────────────────────────────────────
function verifyPatreon(rawBody, sigHeader, secret) {
  const expected = crypto.createHmac('md5', secret).update(rawBody).digest('hex');
  return sigHeader === expected;
}

// ── Normalize to common format ────────────────────────────────
function normalizeStripe(body) {
  const obj = body.data?.object;
  if (!obj) return null;
  const name = obj.billing_details?.name
    || obj.metadata?.name
    || obj.customer_details?.name
    || 'Anonymous';
  const cents = obj.amount_received || obj.amount || 0;
  const message = obj.metadata?.message || '';
  return { name, amountCents: cents, message, platform: 'stripe' };
}

function normalizePayPal(body) {
  const r = body.resource;
  if (!r) return null;
  const name = r.payer?.name?.given_name
    ? `${r.payer.name.given_name} ${r.payer.name.surname || ''}`.trim()
    : 'Anonymous';
  const value = parseFloat(r.amount?.value || r.seller_receivable_breakdown?.gross_amount?.value || '0');
  const cents = Math.round(value * 100);
  const message = r.note_to_payer || '';
  return { name, amountCents: cents, message, platform: 'paypal' };
}

function normalizePatreon(body) {
  const attrs = body.data?.attributes;
  if (!attrs) return null;
  const name = body.included?.find(i => i.type === 'user')?.attributes?.full_name || 'Patron';
  const cents = (attrs.amount_cents || 0);
  return { name, amountCents: cents, message: '', platform: 'patreon' };
}

function normalizeVenmo(body) {
  // Venmo doesn't have a webhook; this handles manual POST from a Zapier/Make integration
  return {
    name: body.name || 'Anonymous',
    amountCents: Math.round((parseFloat(body.amount) || 0) * 100),
    message: body.message || body.note || '',
    platform: 'venmo',
  };
}

// ── Main Handler ──────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method === 'GET') {
    // Dashboard polling endpoint — return latest donation
    const latest = await kvGet('drgregshow:latest');
    if (!latest) return res.status(200).json(null);
    return res.status(200).json(latest);
  }

  if (req.method !== 'POST') return res.status(405).end();

  const source = req.query.source || 'stripe';
  let rawBody = '';

  await new Promise((resolve) => {
    req.on('data', chunk => rawBody += chunk);
    req.on('end', resolve);
  });

  let body;
  try { body = JSON.parse(rawBody); } catch { return res.status(400).json({ error: 'Bad JSON' }); }

  let donation = null;

  try {
    // ── Stripe ──
    if (source === 'stripe') {
      const sig = req.headers['stripe-signature'];
      const secret = process.env.STRIPE_WEBHOOK_SECRET;
      if (sig && secret && !verifyStripe(rawBody, sig, secret)) {
        return res.status(401).json({ error: 'Invalid Stripe signature' });
      }
      const type = body.type;
      if (!['payment_intent.succeeded', 'checkout.session.completed', 'charge.succeeded'].includes(type)) {
        return res.status(200).json({ received: true, skipped: true });
      }
      donation = normalizeStripe(body);
    }

    // ── PayPal ──
    else if (source === 'paypal') {
      const type = body.event_type;
      if (!['PAYMENT.CAPTURE.COMPLETED', 'CHECKOUT.ORDER.APPROVED'].includes(type)) {
        return res.status(200).json({ received: true, skipped: true });
      }
      donation = normalizePayPal(body);
    }

    // ── Patreon ──
    else if (source === 'patreon') {
      const sig = req.headers['x-patreon-signature'];
      const secret = process.env.PATREON_WEBHOOK_SECRET;
      if (sig && secret && !verifyPatreon(rawBody, sig, secret)) {
        return res.status(401).json({ error: 'Invalid Patreon signature' });
      }
      const trigger = req.headers['x-patreon-event'];
      if (!['pledges:create', 'pledges:update'].includes(trigger)) {
        return res.status(200).json({ received: true, skipped: true });
      }
      donation = normalizePatreon(body);
    }

    // ── Venmo (via Zapier/Make) ──
    else if (source === 'venmo') {
      donation = normalizeVenmo(body);
    }

  } catch (err) {
    console.error('Webhook parse error:', err);
    return res.status(500).json({ error: 'Parse failed' });
  }

  if (!donation) return res.status(200).json({ received: true, skipped: true });

  // Add unique ID + timestamp
  donation.id = crypto.randomUUID();
  donation.ts = Date.now();

  // Store as latest + append to history
  await kvSet('drgregshow:latest', donation);
  await kvLPush('drgregshow:history', donation);

  console.log(`[drgregshow] ${donation.platform} ${donation.name} ${donation.amountCents}¢`);
  return res.status(200).json({ received: true, id: donation.id });
}

export const config = { api: { bodyParser: false } };
