/**
 * Lightweight agent loop for JobPay Agent.
 * Uses OpenAI when OPENAI_API_KEY is set; otherwise a deterministic NL parser.
 */

import {
  createDraftPayout,
  getPayoutStatus,
  hasCredentials,
  sendSandboxPayout,
  type DraftPayout,
} from "./paypal.ts";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface AgentState {
  pendingDraft: DraftPayout | null;
  lastBatchId: string | null;
}

export interface AgentResult {
  reply: string;
  state: AgentState;
  toolCalls?: Array<{ name: string; result: unknown }>;
}

const SYSTEM = `You are JobPay Agent, an AI hiring + payout assistant for small businesses.
You help users hire gig workers and pay them via PayPal sandbox.
Tools:
- create_draft_payout: draft a payout (email, amount, note). Always draft before sending.
- send_sandbox_payout: send ONLY after the user explicitly confirms (yes / confirm / send it).
- get_payout_status: look up a batch id.
Never send money without confirmation. Be concise and clear about dry-run vs live sandbox.`;

function parsePayIntent(text: string): {
  name?: string;
  amount?: number;
  email?: string;
  note?: string;
} | null {
  const lower = text.toLowerCase();
  const emailMatch = text.match(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
  );
  const amountMatch = text.match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
  // "Pay Jane $50 ..." or "send 50 to jane@..."
  const nameMatch =
    text.match(
      /(?:pay|hire|send|payout(?:\s+to)?)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i
    ) || text.match(/for\s+([A-Z][a-z]+)/);

  const looksLikePay =
    /\b(pay|payout|send|hire|transfer|compensate)\b/i.test(lower) ||
    (emailMatch && amountMatch);

  if (!looksLikePay) return null;

  const noteMatch = text.match(
    /(?:for|note[:\s]+|because)\s+(.+?)(?:\s+at\s+\S+@|\s*$)/i
  );

  return {
    name: nameMatch?.[1],
    amount: amountMatch ? parseFloat(amountMatch[1]) : undefined,
    email: emailMatch?.[0],
    note: noteMatch?.[1]?.trim(),
  };
}

function isConfirm(text: string): boolean {
  return /^(yes|y|confirm|send|send it|do it|approve|ok|okay|go ahead)\b/i.test(
    text.trim()
  );
}

function isCancel(text: string): boolean {
  return /^(no|n|cancel|stop|nevermind|never mind|abort)\b/i.test(
    text.trim()
  );
}

function statusIntent(text: string): string | null {
  const m = text.match(
    /(?:status|check|lookup).*?\b([A-Z0-9]{8,})\b/i
  );
  if (m) return m[1];
  if (/\b(status|check payout)\b/i.test(text)) return "__last__";
  return null;
}

