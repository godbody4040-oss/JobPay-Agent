import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  emptyState,
  runAgent,
  type AgentState,
  type ChatMessage,
} from "./agent.ts";
import { hasCredentials } from "./paypal.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

/** In-memory session store for the demo UI */
const sessions = new Map<string, { messages: ChatMessage[]; state: AgentState }>();

function getSession(id: string) {
  let s = sessions.get(id);
  if (!s) {
    s = { messages: [], state: emptyState() };
    sessions.set(id, s);
  }
  return s;
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "jobpay-agent",
    paypalCredentials: hasCredentials(),
    mode: process.env.PAYPAL_MODE || "sandbox",
    openai: Boolean(process.env.OPENAI_API_KEY?.trim()),
  });
});

app.post("/api/chat", async (req, res) => {
  try {
    const message = String(req.body?.message || "").trim();
    const sessionId = String(req.body?.sessionId || "default");
    if (!message) {
      res.status(400).json({ error: "message is required" });
      return;
    }

    const session = getSession(sessionId);
    session.messages.push({ role: "user", content: message });

    const result = await runAgent(session.messages, session.state);
    session.state = result.state;
    session.messages.push({ role: "assistant", content: result.reply });

    // Keep history bounded
    if (session.messages.length > 40) {
      session.messages = session.messages.slice(-40);
    }

    res.json({
      reply: result.reply,
      state: {
        hasPendingDraft: Boolean(result.state.pendingDraft),
        pendingDraft: result.state.pendingDraft,
        lastBatchId: result.state.lastBatchId,
      },
      toolCalls: result.toolCalls || [],
      dryRun: !hasCredentials(),
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.post("/api/reset", (req, res) => {
  const sessionId = String(req.body?.sessionId || "default");
  sessions.set(sessionId, { messages: [], state: emptyState() });
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`JobPay Agent listening on http://localhost:${PORT}`);
  console.log(
    hasCredentials()
      ? "PayPal sandbox credentials: loaded"
      : "PayPal sandbox credentials: missing → DRY-RUN mode"
  );
});
