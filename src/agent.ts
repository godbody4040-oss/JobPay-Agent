/**
 * JobPay Agent orchestrator.
 *
 *   user text ─▶ planner (offline NLU, or optional LLM tool-calling) ─▶ typed intents
 *            ─▶ business tools (onboard, log job) run immediately
 *            ─▶ money tools only create DRAFTS ─▶ policy engine ─▶ human Confirm
 *            ─▶ PayPal REST (Payouts / Invoicing / Orders) ─▶ ledger + activity feed
 *
 * The model (or parser) can never move money: only confirmAction() calls PayPal, and only
 * the UI button or an explicit "confirm" message from the human reaches it.
 */
import * as pp from "./paypal.ts";
import {
  type Job,
  type MoneyAction,
  type Session,
  type TraceStep,
  type Worker,
  findWorker,
  log,
  totals,
  upsertWorker,
} from "./ledger.ts";
import { evaluate, isBlocked, limits } from "./policy.ts";
import { parse, type Intent } from "./nlu.ts";
import { llmEnabled, llmPlan } from "./llm.ts";

export interface AgentReply {
  reply: string;
  actionIds: string[];
  trace: TraceStep[];
  planner: "llm" | "offline";
}

const $ = (n: number) => `$${n.toFixed(2)}`;
const first = (name?: string) => (name || "").split(" ")[0];

async function timed<T>(trace: TraceStep[], tool: string, input: unknown, fn: () => Promise<T> | T): Promise<T> {
  const t0 = Date.now();
  try {
    const out = await fn();
    trace.push({ tool, input, output: summarize(out), ms: Date.now() - t0, ok: true });
    return out;
  } catch (e) {
    trace.push({ tool, input, output: e instanceof Error ? e.message : String(e), ms: Date.now() - t0, ok: false });
    throw e;
  }
}

function summarize(out: any): unknown {
  if (!out || typeof out !== "object") return out;
  if ("call" in out && "data" in out) {
    const d = out.data || {};
    return {
      dryRun: out.dryRun,
      id: d.id || d.batch_header?.payout_batch_id,
      status: d.status || d.batch_header?.batch_status,
    };
  }
  if ("kind" in out && "checks" in out) return { draft: out.id, kind: out.kind, amount: out.amount, status: out.status };
  return out;
}

// ---------------------------------------------------------------- drafts

function draft(s: Session, a: Omit<MoneyAction, "id" | "checks" | "status" | "createdAt" | "idempotencyKey" | "currency">): MoneyAction {
  const base = { ...a, id: pp.newId(a.kind), currency: "USD", createdAt: Date.now(), idempotencyKey: pp.newId("jp") };
  const checks = evaluate(s, base);
  const action: MoneyAction = { ...base, checks, status: isBlocked(checks) ? "blocked" : "pending" };
  s.actions.unshift(action);
  log(
    s,
    "policy",
    `${isBlocked(checks) ? "Blocked" : "Drafted"} ${a.kind.replace("_", " ")} ${$(a.amount)} ${a.direction === "out" ? "to" : "from"} ${a.counterparty.name || a.counterparty.email}`,
    action.id
  );
  return action;
}

function draftPayout(s: Session, w: { name?: string; email: string; workerId?: string }, amount: number, note: string, jobId?: string) {
  const idem = pp.newId("jp");
  const a = draft(s, {
    kind: "payout",
    title: `Pay ${w.name || w.email}`,
    amount,
    counterparty: { name: w.name, email: w.email },
    note,
    direction: "out",
    jobId,
    workerId: w.workerId,
    request: {
      method: "POST",
      path: "/v1/payments/payouts",
      body: pp.buildPayoutBody({ recipientEmail: w.email, amount, note, senderItemId: idem }),
    },
  });
  a.idempotencyKey = idem;
  return a;
}

function draftInvoice(s: Session, c: { name?: string; email: string }, amount: number, description: string, jobId?: string) {
  return draft(s, {
    kind: "invoice",
    title: `Invoice ${c.name || c.email}`,
    amount,
    counterparty: c,
    note: description,
    direction: "in",
    jobId,
    request: {
      method: "POST",
      path: "/v2/invoicing/invoices → /send",
      body: pp.buildInvoiceBody({ customerName: c.name, customerEmail: c.email, amount, description, reference: "pending" }),
    },
  });
}

