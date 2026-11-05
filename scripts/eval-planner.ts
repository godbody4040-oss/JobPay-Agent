/**
 * Compare the rule-based planner with the LLM planner on the same prompts.
 *   OPENAI_BASE_URL=http://localhost:8088/v1 OPENAI_MODEL=qwen2.5-1.5b bun run scripts/eval-planner.ts
 * Prints per-case intents and a pass/fail against expected tool + key fields. No PayPal calls.
 */
import { parse } from "../src/nlu.ts";
import { llmPlan, llmEnabled } from "../src/llm.ts";
import { ground, postMergeCheck } from "../src/ground.ts";
import { newSession, upsertWorker } from "../src/ledger.ts";

const s = newSession("eval");
upsertWorker(s, { name: "Maria Lopez", email: "maria.lopez@example.com", trade: "plumber", rate: 45, rateUnit: "hr" });
upsertWorker(s, { name: "Dev Patel", email: "dev.patel@example.com", trade: "handyman", rate: 60, rateUnit: "job" });
const ctx = { workerNames: s.workers.map((w) => w.name) };

type Exp = { type: string; fields?: Record<string, unknown> };
const cases: Array<[string, Exp]> = [
  ["Maria finished the water heater repair for Bob Smith bob.smith@example.com, 3 hours, charge $240", { type: "log_job", fields: { charge: 240, hours: 3 } }],
  ["Onboard Keisha Brown, house cleaner, keisha@example.com, $30/hr", { type: "onboard", fields: { email: "keisha@example.com", rate: 30 } }],
  ["Pay Dev $60 for the fence repair", { type: "pay", fields: { amount: 60 } }],
  ["Invoice Ana Ruiz $180 for tile work at ana.ruiz@example.com", { type: "invoice", fields: { amount: 180, customerEmail: "ana.ruiz@example.com" } }],
  ["run payroll", { type: "payroll" }],
  // paraphrases the rule-based parser was not written for
  ["Can you get Dev his money for today? It was sixty bucks.", { type: "pay", fields: { amount: 60 } }],
  ["Bob Smith owes us two hundred forty dollars for the water heater, email him a bill at bob.smith@example.com", { type: "invoice", fields: { amount: 240 } }],
  ["Maria wrapped up at the Johnsons' — 2.5 hrs on a clogged drain; they're paying $175 (johnson@example.com)", { type: "log_job", fields: { charge: 175, hours: 2.5 } }],
  ["Bring on a new painter named Luis Gomez, his paypal is luis.g@example.com", { type: "onboard", fields: { email: "luis.g@example.com" } }],
  ["what did we make this week?", { type: "report" }],
];

function score(intents: any[], exp: Exp): boolean {
  const i = intents?.[0];
  if (!i || i.type !== exp.type) return false;
  return Object.entries(exp.fields || {}).every(([k, v]) => i[k] === v || String(i[k]).toLowerCase() === String(v).toLowerCase());
}

let rb = 0, lm = 0;
for (const [text, exp] of cases) {
  const r = parse(text, ctx);
  let l: any[] = [];
  let ms = 0;
  if (llmEnabled()) {
    const t0 = Date.now();
    try {
      const raw = await llmPlan(text, s);
      if (!raw.length) raw.push(...(r as any[]));
      // same hybrid policy as agent.ts: grounding + rules win on a confident different task
      l = raw.map((p, idx) => {
        const g: any = ground(p, text, s).intent;
        const rr: any = r[idx];
        if (rr && rr.type !== "unknown" && rr.type !== "provide" && rr.type !== g.type) return rr;
        if (rr && rr.type === g.type) for (const [k, v] of Object.entries(rr)) if (g[k] === undefined) g[k] = v;
        postMergeCheck(g, text);
        return g;
      });
    } catch (e) { l = [{ type: "error", msg: String(e) }]; }
    ms = Date.now() - t0;
  }
  const okR = score(r, exp), okL = score(l, exp);
  rb += +okR; lm += +okL;
  console.log(`\n${text}\n  expect ${JSON.stringify(exp)}\n  rules ${okR ? "PASS" : "FAIL"} ${JSON.stringify(r)}\n  llm   ${okL ? "PASS" : "FAIL"} (${ms}ms) ${JSON.stringify(l)}`);
}
console.log(`\nRule-based only: ${rb}/${cases.length}   Hybrid (LLM + grounding + rules): ${llmEnabled() ? `${lm}/${cases.length}` : "not configured"}`);
