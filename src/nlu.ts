/**
 * Deterministic, offline natural-language planner.
 * Turns plain English into typed intents. No network, no API key — demos never break.
 * The optional LLM planner (llm.ts) produces the exact same Intent shape.
 */

export type Intent =
  | { type: "confirm"; all?: boolean }
  | { type: "cancel"; all?: boolean }
  | { type: "onboard"; name?: string; email?: string; trade?: string; rate?: number; rateUnit?: "hr" | "job" }
  | {
      type: "log_job";
      worker?: string;
      title?: string;
      customerName?: string;
      customerEmail?: string;
      hours?: number;
      charge?: number;
      pay?: number;
      workerEmail?: string;
    }
  | { type: "pay"; worker?: string; email?: string; amount?: number; note?: string }
  | { type: "invoice"; customerName?: string; customerEmail?: string; amount?: number; description?: string }
  | { type: "payment_link"; customerName?: string; customerEmail?: string; amount?: number; description?: string }
  | { type: "capture"; orderId?: string }
  | { type: "payroll" }
  | { type: "status"; ref?: string }
  | { type: "report" }
  | { type: "team" }
  | { type: "help" }
  | { type: "demo" }
  | { type: "provide"; email?: string; amount?: number; name?: string; text: string }
  | { type: "unknown"; text: string };

export interface NluContext {
  workerNames: string[];
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const TRADES = [
  "plumber", "electrician", "landscaper", "lawn care", "cleaner", "house cleaner", "handyman", "painter", "roofer",
  "hvac tech", "hvac", "mover", "carpenter", "gutter cleaner", "pressure washer", "pool tech", "tiler", "welder", "dog walker",
];
const STOP = new Set([
  "I", "The", "A", "An", "Pay", "Paid", "Send", "Invoice", "Bill", "Log", "Onboard", "Add", "Hire", "Job", "For", "At", "To",
  "And", "Then", "Please", "Customer", "Client", "Worker", "Status", "Create", "Make", "New", "Charge", "Our", "My", "Today",
  "Yesterday", "Confirm", "Cancel", "Them", "Him", "Her", "Payment", "Link", "Collect", "Mr", "Mrs", "Ms", "PayPal", "USD",
]);

export function emails(t: string): string[] {
  return t.match(EMAIL_RE) || [];
}

function stripEmails(t: string) {
  return t.replace(EMAIL_RE, " ");
}

/** "$1,250.50", "120 dollars", "120 bucks", "USD 40" */
export function amounts(t: string): Array<{ value: number; index: number; raw: string }> {
  const out: Array<{ value: number; index: number; raw: string }> = [];
  const re = /(?:\$|usd\s*)\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?|(\d+(?:\.\d{1,2})?)\s*(?:dollars|bucks|usd)\b/gi;
  for (const m of stripEmails(t).matchAll(re)) {
    const whole = m[1] ? m[1].replace(/,/g, "") + (m[2] ? "." + m[2] : "") : m[3];
    out.push({ value: parseFloat(whole!), index: m.index ?? 0, raw: m[0] });
  }
  return out;
}

function rate(t: string): { rate?: number; rateUnit?: "hr" | "job" } {
  const m = t.match(/\$\s*(\d+(?:\.\d{1,2})?)\s*(?:\/|an?|per)\s*(hour|hr|h|job|visit|gig)\b/i);
  if (!m) return {};
  return { rate: parseFloat(m[1]), rateUnit: /^(hour|hr|h)$/i.test(m[2]) ? "hr" : "job" };
}

function hours(t: string): number | undefined {
  const m = t.match(/(\d+(?:\.\d+)?)\s*(?:hours|hour|hrs|hr|h)\b/i);
  return m ? parseFloat(m[1]) : undefined;
}

/** amount that follows one of the given cue words within a short window */
function amountAfter(t: string, cues: RegExp): number | undefined {
  const re = new RegExp(`${cues.source}[^$\\d]{0,40}?\\$\\s*(\\d{1,3}(?:,\\d{3})+|\\d+(?:\\.\\d{1,2})?)`, "i");
  const m = stripEmails(t).match(re);
  return m ? parseFloat(m[m.length - 1]!.replace(/,/g, "")) : undefined;
}

function properNames(t: string): string[] {
  const clean = stripEmails(t);
  const out: string[] = [];
  for (const m of clean.matchAll(/\b([A-Z][a-z'’-]+(?:[ \t]+[A-Z][a-z'’-]+){0,3})\b/g)) {
    const words = m[1]!.split(/\s+/);
    while (words.length && STOP.has(words[0]!)) words.shift();
    const name = words.filter((w) => !STOP.has(w)).slice(0, 2);
    if (name.length) out.push(name.join(" "));
  }
  return out;
}