function draftPaymentLink(s: Session, c: { name?: string; email?: string }, amount: number, description: string, jobId?: string) {
  return draft(s, {
    kind: "payment_link",
    title: `Payment link for ${c.name || c.email}`,
    amount,
    counterparty: c,
    note: description,
    direction: "in",
    jobId,
    request: { method: "POST", path: "/v2/checkout/orders", body: pp.buildOrderBody({ amount, description, reference: "pending" }) },
  });
}

function renderDraftLine(a: MoneyAction): string {
  const flags = a.checks.filter((c) => c.level !== "pass");
  const tag = a.status === "blocked" ? "⛔ blocked by policy" : flags.length ? `⚠ ${flags.map((f) => f.label).join("; ")}` : "✓ policy clear";
  return `• **${a.title}** — ${$(a.amount)} · ${tag}`;
}

// ---------------------------------------------------------------- execution (the only path to PayPal)

export async function confirmAction(s: Session, id: string, trace: TraceStep[] = []): Promise<MoneyAction> {
  const a = s.actions.find((x) => x.id === id);
  if (!a) throw new Error("Unknown action");
  if (a.status === "done") return a;
  if (a.status !== "pending" && a.status !== "failed") throw new Error(`Action is ${a.status}; it can't be confirmed.`);
  // Re-check policy at execution time (limits may have changed since drafting).
  a.checks = evaluate(s, a);
  // A failed retry shouldn't flag itself as a duplicate.
  a.checks = a.checks.filter((c) => !(c.id === "dup" && c.detail?.includes(a.id)));
  if (isBlocked(a.checks)) {
    a.status = "blocked";
    return a;
  }
  a.status = "executing";
  try {
    if (a.kind === "payout") {
      const r = await timed(trace, "paypal.payouts.create", { amount: a.amount, to: a.counterparty.email }, () =>
        pp.createPayout(
          { recipientEmail: a.counterparty.email!, amount: a.amount, note: a.note, senderItemId: a.idempotencyKey },
          { confirmed: true }
        )
      );
      a.paypalApi = "payouts";
      a.paypalId = r.data.batch_header?.payout_batch_id;
      a.paypalStatus = r.data.batch_header?.batch_status;
      a.dryRun = r.dryRun;
      const job = s.jobs.find((j) => j.id === a.jobId);
      if (job) job.status = job.status === "billed" ? "closed" : "worker_paid";
      log(s, "payout", `Paid ${a.counterparty.name || a.counterparty.email} ${$(a.amount)} · batch ${a.paypalId}`, a.id);
    } else if (a.kind === "payroll") {
      const items = a.items || [];
      const r = await timed(trace, "paypal.payouts.create (batch)", { workers: items.length, total: a.amount }, () =>
        pp.createPayoutBatch(a.idempotencyKey, items, { confirmed: true })
      );
      a.paypalApi = "payouts";
      a.paypalId = r.data.batch_header?.payout_batch_id;
      a.paypalStatus = r.data.batch_header?.batch_status;
      a.dryRun = r.dryRun;
      for (const i of items) {
        const job = s.jobs.find((j) => j.id === i.jobId);
        if (job) job.status = job.status === "billed" ? "closed" : "worker_paid";
      }
      log(s, "payroll", `Payroll: ${items.length} workers, ${$(a.amount)} in one batch · ${a.paypalId}`, a.id);
    } else if (a.kind === "invoice") {
      try {
        const inv = await timed(trace, "paypal.invoicing.create", { amount: a.amount, to: a.counterparty.email }, () =>
          pp.createInvoice({
            customerName: a.counterparty.name,
            customerEmail: a.counterparty.email!,
            amount: a.amount,
            description: a.note,
            reference: a.idempotencyKey,
          })
        );
        const sent = await timed(trace, "paypal.invoicing.send", { id: inv.data.id }, () =>
          pp.sendInvoice(inv.data.id, { confirmed: true, requestId: `${a.idempotencyKey}_send` })
        );
        a.paypalApi = "invoicing";
        a.paypalId = inv.data.id;
        a.paypalStatus = "SENT";
        a.link = sent.data?.href;
        a.dryRun = inv.dryRun;
      } catch (e) {
        // Self-healing: if this sandbox app lacks the Invoicing feature, fall back to an Orders checkout link.
        if (!(e instanceof pp.PayPalApiError) || (e.status !== 403 && e.status !== 401)) throw e;
        const o = await timed(trace, "paypal.orders.create (fallback)", { amount: a.amount }, () =>
          pp.createOrder({ amount: a.amount, description: a.note, reference: a.idempotencyKey })
        );
        a.paypalApi = "orders";
        a.paypalId = o.data.id;
        a.paypalStatus = o.data.status;
        a.link = pp.approveLink(o.data);
        a.dryRun = o.dryRun;
        a.fallback = "Invoicing isn't enabled on this PayPal app, so I created a PayPal checkout link for the same amount instead.";
      }
      const job = s.jobs.find((j) => j.id === a.jobId);
      if (job) job.status = job.status === "worker_paid" ? "closed" : "billed";
      log(s, "invoice", `Billed ${a.counterparty.name || a.counterparty.email} ${$(a.amount)} · ${a.paypalId}`, a.id);
    } else if (a.kind === "payment_link") {
      const o = await timed(trace, "paypal.orders.create", { amount: a.amount }, () =>
        pp.createOrder({ amount: a.amount, description: a.note, reference: a.idempotencyKey })
      );
      a.paypalApi = "orders";
      a.paypalId = o.data.id;
      a.paypalStatus = o.data.status;
      a.link = pp.approveLink(o.data);
      a.dryRun = o.dryRun;
      const job = s.jobs.find((j) => j.id === a.jobId);
      if (job) job.status = job.status === "worker_paid" ? "closed" : "billed";
      log(s, "payment_link", `Payment link ${$(a.amount)} for ${a.counterparty.name || a.counterparty.email || "customer"} · order ${a.paypalId}`, a.id);
    } else if (a.kind === "capture") {
      const r = await timed(trace, "paypal.orders.capture", { id: a.orderId }, () =>
        pp.captureOrder(a.orderId!, { confirmed: true, requestId: a.idempotencyKey })
      );
      a.paypalApi = "orders";
      a.paypalId = r.data.id;
      a.paypalStatus = r.data.status;
      a.dryRun = r.dryRun;
      const src = s.actions.find((x) => x.paypalId === a.orderId && x.id !== a.id);
      if (src) src.paypalStatus = r.data.status;
      log(s, "capture", `Captured ${$(a.amount)} on order ${a.orderId}`, a.id);
    }
    a.status = "done";
    a.executedAt = Date.now();
    a.error = undefined;
  } catch (e) {
    a.status = "failed";
    a.error = e instanceof Error ? e.message : String(e);
    log(s, "system", `Failed: ${a.title} — ${a.error}`, a.id);
  }
  return a;
}

