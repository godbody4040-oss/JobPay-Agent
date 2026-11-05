# Devpost submission copy (paste-ready)

**Project name:** JobPay Agent

**Tagline:** Close out a job in one sentence. AI pays your crew with PayPal Payouts and bills your customer with PayPal, and you approve every dollar.

## Inspiration
Home-service owners such as plumbers, cleaners and handymen end every day with the same chores: work out what each contractor is owed, pay them fast, bill the customer, and wonder whether the job made money. Those chores are spread across texts, a spreadsheet and several PayPal tabs. We wanted one sentence to do all of it, safely.

## What it does
You type something like *“Maria finished the water heater repair for Bob Smith, 3 hours, charge $240.”* JobPay Agent then:

- logs the job,
- works out Maria's pay from her rate ($135) and your margin ($105, 44%),
- drafts a PayPal Payout to Maria and a PayPal invoice to Bob,
- runs both drafts through a spend policy (caps, duplicate-pay detection, crew membership, margin, sandbox lock),
- waits for your **Confirm**,
- executes them on PayPal,
- and reconciles live status in an AG Grid ledger.

“Run payroll” pays every unpaid job in **one multi-item Payouts batch**. If Invoicing isn't enabled on the PayPal app, the agent heals itself by sending a PayPal Checkout link instead.

## How we built it
- **PayPal:** Payouts v1 (single payouts and batches, plus status), Invoicing v2 (create, send, get), Orders v2 (create, get, capture), OAuth2 client credentials, and `PayPal-Request-Id` idempotency. Everything is sandbox-locked.
- **AI:** An agentic planner turns language into typed tool calls. The default planner is a deterministic offline NLU that is free, instant and needs no key. An optional OpenAI-compatible tool-calling planner (OpenAI, or a free local Ollama model) shares the same tool manifest, whose names mirror the PayPal Agent Toolkit. Every response shows an agent trace.
- **Stack:** Bun, TypeScript, Express, a no-build vanilla JS UI and AG Grid Community. There are 14 tests and GitHub Actions CI, and you can deploy free on Render with Docker and `render.yaml`.

## Challenges
- Keeping the AI in charge of *planning* but never *executing*. Only `confirmAction()` can call a money-moving endpoint, and the PayPal helpers refuse to run without `confirmed: true`.
- Dealing with sandbox apps that lack Invoicing permission, which we solved with an automatic fallback to Orders.

## Accomplishments
- A real end-to-end run in the PayPal sandbox: a payout batch reached `SUCCESS`, a 2-worker payroll batch was created, and Checkout orders were created with working approval links.
- A demo that works fully offline with no keys.

## What's next
PayPal webhooks to auto-close jobs, persistent multi-user storage, and swapping the REST layer for `@paypal/agent-toolkit` or the PayPal MCP server.

## Built with
paypal-payouts, paypal-invoicing, paypal-orders, typescript, bun, express, ag-grid, openai-compatible (optional), render

**Try it:** `git clone https://github.com/godbody4040-oss/JobPay-Agent && cd JobPay-Agent && bun install && bun run start`
