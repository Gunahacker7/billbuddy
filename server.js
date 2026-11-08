'use strict';

/**
 * BillBuddy — AI Bill-Pay Agent for Small Shops
 *
 * Flow:
 *   1. Shop owner pastes a supplier bill (plain text).
 *   2. POST /api/extract  -> Google Gemini turns the bill into a structured
 *      payment draft (with a labelled demo-parser fallback when no key set).
 *   3. Owner edits + approves the draft in the UI.
 *   4. POST /api/pay      -> creates a PayPal Sandbox order (Orders v2,
 *      intent CAPTURE) and returns the buyer approval link.
 *      GET  /pay/return   -> captures the approved order, writes the ledger.
 *      POST /api/pay/capture/:orderId -> same capture, for API-driven demos.
 *      With no PayPal credentials, /api/pay returns a SIMULATED result so
 *      the end-to-end flow never dead-ends for judges.
 *   5. GET /api/ledger    -> local JSON ledger of processed bills.
 *
 * No secrets are ever logged. All config comes from environment variables.
 */

require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = 'gemini-2.5-flash';

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const PAYPAL_ENV = (process.env.PAYPAL_ENV || 'sandbox').toLowerCase();
const PAYPAL_BASE =
  PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

// PayPal sandbox checkout rejects INR (CURRENCY_NOT_SUPPORTED — verified live).
// Bills stay in their original currency; INR bills settle in USD at a demo FX
// rate so the sandbox payment can proceed. Both amounts are recorded.
const SANDBOX_SUPPORTED_CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'AUD', 'CAD', 'JPY', 'SGD']);
const DEMO_FX_INR_PER_USD = Number(process.env.DEMO_FX_INR_PER_USD) || 83;

const LEDGER_PATH = path.join(__dirname, 'data', 'ledger.json');

app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------------------------------------------------------- helpers */