export function cancelAction(s: Session, id: string): MoneyAction {
  const a = s.actions.find((x) => x.id === id);
  if (!a) throw new Error("Unknown action");
  if (a.status === "pending" || a.status === "blocked" || a.status === "failed") {
    a.status = "canceled";
    log(s, "system", `Canceled ${a.title} ${$(a.amount)}`, a.id);
  }
  return a;
}

export async function refreshStatuses(s: Session, trace: TraceStep[] = [], ref?: string): Promise<MoneyAction[]> {
  const targets = s.actions.filter((a) => a.status === "done" && a.paypalId && (!ref || a.paypalId === ref || a.id === ref));
  for (const a of targets.slice(0, 12)) {
    try {
      if (a.paypalApi === "payouts") {
        const r = await timed(trace, "paypal.payouts.get", { id: a.paypalId }, () => pp.getPayout(a.paypalId!));
        a.paypalStatus = r.data.batch_header?.batch_status || a.paypalStatus;
        const item = (r.data as any).items?.[0];
        if (item?.transaction_status && item.transaction_status !== a.paypalStatus) a.paypalStatus = `${a.paypalStatus} · ${item.transaction_status}`;
      } else if (a.paypalApi === "invoicing") {
        const r = await timed(trace, "paypal.invoicing.get", { id: a.paypalId }, () => pp.getInvoice(a.paypalId!));
        a.paypalStatus = r.data.status || a.paypalStatus;
      } else if (a.paypalApi === "orders") {
        const r = await timed(trace, "paypal.orders.get", { id: a.paypalId }, () => pp.getOrder(a.paypalId!));
        a.paypalStatus = r.data.status || a.paypalStatus;
      }
    } catch {
      /* keep last known status */
    }
  }
  return targets;
}