async function runToolsLocal(
  userText: string,
  state: AgentState
): Promise<AgentResult> {
  const toolCalls: Array<{ name: string; result: unknown }> = [];
  const modeNote = hasCredentials()
    ? "PayPal sandbox credentials are configured."
    : "Running in DRY-RUN mode (no PayPal credentials yet).";

  if (isCancel(userText) && state.pendingDraft) {
    return {
      reply: `Canceled draft payout of $${state.pendingDraft.amount} to ${state.pendingDraft.recipientEmail}.`,
      state: { ...state, pendingDraft: null },
    };
  }

  if (isConfirm(userText)) {
    if (!state.pendingDraft) {
      return {
        reply:
          "Nothing to confirm. Tell me who to pay, how much, and their email — e.g. \"Pay Jane $50 for the lawn job at jane@example.com\".",
        state,
      };
    }
    try {
      const result = await sendSandboxPayout(state.pendingDraft, {
        confirm: true,
      });
      toolCalls.push({ name: "send_sandbox_payout", result });
      return {
        reply: result.dryRun
          ? `✅ Confirmed (dry-run).\n${result.message}\n\nWould have paid $${result.draft.amount} ${result.draft.currency} → ${result.draft.recipientEmail}\nNote: ${result.draft.note}\n\nAdd PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to .env to hit the real sandbox API.`
          : `✅ Sent to PayPal sandbox.\n${result.message}\nAmount: $${result.draft.amount} → ${result.draft.recipientEmail}`,
        state: {
          pendingDraft: null,
          lastBatchId: result.batchId || state.lastBatchId,
        },
        toolCalls,
      };
    } catch (err) {
      return {
        reply: `Send failed: ${err instanceof Error ? err.message : String(err)}`,
        state,
        toolCalls,
      };
    }
  }

  const batchKey = statusIntent(userText);
  if (batchKey) {
    const id =
      batchKey === "__last__" ? state.lastBatchId : batchKey;
    if (!id) {
      return {
        reply: "No payout batch id yet. Send a payout first, or pass a batch id.",
        state,
      };
    }
    try {
      const result = await getPayoutStatus(id);
      toolCalls.push({ name: "get_payout_status", result });
      return {
        reply: `Payout status for ${id}:\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``,
        state,
        toolCalls,
      };
    } catch (err) {
      return {
        reply: `Status check failed: ${err instanceof Error ? err.message : String(err)}`,
        state,
        toolCalls,
      };
    }
  }

  const intent = parsePayIntent(userText);
  if (intent && intent.email && intent.amount) {
    try {
      const draft = createDraftPayout({
        recipientEmail: intent.email,
        amount: intent.amount,
        note: intent.note || (intent.name ? `Payment for ${intent.name}` : undefined),
        receiverName: intent.name,
      });
      toolCalls.push({ name: "create_draft_payout", result: draft });
      return {
        reply: [
          `Draft payout ready (${modeNote})`,
          ``,
          `• Worker: ${intent.name || "—"}`,
          `• Email: ${draft.recipientEmail}`,
          `• Amount: $${draft.amount} ${draft.currency}`,
          `• Note: ${draft.note}`,
          `• Item id: ${draft.senderItemId}`,
          ``,
          `Reply **confirm** to send via PayPal sandbox, or **cancel** to discard.`,
        ].join("\n"),
        state: { ...state, pendingDraft: draft },
        toolCalls,
      };
    } catch (err) {
      return {
        reply: `Could not draft payout: ${err instanceof Error ? err.message : String(err)}`,
        state,
        toolCalls,
      };
    }
  }

  if (intent && (!intent.email || !intent.amount)) {
    const missing = [
      !intent.amount ? "amount (e.g. $50)" : null,
      !intent.email ? "worker email" : null,
    ]
      .filter(Boolean)
      .join(" and ");
    return {
      reply: `I can draft that — I still need ${missing}. Example: "Pay Jane $50 for the lawn job at jane@example.com"`,
      state,
    };
  }

  return {
    reply: [
      `Hi — I'm JobPay Agent. ${modeNote}`,
      ``,
      `Try: "Pay Jane $50 for the lawn job at jane@example.com"`,
      `Then reply confirm to send (sandbox / dry-run).`,
      `Or: "status" after a send to check the batch.`,
    ].join("\n"),
    state,
  };
}

async function runWithOpenAI(
  messages: ChatMessage[],
  state: AgentState
): Promise<AgentResult | null> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) return null;

  // Tool-calling via Chat Completions — optional enhancement.
  // For the hackathon prototype we keep a thin wrapper; on failure fall back to local parser.
  try {
    const tools = [
      {
        type: "function",
        function: {
          name: "create_draft_payout",
          description: "Draft a PayPal sandbox payout for one worker",
          parameters: {
            type: "object",
            properties: {
              recipientEmail: { type: "string" },
              amount: { type: "number" },
              note: { type: "string" },
              receiverName: { type: "string" },
            },
            required: ["recipientEmail", "amount"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "send_sandbox_payout",
          description:
            "Send the pending draft via PayPal sandbox. Only after user confirmation.",
          parameters: {
            type: "object",
            properties: {
              confirm: { type: "boolean" },
            },
            required: ["confirm"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "get_payout_status",
          description: "Get PayPal payout batch status",
          parameters: {
            type: "object",
            properties: {
              batchId: { type: "string" },
            },
            required: ["batchId"],
          },
        },
      },
    ];

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: SYSTEM },
          ...messages,
          ...(state.pendingDraft
            ? [
                {
                  role: "system",
                  content: `Pending draft: ${JSON.stringify(state.pendingDraft)}`,
                },
              ]
            : []),
        ],
        tools,
        tool_choice: "auto",
      }),
    });

    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices: Array<{
        message: {
          content?: string | null;
          tool_calls?: Array<{
            function: { name: string; arguments: string };
          }>;
        };
      }>;
    };

    const msg = data.choices[0]?.message;
    if (!msg) return null;

    const toolCalls: Array<{ name: string; result: unknown }> = [];
    let nextState = { ...state };

    if (msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        const name = tc.function.name;
        const args = JSON.parse(tc.function.arguments || "{}") as Record<
          string,
          unknown
        >;

        if (name === "create_draft_payout") {
          const draft = createDraftPayout({
            recipientEmail: String(args.recipientEmail),
            amount: Number(args.amount),
            note: args.note ? String(args.note) : undefined,
            receiverName: args.receiverName
              ? String(args.receiverName)
              : undefined,
          });
          toolCalls.push({ name, result: draft });
          nextState.pendingDraft = draft;
        } else if (name === "send_sandbox_payout") {
          if (!nextState.pendingDraft) {
            toolCalls.push({
              name,
              result: { error: "No pending draft" },
            });
          } else if (!args.confirm) {
            toolCalls.push({
              name,
              result: { error: "confirm must be true" },
            });
          } else {
            const result = await sendSandboxPayout(nextState.pendingDraft, {
              confirm: true,
            });
            toolCalls.push({ name, result });
            nextState = {
              pendingDraft: null,
              lastBatchId: result.batchId || nextState.lastBatchId,
            };
          }
        } else if (name === "get_payout_status") {
          const result = await getPayoutStatus(String(args.batchId));
          toolCalls.push({ name, result });
        }
      }

      const summary =
        msg.content ||
        (nextState.pendingDraft
          ? `Draft ready for $${nextState.pendingDraft.amount} → ${nextState.pendingDraft.recipientEmail}. Reply confirm to send.`
          : `Done. Tools run: ${toolCalls.map((t) => t.name).join(", ")}`);

      return { reply: summary, state: nextState, toolCalls };
    }

    if (msg.content) {
      return { reply: msg.content, state: nextState };
    }
  } catch {
    return null;
  }
  return null;
}

export async function runAgent(
  messages: ChatMessage[],
  state: AgentState
): Promise<AgentResult> {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) {
    return {
      reply: "Send a message to get started.",
      state,
    };
  }

  const openai = await runWithOpenAI(messages, state);
  if (openai) return openai;

  return runToolsLocal(lastUser.content, state);
}

export function emptyState(): AgentState {
  return { pendingDraft: null, lastBatchId: null };
}