function knownWorker(t: string, ctx: NluContext): string | undefined {
  const lower = t.toLowerCase();
  let best: { name: string; idx: number } | undefined;
  for (const n of ctx.workerNames) {
    for (const cand of [n.toLowerCase(), n.toLowerCase().split(/\s+/)[0]!]) {
      const idx = lower.search(new RegExp(`\\b${cand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`));
      if (idx >= 0 && (!best || idx < best.idx)) best = { name: n, idx };
    }
  }
  return best?.name;
}

function nameAfter(t: string, cue: RegExp, exclude: string[] = []): string | undefined {
  const clean = stripEmails(t);
  const cueRe = new RegExp(cue.source, "gi");
  let name = "";
  for (const c of clean.matchAll(cueRe)) {
    const rest = clean.slice((c.index ?? 0) + c[0].length);
    const m = rest.match(/^\s+(?:(?:a|an|the|new|our|my|worker|customer|client|to)\s+)*([A-Z][a-z'’-]+(?:[ \t]+[A-Z][a-z'’-]+)?)/);
    if (!m) continue;
    const words = m[1]!.split(/\s+/).filter((w) => !STOP.has(w));
    if (words.length) {
      name = words.join(" ");
      break;
    }
  }
  if (!name || exclude.some((e) => e.toLowerCase().split(" ")[0] === name.toLowerCase().split(" ")[0])) return undefined;
  return name;
}