// ---------------------------------------------------------------- intent handlers

function need(s: Session, intent: Intent, missing: string[], question: string): string {
  s.awaiting = { intent, missing };
  return question;
}

function onboard(s: Session, i: Extract<Intent, { type: "onboard" }>): string {
  if (!i.name) return need(s, i, ["name"], "Who should I onboard? Give me a name and their PayPal email.");
  if (!i.email && !findWorker(s, i.name)?.email)
    return need(s, i, ["email"], `What's ${first(i.name)}'s PayPal email? That's where payouts land.`);
  const { worker, created } = upsertWorker(s, { name: i.name, email: i.email?.toLowerCase(), trade: i.trade, rate: i.rate, rateUnit: i.rateUnit });
  s.lastWorkerId = worker.id;
  log(s, "worker", `${created ? "Onboarded" : "Updated"} ${worker.name}${worker.trade ? ` (${worker.trade})` : ""}`, worker.id);
  const rate = worker.rate ? ` at ${$(worker.rate)}/${worker.rateUnit === "job" ? "job" : "hr"}` : "";
  return `${created ? "Onboarded" : "Updated"} **${worker.name}**${worker.trade ? `, ${worker.trade}` : ""}${rate}. Payouts go to ${worker.email}.`;
}

function workerPay(w: Worker | undefined, hours?: number): number | undefined {
  if (!w?.rate) return undefined;
  if (w.rateUnit === "job") return w.rate;
  return hours ? Math.round(w.rate * hours * 100) / 100 : undefined;
}

function pay(s: Session, i: Extract<Intent, { type: "pay" }>, out: string[]): MoneyAction[] {
  let w = findWorker(s, i.email) || findWorker(s, i.worker);
  const email = i.email?.toLowerCase() || w?.email;
  const amount = i.amount ?? (w?.rateUnit === "job" ? w.rate : undefined);
  const missing = [!email && "email", !amount && "amount"].filter(Boolean) as string[];
  if (!i.worker && !email) {
    out.push(need(s, i, ["worker"], "Who should I pay? e.g. “Pay Maria $150 for the gutter job”."));
    return [];
  }
  if (missing.length) {
    out.push(
      need(
        s,
        i,
        missing,
        `I can pay ${first(i.worker) || "them"} — I just need ${missing.map((m) => (m === "email" ? "their PayPal email" : "the amount")).join(" and ")}.`
      )
    );
    return [];
  }
  const job = s.jobs.find((j) => j.id === s.lastJobId && j.workerId === w?.id && j.status !== "closed");
  const note = i.note ? `Payment for ${i.note}` : job ? `Payment for ${job.title}` : "Gig payment via JobPay Agent";
  const a = draftPayout(s, { name: w?.name || i.worker, email: email!, workerId: w?.id }, amount!, note, i.note ? undefined : job?.id);
  out.push(
    a.status === "blocked"
      ? `I drafted a payout to **${w?.name || i.worker || email}**, but your spend policy blocked it.\n${renderDraftLine(a)}`
      : `Drafted a payout to **${w?.name || i.worker || email}** — approve it on the card.\n${renderDraftLine(a)}`
  );
  return [a];
}

