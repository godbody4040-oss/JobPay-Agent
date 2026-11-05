/* JobPay Agent — front end. Vanilla JS, no build step. */
const $ = (s, el = document) => el.querySelector(s);
const sessionId = localStorage.jobpaySession || (localStorage.jobpaySession = "s_" + Math.random().toString(36).slice(2, 10));
let S = { actions: [], workers: [], jobs: [], activity: [], totals: {}, messages: [], meta: {} };
let grid = null;
let busy = false;

const fmt = (n) => "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt0 = (n) => (n < 0 ? "−$" : "$") + Math.abs(Number(n || 0)).toLocaleString("en-US", { maximumFractionDigits: 0 });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const KIND = { payroll: "Payroll batch · PayPal Payouts", payout: "Payout · PayPal Payouts", invoice: "Invoice · PayPal Invoicing", payment_link: "Payment link · PayPal Checkout", capture: "Capture · PayPal Orders" };
const STATE = { pending: "Awaiting approval", blocked: "Blocked by policy", executing: "Sending…", done: "Sent", canceled: "Canceled", failed: "Failed" };

function md(text) {
  return esc(text)
    .split("\n")
    .map((line) => {
      let l = line
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/(https:\/\/www\.sandbox\.paypal\.com\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">open PayPal checkout ↗</a>');
      if (/^•\s?/.test(line)) return `<div class="li">${l.replace(/^•\s?/, "")}</div>`;
      return l.trim() ? `<p>${l}</p>` : "";
    })
    .join("");
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify({ sessionId, ...body }) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function absorb(d) {
  for (const k of ["actions", "workers", "jobs", "activity", "totals", "meta", "awaiting"]) if (d[k] !== undefined) S[k] = d[k];
  renderSide();
  refreshCards();
  renderChips();
}

// ---------------------------------------------------------------- transcript
function cardHTML(a) {
  const dir = a.direction === "in" ? "in" : "out";
  const to = a.direction === "in" ? "from" : "to";
  const checks = (a.checks || []).map((c) => `<li class="${c.level}" title="${esc(c.detail || "")}">${esc(c.label)}</li>`).join("");
  const can = a.status === "pending" || a.status === "failed";
  const result =
    a.status === "done"
      ? `<div class="result">
          <span>${a.dryRun ? "DRY-RUN" : "PayPal sandbox"} · ${esc(a.paypalApi || "")} · <b>${esc(a.paypalId || "")}</b> · ${esc(a.paypalStatus || "")}</span>
          ${a.link ? `<a class="btn xs ghost" href="${esc(a.link)}" target="_blank" rel="noopener">Open PayPal checkout ↗</a>` : ""}
          ${a.fallback ? `<span class="fb">↪ ${esc(a.fallback)}</span>` : ""}
        </div>`
      : a.status === "failed"
        ? `<div class="result"><span class="err">${esc(a.error)}</span></div>`
        : "";
  return `<article class="card ${dir} ${a.status}" data-id="${a.id}">
    <div class="card-top"><span class="kind">${KIND[a.kind] || a.kind}</span><span class="state ${a.status}">${STATE[a.status] || a.status}</span></div>
    <div class="amt">${fmt(a.amount)}<small>${a.currency}</small></div>
    <div class="party">${to} <strong>${esc(a.counterparty?.name || a.counterparty?.email || "customer")}</strong> ${a.counterparty?.email ? `<span class="mono">${esc(a.counterparty.email)}</span>` : ""}</div>
    <div class="party muted">${esc(a.note)}</div>
    ${a.items?.length ? `<ul class="items">${a.items.map((i) => `<li><span>${esc(i.name)} <span class="mono">${esc(i.email)}</span></span><span class="muted">${esc(i.note.replace("Payment for ", ""))}</span><b>${fmt(i.amount)}</b></li>`).join("")}</ul>` : ""}
    <ul class="checks">${checks}</ul>
    <details class="req"><summary>View PayPal request · ${esc(a.request?.method)} ${esc(a.request?.path)}</summary><pre>${esc(JSON.stringify(a.request?.body ?? {}, null, 2))}</pre></details>
    ${result}
    ${
      can
        ? `<div class="card-actions">
            <button class="btn ok" data-confirm="${a.id}">${a.status === "failed" ? "Retry" : "Confirm & send"}</button>
            <button class="btn ghost" data-cancel="${a.id}">Cancel</button>
            <span class="muted small">Idempotency key ${esc(a.idempotencyKey)}</span>
          </div>`
        : a.status === "blocked"
          ? `<div class="card-actions"><button class="btn ghost" data-cancel="${a.id}">Discard</button><span class="muted small">Fix the red check, then ask again.</span></div>`
          : ""
    }
  </article>`;
}

function traceHTML(trace) {
  if (!trace?.length) return "";
  const rows = trace
    .map((t) => `<li class="${t.ok ? "" : "bad"}"><b>${esc(t.tool)}</b><i>${t.ms ?? 0}ms</i><span>${esc(JSON.stringify(t.output ?? "")).slice(0, 160)}</span></li>`)
    .join("");
  return `<details class="trace"><summary>agent trace · ${trace.length} step${trace.length > 1 ? "s" : ""}</summary><ol>${rows}</ol></details>`;
}

function addMsg(m) {
  const log = $("#log");
  $(".hero", log)?.remove();
  const el = document.createElement("div");
  el.className = `msg ${m.role === "user" ? "user" : "agent"}`;
  const cards = (m.actionIds || []).map((id) => S.actions.find((a) => a.id === id)).filter(Boolean);
  el.innerHTML = `<div class="who">${m.role === "user" ? "You" : "Agent"}<br><span class="muted">${time(m.ts || Date.now())}</span></div>
    <div class="body">${m.role === "user" ? esc(m.content) : md(m.content)}
      ${cards.length ? `<div class="cards">${cards.map(cardHTML).join("")}</div>` : ""}
      ${m.role !== "user" ? traceHTML(m.trace) : ""}
    </div>`;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

function refreshCards() {
  document.querySelectorAll(".card[data-id]").forEach((el) => {
    const a = S.actions.find((x) => x.id === el.dataset.id);
    if (a) el.outerHTML = cardHTML(a);
  });
}

function hero() {
  $("#log").innerHTML = `<div class="hero">
    <h2>Your crew did the work.<br><em>Let the agent settle up.</em></h2>
    <p>Tell JobPay what happened on a job, the way you'd text your office manager. It logs the job, works out the worker's pay and your margin, then drafts a <strong>PayPal Payout</strong> to the worker and a <strong>PayPal invoice or checkout link</strong> to the customer. Nothing moves until you press Confirm.</p>
    <div class="steps">
      <div class="step"><b>01 Onboard</b><span>Add workers with their PayPal email and rate.</span></div>
      <div class="step"><b>02 Close out</b><span>Describe the finished job in one sentence.</span></div>
      <div class="step"><b>03 Approve</b><span>Policy-checked drafts wait for your OK.</span></div>
      <div class="step"><b>04 Reconcile</b><span>Live PayPal status, margins and books.</span></div>
    </div>
    <p class="muted small">Start with <strong>Load demo crew</strong> below, or type your own.</p>
  </div>`;
}

async function send(text) {
  text = text.trim();
  if (!text || busy) return;
  busy = true;
  $("#sendBtn").disabled = true;
  addMsg({ role: "user", content: text, ts: Date.now() });
  $("#input").value = "";
  autosize();
  const wait = document.createElement("div");
  wait.className = "msg agent";
  wait.innerHTML = `<div class="who">Agent</div><div class="body"><div class="typing"><span></span><span></span><span></span></div></div>`;
  $("#log").appendChild(wait);
  $("#log").scrollTop = $("#log").scrollHeight;
  try {
    const d = await api("/api/chat", { message: text });
    wait.remove();
    absorb(d);
    addMsg({ role: "assistant", content: d.reply, actionIds: d.actionIds, trace: d.trace, ts: Date.now() });
  } catch (e) {
    wait.remove();
    addMsg({ role: "assistant", content: "Something went wrong: " + e.message, ts: Date.now() });
  } finally {
    busy = false;
    $("#sendBtn").disabled = false;
    if (matchMedia("(pointer:fine)").matches) $("#input").focus();
  }
}

async function act(id, verb, btn) {
  if (btn) {
    btn.disabled = true;
    btn.textContent = verb === "confirm" ? "Sending to PayPal…" : "Canceling…";
  }
  try {
    const d = await api(`/api/actions/${id}/${verb}`, {});
    absorb(d);
    if (verb === "confirm") addMsg({ role: "assistant", content: d.reply, actionIds: [], trace: d.trace, ts: Date.now() });
  } catch (e) {
    addMsg({ role: "assistant", content: "Couldn't do that: " + e.message, ts: Date.now() });
    if (btn) btn.disabled = false;
  }
}

// ---------------------------------------------------------------- side panels
function setVal(id, v) {
  const el = $(id);
  if (el.textContent !== v) {
    el.textContent = v;
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
  }
}

function renderSide() {
  const t = S.totals || {};
  const m = S.meta || {};
  setVal("#tPaid", fmt0(t.paidOut));
  setVal("#tBilled", fmt0(t.billed));
  setVal("#tMargin", fmt0(t.grossMargin));
  setVal("#tPending", String(t.pending || 0));
  setVal("#tCap", m.limits ? fmt0(m.limits.dailyPayoutCap - (t.paidToday || 0)) : "$—");
  const badge = $("#tabBadge");
  badge.hidden = !t.pending;
  badge.textContent = t.pending || "";

  const mp = $("#modePill");
  mp.className = "pill " + (m.dryRun ? "dry" : "live");
  mp.textContent = m.publicDemo ? "Public demo · dry-run" : m.dryRun ? "Dry-run · no keys" : "PayPal sandbox · live";
  mp.title = m.publicDemo ? "This hosted demo never calls PayPal: every request body is real, nothing is sent." : "";
  $("#plannerPill").textContent = m.planner && m.planner !== "offline" ? m.planner.replace("llm:", "LLM · ") : "Rule-based planner";
  $("#plannerPill").title = m.planner && m.planner !== "offline" ? "LLM tool-calling with rule-based fallback" : "No language model is configured; a deterministic rule-based parser plans the tools.";

  // crew
  const earned = {};
  for (const a of S.actions) {
    if (a.status !== "done") continue;
    if (a.kind === "payout") earned[a.counterparty.email] = (earned[a.counterparty.email] || 0) + a.amount;
    if (a.kind === "payroll") for (const i of a.items || []) earned[i.email] = (earned[i.email] || 0) + i.amount;
  }
  $("#crewCount").textContent = S.workers.length ? `${S.workers.length} on payroll` : "";
  $("#crew").innerHTML = S.workers.length
    ? S.workers
        .map(
          (w) => `<li><div class="av">${esc(w.name[0])}</div>
            <div style="min-width:0"><div class="nm">${esc(w.name)}</div><div class="sub">${esc(w.trade || "crew")}${w.rate ? ` · ${fmt0(w.rate)}/${w.rateUnit === "job" ? "job" : "hr"}` : ""} · ${esc(w.email || "")}</div></div>
            <div class="earned">${fmt0(earned[w.email] || 0)}<small>paid</small></div></li>`
        )
        .join("")
    : `<li class="empty" style="display:block;border:0;background:none">No crew yet — tap “Load demo crew”.</li>`;
  const L = m.limits || {};
  $("#rails").innerHTML = [
    ["Environment", m.mode === "sandbox" ? "Sandbox only (live locked)" : m.mode],
    ["Per-payout cap", fmt0(L.maxPayout)],
    ["Daily payout cap", fmt0(L.dailyPayoutCap)],
    ["Invoice cap", fmt0(L.maxInvoice)],
    ["Duplicate detection", "On"],
    ["Human approval", "Required for every dollar"],
  ]
    .map(([k, v]) => `<li><span>${k}</span><b>${esc(v)}</b></li>`)
    .join("");

  // feed
  $("#feed").innerHTML = S.activity.length
    ? S.activity.map((x) => `<li class="${x.kind}"><time>${time(x.ts)}</time><span class="dot"></span><span>${esc(x.text)}</span></li>`).join("")
    : `<li class="empty" style="display:block">Activity shows up here as the agent works.</li>`;

  renderGrid();
}

function rows() {
  return S.actions
    .filter((a) => a.status !== "canceled")
    .map((a) => ({
      when: a.executedAt || a.createdAt,
      type: a.kind.replace("_", " "),
      party: a.counterparty?.name || a.counterparty?.email || "—",
      amount: a.direction === "out" ? -a.amount : a.amount,
      status: a.status === "done" ? a.paypalStatus || "SENT" : a.status.toUpperCase(),
      paypalId: a.paypalId || "",
      api: a.paypalApi || "",
    }));
}

function renderGrid() {
  const el = $("#grid");
  const data = rows();
  const net = data.filter((r) => !/PENDING$|BLOCKED|FAILED/.test(r.status) || r.paypalId).reduce((n, r) => n + (r.paypalId ? r.amount : 0), 0);
  if (window.agGrid?.createGrid) {
    if (!grid) {
      el.classList.remove("fallback");
      el.innerHTML = "";
      const theme = agGrid.themeQuartz.withParams({
        backgroundColor: "#161410",
        foregroundColor: "#f1ebdd",
        headerBackgroundColor: "#1d1a15",
        headerTextColor: "#8f8778",
        borderColor: "#2b2721",
        accentColor: "#ffb547",
        oddRowBackgroundColor: "#13110e",
        rowHoverColor: "#221e17",
        fontFamily: "Inter Tight, system-ui, sans-serif",
        headerFontFamily: "JetBrains Mono, monospace",
        headerFontSize: 10.5,
        fontSize: 13,
        spacing: 6,
        wrapperBorderRadius: 12,
      });
      grid = agGrid.createGrid(el, {
        theme,
        rowData: data,
        pinnedBottomRowData: [{ type: "Net", party: "billed − paid", amount: net }],
        animateRows: true,
        overlayNoRowsTemplate: '<span style="color:#8f8778">Payouts, invoices and payment links land here.</span>',
        defaultColDef: { sortable: true, resizable: true, filter: false, minWidth: 70 },
        columnDefs: [
          { field: "type", headerName: "Type", width: 100, filter: true, cellStyle: { textTransform: "capitalize" } },
          { field: "party", headerName: "Counterparty", flex: 1, minWidth: 110 },
          {
            field: "amount", headerName: "Amount", width: 112, type: "rightAligned",
            valueFormatter: (p) => (p.value < 0 ? "−" : "+") + fmt(Math.abs(p.value || 0)),
            cellStyle: (p) => ({ color: p.value < 0 ? "#ff7a4d" : "#7fd99a", fontFamily: "JetBrains Mono, monospace" }),
          },
          {
            field: "status", headerName: "Status", width: 150, filter: true,
            cellStyle: (p) => ({ fontFamily: "JetBrains Mono, monospace", fontSize: "11.5px", color: /BLOCKED|FAILED/.test(p.value || "") ? "#ff5d5d" : /PENDING|AWAIT|ACTION/.test(p.value || "") ? "#ffb547" : "#7fd99a" }),
          },
          { field: "paypalId", headerName: "PayPal ID", width: 170, cellStyle: { fontFamily: "JetBrains Mono, monospace", fontSize: "11.5px" } },
          { field: "api", headerName: "API", width: 96 },
          { field: "when", headerName: "Time", width: 92, sort: "desc", valueFormatter: (p) => (p.value ? time(p.value) : "") },
        ],
      });
    } else {
      grid.setGridOption("rowData", data);
      grid.setGridOption("pinnedBottomRowData", [{ type: "Net", party: "billed − paid", amount: net }]);
    }
    return;
  }
  el.classList.add("fallback");
  el.innerHTML = data.length
    ? `<table><thead><tr><th>Type</th><th>Counterparty</th><th>Amount</th><th>Status</th><th>PayPal ID</th></tr></thead><tbody>${data
        .map((r) => `<tr><td>${esc(r.type)}</td><td>${esc(r.party)}</td><td class="mono">${r.amount < 0 ? "−" : "+"}${fmt(Math.abs(r.amount))}</td><td class="mono">${esc(r.status)}</td><td class="mono">${esc(r.paypalId)}</td></tr>`)
        .join("")}</tbody></table>`
    : `<div class="empty">Payouts, invoices and payment links land here.</div>`;
}

// ---------------------------------------------------------------- chips
function renderChips() {
  const chips = [];
  const pending = S.actions.filter((a) => a.status === "pending").length;
  const w = S.workers;
  if (pending) chips.push([pending > 1 ? "Confirm all" : "Confirm", true], ["Cancel", false]);
  if (!w.length) {
    chips.push(["Load demo crew", !pending], ["Onboard Maria Lopez, plumber, maria.lopez@example.com, $45/hr", false]);
  } else {
    const m = w[0].name.split(" ")[0];
    chips.push([`${m} finished the water heater repair for Bob Smith bob.smith@example.com, 3 hours, charge $240`, !pending]);
    if (w[1]) chips.push([`${w[1].name.split(" ")[0]} finished the fence repair for Ana Ruiz, charge $180`, false]);
    if (S.jobs.some((j) => j.workerPay && j.status !== "worker_paid" && j.status !== "closed")) chips.push(["Run payroll", false]);
    chips.push(["Send a payment link to Ana Ruiz for $99 deposit", false]);
  }
  if (S.actions.some((a) => a.status === "done")) chips.push(["Status", false], ["Show my books", false]);
  chips.push(["Who's on my crew", false], ["Help", false]);
  $("#chips").innerHTML = chips.slice(0, 7).map(([t, hot]) => `<button class="chip ${hot ? "hot" : ""}" type="button">${esc(t)}</button>`).join("");
}

// ---------------------------------------------------------------- wiring
function autosize() {
  const t = $("#input");
  t.style.height = "";
  if (t.value) t.style.height = Math.min(t.scrollHeight, 160) + "px";
}

function setTab(tab) {
  document.body.dataset.tab = tab;
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  if (tab === "ledger" && grid) setTimeout(() => grid.sizeColumnsToFit?.(), 30);
}

document.addEventListener("click", (e) => {
  const c = e.target.closest("[data-confirm]");
  if (c) return act(c.dataset.confirm, "confirm", c);
  const x = e.target.closest("[data-cancel]");
  if (x) return act(x.dataset.cancel, "cancel", x);
  const chip = e.target.closest(".chip");
  if (chip) return send(chip.textContent);
  const tab = e.target.closest(".tabs button");
  if (tab) return setTab(tab.dataset.tab);
});
$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  send($("#input").value);
});
$("#input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send($("#input").value);
  }
});
$("#input").addEventListener("input", autosize);
$("#demoBtn").addEventListener("click", () => send("Load demo crew"));
$("#refreshBtn").addEventListener("click", async () => {
  const b = $("#refreshBtn");
  b.disabled = true;
  b.textContent = "↻ Checking PayPal…";
  try {
    absorb(await api("/api/refresh", {}));
  } finally {
    b.disabled = false;
    b.textContent = "↻ Live PayPal status";
  }
});
$("#resetBtn").addEventListener("click", async () => {
  if (!confirm("Start a fresh session? Sandbox history stays in PayPal.")) return;
  grid?.destroy?.();
  grid = null;
  S = { actions: [], workers: [], jobs: [], activity: [], totals: {}, messages: [], meta: S.meta };
  absorb(await api("/api/reset", {}));
  hero();
});

(async function boot() {
  setTab("chat");
  if (innerWidth < 560) $("#input").placeholder = "Tell me about a job, a payment, or a worker…";
  try {
    const d = await api(`/api/state?sessionId=${encodeURIComponent(sessionId)}`);
    S.messages = d.messages || [];
    absorb(d);
    if (!S.messages.length) hero();
    else S.messages.forEach(addMsg);
  } catch (e) {
    hero();
  }
  // AG Grid loads from CDN (deferred); re-render once it's there, fall back to a table offline.
  let tries = 0;
  const wait = setInterval(() => {
    if (window.agGrid || ++tries > 40) {
      clearInterval(wait);
      renderGrid();
    }
  }, 150);
  const p = new URLSearchParams(location.search);
  if (p.has("paid")) addMsg({ role: "assistant", content: "✅ PayPal sent you back after the customer approved checkout. Say **capture** to collect the funds, or **status** to check.", ts: Date.now() });
})();