// fetch with a hard timeout so a slow upstream never hangs a request.
async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function readLedger() {
  try {
    const raw = fs.readFileSync(LEDGER_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function appendLedger(entry) {
  const ledger = readLedger();
  ledger.unshift(entry); // newest first
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
  return entry;
}

function newEntry(fields) {
  return {
    id: crypto.randomUUID(),
    time: new Date().toISOString(),
    ...fields,
  };
}

// Validate + normalise a payment draft coming from AI or from the client.
function validateDraft(d) {
  if (!d || typeof d !== 'object') throw new Error('Draft must be an object.');
  const payee_name = String(d.payee_name || '').trim();
  if (!payee_name) throw new Error('payee_name is required.');

  const amount = Number(d.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('amount must be a number greater than 0.');
  }

  let currency = String(d.currency || 'INR').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) currency = 'INR';

  const payee_email = String(d.payee_email || '').trim();
  if (payee_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payee_email)) {
    throw new Error('payee_email is not a valid email address.');
  }

  return {
    payee_name,
    payee_email,
    amount: Math.round(amount * 100) / 100,
    currency,
    due_date: String(d.due_date || '').trim(),
    invoice_no: String(d.invoice_no || '').trim(),
    description: String(d.description || '').trim(),
  };
}

/* --------------------------------------------------------- settlement FX */

// Round to 2 decimal places (money).
function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Work out the settlement amount/currency for a PayPal sandbox order.
 * Supported currencies pass through unchanged. INR converts to USD at the
 * demo FX rate. Returns null for any other unsupported currency (the caller
 * turns that into a clear 400 naming the currency).
 */
function computeSettlement(draft) {
  if (SANDBOX_SUPPORTED_CURRENCIES.has(draft.currency)) {
    return { amount: draft.amount, currency: draft.currency, converted: false, fx_rate: null };
  }
  if (draft.currency === 'INR') {
    return {
      amount: round2(draft.amount / DEMO_FX_INR_PER_USD),
      currency: 'USD',
      converted: true,
      fx_rate: DEMO_FX_INR_PER_USD,
    };
  }
  return null;
}

// PayPal order description: when converted, it carries the ORIGINAL bill
// amount and the demo rate, e.g. "Bill SLWT/2026/1847 — ₹19,152.00 settled
// as USD at demo rate 83".
function settlementDescription(draft, settlement) {
  if (!settlement.converted) {
    return draft.description || `Payment to ${draft.payee_name}`;
  }
  const inr = draft.amount.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const ref = draft.invoice_no ? `Bill ${draft.invoice_no}` : `Bill to ${draft.payee_name}`;
  return `${ref} — ₹${inr} settled as USD at demo rate ${settlement.fx_rate}`;
}

// Extra ledger fields recording the settlement side of a payment. The
// original bill amount/currency are stored separately on the entry itself.
function settlementLedgerFields(settlement) {
  if (!settlement) return {};
  return {
    settlement_amount: settlement.amount,
    settlement_currency: settlement.currency,
    ...(settlement.converted ? { fx_rate: settlement.fx_rate } : {}),
  };
}

/* ------------------------------------------------------- demo bill parser */
/**
 * Fallback parser used ONLY when GEMINI_API_KEY is not configured.
 * Simple heuristics: first non-empty line = payee, "Total/Amount Due" line =
 * amount, plus invoice-number and date patterns. Always labelled demo_mode.
 */
function demoParse(billText) {
  const lines = billText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const payee_name = lines.length ? lines[0].replace(/[:\-]+$/, '') : 'Unknown Payee';

  // Prefer an explicit total line; otherwise take the largest money figure.
  let amount = 0;
  const moneyRe = /(?:₹|Rs\.?|INR)\s*([\d,]+(?:\.\d{1,2})?)/gi;
  const totalLine = lines.find((l) => /total|amount due|grand total|balance due/i.test(l));
  const scan = (text) => {
    let m;
    let best = 0;
    moneyRe.lastIndex = 0;
    while ((m = moneyRe.exec(text)) !== null) {
      const v = parseFloat(m[1].replace(/,/g, ''));
      if (Number.isFinite(v) && v > best) best = v;
    }
    return best;
  };
  amount = totalLine ? scan(totalLine) : 0;
  if (!amount) amount = scan(billText);

  const invoiceMatch = billText.match(/(?:invoice|inv|bill)\s*(?:no\.?|#|number)?\s*[:\-]?\s*([A-Za-z0-9\-\/]+)/i);
  const dueMatch = billText.match(/(?:due\s*date|pay\s*by|due)\s*[:\-]?\s*(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{4}-\d{2}-\d{2})/i);
  const emailMatch = billText.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);

  return {
    payee_name,
    payee_email: emailMatch ? emailMatch[0] : '',
    amount,
    currency: 'INR',
    due_date: dueMatch ? dueMatch[1] : '',
    invoice_no: invoiceMatch ? invoiceMatch[1] : '',
    description: lines.slice(0, 3).join(' — ').slice(0, 120),
  };
}

/* ------------------------------------------------------------- Gemini AI */

async function geminiExtract(billText) {
  const prompt = [
    'You are a precise data-extraction agent for supplier bills in India.',
    'Extract the payment details from the bill text below.',
    'Respond with ONLY a JSON object, no markdown, no extra text, with exactly these keys:',
    '{"payee_name": string, "payee_email": string, "amount": number, "currency": string,',
    ' "due_date": string, "invoice_no": string, "description": string}',
    'Rules: amount is the total amount payable as a plain number (no commas, no symbols).',
    'currency is a 3-letter ISO code; default "INR" if not stated.',
    'due_date in YYYY-MM-DD if a date is present, else "".',
    'payee_email is "" if not present. description is a one-line summary of what the bill is for.',
    '',
    'BILL TEXT:',
    billText,
  ].join('\n');

  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
      }),
    },
    30000
  );

  if (!res.ok) {
    throw new Error(`Gemini API error (HTTP ${res.status}).`);
  }
  const data = await res.json();
  const text =
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  const jsonStart = text.indexOf('{');
  const jsonEnd = text.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1) {
    throw new Error('Gemini did not return a JSON object.');
  }
  return JSON.parse(text.slice(jsonStart, jsonEnd + 1));
}

/* ---------------------------------------------------------------- PayPal */

async function paypalAccessToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetchWithTimeout(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`PayPal OAuth failed (HTTP ${res.status}).`);
  const data = await res.json();
  return data.access_token;
}

