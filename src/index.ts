import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cancelAction, confirmAction, executedLine, handleMessage, refreshStatuses, HELP } from "./agent.ts";
import { getSession, resetSession, snapshot } from "./ledger.ts";
import { forcedDryRun, hasCredentials, paypalMode } from "./paypal.ts";
import { limits } from "./policy.ts";
import { llmLabel } from "./llm.ts";
import { TOOLS } from "./tools.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const app = express();
const PORT = Number(process.env.PORT || 3000);

app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));
app.use((_, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});
app.use(express.static(path.join(__dirname, "..", "public"), { extensions: ["html"] }));

// Tiny per-IP rate limit so a public demo can't be hammered.
const hits = new Map<string, { n: number; reset: number }>();
app.use("/api", (req, res, next) => {
  const ip = req.headers["x-forwarded-for"]?.toString().split(",")[0] || req.socket.remoteAddress || "?";
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now > h.reset) hits.set(ip, { n: 1, reset: now + 60_000 });
  else if (++h.n > Number(process.env.RATE_LIMIT_PER_MIN || 90)) return void res.status(429).json({ error: "Slow down a little." });
  next();
});

const sid = (req: express.Request) => String(req.body?.sessionId || req.query.sessionId || "default").slice(0, 64);

function meta() {
  return {
    paypalCredentials: hasCredentials(),
    mode: paypalMode(),
    dryRun: !hasCredentials(),
    publicDemo: forcedDryRun(),
    planner: llmLabel() ? `llm:${llmLabel()}` : "offline",
    limits: limits(),
  };
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "jobpay-agent", version: "1.0.0", ...meta(), openai: Boolean(llmLabel()) });
});

app.get("/api/tools", (_req, res) => res.json({ tools: TOOLS }));

app.get("/api/state", (req, res) => {
  const s = getSession(sid(req));
  res.json({ ...snapshot(s), messages: s.messages, meta: meta(), help: HELP });
});

app.post("/api/chat", async (req, res) => {
  try {
    const message = String(req.body?.message || "").trim().slice(0, 2000);
    if (!message) return void res.status(400).json({ error: "message is required" });
    const s = getSession(sid(req));
    s.messages.push({ role: "user", content: message, ts: Date.now() });
    const r = await handleMessage(s, message);
    s.messages.push({ role: "assistant", content: r.reply, ts: Date.now(), actionIds: r.actionIds, trace: r.trace });
    if (s.messages.length > 120) s.messages.splice(0, s.messages.length - 120);
    res.json({ reply: r.reply, actionIds: r.actionIds, trace: r.trace, planner: r.planner, ...snapshot(s), meta: meta() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/actions/:id/confirm", async (req, res) => {
  try {
    const s = getSession(sid(req));
    const trace: any[] = [];
    const a = await confirmAction(s, req.params.id, trace);
    const line = executedLine(a);
    s.messages.push({ role: "assistant", content: line, ts: Date.now(), actionIds: [a.id], trace });
    res.json({ action: a, reply: line, trace, ...snapshot(s), meta: meta() });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/actions/:id/cancel", (req, res) => {
  try {
    const s = getSession(sid(req));
    const a = cancelAction(s, req.params.id);
    res.json({ action: a, ...snapshot(s), meta: meta() });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/refresh", async (req, res) => {
  const s = getSession(sid(req));
  const trace: any[] = [];
  await refreshStatuses(s, trace);
  res.json({ trace, ...snapshot(s), meta: meta() });
});

app.post("/api/reset", (req, res) => {
  const s = resetSession(sid(req));
  res.json({ ok: true, ...snapshot(s), meta: meta() });
});

if (import.meta.main) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`JobPay Agent listening on http://localhost:${PORT}`);
    console.log(hasCredentials() ? "PayPal sandbox credentials: loaded" : "PayPal sandbox credentials: missing → DRY-RUN mode");
    console.log(`Planner: ${llmLabel() ? `LLM (${llmLabel()}) with offline fallback` : "offline (no API key needed)"}`);
  });
}