function bill(s: Session, i: Extract<Intent, { type: "invoice" | "payment_link" }>, out: string[]): MoneyAction[] {
  const job = s.jobs.find((j) => j.customerName && i.customerName && first(j.customerName).toLowerCase() === first(i.customerName).toLowerCase());
  const email = i.customerEmail?.toLowerCase() || job?.customerEmail;
  const amount = i.amount ?? job?.charge;
  const what = i.type === "invoice" ? "invoice" : "payment link";
  const missing = [i.type === "invoice" && !email && "email", !amount && "amount"].filter(Boolean) as string[];
  if (missing.length) {
    out.push(
      need(s, i, missing, `Happy to send a ${what} to ${i.customerName || "the customer"} — I need ${missing.map((m) => (m === "email" ? "their email" : "the amount")).join(" and ")}.`)
    );
    return [];
  }
  const desc = i.description ? cap(i.description) : job?.title || "Home service";
  const c = { name: i.customerName || job?.customerName, email };
  const a = i.type === "invoice" ? draftInvoice(s, c as any, amount!, desc, job?.id) : draftPaymentLink(s, c, amount!, desc, job?.id);
  out.push(`Drafted a ${what} for **${c.name || c.email}**.\n${renderDraftLine(a)}`);
  return [a];
}

const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);

function logJob(s: Session, i: Extract<Intent, { type: "log_job" }>, out: string[]): MoneyAction[] {
  let w = findWorker(s, i.worker);
  if (!w && i.worker && i.workerEmail) w = upsertWorker(s, { name: i.worker, email: i.workerEmail }).worker;
  const pay = i.pay ?? workerPay(w, i.hours);
  const job: Job = {
    id: pp.newId("job"),
    title: i.title || `Job for ${i.customerName || "customer"}`,
    workerId: w?.id,
    customerName: i.customerName,
    customerEmail: i.customerEmail?.toLowerCase(),
    hours: i.hours,
    charge: i.charge,
    workerPay: pay,
    status: "logged",
    createdAt: Date.now(),
  };
  s.jobs.unshift(job);
  s.lastJobId = job.id;
  log(s, "job", `Logged “${job.title}”${w ? ` by ${w.name}` : ""}${job.customerName ? ` for ${job.customerName}` : ""}`, job.id);

  const plan: string[] = [`Logged **${job.title}**${w ? ` · ${w.name}` : ""}${job.customerName ? ` · customer ${job.customerName}` : ""}${job.hours ? ` · ${job.hours}h` : ""}.`];
  const created: MoneyAction[] = [];
  if (pay && w?.email) {
    created.push(draftPayout(s, { name: w.name, email: w.email, workerId: w.id }, pay, `Payment for ${job.title}`, job.id));
  } else if (!w) {
    plan.push(`I don't have ${i.worker || "that worker"} on your crew yet — onboard them with their PayPal email and I'll draft the payout.`);
  } else if (!pay) {
    plan.push(`How much should ${first(w.name)} get? Say “pay ${first(w.name)} $X”.`);
  }
  if (job.charge && job.customerEmail) {
    created.push(draftInvoice(s, { name: job.customerName, email: job.customerEmail }, job.charge, job.title, job.id));
  } else if (job.charge && !job.customerEmail) {
    created.push(draftPaymentLink(s, { name: job.customerName }, job.charge, job.title, job.id));
    plan.push(`No customer email, so I drafted a PayPal checkout link you can text them instead.`);
  }
  if (job.charge && pay) {
    const m = job.charge - pay;
    plan.push(`Margin on this job: **${$(m)}** (${Math.round((m / job.charge) * 100)}%).`);
  }
  if (created.length) plan.push(`Close-out plan — nothing moves until you approve:\n${created.map(renderDraftLine).join("\n")}`);
  out.push(plan.join("\n"));
  return created;
}

