/** In-memory business ledger for one session (workers, jobs, money actions, activity). */
import { newId } from "./paypal.ts";

export interface Worker {
  id: string;
  name: string;
  email?: string;
  trade?: string;
  rate?: number;
  rateUnit?: "hr" | "job";
  createdAt: number;
}

export interface Job {
  id: string;
  title: string;
  workerId?: string;
  customerName?: string;
  customerEmail?: string;
  hours?: number;
  charge?: number;
  workerPay?: number;
  status: "logged" | "worker_paid" | "billed" | "closed";
  createdAt: number;
}

export type ActionKind = "payout" | "invoice" | "payment_link" | "capture";
export type ActionStatus = "pending" | "blocked" | "executing" | "done" | "canceled" | "failed";

export interface PolicyCheck {
  id: string;
  label: string;
  level: "pass" | "warn" | "fail";
  detail?: string;
}

export interface MoneyAction {
  id: string;
  kind: ActionKind;
  status: ActionStatus;
  title: string;
  amount: number;
  currency: string;
  counterparty: { name?: string; email?: string };
  note: string;
  direction: "out" | "in";
  jobId?: string;
  workerId?: string;
  orderId?: string; // for capture
  checks: PolicyCheck[];
  request: { method: string; path: string; body?: unknown };
  idempotencyKey: string;
  paypalApi?: "payouts" | "invoicing" | "orders";
  paypalId?: string;
  paypalStatus?: string;
  link?: string;
  dryRun?: boolean;
  fallback?: string;
  error?: string;
  createdAt: number;
  executedAt?: number;
}

export interface Activity {
  id: string;
  ts: number;
  kind: "worker" | "job" | "payout" | "invoice" | "payment_link" | "capture" | "policy" | "system";
  text: string;
  ref?: string;
}

export interface TraceStep {
  tool: string;
  input?: unknown;
  output?: unknown;
  ms?: number;
  ok: boolean;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  ts: number;
  actionIds?: string[];
  trace?: TraceStep[];
}

export interface Session {
  id: string;
  messages: ChatMessage[];
  workers: Worker[];
  jobs: Job[];
  actions: MoneyAction[];
  activity: Activity[];
  awaiting: { intent: any; missing: string[] } | null;
  lastJobId?: string;
  lastWorkerId?: string;
}

const sessions = new Map<string, Session>();

export function newSession(id: string): Session {
  return { id, messages: [], workers: [], jobs: [], actions: [], activity: [], awaiting: null };
}

export function getSession(id: string): Session {
  let s = sessions.get(id);
  if (!s) {
    s = newSession(id);
    sessions.set(id, s);
  }
  return s;
}

export function resetSession(id: string): Session {
  const s = newSession(id);
  sessions.set(id, s);
  return s;
}

export function log(s: Session, kind: Activity["kind"], text: string, ref?: string) {
  s.activity.unshift({ id: newId("act"), ts: Date.now(), kind, text, ref });
  if (s.activity.length > 200) s.activity.length = 200;
}

export function findWorker(s: Session, nameOrEmail?: string): Worker | undefined {
  if (!nameOrEmail) return undefined;
  const q = nameOrEmail.trim().toLowerCase();
  return (
    s.workers.find((w) => w.email?.toLowerCase() === q) ||
    s.workers.find((w) => w.name.toLowerCase() === q) ||
    s.workers.find((w) => w.name.toLowerCase().split(/\s+/)[0] === q.split(/\s+/)[0])
  );
}

export function upsertWorker(s: Session, w: Omit<Worker, "id" | "createdAt">): { worker: Worker; created: boolean } {
  const existing = findWorker(s, w.email) || findWorker(s, w.name);
  if (existing) {
    Object.assign(existing, Object.fromEntries(Object.entries(w).filter(([, v]) => v !== undefined)));
    return { worker: existing, created: false };
  }
  const worker: Worker = { id: newId("wkr"), createdAt: Date.now(), ...w };
  s.workers.push(worker);
  return { worker, created: true };
}

export function totals(s: Session) {
  const done = s.actions.filter((a) => a.status === "done");
  const sum = (xs: MoneyAction[]) => xs.reduce((n, a) => n + a.amount, 0);
  const paidOut = sum(done.filter((a) => a.kind === "payout"));
  const billed = sum(done.filter((a) => a.kind === "invoice" || a.kind === "payment_link"));
  const collected = sum(done.filter((a) => a.kind === "capture"));
  const today = new Date().toDateString();
  const paidToday = sum(done.filter((a) => a.kind === "payout" && new Date(a.executedAt || 0).toDateString() === today));
  const pending = s.actions.filter((a) => a.status === "pending").length;
  const blocked = s.actions.filter((a) => a.status === "blocked").length;
  return { paidOut, billed, collected, paidToday, pending, blocked, grossMargin: billed - paidOut };
}

/** Public, JSON-safe snapshot for the UI. */
export function snapshot(s: Session) {
  return {
    workers: s.workers,
    jobs: s.jobs,
    actions: s.actions,
    activity: s.activity.slice(0, 60),
    totals: totals(s),
    awaiting: s.awaiting ? { missing: s.awaiting.missing } : null,
  };
}
