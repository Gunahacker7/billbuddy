# 🧾 BillBuddy — AI Bill-Pay Agent for Small Shops

> Paste a supplier bill → AI drafts the payment → you approve → **PayPal Sandbox** pays it → it lands in your ledger.

Built for the **PayPal AI Hackathon** ("Build what's next with PayPal and AI").

---

## The problem

Small shop owners in India (kirana stores, small retailers) receive supplier bills as
paper invoices, photos, and WhatsApp messages. Paying each one means manually typing
the payee, amount, and invoice number into a payment app — slow, error-prone, and easy
to forget until a due date passes and late fees or lost supplier credit follow.

## The idea

**BillBuddy is an AI agent that does the typing for you.** The owner pastes the bill
text, Google Gemini extracts a clean, structured payment draft, the owner reviews and
approves it (nothing moves without a human OK), and BillBuddy creates and captures a
real **PayPal Sandbox** checkout order. Every processed bill is recorded in a local
ledger, so the shop has a searchable payment history.

## How it works

```
Paste bill text ──► POST /api/extract ──► Gemini extraction ──► editable draft card
                                                                      │ owner approves
                                                                      ▼
Ledger (JSON) ◄── capture ◄── PayPal redirect /pay/return ◄── POST /api/pay
                                                              (Orders v2, CAPTURE)
```

1. **Extract** — `POST /api/extract` sends the bill text to Google Gemini
   (`gemini-3.8-flash`) with a strict JSON-extraction prompt and returns a validated
   draft: `payee_name, payee_email, amount, currency, due_date, invoice_no, description`.
2. **Review** — the draft is shown as a fully editable card. The human is always in
   the loop: no payment is created until the owner clicks approve.
3. **Pay** — `POST /api/pay` creates a PayPal **Orders v2** order (intent `CAPTURE`,
   `custom_id` = invoice number) on the Sandbox and returns the buyer approval link.
4. **Capture** — after the buyer approves on PayPal, the redirect to `GET /pay/return`
   captures the order server-side (an API equivalent exists at
   `POST /api/pay/capture/:orderId`). A successful capture writes a `PAID` ledger entry
   with the PayPal order id and transaction id.

### Graceful fallbacks (so judges can always run it end-to-end)

| Missing config        | Behaviour                                                                 |
|-----------------------|---------------------------------------------------------------------------|
| No `GEMINI_API_KEY`   | `/api/extract` uses a clearly-labelled demo parser (`demo_mode: true`)    |
| No PayPal credentials | `/api/pay` returns a clearly-labelled `SIMULATED` payment + ledger entry   |

## Currency note

PayPal sandbox checkout does **not** support INR — orders in INR are rejected
with `CURRENCY_NOT_SUPPORTED` — while BillBuddy's bills are Indian. So BillBuddy
extracts and stores every bill in its **original currency**, and converts INR
bills to **USD** at a configurable demo rate (`DEMO_FX_INR_PER_USD`, default
`83`) purely for the sandbox payment. Both amounts are recorded: the PayPal
order description carries the original bill amount and rate (e.g. *"Bill
SLWT/2026/1847 — ₹19,152.00 settled as USD at demo rate 83"*), and each ledger
entry keeps the original `amount`/`currency` alongside `settlement_amount`,
`settlement_currency` and `fx_rate`. Bills already in a sandbox-supported
currency (USD, EUR, GBP, AUD, CAD, JPY, SGD) are paid as-is; any other
unsupported currency is rejected with a clear error naming the currency.

## Architecture

- **Runtime:** Node.js ≥ 18, Express 4 — no build step.
- **Frontend:** one vanilla HTML/CSS/JS page served by Express (`public/index.html`).
- **AI:** Google Gemini REST API via built-in `fetch` (no SDK).
- **Payments:** PayPal Sandbox REST API — OAuth2 client-credentials, Orders v2
  create + capture, also via built-in `fetch`.
- **Storage:** local JSON ledger at `data/ledger.json` (no database to set up).
- **Config:** environment variables only (see `.env.example`). No secrets in code,
  and secrets are never logged.

## Setup

### 1. Get a PayPal Sandbox app (free, ~2 minutes)

1. Go to the [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/) and
   log in (create a free developer account if needed).
2. **Apps & Credentials → Sandbox → Create App** (e.g. name it "BillBuddy").
3. Copy the **Client ID** and **Secret**.
4. (Optional) In **Sandbox → Accounts**, note the auto-created personal (buyer) test
   account — you will use it to approve payments in the demo.

### 2. Get a Gemini API key (free tier)

1. Go to [Google AI Studio](https://aistudio.google.com/app/apikey) → **Create API key**.
2. Copy the key. (Optional — without it, BillBuddy runs in labelled demo-parse mode.)

### 3. Run BillBuddy

```bash
npm install
cp .env.example .env   # then fill in GEMINI_API_KEY, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET
npm start
```

Open **http://localhost:3000**.

## Demo script (≈2 minutes)

1. Open the app. Point out the status badges: Gemini connected, PayPal sandbox.
2. Click **"Sample: Kirana wholesale invoice"**, then **"Extract with AI"** —
   Gemini returns payee *Sri Lakshmi Wholesale Traders*, amount **₹19,152**, invoice
   `SLWT/2026/1847`, due date — all without typing.
3. Edit a field (e.g. fix the description) to show the human-in-the-loop review step.
4. Click **"Approve & Pay with PayPal (Sandbox)"** → open the approval link → log in
   with the sandbox **buyer** test account → approve.
5. PayPal redirects back; BillBuddy captures the payment and the **ledger updates**
   with status `PAID`, the PayPal order id, and the transaction id.
6. Repeat with the electricity-bill sample — the same flow works for utility bills.
7. (Optional) Restart without keys to show the demo-parser / simulated-payment
   fallbacks that keep the flow runnable anywhere.

## AI tools used

- **Google Gemini** (`gemini-3.8-flash`) — bill understanding and structured extraction.
- Development assistance from an AI coding assistant for scaffolding and review.

## Project structure

```
billbuddy/
├── server.js          # Express app: extract, pay, capture, ledger, redirects
├── public/index.html  # Single-page UI (bill input → draft → pay → ledger)
├── data/ledger.json   # Local payment ledger (git-ignored, auto-created)
├── .env.example       # Configuration template
├── package.json
└── README.md
```

## License

MIT — see [LICENSE](LICENSE).