function draftPayroll(s: Session, out: string[]): MoneyAction | null {
  const paidJobIds = new Set<string>();
  for (const x of s.actions) {
    if (x.status !== "done") continue;
    if (x.kind === "payout" && x.jobId) paidJobIds.add(x.jobId);
    if (x.kind === "payroll") x.items?.forEach((i) => i.jobId && paidJobIds.add(i.jobId));
  }
  const unpaid = s.jobs.filter((j) => j.workerId && j.workerPay && !paidJobIds.has(j.id) && j.status !== "worker_paid" && j.status !== "closed");
  if (!unpaid.length) {
    out.push("Payroll is clear. Every logged job is already paid. Log a job and I'll queue it for the next batch.");
    return null;
  }
  // Fold any single pending payout drafts for these jobs into the batch.
  const folded = s.actions.filter((x) => x.kind === "payout" && (x.status === "pending" || x.status === "blocked") && x.jobId && unpaid.some((j) => j.id === x.jobId));
  for (const f of folded) {
    f.status = "canceled";
    log(s, "system", `Folded ${f.title} into payroll`, f.id);
  }
  const batchId = pp.newId("payroll");
  const items = unpaid.map((j) => {
    const w = s.workers.find((x) => x.id === j.workerId)!;
    return { workerId: w.id, name: w.name, email: w.email || "", amount: j.workerPay!, note: `Payment for ${j.title}`, jobId: j.id, senderItemId: pp.newId("jp") };
  });
  const total = Math.round(items.reduce((n, i) => n + i.amount, 0) * 100) / 100;
  const base = {
    kind: "payroll" as const,
    title: `Payroll · ${items.length} job${items.length > 1 ? "s" : ""}`,
    amount: total,
    counterparty: { name: [...new Set(items.map((i) => i.name.split(" ")[0]))].join(", ") },
    note: "One PayPal Payouts batch for all unpaid jobs",
    direction: "out" as const,
    items,
    request: { method: "POST", path: "/v1/payments/payouts", body: pp.buildBatchBody(batchId, items) },
  };
  const a = draft(s, base);
  a.idempotencyKey = batchId;
  out.push(
    [
      `Payroll ready: **${items.length} job${items.length > 1 ? "s" : ""}**, **${$(total)}**, sent as ONE PayPal Payouts batch${folded.length ? ` (folded in ${folded.length} single draft${folded.length > 1 ? "s" : ""})` : ""}.`,
      ...items.map((i) => `• ${i.name}: ${$(i.amount)} for ${i.note.replace("Payment for ", "")}`),
      renderDraftLine(a),
    ].join("\n")
  );
  return a;
}

