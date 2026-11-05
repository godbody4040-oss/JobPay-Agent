/** Spend policy engine: every draft is checked before a human can approve it. */
import type { MoneyAction, PolicyCheck, Session } from "./ledger.ts";
import { totals, findWorker } from "./ledger.ts";
import { hasCredentials, paypalMode } from "./paypal.ts";

export const limits = () => ({
  maxPayout: Number(process.env.JOBPAY_MAX_PAYOUT || 500),
  dailyPayoutCap: Number(process.env.JOBPAY_DAILY_CAP || 2000),
  maxInvoice: Number(process.env.JOBPAY_MAX_INVOICE || 10000),
});

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function evaluate(s: Session, a: Omit<MoneyAction, "checks" | "status">): PolicyCheck[] {
  const L = limits();
  const checks: PolicyCheck[] = [];
  checks.push(
    paypalMode() === "sandbox"
      ? { id: "sandbox", label: hasCredentials() ? "PayPal sandbox lock" : "Dry-run (no credentials)", level: "pass" }
      : { id: "sandbox", label: "Live mode is disabled in this build", level: "fail" }
  );

  if (a.kind !== "capture") {
    checks.push(
      a.counterparty.email && EMAIL.test(a.counterparty.email)
        ? { id: "email", label: "Valid PayPal email", level: "pass", detail: a.counterparty.email }
        : { id: "email", label: "Recipient email missing or invalid", level: "fail" }
    );
  }
  if (!(a.amount > 0)) checks.push({ id: "amount", label: "Amount must be positive", level: "fail" });

  if (a.kind === "payout") {
    const t = totals(s);
    checks.push(
      a.amount <= L.maxPayout
        ? { id: "cap", label: `Under per-payout cap ($${L.maxPayout})`, level: "pass" }
        : { id: "cap", label: `Over per-payout cap ($${L.maxPayout})`, level: "fail", detail: "Raise JOBPAY_MAX_PAYOUT or split the payment." }
    );
    checks.push(
      t.paidToday + a.amount <= L.dailyPayoutCap
        ? { id: "daily", label: `Within daily cap ($${(L.dailyPayoutCap - t.paidToday).toFixed(0)} left)`, level: "pass" }
        : { id: "daily", label: `Exceeds daily payout cap ($${L.dailyPayoutCap})`, level: "fail" }
    );
    const w = a.workerId ? s.workers.find((x) => x.id === a.workerId) : findWorker(s, a.counterparty.email);
    checks.push(
      w
        ? { id: "kyc", label: `${w.name} is on your crew`, level: "pass" }
        : { id: "kyc", label: "Recipient not onboarded to your crew", level: "warn", detail: "Onboard them first for a clean audit trail." }
    );
    const dup = s.actions.find(
      (x) =>
        x.kind === "payout" &&
        (x.status === "done" || x.status === "pending") &&
        x.counterparty.email === a.counterparty.email &&
        Math.abs(x.amount - a.amount) < 0.005 &&
        (a.jobId ? x.jobId === a.jobId : Date.now() - x.createdAt < 86_400_000)
    );
    if (dup) checks.push({ id: "dup", label: "Possible duplicate payment", level: a.jobId && dup.jobId === a.jobId ? "fail" : "warn", detail: `Matches ${dup.status} payout ${dup.id}` });
    const job = a.jobId ? s.jobs.find((j) => j.id === a.jobId) : undefined;
    if (job?.charge !== undefined) {
      const margin = job.charge - a.amount;
      checks.push(
        margin >= 0
          ? { id: "margin", label: `Job margin $${margin.toFixed(2)} (${Math.round((margin / job.charge) * 100)}%)`, level: "pass" }
          : { id: "margin", label: `Paying $${(-margin).toFixed(2)} more than you billed`, level: "warn" }
      );
    }
  }

  if (a.kind === "invoice" || a.kind === "payment_link") {
    checks.push(
      a.amount <= L.maxInvoice
        ? { id: "cap", label: `Under invoice cap ($${L.maxInvoice})`, level: "pass" }
        : { id: "cap", label: `Over invoice cap ($${L.maxInvoice})`, level: "fail" }
    );
    const dup = a.jobId && s.actions.find((x) => (x.kind === "invoice" || x.kind === "payment_link") && x.jobId === a.jobId && (x.status === "done" || x.status === "pending"));
    if (dup) checks.push({ id: "dup", label: "This job already has a bill", level: "warn", detail: dup.id });
  }

  if (a.kind === "capture") {
    checks.push(a.orderId ? { id: "order", label: `Order ${a.orderId}`, level: "pass" } : { id: "order", label: "No order to capture", level: "fail" });
  }
  return checks;
}

export const isBlocked = (checks: PolicyCheck[]) => checks.some((c) => c.level === "fail");
