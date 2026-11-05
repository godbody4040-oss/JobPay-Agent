/**
 * PayPal REST client for JobPay Agent (sandbox-only by design).
 *
 * APIs used:
 *  - OAuth 2.0 client credentials   POST /v1/oauth2/token
 *  - Payouts v1                       POST /v1/payments/payouts, GET /v1/payments/payouts/{id}
 *  - Invoicing v2                     POST /v2/invoicing/invoices, POST .../{id}/send, GET .../{id}
 *  - Orders v2 (Checkout)             POST /v2/checkout/orders, GET /v2/checkout/orders/{id},
 *                                     POST /v2/checkout/orders/{id}/capture
 *
 * Every money-moving call (payout, invoice send, order capture) requires an explicit
 * `confirmed: true` flag that only the human-confirm gate in agent.ts can set.
 * Without credentials every call returns a realistic DRY-RUN result with the exact request body.
 */

const SANDBOX_BASE = "https://api-m.sandbox.paypal.com";

export type PayPalMode = "sandbox" | "live";

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  mode: PayPalMode;
}

export interface ApiCall {
  method: string;
  path: string;
  body?: unknown;
  requestId?: string;
}

export interface ApiResult<T = any> {
  dryRun: boolean;
  call: ApiCall;
  data: T;
}

export function hasCredentials(): boolean {
  return Boolean(process.env.PAYPAL_CLIENT_ID?.trim() && process.env.PAYPAL_CLIENT_SECRET?.trim());
}

export function paypalMode(): PayPalMode {
  return (process.env.PAYPAL_MODE || "sandbox").toLowerCase() === "live" ? "live" : "sandbox";
}

export function getConfig(): PayPalConfig | null {
  if (!hasCredentials()) return null;
  return {
    clientId: process.env.PAYPAL_CLIENT_ID!.trim(),
    clientSecret: process.env.PAYPAL_CLIENT_SECRET!.trim(),
    mode: paypalMode(),
  };
}

/** Safety: this project never talks to live PayPal. */
function assertSandbox(config: PayPalConfig) {
  if (config.mode !== "sandbox") {
    throw new Error("Safety lock: JobPay Agent only runs against the PayPal sandbox (set PAYPAL_MODE=sandbox).");
  }
}

let cachedToken: { accessToken: string; expiresAt: number } | null = null;

export async function getAccessToken(config: PayPalConfig): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 30_000) return cachedToken.accessToken;
  const auth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  const res = await fetch(`${SANDBOX_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PayPal OAuth failed (${res.status})`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.accessToken;
}

export class PayPalApiError extends Error {
  constructor(public status: number, public details: unknown, message: string) {
    super(message);
  }
}

function summarizeError(raw: any): string {
  if (!raw || typeof raw !== "object") return String(raw);
  const parts = [raw.name, raw.message].filter(Boolean);
  const d = Array.isArray(raw.details) ? raw.details[0] : null;
  if (d) parts.push([d.field, d.issue, d.description].filter(Boolean).join(" "));
  return parts.join(" — ") || JSON.stringify(raw).slice(0, 300);
}

/** Low-level request with idempotency + sandbox lock. Returns DRY-RUN when no credentials. */
export async function paypalRequest<T = any>(
  call: ApiCall,
  dryRunData: () => T
): Promise<ApiResult<T>> {
  const config = getConfig();
  if (!config) return { dryRun: true, call, data: dryRunData() };
  assertSandbox(config);
  const token = await getAccessToken(config);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
  if (call.requestId) headers["PayPal-Request-Id"] = call.requestId;
  const res = await fetch(`${SANDBOX_BASE}${call.path}`, {
    method: call.method,
    headers,
    body: call.body === undefined ? undefined : JSON.stringify(call.body),
  });
  const text = await res.text();
  let raw: any = {};
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    raw = { text };
  }
  if (!res.ok) {
    throw new PayPalApiError(res.status, raw, `PayPal ${call.method} ${call.path} failed (${res.status}): ${summarizeError(raw)}`);
  }
  return { dryRun: false, call, data: raw as T };
}