function report(s: Session): string {
  const t = totals(s);
  const L = limits();
  const byWorker = new Map<string, number>();
  for (const a of s.actions.filter((x) => (x.kind === "payout" || x.kind === "payroll") && x.status === "done")) {
    const rows = a.items?.length ? a.items.map((i) => [i.name, i.amount] as const) : [[a.counterparty.name || a.counterparty.email!, a.amount] as const];
    for (const [n, v] of rows) byWorker.set(n, (byWorker.get(n) || 0) + v);
  }
  const jobs = s.jobs.filter((j) => j.charge && j.workerPay);
  const avgMargin = jobs.length ? jobs.reduce((n, j) => n + (j.charge! - j.workerPay!) / j.charge!, 0) / jobs.length : undefined;
  const open = s.actions.filter((a) => a.status === "done" && a.direction === "in" && !/PAID|COMPLETED/.test(a.paypalStatus || ""));
  return [
    `**Books so far**`,
    `• Paid out to crew: ${$(t.paidOut)} (${$(t.paidToday)} today, ${$(Math.max(0, L.dailyPayoutCap - t.paidToday))} left under the daily cap)`,
    `• Billed to customers: ${$(t.billed)} · collected ${$(t.collected)}`,
    `• Gross margin: ${$(t.grossMargin)}${avgMargin !== undefined ? ` · avg job margin ${Math.round(avgMargin * 100)}%` : ""}`,
    byWorker.size ? `• Top earners: ${[...byWorker].sort((a, b) => b[1] - a[1]).map(([n, v]) => `${n} ${$(v)}`).join(", ")}` : "",
    open.length ? `• Waiting on customers: ${open.map((a) => `${a.counterparty.name || a.counterparty.email} ${$(a.amount)}`).join(", ")}` : "",
    t.pending ? `• ${t.pending} draft(s) waiting for your approval` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function team(s: Session): string {
  if (!s.workers.length) return "No crew yet. Try “Onboard Maria Lopez, plumber, maria.lopez@example.com, $45/hr” — or say **load demo crew**.";
  return [
    `**Your crew (${s.workers.length})**`,
    ...s.workers.map((w) => `• ${w.name}${w.trade ? ` — ${w.trade}` : ""}${w.rate ? `, ${$(w.rate)}/${w.rateUnit === "job" ? "job" : "hr"}` : ""} · ${w.email}`),
  ].join("\n");
}

export const HELP = [
  "I run the money side of a home-service crew on PayPal. Try:",
  "• **Onboard** — “Onboard Maria Lopez, plumber, maria.lopez@example.com, $45/hr”",
  "• **Close out a job** — “Maria finished the gutter job for Bob Smith bob.smith@example.com, 3 hours, charge $240”",
  "• **Pay** — “Pay Dev $60 for the fence repair”, or **“Run payroll”** to pay every unpaid job in one PayPal batch",
  "• **Bill** — “Invoice Ana $180 for tile work at ana.ruiz@example.com” or “Send a payment link to Ana for $99”",
  "• **Track** — “status”, “show my books”, “who's on my crew”",
  "Every payment is a draft until you hit **Confirm**. Policy limits and a sandbox lock are always on.",
].join("\n");

function seedDemo(s: Session): string {
  const crew = [
    { name: "Maria Lopez", email: "maria.lopez@example.com", trade: "plumber", rate: 45, rateUnit: "hr" as const },
    { name: "Dev Patel", email: "dev.patel@example.com", trade: "handyman", rate: 60, rateUnit: "job" as const },
    { name: "Keisha Brown", email: "keisha.brown@example.com", trade: "house cleaner", rate: 30, rateUnit: "hr" as const },
  ];
  for (const w of crew) upsertWorker(s, w);
  log(s, "worker", "Loaded demo crew (3 workers)");
  return `${team(s)}\n\nNow try: “Maria finished the water heater repair for Bob Smith bob.smith@example.com, 3 hours, charge $240”.`;
}

/** Merge a follow-up answer into a pending, half-filled intent. */
function fill(s: Session, i: Intent): Intent | null {
  const aw = s.awaiting;
  if (!aw) return null;
  if (i.type !== "provide" && i.type !== "unknown") return null;
  const p = i.type === "provide" ? i : { email: undefined, amount: undefined, name: undefined, text: i.text };
  const prev = { ...aw.intent };
  if (p.email) {
    if ("email" in prev || prev.type === "pay" || prev.type === "onboard") prev.email = p.email;
    if (prev.type === "invoice" || prev.type === "payment_link") prev.customerEmail = p.email;
  }
  if (p.amount) prev.amount = p.amount;
  if (p.name && !prev.name && prev.type === "onboard") prev.name = p.name;
  if (aw.missing.includes("name") && !prev.name && i.type === "unknown") prev.name = p.text.trim();
  s.awaiting = null;
  return prev;
}

// ---------------------------------------------------------------- main loop

export async function handleMessage(s: Session, text: string): Promise<AgentReply> {
  const trace: TraceStep[] = [];
  const out: string[] = [];
  const actionIds: string[] = [];
  const ctx = { workerNames: s.workers.map((w) => w.name) };

  let planner: "llm" | "offline" = "offline";
  let intents: Intent[] | null = null;
  if (llmEnabled()) {
    intents = await timed(trace, "llm.plan", { text }, () => llmPlan(text, s)).catch(() => null);
    if (intents?.length) planner = "llm";
  }
  if (!intents?.length) intents = await timed(trace, "nlu.parse", { text }, () => parse(text, ctx));

  for (let intent of intents) {
    const filled = fill(s, intent);
    if (filled) intent = filled;
    else if (intent.type !== "provide" && intent.type !== "unknown") s.awaiting = null;

    switch (intent.type) {
      case "onboard":
        out.push(onboard(s, intent));
        break;
      case "pay":
        actionIds.push(...pay(s, intent, out).map((a) => a.id));
        break;
      case "invoice":
      case "payment_link":
        actionIds.push(...bill(s, intent, out).map((a) => a.id));
        break;
      case "log_job":
        actionIds.push(...logJob(s, intent, out).map((a) => a.id));
        break;
      case "payroll": {
        const a = draftPayroll(s, out);
        if (a) actionIds.push(a.id);
        break;
      }
      case "capture": {
        const src = intent.orderId
          ? s.actions.find((a) => a.paypalId === intent.orderId)
          : s.actions.find((a) => a.status === "done" && a.paypalApi === "orders" && a.kind !== "capture");
        const orderId = intent.orderId || src?.paypalId;
        const a = draft(s, {
          kind: "capture",
          title: `Capture order ${orderId || "?"}`,
          amount: src?.amount || 0,
          counterparty: src?.counterparty || {},
          note: src?.note || "Capture approved order",
          direction: "in",
          jobId: src?.jobId,
          orderId,
          request: { method: "POST", path: `/v2/checkout/orders/${orderId}/capture` },
        });
        actionIds.push(a.id);
        out.push(`Drafted a capture for order ${orderId || "—"}. The customer must approve the checkout link first.\n${renderDraftLine(a)}`);
        break;
      }
      case "confirm": {
        const pending = s.actions.filter((a) => a.status === "pending");
        if (!pending.length) {
          out.push("Nothing is waiting for approval right now.");
          break;
        }
        const targets = intent.all ? pending : [pending[0]!];
        for (const a of targets) {
          await confirmAction(s, a.id, trace);
          actionIds.push(a.id);
          out.push(executedLine(a));
        }
        const left = s.actions.filter((a) => a.status === "pending").length;
        if (left) out.push(`${left} more draft(s) waiting — say **confirm all** or use the cards.`);
        break;
      }
      case "cancel": {
        const pending = s.actions.filter((a) => a.status === "pending" || a.status === "blocked");
        if (!pending.length) {
          out.push("Nothing to cancel.");
          break;
        }
        for (const a of intent.all ? pending : [pending[0]!]) {
          cancelAction(s, a.id);
          actionIds.push(a.id);
          out.push(`Canceled **${a.title}** (${$(a.amount)}). No money moved.`);
        }
        break;
      }
      case "status": {
        const done = await refreshStatuses(s, trace, intent.ref);
        out.push(
          done.length
            ? `**Live PayPal status**\n${done.map((a) => `• ${a.title} ${$(a.amount)} — ${a.paypalStatus} (${a.paypalId})`).join("\n")}`
            : "Nothing has been sent to PayPal yet."
        );
        break;
      }
      case "report":
        out.push(report(s));
        break;
      case "team":
        out.push(team(s));
        break;
      case "demo":
        out.push(seedDemo(s));
        break;
      case "help":
        out.push(HELP);
        break;
      default:
        out.push(s.workers.length ? `I didn't catch a task in that.\n\n${HELP}` : HELP);
    }
  }

  return { reply: out.join("\n\n"), actionIds: [...new Set(actionIds)], trace, planner };
}

export function executedLine(a: MoneyAction): string {
  if (a.status === "done") {
    const mode = a.dryRun ? " (dry-run)" : " in the PayPal sandbox";
    const what =
      a.kind === "payroll"
        ? `Payroll sent${mode}: ${a.items?.length} workers, ${$(a.amount)} in one batch · ${a.paypalId} · ${a.paypalStatus}`
        : a.kind === "payout"
        ? `Paid ${a.counterparty.name || a.counterparty.email} ${$(a.amount)}${mode} · batch ${a.paypalId} · ${a.paypalStatus}`
        : a.kind === "capture"
          ? `Captured ${$(a.amount)}${mode} · ${a.paypalStatus}`
          : `Billed ${a.counterparty.name || a.counterparty.email || "customer"} ${$(a.amount)}${mode} · ${a.paypalId}`;
    return `✅ ${what}${a.link ? `\nCheckout link: ${a.link}` : ""}${a.fallback ? `\n↪ ${a.fallback}` : ""}`;
  }
  if (a.status === "blocked") return `⛔ ${a.title} is blocked: ${a.checks.filter((c) => c.level === "fail").map((c) => c.label).join("; ")}`;
  return `❌ ${a.title} failed: ${a.error}`;
}
