import { beforeAll, describe, expect, test } from "bun:test";
import { parse } from "../src/nlu.ts";
import { handleMessage, confirmAction, cancelAction } from "../src/agent.ts";
import { newSession } from "../src/ledger.ts";
import * as pp from "../src/paypal.ts";

beforeAll(() => {
  // Tests never touch PayPal: force dry-run regardless of local .env
  delete process.env.PAYPAL_CLIENT_ID;
  delete process.env.PAYPAL_CLIENT_SECRET;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  process.env.PAYPAL_MODE = "sandbox";
});

const ctx = { workerNames: ["Maria Lopez", "Dev Patel"] };

describe("offline planner", () => {
  test("onboard with trade + hourly rate", () => {
    expect(parse("Onboard Maria Lopez, plumber, maria.lopez@example.com, $45/hr", ctx)[0]).toMatchObject({
      type: "onboard", name: "Maria Lopez", email: "maria.lopez@example.com", trade: "plumber", rate: 45, rateUnit: "hr",
    });
  });
  test("job close-out extracts worker, customer, charge and pay", () => {
    expect(parse("Maria finished the gutter cleaning job for Bob Smith (bob.smith@example.com) — charge $240, pay Maria $150", ctx)[0]).toMatchObject({
      type: "log_job", worker: "Maria Lopez", customerName: "Bob Smith", customerEmail: "bob.smith@example.com", charge: 240, pay: 150,
    });
  });
  test("hours-based job", () => {
    expect(parse("Maria fixed a leaky faucet for Ana Ruiz ana@example.com, 3 hours, bill $210", ctx)[0]).toMatchObject({ type: "log_job", hours: 3, charge: 210 });
  });
  test("compound instruction splits into two intents", () => {
    const r = parse("pay Maria $80 then invoice Ana $120 for tile work", ctx);
    expect(r.map((i) => i.type)).toEqual(["pay", "invoice"]);
  });
  test("thousands separators", () => {
    expect(parse("Invoice Bob $1,250.50 at bob@example.com", ctx)[0]).toMatchObject({ amount: 1250.5 });
  });
  test("confirm all / cancel", () => {
    expect(parse("confirm all", ctx)[0]).toEqual({ type: "confirm", all: true });
    expect(parse("cancel", ctx)[0]).toMatchObject({ type: "cancel" });
  });
});

describe("agentic workflow (dry-run)", () => {
  test("onboard → close out job → policy-checked drafts → confirm all → books", async () => {
    const s = newSession("t1");
    await handleMessage(s, "Onboard Maria Lopez, plumber, maria.lopez@example.com, $45/hr");
    expect(s.workers).toHaveLength(1);

    const r = await handleMessage(s, "Maria finished the water heater repair for Bob Smith bob.smith@example.com, 3 hours, charge $240");
    expect(s.jobs).toHaveLength(1);
    expect(r.actionIds).toHaveLength(2);
    const payout = s.actions.find((a) => a.kind === "payout")!;
    expect(payout.amount).toBe(135); // 3h × $45
    expect(payout.status).toBe("pending");
    expect(payout.checks.find((c) => c.id === "margin")?.level).toBe("pass");
    // nothing has moved yet
    expect(s.actions.every((a) => !a.paypalId)).toBe(true);

    await handleMessage(s, "confirm all");
    expect(s.actions.every((a) => a.status === "done" && a.dryRun)).toBe(true);
    expect(s.jobs[0]!.status).toBe("closed");

    const rep = await handleMessage(s, "show my books");
    expect(rep.reply).toContain("$135.00");
    expect(rep.reply).toContain("$240.00");
  });

  test("slot filling across turns", async () => {
    const s = newSession("t2");
    const a = await handleMessage(s, "Pay Jane $50 for the lawn job");
    expect(a.reply).toMatch(/PayPal email/);
    const b = await handleMessage(s, "jane@example.com");
    expect(b.actionIds).toHaveLength(1);
    expect(s.actions[0]).toMatchObject({ kind: "payout", amount: 50, counterparty: { email: "jane@example.com" } });
  });

  test("policy blocks over-cap payouts and confirm can't bypass it", async () => {
    const s = newSession("t3");
    await handleMessage(s, "Pay Jane $5000 at jane@example.com");
    const a = s.actions[0]!;
    expect(a.status).toBe("blocked");
    await expect(confirmAction(s, a.id)).rejects.toThrow();
    expect(a.paypalId).toBeUndefined();
  });

  test("duplicate payout for same job is blocked", async () => {
    const s = newSession("t4");
    await handleMessage(s, "Onboard Dev Patel, handyman, dev@example.com, $60 per job");
    await handleMessage(s, "Dev finished the fence repair for Ana ana@example.com, charge $150");
    const first = s.actions.find((a) => a.kind === "payout")!;
    await confirmAction(s, first.id);
    const s2 = await handleMessage(s, "Pay Dev $60");
    expect(s2.actionIds).toHaveLength(1);
    const again = s.actions.find((a) => a.id === s2.actionIds[0])!;
    expect(again.status).toBe("blocked");
    expect(again.checks.find((c) => c.id === "dup")?.level).toBe("fail");
  });

  test("cancel discards a draft without calling PayPal", async () => {
    const s = newSession("t5");
    await handleMessage(s, "Invoice Bob $90 for mowing at bob@example.com");
    const a = cancelAction(s, s.actions[0]!.id);
    expect(a.status).toBe("canceled");
    expect(a.paypalId).toBeUndefined();
  });
});