function jobTitle(t: string): string | undefined {
  const clean = stripEmails(t);
  let m = clean.match(/\bthe\s+([a-z][a-z\s-]{2,40}?)\s+(?:job|gig|repair|install|cleaning|visit)\b/i);
  if (m) return cap(`${m[1]!.trim()} ${clean.match(/\b(job|gig|repair|install|cleaning|visit)\b/i)?.[1] ?? "job"}`);
  m = clean.match(/\b(?:fixed|cleaned|installed|repaired|mowed|painted|replaced|moved|serviced|finished|completed|did)\s+(?:a|an|the)?\s*([a-z][a-z\s-]{2,40}?)(?=\s+(?:for|at|on|in|—|-|,|\.|\(|\$|today|yesterday)|[,.(]|$)/i);
  if (m && !/^(the|a|an)$/i.test(m[1]!.trim())) return cap(m[1]!.trim());
  m = clean.match(/\bjob[:\s]+([^,.$(]{3,50})/i);
  if (m) return cap(m[1]!.trim());
  return undefined;
}

function desc(t: string): string | undefined {
  const m = stripEmails(t).match(/\bfor\s+(?:the\s+|a\s+|an\s+)?([a-z][a-z0-9 '’-]{2,60}?)(?=\s+(?:at|to|on|by|due)\b|\s*[,.$(]|\s*$)/);
  return m?.[1]?.trim() || undefined;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function trade(t: string): string | undefined {
  const lower = t.toLowerCase();
  return TRADES.find((tr) => lower.includes(tr));
}

/** Split compound instructions: "pay Maria $80 then invoice Bob $120" */
export function splitClauses(text: string): string[] {
  return text
    .split(/\s*(?:;|\n|\band then\b|\bthen\b|\balso\b)\s*/i)
    .map((s) => s.trim().replace(/^(and|,)\s+/i, ""))
    .filter(Boolean);
}

export function parseClause(text: string, ctx: NluContext): Intent {
  const t = text.trim();
  const lower = t.toLowerCase();
  const em = emails(t);
  const amts = amounts(t);

  if (/^(yes|y|yep|confirm|approve|approved|send it|do it|go ahead|ship it|ok|okay|looks good|lgtm)\b/i.test(t))
    return { type: "confirm", all: /\ball\b|\bboth\b|\beverything\b/i.test(t) };
  if (/^(confirm|approve)\s+(all|both|everything)/i.test(t)) return { type: "confirm", all: true };
  if (/^(no|n|nope|cancel|stop|abort|never ?mind|discard|scrap)\b/i.test(t))
    return { type: "cancel", all: /\ball\b|\bboth\b|\beverything\b/i.test(t) };
  if (/^(help|\?|what can you do|how does this work)/i.test(t)) return { type: "help" };
  if (/\b(demo|sample|seed|example crew|load (the )?crew)\b/i.test(lower) && !em.length) return { type: "demo" };
  if (/\b(run|do|process|send)\b.{0,20}\bpayroll\b|\bpayroll\b|\bpay (everyone|everybody|the (whole )?crew|all( workers)?)\b/i.test(lower)) return { type: "payroll" };
  if (/\bcapture\b/i.test(lower)) return { type: "capture", orderId: t.match(/\b([A-Z0-9]{12,20})\b/)?.[1] };
  if (/\b(status|refresh|track|where is|did .* (clear|go through)|check on)\b/i.test(lower))
    return { type: "status", ref: t.match(/\b([A-Z0-9][A-Z0-9-]{9,})\b/)?.[1] };
  if (/\b(report|summary|summarize|how much|margin|ledger|books|totals?|p&l|profit|spent|earned)\b/i.test(lower)) return { type: "report" };
  if (/\b(my team|my crew|roster|who('| i)s on|list (workers|crew|team)|show (workers|crew|team))\b/i.test(lower)) return { type: "team" };

  const worker = knownWorker(t, ctx);
  const isOnboard = /\b(onboard|hire|add|bring on|sign up|recruit|new worker)\b/i.test(lower) && !/\b(invoice|bill|pay)\b/i.test(lower);
  if (isOnboard) {
    const name = nameAfter(t, /(?:onboard|hire|add|bring on|sign up|recruit)/i) || properNames(t)[0];
    return { type: "onboard", name, email: em[0], trade: trade(t), ...rate(t) };
  }

  const isPaymentLink = /\b(payment link|pay link|checkout link|checkout|collect|deposit|pay ?now link)\b/i.test(lower);
  const isJob = /\b(finished|completed|wrapped( up)?|done with|log(ged)?( a)? job|log job|job done|closed out|close out|fixed|cleaned|installed|repaired|mowed|painted|replaced|serviced|did the)\b/i.test(lower);
  const isInvoice = /\b(invoice|bill)\b/i.test(lower);
  const isPay = /\b(pay|payout|send)\b/i.test(lower);

  if (isJob) {
    const cueCharge = amountAfter(t, /(?:charge[ds]?|bill(?:ed)?|invoice|customer pays|price[ds]?|quoted?|total)/);
    const cuePay = amountAfter(t, /(?:pay(?:ing)?|payout|worker gets|cut)/);
    let charge = cueCharge;
    let pay = cuePay;
    if (charge === undefined && pay === undefined && amts.length >= 2) {
      charge = Math.max(...amts.map((a) => a.value));
      pay = Math.min(...amts.map((a) => a.value));
    } else if (charge === undefined && pay === undefined && amts.length === 1) {
      if (isInvoice) charge = amts[0]!.value;
      else pay = amts[0]!.value;
    } else if (amts.length >= 2) {
      if (charge === undefined) charge = amts.map((a) => a.value).find((v) => v !== pay);
      if (pay === undefined) pay = amts.map((a) => a.value).find((v) => v !== charge);
    }
    const custEmail = em.find((e) => !worker || !e.toLowerCase().startsWith(worker.toLowerCase().split(" ")[0]!));
    const customerName =
      nameAfter(t, /\b(?:for|customer|client)/, worker ? [worker] : []) ??
      properNames(t).find((n) => !worker || n.split(" ")[0]!.toLowerCase() !== worker.split(" ")[0]!.toLowerCase());
    const w = worker || properNames(t)[0];
    return {
      type: "log_job",
      worker: w,
      title: jobTitle(t),
      customerName: customerName && customerName !== w ? customerName : undefined,
      customerEmail: custEmail,
      hours: hours(t),
      charge,
      pay,
    };
  }

  if (isPaymentLink) {
    return {
      type: "payment_link",
      customerName: nameAfter(t, /(?:for|from|to|collect from|link for)/) ?? properNames(t)[0],
      customerEmail: em[0],
      amount: amts[0]?.value,
      description: desc(t),
    };
  }

  if (isInvoice) {
    const name = nameAfter(t, /(?:invoice|bill)/) ?? properNames(t)[0];
    return {
      type: "invoice",
      customerName: name,
      customerEmail: em[0],
      amount: amts[0]?.value,
      description: desc(t),
    };
  }

  if (isPay) {
    const name = worker || nameAfter(t, /(?:pay|send|payout(?:\s+to)?)/) || properNames(t)[0];
    return {
      type: "pay",
      worker: name,
      email: em[0],
      amount: amts[0]?.value,
      note: t.match(/\bfor\s+(?:the\s+)?(.{3,80}?)(?:\s+at\s+\S+@\S+|\s*$|[.,])/i)?.[1]?.trim(),
    };
  }

  if (em.length || amts.length) return { type: "provide", email: em[0], amount: amts[0]?.value, name: properNames(t)[0], text: t };
  return { type: "unknown", text: t };
}

export function parse(text: string, ctx: NluContext): Intent[] {
  const clauses = splitClauses(text);
  // Don't split a job close-out; its clauses ("...then pay Maria") belong to one plan.
  if (clauses.length > 1 && /\b(finished|completed|wrapped|done with|close out|closed out)\b/i.test(clauses[0]!)) {
    return [parseClause(text, ctx)];
  }
  return clauses.map((c) => parseClause(c, ctx));
}
