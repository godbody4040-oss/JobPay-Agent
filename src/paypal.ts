/**
 * PayPal REST sandbox helpers (Payouts API).
 * Docs: https://developer.paypal.com/docs/api/payments.payouts-batch/v1/
 */

const SANDBOX_BASE = "https://api-m.sandbox.paypal.com";
const LIVE_BASE = "https://api-m.paypal.com";

export type PayPalMode = "sandbox" | "live";

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  mode: PayPalMode;
}

export interface DraftPayout {
  recipientEmail: string;
  amount: string; // e.g. "50.00"
  currency: string;
  note: string;
  senderItemId: string;
  receiverName?: string;
}

export interface PayoutResult {
  dryRun: boolean;
  batchId?: string;
  status?: string;
  links?: Array<{ rel: string; href: string; method: string }>;
  draft: DraftPayout;
  requestBody: unknown;
  raw?: unknown;
  message: string;
}

function baseUrl(mode: PayPalMode): string {
  return mode === "live" ? LIVE_BASE : SANDBOX_BASE;
}

export function hasCredentials(): boolean {
  return Boolean(
    process.env.PAYPAL_CLIENT_ID?.trim() &&
      process.env.PAYPAL_CLIENT_SECRET?.trim()
  );
}

export function getConfig(): PayPalConfig | null {
  if (!hasCredentials()) return null;
  const mode = (process.env.PAYPAL_MODE || "sandbox").toLowerCase() as PayPalMode;
  return {
    clientId: process.env.PAYPAL_CLIENT_ID!.trim(),
    clientSecret: process.env.PAYPAL_CLIENT_SECRET!.trim(),
    mode: mode === "live" ? "live" : "sandbox",
  };
}

let cachedToken: { accessToken: string; expiresAt: number } | null = null;

export async function getAccessToken(config: PayPalConfig): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 30_000) {
    return cachedToken.accessToken;
  }

  const auth = Buffer.from(
    `${config.clientId}:${config.clientSecret}`
  ).toString("base64");

  const res = await fetch(`${baseUrl(config.mode)}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPal OAuth failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };

  cachedToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return cachedToken.accessToken;
}

export function buildPayoutRequestBody(draft: DraftPayout) {
  return {
    sender_batch_header: {
      sender_batch_id: `jobpay_${draft.senderItemId}`,
      email_subject: "You have a payment from JobPay Agent",
      email_message:
        draft.note || "Thanks for the gig work — paid via JobPay Agent.",
    },
    items: [
      {
        recipient_type: "EMAIL",
        amount: {
          value: draft.amount,
          currency: draft.currency || "USD",
        },
        note: draft.note,
        sender_item_id: draft.senderItemId,
        receiver: draft.recipientEmail,
      },
    ],
  };
}

export function createDraftPayout(input: {
  recipientEmail: string;
  amount: number | string;
  note?: string;
  receiverName?: string;
  currency?: string;
}): DraftPayout {
  const amountNum =
    typeof input.amount === "string"
      ? parseFloat(input.amount.replace(/[$,]/g, ""))
      : input.amount;

  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    throw new Error("Amount must be a positive number");
  }
  if (!input.recipientEmail || !input.recipientEmail.includes("@")) {
    throw new Error("A valid recipient email is required");
  }

  return {
    recipientEmail: input.recipientEmail.trim().toLowerCase(),
    amount: amountNum.toFixed(2),
    currency: (input.currency || "USD").toUpperCase(),
    note: (input.note || "Gig payment via JobPay Agent").slice(0, 1000),
    senderItemId: `jp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    receiverName: input.receiverName?.trim(),
  };
}

export async function sendSandboxPayout(
  draft: DraftPayout,
  opts: { confirm: boolean } = { confirm: false }
): Promise<PayoutResult> {
  if (!opts.confirm) {
    throw new Error(
      "Refusing to send: confirm=true is required before send_sandbox_payout"
    );
  }

  const requestBody = buildPayoutRequestBody(draft);
  const config = getConfig();

  if (!config) {
    return {
      dryRun: true,
      draft,
      requestBody,
      message:
        "DRY-RUN: No PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET set. Payload is ready for sandbox once credentials are added.",
    };
  }

  if (config.mode !== "sandbox") {
    throw new Error(
      "Safety: JobPay Agent only sends via PAYPAL_MODE=sandbox in this prototype"
    );
  }

  const token = await getAccessToken(config);
  const res = await fetch(`${baseUrl(config.mode)}/v1/payments/payouts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "PayPal-Request-Id": draft.senderItemId,
    },
    body: JSON.stringify(requestBody),
  });

  const raw = await res.json().catch(async () => ({ text: await res.text() }));

  if (!res.ok) {
    throw new Error(
      `PayPal Payouts failed (${res.status}): ${JSON.stringify(raw)}`
    );
  }

  const batch = raw as {
    batch_header?: { payout_batch_id?: string; batch_status?: string };
    links?: Array<{ rel: string; href: string; method: string }>;
  };

  return {
    dryRun: false,
    batchId: batch.batch_header?.payout_batch_id,
    status: batch.batch_header?.batch_status,
    links: batch.links,
    draft,
    requestBody,
    raw,
    message: `Sandbox payout submitted. Batch ${batch.batch_header?.payout_batch_id} status=${batch.batch_header?.batch_status}`,
  };
}

export async function getPayoutStatus(batchId: string): Promise<unknown> {
  const config = getConfig();
  if (!config) {
    return {
      dryRun: true,
      batchId,
      message:
        "DRY-RUN: No credentials. Would GET /v1/payments/payouts/{batchId}",
    };
  }

  const token = await getAccessToken(config);
  const res = await fetch(
    `${baseUrl(config.mode)}/v1/payments/payouts/${encodeURIComponent(batchId)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  const raw = await res.json().catch(async () => ({ text: await res.text() }));
  if (!res.ok) {
    throw new Error(
      `PayPal get payout failed (${res.status}): ${JSON.stringify(raw)}`
    );
  }
  return raw;
}
