/**
 * Grounding guard for LLM plans. Small models invent plausible data (a fake customer, a made-up rate,
 * pay copied from the charge). Before an LLM intent reaches the agent, every email, amount and name
 * must be traceable to the user's message or the crew record; anything else is dropped and the
 * agent asks for it instead. Approvals are never decided by the model.
 */
import type { Intent } from "./nlu.ts";
import { amounts, emails } from "./nlu.ts";
import type { Session } from "./ledger.ts";

const ONES: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, a: 1,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** Numbers written in words: "sixty", "two hundred forty", "a hundred and fifty", "1.5k" is not handled. */
export function wordNumbers(text: string): number[] {
  const out: number[] = [];
  const toks = text.toLowerCase().replace(/[-,]/g, " ").split(/\s+/);
  let cur = 0, total = 0, active = false;
  const flush = () => {
    if (active) out.push(total + cur);
    cur = 0; total = 0; active = false;
  };
  for (const t of toks) {
    const w = t.replace(/[^a-z]/g, "");
    if (w in ONES && !(w === "a" && !active && !/^(hundred|thousand)/.test(toks[toks.indexOf(t) + 1] || ""))) { cur += ONES[w]!; active = true; }
    else if (w in TENS) { cur += TENS[w]!; active = true; }
    else if (w === "hundred" && active) cur *= 100;
    else if (w === "thousand" && active) { total += cur * 1000; cur = 0; }
    else if (w === "and" && active) continue;
    else flush();
  }
  flush();
  return out;
}

export function groundedNumbers(text: string): Set<number> {
  const nums = new Set<number>();
  for (const a of amounts(text)) nums.add(a.value);
  for (const m of text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, " ").matchAll(/\d+(?:\.\d+)?/g)) nums.add(parseFloat(m[0]));
  for (const n of wordNumbers(text)) nums.add(n);
  return nums;
}

const NUM_FIELDS = ["amount", "charge", "pay", "hours", "rate"] as const;

/** After merging LLM + rule fields: a job's worker pay can't silently equal the customer charge. */
export function postMergeCheck(i: any, text: string): string[] {
  if (i.type === "log_job" && i.pay !== undefined && i.pay === i.charge && !/\bpay\s+(?!.*\bpaying\b)[A-Z]/.test(text)) {
    delete i.pay;
    return ["pay=charge (dropped; computed from rate)"];
  }
  return [];
}

export function ground(intent: any, text: string, s: Session): { intent: Intent; dropped: string[] } {
  const i = { ...intent };
  const dropped: string[] = [];
  const lower = text.toLowerCase();
  const textEmails = new Set(emails(text).map((e) => e.toLowerCase()));
  const crewEmails = new Set(s.workers.map((w) => w.email?.toLowerCase()).filter(Boolean) as string[]);
  const nums = groundedNumbers(text);

  for (const k of ["email", "customerEmail", "workerEmail"]) {
    if (i[k] === undefined || i[k] === null || i[k] === "") { delete i[k]; continue; }
    const e = String(i[k]).toLowerCase();
    const ok = textEmails.has(e) || (k !== "customerEmail" && crewEmails.has(e));
    if (!ok) { dropped.push(`${k}=${i[k]}`); delete i[k]; }
  }
  for (const k of NUM_FIELDS) {
    if (i[k] === undefined || i[k] === null) continue;
    const n = Number(i[k]);
    if (!Number.isFinite(n) || n <= 0 || !nums.has(n)) { dropped.push(`${k}=${i[k]}`); delete i[k]; }
  }
  // In a job close-out, the same number can't be both what the customer pays and the worker's pay
  // unless the user said so explicitly; the agent derives pay from the worker's rate instead.
  if (i.type === "log_job" && i.pay !== undefined && i.pay === i.charge && !/\bpay\b/i.test(text)) { dropped.push(`pay=${i.pay}`); delete i.pay; }
  for (const k of ["customerName", "name", "worker"]) {
    if (!i[k]) continue;
    const first = String(i[k]).split(/\s+/)[0]!.toLowerCase().replace(/[^a-z'’-]/g, "");
    const crew = s.workers.some((w) => w.name.toLowerCase().split(" ")[0] === first);
    if (!first || (!lower.includes(first) && !(k === "worker" && crew && lower.includes(first)))) { dropped.push(`${k}=${i[k]}`); delete i[k]; }
  }
  return { intent: i as Intent, dropped };
}
