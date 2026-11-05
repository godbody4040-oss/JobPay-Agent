/**
 * End-to-end smoke test over HTTP. Uses PayPal sandbox if .env has credentials, else dry-run.
 *   bun run smoke
 * Moves at most $3 of SANDBOX (fake) money. Never prints credentials.
 */
import { app } from "../src/index.ts";

const server = app.listen(0);
const port = (server.address() as any).port;
const base = `http://127.0.0.1:${port}`;
const sessionId = `smoke_${Date.now()}`;
const post = async (p: string, body: any = {}) =>
  (await fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, ...body }) })).json() as any;
const say = async (m: string) => {
  const r = await post("/api/chat", { message: m });
  console.log(`\n> ${m}\n${r.reply}`);
  return r;
};

const health = await (await fetch(base + "/health")).json();
console.log("health:", JSON.stringify(health));
await say("Onboard Maria Lopez, plumber, maria.lopez@example.com, $1/hr");
const job = await say("Maria finished the faucet repair for Bob Smith bob.smith@example.com, 2 hours, charge $3");
for (const id of job.actionIds) {
  const r = await post(`/api/actions/${id}/confirm`);
  console.log(`\n[confirm ${r.action.kind}] ${r.reply}`);
}
await say("status");
await say("show my books");
server.close();