async function paypalCreateOrder(draft, settlement) {
  const token = await paypalAccessToken();
  const res = await fetchWithTimeout(`${PAYPAL_BASE}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': crypto.randomUUID(),
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: draft.invoice_no || undefined,
          description: settlementDescription(draft, settlement).slice(0, 127),
          custom_id: draft.invoice_no || undefined,
          amount: {
            currency_code: settlement.currency,
            value: settlement.amount.toFixed(2),
          },
          // In sandbox the funds go to the merchant account of the app;
          // payee_email is recorded for display/ledger purposes.
          ...(draft.payee_email ? { payee: { email_address: draft.payee_email } } : {}),
        },
      ],
      application_context: {
        brand_name: 'BillBuddy',
        landing_page: 'LOGIN',
        user_action: 'PAY_NOW',
        return_url: `${BASE_URL}/pay/return`,
        cancel_url: `${BASE_URL}/pay/cancel`,
      },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`PayPal order creation failed (HTTP ${res.status}).`);
  }
  const approveLink = (data.links || []).find(
    (l) => l.rel === 'approve' || l.rel === 'payer-action'
  );
  return { order: data, approve_url: approveLink ? approveLink.href : null };
}

async function paypalCaptureOrder(orderId) {
  const token = await paypalAccessToken();
  const res = await fetchWithTimeout(
    `${PAYPAL_BASE}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': crypto.randomUUID(),
      },
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`PayPal capture failed (HTTP ${res.status}).`);
  }
  const capture =
    data?.purchase_units?.[0]?.payments?.captures?.[0] || {};
  return { order: data, capture_id: capture.id || '', status: data.status || '' };
}

const hasPayPalCreds = () => Boolean(PAYPAL_CLIENT_ID && PAYPAL_CLIENT_SECRET);

// Orders awaiting buyer approval, keyed by PayPal order id, so the capture
// step (redirect or API) can write a complete ledger entry. Each value holds
// the original { draft, settlement } — draft keeps the bill's own
// amount/currency, settlement the amount/currency actually charged.
const pendingOrders = new Map();

/* ---------------------------------------------------------------- routes */

// Step 1: bill text -> structured payment draft
app.post('/api/extract', async (req, res) => {
  try {
    const billText = String(req.body?.bill_text || '').trim();
    if (!billText) {
      return res.status(400).json({ error: 'bill_text is required.' });
    }
    if (billText.length > 20000) {
      return res.status(400).json({ error: 'bill_text is too long (max 20000 chars).' });
    }

    if (!GEMINI_API_KEY) {
      const draft = validateDraft(demoParse(billText));
      return res.json({ draft, demo_mode: true, source: 'demo-parser' });
    }

    const raw = await geminiExtract(billText);
    const draft = validateDraft(raw);
    return res.json({ draft, demo_mode: false, source: 'gemini' });
  } catch (err) {
    return res.status(502).json({ error: err.message || 'Extraction failed.' });
  }
});

