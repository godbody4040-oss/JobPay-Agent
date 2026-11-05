/**
 * Tool manifest. Names for the PayPal tools mirror the official PayPal Agent Toolkit
 * (create_invoice, send_invoice, get_invoice, create_order, get_order, capture_order) so the
 * same plan can be routed to @paypal/agent-toolkit or the PayPal MCP server later.
 * `gate: "human"` tools only ever produce a draft; execution requires a human Confirm.
 */
export interface ToolDef {
  name: string;
  description: string;
  gate: "none" | "human";
  paypal?: string;
  parameters: Record<string, unknown>;
}

const str = { type: "string" };
const num = { type: "number" };

export const TOOLS: ToolDef[] = [
  {
    name: "onboard_worker",
    description: "Add or update a gig worker on the crew (name, PayPal email, trade, pay rate).",
    gate: "none",
    parameters: { type: "object", properties: { name: str, email: str, trade: str, rate: num, rateUnit: { type: "string", enum: ["hr", "job"] } }, required: ["name"] },
  },
  {
    name: "log_job",
    description: "Log a completed job and plan its close-out: pay the worker and bill the customer. Use when the user says a worker finished/fixed/completed something.",
    gate: "none",
    parameters: {
      type: "object",
      properties: { worker: str, workerEmail: str, title: str, customerName: str, customerEmail: str, hours: num, charge: { ...num, description: "amount billed to the customer" }, pay: { ...num, description: "amount paid to the worker" } },
    },
  },
  {
    name: "create_payout",
    description: "Draft a PayPal Payout to a worker. Never sends; the human confirms.",
    gate: "human",
    paypal: "POST /v1/payments/payouts",
    parameters: { type: "object", properties: { worker: str, email: str, amount: num, note: str } },
  },
  {
    name: "run_payroll",
    description: "Draft ONE PayPal Payouts batch paying every worker for all completed, unpaid jobs.",
    gate: "human",
    paypal: "POST /v1/payments/payouts (multi-item batch)",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "create_invoice",
    description: "Draft a PayPal invoice to a customer (create + send on confirm).",
    gate: "human",
    paypal: "POST /v2/invoicing/invoices, POST /v2/invoicing/invoices/{id}/send",
    parameters: { type: "object", properties: { customerName: str, customerEmail: str, amount: num, description: str } },
  },
  {
    name: "create_order",
    description: "Draft a PayPal checkout (Orders v2) payment link a customer can pay from their phone.",
    gate: "human",
    paypal: "POST /v2/checkout/orders",
    parameters: { type: "object", properties: { customerName: str, customerEmail: str, amount: num, description: str } },
  },
  {
    name: "capture_order",
    description: "Draft a capture of an approved PayPal order.",
    gate: "human",
    paypal: "POST /v2/checkout/orders/{id}/capture",
    parameters: { type: "object", properties: { orderId: str } },
  },
  {
    name: "get_status",
    description: "Refresh live PayPal status for payouts, invoices and orders.",
    gate: "none",
    paypal: "GET /v1/payments/payouts/{id}, GET /v2/invoicing/invoices/{id}, GET /v2/checkout/orders/{id}",
    parameters: { type: "object", properties: { ref: str } },
  },
  { name: "confirm_pending", description: "ONLY when the user explicitly approves pending drafts (yes/confirm/approve).", gate: "none", parameters: { type: "object", properties: { all: { type: "boolean" } } } },
  { name: "cancel_pending", description: "User rejects pending drafts.", gate: "none", parameters: { type: "object", properties: { all: { type: "boolean" } } } },
  { name: "report", description: "Summarize money paid, billed, collected and margins.", gate: "none", parameters: { type: "object", properties: {} } },
  { name: "list_team", description: "List the crew.", gate: "none", parameters: { type: "object", properties: {} } },
];

export const TOOL_TO_INTENT: Record<string, string> = {
  onboard_worker: "onboard",
  log_job: "log_job",
  create_payout: "pay",
  run_payroll: "payroll",
  create_invoice: "invoice",
  create_order: "payment_link",
  capture_order: "capture",
  get_status: "status",
  confirm_pending: "confirm",
  cancel_pending: "cancel",
  report: "report",
  list_team: "team",
};