describe("payroll batch", () => {
  test("folds unpaid jobs into ONE multi-item Payouts batch and blocks double pay", async () => {
    const s = newSession("t6");
    await handleMessage(s, "load demo crew");
    await handleMessage(s, "Maria finished the faucet repair for Bob bob@example.com, 2 hours, charge $200");
    await handleMessage(s, "Dev finished the fence repair for Ana ana@example.com, charge $150");
    const r = await handleMessage(s, "run payroll");
    const batch = s.actions.find((a) => a.id === r.actionIds[0])!;
    expect(batch.kind).toBe("payroll");
    expect(batch.items).toHaveLength(2);
    expect(batch.amount).toBe(150); // 2h×$45 + $60/job
    expect((batch.request.body as any).items).toHaveLength(2);
    // single payout drafts for those jobs were folded in
    expect(s.actions.filter((a) => a.kind === "payout" && a.status === "pending")).toHaveLength(0);
    await confirmAction(s, batch.id);
    expect(batch.status).toBe("done");
    expect(s.jobs.every((j) => j.status === "worker_paid")).toBe(true);
    const again = await handleMessage(s, "run payroll");
    expect(again.actionIds).toHaveLength(0);
    expect(again.reply).toMatch(/clear/);
  });
});

describe("PayPal safety", () => {
  test("money-moving helpers refuse without confirmation", async () => {
    await expect(pp.createPayout({ recipientEmail: "a@b.co", amount: 1, note: "x", senderItemId: "x" }, { confirmed: false })).rejects.toThrow();
    await expect(pp.sendInvoice("INV", { confirmed: false, requestId: "x" })).rejects.toThrow();
    await expect(pp.captureOrder("O", { confirmed: false, requestId: "x" })).rejects.toThrow();
    await expect(pp.createPayoutBatch("b", [], { confirmed: false })).rejects.toThrow();
  });
  test("request bodies match PayPal schemas", () => {
    const b = pp.buildPayoutBody({ recipientEmail: "a@b.co", amount: 12.5, note: "n", senderItemId: "s1" });
    expect(b.items[0]!.amount).toEqual({ value: "12.50", currency: "USD" });
    const o = pp.buildOrderBody({ amount: 99, description: "d", reference: "r" });
    expect(o.intent).toBe("CAPTURE");
    const i = pp.buildInvoiceBody({ customerEmail: "c@d.co", customerName: "Bob Smith", amount: 10, description: "x", reference: "r" });
    expect(i.primary_recipients[0]!.billing_info.email_address).toBe("c@d.co");
  });
});

describe("public demo lock", () => {
  test("JOBPAY_FORCE_DRY_RUN ignores credentials", () => {
    process.env.PAYPAL_CLIENT_ID = "x";
    process.env.PAYPAL_CLIENT_SECRET = "y";
    process.env.JOBPAY_FORCE_DRY_RUN = "true";
    expect(pp.hasCredentials()).toBe(false);
    expect(pp.getConfig()).toBeNull();
    delete process.env.PAYPAL_CLIENT_ID;
    delete process.env.PAYPAL_CLIENT_SECRET;
    delete process.env.JOBPAY_FORCE_DRY_RUN;
  });
});

describe("grounding guard (LLM output)", () => {
  test("drops invented customer, email, hours; keeps grounded fields", async () => {
    const { ground, wordNumbers } = await import("../src/ground.ts");
    const s = newSession("g1");
    s.workers.push({ id: "w1", name: "Dev Patel", email: "dev.patel@example.com", rate: 60, rateUnit: "job", createdAt: 0 });
    const g = ground(
      { type: "log_job", worker: "Dev Patel", customerName: "John Doe", customerEmail: "john.doe@example.com", hours: 2, charge: 60 },
      "Dev finished the fence repair, charge $60",
      s
    );
    expect(g.intent).toMatchObject({ type: "log_job", worker: "Dev Patel", charge: 60 });
    expect((g.intent as any).customerName).toBeUndefined();
    expect((g.intent as any).customerEmail).toBeUndefined();
    expect((g.intent as any).hours).toBeUndefined();
    expect(wordNumbers("two hundred forty dollars")).toContain(240);
  });
  test("customer 'paying' is the charge, not worker pay", () => {
    expect(parse("Maria wrapped up at the Johnsons, 2.5 hrs on a clogged drain; they're paying $175 (johnson@example.com)", ctx)[0]).toMatchObject({ charge: 175 });
  });
});
