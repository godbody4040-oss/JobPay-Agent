# JobPay Agent: guide for judges

**One line:** A home-service owner describes a finished job in one sentence. JobPay Agent works out the worker's pay and the margin, then pays the worker through **PayPal Payouts** and bills the customer through **PayPal Invoicing or Checkout**, but only after a policy check and the owner's tap.

## Run it (under 5 minutes)

```bash
git clone https://github.com/godbody4040-oss/JobPay-Agent.git && cd JobPay-Agent
bun install && bun run start          # http://localhost:3000, works with no keys (DRY-RUN, rule-based planner)
bun run llm:local                     # optional, free: Qwen2.5-3B via llama.cpp on :8088 (~2.1 GB download)
OPENAI_BASE_URL=http://localhost:8088/v1 OPENAI_MODEL=qwen2.5-3b-instruct bun run start   # AI planner on
# optional real sandbox: cp .env.example .env, add sandbox keys, restart, then `bun run smoke`
```

## 90-second demo script

| Time | On screen | Say |
|---|---|---|
| 0:00–0:10 | Landing page, “Your crew did the work. *Let the agent settle up.*” | “Home-service owners finish the day with a crew to pay and customers to bill. JobPay Agent closes out a job in one sentence, on PayPal.” |
| 0:10–0:20 | Click **Load demo crew**. The Crew panel fills: Maria (plumber, $45/hr), Dev ($60 per job), Keisha. | “My crew is onboarded with their PayPal emails and rates.” |
| 0:20–0:40 | Tap the amber chip: *“Maria finished the water heater repair for Bob Smith bob.smith@example.com, 3 hours, charge $240.”* Two cards appear. | “The agent logged the job, worked out Maria's pay from her rate (3 × $45 = $135) and my $105 margin, and planned the close-out: a payout to Maria and an invoice to Bob. Nothing has moved yet.” |
| 0:40–0:50 | Point at the policy chips (caps, crew member, margin 44%, sandbox lock) and open **View PayPal request**. | “Every draft goes through a spend policy, and here is the exact PayPal request it will send.” |
| 0:50–1:05 | **Confirm & send** on both cards. The ticker updates, the AG Grid ledger fills, and the activity feed shows a payout batch ID and an invoice or checkout link. | “One tap each, and it's live in the PayPal sandbox: a Payouts batch for Maria and a bill for Bob. If Invoicing isn't enabled, the agent heals itself with a PayPal Checkout link.” |
| 1:05–1:15 | Type *“Pay Dev $900 for the deck.”* A red **Blocked by policy** card appears. | “Guardrails are real. Over the cap is blocked, and a duplicate pay for the same job is blocked too.” |
| 1:15–1:20 | *(Optional, if time allows)* Log a second job for Dev, then say *“Run payroll.”* | “Friday payroll: every unpaid job goes out as one PayPal Payouts batch.” |
| 1:20–1:25 | **↻ Live PayPal status**, then the *“Show my books”* chip. | “It reconciles against PayPal and tells me what I paid, what I billed, my margin and who still owes me.” |
| 1:25–1:30 | Open **agent trace**. | “Every step is traceable. The AI plans, PayPal moves the money, and the human stays in control.” |

**Recording tips:** run with the **local LLM on** (the pill reads *LLM · qwen2.5-3b-instruct*). That's what makes the AI real in the video. Type at least one paraphrase, such as *“Can you get Dev his money for today? It was sixty bucks.”*, and open the trace to show `llm.plan` and `grounding.check`. Use a 1440×900 window in **sandbox** mode so the pill reads *PayPal sandbox · live*, and finish with a 5-second phone-width shot (the tabs: Agent, Ledger, Crew).

## Scoring self-check

| Criterion | Evidence | Where |
|---|---|---|
| **Technological implementation** | 3 PayPal products: Payouts (single and multi-item payroll batches), Invoicing v2 and Orders v2, across create, send, get and capture. OAuth caching, `PayPal-Request-Id` idempotency, a sandbox lock, a 403 fallback from Invoicing to Orders. An LLM tool-calling planner verified with free Qwen2.5-3B (10/10 on our 10-prompt eval, against 8/10 for the rule-based fallback, which is not AI), plus a grounding guard against made-up fields. 17 tests, a planner eval and a live smoke script. | `src/paypal.ts`, `src/agent.ts`, `src/llm.ts`, `src/ground.ts`, `scripts/eval-planner.ts`, `tests/`, `scripts/smoke.ts` |
| **Design** | Dark editorial UI (serif display, mono data, amber accent). Draft cards with policy chips and a request preview. Live ticker, AG Grid ledger, activity timeline. Tabbed mobile layout and reduced-motion support. | `public/` |
| **Potential impact** | A specific audience (owners of 2–25-person contractor crews) and a specific pain (end-of-day close-out across pay, billing and margin). It runs on the PayPal account they already use to get paid. | README, “The problem” |
| **Innovation** | **Job close-out as one agentic transaction**: a single sentence produces a two-sided PayPal flow (money out to labor, money in from the customer) with margin awareness. A policy engine sits between the AI and the money, and a human holds the final key. | `logJob()` in `src/agent.ts` |
| **Presentation** | The 90-second script above, an architecture diagram, an agent trace in the UI, and dry-run mode so any judge can reproduce it. | README, this file |

### Prize fit
- **Best Use of Agentic Commerce.** The agent plans and executes multi-step commerce (pay labor and charge the customer) with guardrails and human approval.
- **Best Use of PayPal + AI.** An LLM plans PayPal tool calls, a grounding check and a policy engine constrain it, and PayPal Payouts, Invoicing and Orders execute after a human tap.
- **Best Demo Delivery.** Live at https://jobpay-agent.onrender.com (dry-run). Locally it works with no keys, and the free local LLM makes the AI reproducible without an account.
- **AG Grid.** The Ledger is AG Grid Community: a custom Quartz theme, a pinned net-cash row, conditional styling and filters.
- **Render.** Live on a Free web service, with the Blueprint and Dockerfile in the repo.

## Honest limits
- **AI status.** The LLM planner is verified **locally** with Qwen2.5-3B only. It is **not** verified with OpenAI or any hosted API. The **hosted Render demo runs no model**; its planner is rule-based (not AI). The eval is a small self-written set, not a benchmark.
- The ledger is in memory per session. Persistence and webhooks are on the roadmap.
- The demo sandbox app doesn't have Invoicing enabled, so the fallback to a Checkout link is what you'll see unless you enable *Invoicing* on your sandbox app in the PayPal Developer Dashboard.
- Payouts to `@example.com` addresses stay `UNCLAIMED` in the sandbox. Use a sandbox personal account email to see `SUCCESS`.