// Step 2: approved draft -> PayPal sandbox order (or simulated payment)
app.post('/api/pay', async (req, res) => {
  let draft;
  try {
    draft = validateDraft(req.body?.draft || req.body);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // Settlement: PayPal sandbox checkout rejects INR and other unsupported
  // currencies. Supported currencies settle as-is; INR settles in USD at the
  // demo FX rate; anything else is a clear 400 naming the currency. The
  // original bill amount/currency are preserved on the ledger entry.
  const settlement = computeSettlement(draft);
  if (!settlement) {
    return res.status(400).json({
      error: `Currency ${draft.currency} is not supported by PayPal sandbox checkout, and BillBuddy can only convert INR bills. Supported currencies: USD, EUR, GBP, AUD, CAD, JPY, SGD — or provide the bill in INR.`,
    });
  }
  const settlementInfo = {
    amount: settlement.amount,
    currency: settlement.currency,
    converted: settlement.converted,
    fx_rate: settlement.fx_rate,
  };

  // No credentials configured: clearly-labelled simulation, ledger recorded.
  if (!hasPayPalCreds()) {
    const orderId = `SIM-${Date.now().toString(36).toUpperCase()}`;
    const entry = appendLedger(
      newEntry({
        payee_name: draft.payee_name,
        payee_email: draft.payee_email,
        amount: draft.amount,
        currency: draft.currency,
        invoice_no: draft.invoice_no,
        status: 'SIMULATED',
        paypal_order_id: orderId,
        transaction_id: '',
        ...settlementLedgerFields(settlement),
      })
    );
    return res.json({
      simulated: true,
      status: 'SIMULATED',
      paypal_order_id: orderId,
      settlement: settlementInfo,
      message:
        'PayPal credentials not configured — this payment was SIMULATED and recorded in the ledger. Add PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET to .env for real sandbox payments.',
      ledger_entry: entry,
    });
  }

  try {
    const { order, approve_url } = await paypalCreateOrder(draft, settlement);
    pendingOrders.set(order.id, { draft, settlement });
    return res.json({
      simulated: false,
      status: order.status || 'CREATED',
      paypal_order_id: order.id,
      approve_url,
      settlement: settlementInfo,
      message: approve_url
        ? 'Sandbox order created. Open the approval link, log in with a PayPal SANDBOX buyer account and approve — you will be redirected back here and the payment will be captured automatically.'
        : 'Sandbox order created, but PayPal returned no approval link.',
      draft,
    });
  } catch (err) {
    return res.status(502).json({ error: err.message || 'PayPal order creation failed.' });
  }
});

// Step 3 (API path): capture an approved order and record the ledger entry.
app.post('/api/pay/capture/:orderId', async (req, res) => {
  const { orderId } = req.params;
  if (!hasPayPalCreds()) {
    return res.status(400).json({
      error: 'PayPal credentials not configured; nothing to capture (payments are simulated).',
    });
  }
  try {
    const { capture_id, status } = await paypalCaptureOrder(orderId);
    const pending = pendingOrders.get(orderId) || {};
    let draft = pending.draft || null;
    let settlement = pending.settlement || null;
    if (req.body?.draft) {
      try { draft = validateDraft(req.body.draft); } catch { /* keep stored draft */ }
    }
    if (draft && !settlement) settlement = computeSettlement(draft);
    pendingOrders.delete(orderId);
    const entry = appendLedger(
      newEntry({
        payee_name: draft?.payee_name || 'PayPal payer',
        payee_email: draft?.payee_email || '',
        amount: draft?.amount ?? 0,
        currency: draft?.currency || 'INR',
        invoice_no: draft?.invoice_no || '',
        status: 'PAID',
        paypal_order_id: orderId,
        transaction_id: capture_id,
        ...settlementLedgerFields(settlement),
      })
    );
    return res.json({ status: 'PAID', paypal_status: status, transaction_id: capture_id, ledger_entry: entry });
  } catch (err) {
    return res.status(502).json({ error: err.message || 'Capture failed.' });
  }
});

// Step 3 (browser path): PayPal redirects the buyer back here after approval.
app.get('/pay/return', async (req, res) => {
  const orderId = String(req.query.token || '');
  if (!orderId || !hasPayPalCreds()) {
    return res.redirect('/?status=error&msg=missing-order');
  }
  try {
    const { capture_id } = await paypalCaptureOrder(orderId);
    const pending = pendingOrders.get(orderId) || {};
    const draft = pending.draft || null;
    const settlement = pending.settlement || (draft ? computeSettlement(draft) : null);
    pendingOrders.delete(orderId);
    appendLedger(
      newEntry({
        payee_name: draft?.payee_name || 'Supplier (PayPal checkout)',
        payee_email: draft?.payee_email || '',
        amount: draft?.amount ?? 0,
        currency: draft?.currency || '',
        invoice_no: draft?.invoice_no || '',
        status: 'PAID',
        paypal_order_id: orderId,
        transaction_id: capture_id,
        ...settlementLedgerFields(settlement),
      })
    );
    return res.redirect(`/?status=paid&order=${encodeURIComponent(orderId)}`);
  } catch {
    return res.redirect(`/?status=error&order=${encodeURIComponent(orderId)}`);
  }
});

app.get('/pay/cancel', (req, res) => {
  res.redirect('/?status=cancelled');
});

// Ledger
app.get('/api/ledger', (req, res) => {
  res.json({ entries: readLedger() });
});

// Config status (never exposes secret values)
app.get('/api/config', (req, res) => {
  res.json({
    gemini_configured: Boolean(GEMINI_API_KEY),
    paypal_configured: hasPayPalCreds(),
    paypal_env: PAYPAL_ENV,
  });
});

app.use((err, req, res, next) => {
  // body-parser JSON errors etc.
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body.' });
  }
  return next(err);
});

app.listen(PORT, () => {
  console.log(`BillBuddy running at ${BASE_URL} (port ${PORT})`);
  console.log(`Gemini: ${GEMINI_API_KEY ? 'configured' : 'NOT configured (demo parser active)'}`);
  console.log(`PayPal: ${hasPayPalCreds() ? `configured (${PAYPAL_ENV})` : 'NOT configured (simulated payments active)'}`);
});
