# JobPay Agent

**PayPal AI Hackathon 2026** entry — targeting **Best Use of Agentic Commerce** and **Best Use of PayPal + AI**.

An AI agent that helps a small business **hire a gig worker and pay them via PayPal** (sandbox first). You chat in plain English; the agent drafts a Payouts API payload, asks you to confirm, then sends (or dry-runs) the payment.

> Example: *“Pay Jane $50 for the lawn job at jane@example.com”* → draft → **confirm** → PayPal sandbox payout.

## Why this angle

- **Agentic commerce**: the agent owns the workflow (parse intent → draft → human confirm → PayPal action → status).
- **PayPal + AI**: natural-language hiring/pay instructions map onto the [PayPal Payouts API](https://developer.paypal.com/docs/api/payments.payouts-batch/v1/) with a mandatory confirmation gate (no silent sends).

## Quick start

```bash
git clone https://github.com/godbody4040-oss/JobPay-Agent.git
cd JobPay-Agent
bun install          # or: npm install
cp .env.example .env # optional — works in dry-run without keys
bun run start        # or: npm start / bun run src/index.ts
```

Open **http://localhost:3000**

Health check: `GET http://localhost:3000/health`

### Without PayPal credentials (default)

The server starts in **DRY-RUN** mode. Draft + confirm still work; `send_sandbox_payout` returns the payload that *would* be POSTed to PayPal.

### With PayPal sandbox

1. Create a sandbox app at [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/applications/sandbox).
2. Put Client ID / Secret in `.env`:

```env
PAYPAL_CLIENT_ID=...
PAYPAL_CLIENT_SECRET=...
PAYPAL_MODE=sandbox
```

3. Restart the server. Confirmed sends hit `https://api-m.sandbox.paypal.com`.

### Optional OpenAI

```env
OPENAI_API_KEY=sk-...
```

When set, the agent can use Chat Completions tool-calling (`gpt-4o-mini`). Without it, a built-in deterministic parser handles pay / confirm / status — enough for the demo.

No OpenAI key? You can also point a local OpenAI-compatible server at the same API shape later; the prototype does not require any LLM to run.

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Liveness + credential flags |
| `POST` | `/api/chat` | `{ "message": "...", "sessionId": "optional" }` → agent reply + tools |
| `POST` | `/api/reset` | Clear session state |

### Agent tools

1. **`create_draft_payout`** — builds a PayPal Payouts batch payload (one worker email + amount + note).
2. **`send_sandbox_payout`** — requires explicit `confirm: true`; calls sandbox Payouts or returns dry-run.
3. **`get_payout_status`** — `GET /v1/payments/payouts/{batch_id}`.

## Project layout

```
src/index.ts    Express server
src/agent.ts    Agent loop (OpenAI tools or local parser)
src/paypal.ts   OAuth client-credentials + Payouts helpers
public/         Minimal chat UI
.env.example    Env template (no secrets)
LICENSE         MIT
```

## Hackathon notes

- Event: [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/)
- Submission deadline: **Thu Nov 12, 2026, 3:00 PM ET**
- This repo is **public**, **MIT** licensed (required for judging).
- Prototype only sends when `PAYPAL_MODE=sandbox` (safety lock in code).
- Never commit real `.env` secrets.

## License

[MIT](./LICENSE) © 2026 Adam Dancy
