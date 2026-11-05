/**
 * Optional LLM planner (OpenAI-compatible tool calling).
 * Works with OpenAI, or fully local/free with Ollama / LM Studio via OPENAI_BASE_URL.
 * The LLM only *plans* (chooses tools + arguments); it never executes money movement.
 * Any failure falls back to the offline planner in nlu.ts.
 */
import type { Intent } from "./nlu.ts";
import type { Session } from "./ledger.ts";
import { TOOLS, TOOL_TO_INTENT } from "./tools.ts";

export function llmEnabled(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim() || process.env.OPENAI_BASE_URL?.trim());
}

export function llmLabel(): string | null {
  if (!llmEnabled()) return null;
  return process.env.OPENAI_MODEL || "gpt-4o-mini";
}

const SYSTEM = `You are JobPay Agent, the money operator for a small home-service business (plumbers, cleaners, handymen).
Translate the owner's message into tool calls. You may call several tools in order.
Rules: never invent emails or amounts; leave unknown fields out. Money tools only create drafts the human approves.
Use log_job when a worker finished a job (it plans payout + customer bill). Use confirm_pending ONLY on explicit approval.`;

export async function llmPlan(text: string, s: Session): Promise<Intent[]> {
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(process.env.LLM_TIMEOUT_MS || 12000));
  try {
    const context = {
      crew: s.workers.map((w) => ({ name: w.name, email: w.email, rate: w.rate, unit: w.rateUnit })),
      pendingDrafts: s.actions.filter((a) => a.status === "pending").map((a) => ({ title: a.title, amount: a.amount })),
      awaiting: s.awaiting,
      recentChat: s.messages.slice(-6).map((m) => `${m.role}: ${m.content.slice(0, 300)}`),
    };
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        ...(process.env.OPENAI_API_KEY ? { Authorization: `Bearer ${process.env.OPENAI_API_KEY.trim()}` } : {}),
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "system", content: `Context: ${JSON.stringify(context)}` },
          { role: "user", content: text },
        ],
        tools: TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
        tool_choice: "auto",
      }),
    });
    if (!res.ok) throw new Error(`LLM ${res.status}`);
    const data: any = await res.json();
    const calls = data.choices?.[0]?.message?.tool_calls || [];
    return calls
      .map((c: any) => {
        const type = TOOL_TO_INTENT[c.function?.name];
        if (!type) return null;
        let args: any = {};
        try {
          args = JSON.parse(c.function.arguments || "{}");
        } catch {}
        return { type, ...args } as Intent;
      })
      .filter(Boolean);
  } finally {
    clearTimeout(timer);
  }
}