// ---------- ids ----------
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}
const fakeId = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 12).toUpperCase()}`;
export const money = (n: number) => n.toFixed(2);

// ---------- Payouts ----------
export interface PayoutInput {
  recipientEmail: string;
  amount: number;
  currency?: string;
  note: string;
  senderItemId: string;
}

export function buildPayoutBody(p: PayoutInput) {
  return {
    sender_batch_header: {
      sender_batch_id: `jobpay_${p.senderItemId}`,
      email_subject: "You've been paid via JobPay Agent",
      email_message: p.note,
    },
    items: [
      {
        recipient_type: "EMAIL",
        amount: { value: money(p.amount), currency: p.currency || "USD" },
        note: p.note,
        sender_item_id: p.senderItemId,
        receiver: p.recipientEmail,
      },
    ],
  };
}

export async function createPayout(p: PayoutInput, opts: { confirmed: boolean }) {
  if (!opts.confirmed) throw new Error("Refusing to move money: payout requires human confirmation.");
  return paypalRequest(
    { method: "POST", path: "/v1/payments/payouts", body: buildPayoutBody(p), requestId: p.senderItemId },
    () => ({ batch_header: { payout_batch_id: fakeId("DRY"), batch_status: "PENDING" } })
  );
}

export async function getPayout(batchId: string) {
  return paypalRequest(
    { method: "GET", path: `/v1/payments/payouts/${encodeURIComponent(batchId)}` },
    () => ({ batch_header: { payout_batch_id: batchId, batch_status: "SUCCESS" }, items: [] })
  );
}

// ---------- Invoicing v2 ----------
export interface InvoiceInput {
  customerName?: string;
  customerEmail: string;
  description: string;
  amount: number;
  currency?: string;
  note?: string;
  dueInDays?: number;
  reference: string;
}

export function buildInvoiceBody(i: InvoiceInput) {
  const [given, ...rest] = (i.customerName || "").trim().split(/\s+/);
  const due = new Date(Date.now() + (i.dueInDays ?? 14) * 86_400_000).toISOString().slice(0, 10);
  return {
    detail: {
      currency_code: i.currency || "USD",
      reference: i.reference,
      note: i.note || "Thanks for your business — powered by JobPay Agent.",
      payment_term: { term_type: "DUE_ON_DATE_SPECIFIED", due_date: due },
    },
    primary_recipients: [
      {
        billing_info: {
          ...(given ? { name: { given_name: given, surname: rest.join(" ") || undefined } } : {}),
          email_address: i.customerEmail,
        },
      },
    ],
    items: [
      {
        name: i.description.slice(0, 200),
        quantity: "1",
        unit_amount: { currency_code: i.currency || "USD", value: money(i.amount) },
        unit_of_measure: "AMOUNT",
      },
    ],
  };
}

export async function createInvoice(i: InvoiceInput) {
  const body = buildInvoiceBody(i);
  return paypalRequest(
    { method: "POST", path: "/v2/invoicing/invoices", body, requestId: i.reference },
    () => ({ id: fakeId("INV2-DRY"), status: "DRAFT", detail: { invoice_number: "DRY-0001" } })
  );
}

export async function sendInvoice(invoiceId: string, opts: { confirmed: boolean; requestId: string }) {
  if (!opts.confirmed) throw new Error("Refusing to bill a customer: invoice send requires human confirmation.");
  return paypalRequest(
    {
      method: "POST",
      path: `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/send`,
      body: { send_to_invoicer: true, send_to_recipient: true },
      requestId: opts.requestId,
    },
    () => ({ href: `https://www.sandbox.paypal.com/invoice/p/#${invoiceId}` })
  );
}

export async function getInvoice(invoiceId: string) {
  return paypalRequest(
    { method: "GET", path: `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}` },
    () => ({ id: invoiceId, status: "SENT" })
  );
}

// ---------- Orders v2 (Checkout / payment link) ----------
export interface OrderInput {
  amount: number;
  currency?: string;
  description: string;
  reference: string;
}

export function buildOrderBody(o: OrderInput) {
  return {
    intent: "CAPTURE",
    purchase_units: [
      {
        reference_id: o.reference.slice(0, 256),
        description: o.description.slice(0, 127),
        amount: { currency_code: o.currency || "USD", value: money(o.amount) },
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: "JobPay Agent",
          user_action: "PAY_NOW",
          shipping_preference: "NO_SHIPPING",
          return_url: `${process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`}/?paid=1`,
          cancel_url: `${process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`}/?canceled=1`,
        },
      },
    },
  };
}

export async function createOrder(o: OrderInput) {
  return paypalRequest(
    { method: "POST", path: "/v2/checkout/orders", body: buildOrderBody(o), requestId: o.reference },
    () => {
      const id = fakeId("DRYORDER");
      return {
        id,
        status: "PAYER_ACTION_REQUIRED",
        links: [{ rel: "payer-action", href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}`, method: "GET" }],
      };
    }
  );
}

export async function getOrder(orderId: string) {
  return paypalRequest(
    { method: "GET", path: `/v2/checkout/orders/${encodeURIComponent(orderId)}` },
    () => ({ id: orderId, status: "APPROVED" })
  );
}

export async function captureOrder(orderId: string, opts: { confirmed: boolean; requestId: string }) {
  if (!opts.confirmed) throw new Error("Refusing to capture funds: capture requires human confirmation.");
  return paypalRequest(
    { method: "POST", path: `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, body: {}, requestId: opts.requestId },
    () => ({ id: orderId, status: "COMPLETED" })
  );
}

export function approveLink(order: any): string | undefined {
  return order?.links?.find((l: any) => l.rel === "payer-action" || l.rel === "approve")?.href;
}
