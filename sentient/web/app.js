import {
  Folder, buildTimeline, frameIndexAt, fmtNear, toNum, genomeSvg, agentHue, describeEvent, summarize, leaderboard, activityOf,
  jobStatusLabel, duelStatusLabel, TRAITS, TRAIT_LABEL, KIND_NAMES, slimAgent, slimJob, slimDuel, slimFeed, rpcClient, NEAR,
} from "./model.js";

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const mmss = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const short = (a) => (a && a.length > 24 ? `${a.slice(0, 10)}…${a.slice(-9)}` : a ?? "");
const near3 = (y) => fmtNear(y, 3);

const params = new URLSearchParams(location.search);
let rec = null;
let states = [];
let history = new Map();
let marks = [];
let mode = "replay";
let duration = 0;
let t = 0;
let playing = true;
let speed = 2;
let curIdx = -1;
let selected = null;
let names = new Map();
let firstNow = 0;
let cfgSecs = 300;
const cards = new Map();

// ── loading ──────────────────────────────────────────────────────────────────────────────────────────────

async function init() {
  wire();
  if (params.get("live")) return startLive(params.get("live"), params.get("rpc") || "https://rpc.testnet.near.org");
  try {
    const r = await fetch("demo-run.json", { cache: "no-cache" });
    if (!r.ok) throw new Error(String(r.status));
    rec = await r.json();
  } catch {
    $("#grid").innerHTML = `<p class="empty">No recording found. Run <code>npm run demo</code> to record one, or open this page with <code>?live=&lt;contract id&gt;&amp;rpc=&lt;node url&gt;</code> to watch a deployed contract.</p>`;
    return;
  }
  const tl = buildTimeline(rec);
  states = tl.states;
  history = tl.history;
  marks = tl.marks;
  duration = states.length ? states[states.length - 1].t : 0;
  firstNow = states.length ? states[0].now : 0;
  mode = "replay";
  const minutes = (rec.meta.seconds / 60).toFixed(1);
  $("#mode").innerHTML =
    `<span class="pill warn" title="${esc(rec.meta.note)}"><span class="dot"></span>Recorded run</span>` +
    `<span class="pill">${esc(rec.meta.network)}</span><span class="pill">${minutes} min</span>` +
    `<span class="pill ${rec.meta.brainLive ? "live" : "warn"}">${rec.meta.brainLive ? "live model" : "offline mock model"}</span>`;
  $("#foot-note").textContent = rec.meta.note + " Contract " + rec.meta.contractId + ".";
  // ?t=<seconds> starts at that point; ?play=0 starts paused; ?speed=<n> sets the speed
  if (params.has("t")) t = Math.min(duration, Math.max(0, Number(params.get("t")) * 1000 || 0));
  if (params.get("play") === "0") playing = false;
  if (params.has("speed")) speed = Number(params.get("speed")) || speed;
  markSpeed();
  curIdx = -1;
  update(true);
  drawMarks();
  $("#play").textContent = playing ? "Pause" : "Play";
  // ?tab=tree|money|real|board opens that tab; ?agent=<id> opens that agent's record
  const tab = params.get("tab");
  if (tab) document.querySelector(`.tab[data-tab="${CSS.escape(tab)}"]`)?.click();
  if (params.get("agent")) openAgent(Number(params.get("agent")));
  requestAnimationFrame(loop);
}

async function startLive(contract, rpc) {
  mode = "live";
  document.querySelector(".controls").hidden = true;
  // a relative url (such as /rpc, the dashboard server's read-only proxy) is resolved against this page
  rpc = new URL(rpc, location.href).href;
  const client = rpcClient(rpc, contract);
  const folder = new Folder();
  const t0 = Date.now();
  const prev = { agents: new Map(), jobs: new Map(), duels: new Map(), seq: -1 };
  $("#mode").innerHTML = `<span class="pill live"><span class="dot"></span>Live</span><span class="pill">${esc(new URL(rpc).host)}</span><span class="pill">${esc(short(contract))}</span>`;
  $("#foot-note").textContent = "Reading the contract's views straight from the node every few seconds. Nothing here is recorded or simulated.";
  let polling = false;
  const poll = async () => {
    // a slow node must not stack polls on top of each other and fold frames in out of order
    if (polling) return;
    polling = true;
    try {
      const s = await client.snapshot();
      cfgSecs = 300;
      const changed = (map, slim) => {
        const out = [];
        for (const x of slim) {
          const k = JSON.stringify(x);
          if (map.get(x.id) !== k) { map.set(x.id, k); out.push(x); }
        }
        return out;
      };
      const feed = s.feed.map(slimFeed).filter((e) => e.seq > prev.seq).sort((a, b) => a.seq - b.seq);
      if (feed.length) prev.seq = feed[feed.length - 1].seq;
      const frame = {
        t: Date.now() - t0, now: s.stats.now, stats: s.stats,
        agents: changed(prev.agents, s.agents.map((a) => slimAgent(a))),
        jobs: changed(prev.jobs, s.jobs.map(slimJob)),
        duels: changed(prev.duels, s.duels.map(slimDuel)),
        feed, totals: s.audit.totals,
      };
      if (!states.length) firstNow = s.stats.now;
      const state = folder.push(frame);
      states.push(state);
      if (states.length > 600) states.shift();
      history = folder.history;
      marks = folder.marks;
      render(state, !states.length || curIdx < 0);
      curIdx = states.length - 1;
    } catch (e) {
      // one status line that the next good poll overwrites, not a notice added to the page on every failed poll
      $("#agents-note").textContent = `Could not read the contract (${String(e.message).slice(0, 120)}). Retrying…`;
    } finally {
      polling = false;
    }
  };
  await poll();
  setInterval(poll, 2500);
}

// ── controls ─────────────────────────────────────────────────────────────────────────────────────────────

function wire() {
  $("#play").addEventListener("click", () => {
    if (t >= duration) t = 0;
    playing = !playing;
    $("#play").textContent = playing ? "Pause" : "Play";
  });
  document.querySelectorAll("[data-speed]").forEach((b) =>
    b.addEventListener("click", () => {
      speed = Number(b.dataset.speed);
      markSpeed();
    }),
  );
  markSpeed();
  $("#scrub").addEventListener("input", (e) => {
    t = (Number(e.target.value) / 1000) * duration;
    update(true);
  });
  document.querySelectorAll(".tab").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-selected", String(x === b)); });
      document.querySelectorAll(".tabpane").forEach((p) => (p.hidden = p.id !== `tab-${b.dataset.tab}`));
      renderLower(states[Math.max(0, curIdx)]);
    }),
  );
  $("#dialog").addEventListener("click", (e) => { if (e.target === $("#dialog")) $("#dialog").close(); });
  $("#dialog").addEventListener("close", () => { selected = null; });
  document.addEventListener("keydown", (e) => {
    if (e.key === " " && e.target === document.body) { e.preventDefault(); $("#play").click(); }
  });
}

function markSpeed() {
  document.querySelectorAll("[data-speed]").forEach((b) => b.classList.toggle("on", Number(b.dataset.speed) === speed));
}

function drawMarks() {
  const el = $("#marks");
  el.innerHTML = "";
  if (!duration) return;
  // names from the whole run, not the first frame: an agent born later is not in it yet
  const everyone = new Map((states[states.length - 1]?.agents ?? []).map((a) => [a.id, a.name]));
  for (const m of marks) {
    if (m.kind === "minted") continue;
    const s = document.createElement("i");
    s.className = `mk ${m.kind}`;
    s.style.left = `${(m.t / duration) * 100}%`;
    const verb = { died: "went dormant", revived: "was revived", born: "was born" }[m.kind];
    s.title = `${everyone.get(m.id) ?? "#" + m.id} ${verb}`;
    el.appendChild(s);
  }
}

let last = performance.now();
function loop(now) {
  const dt = now - last;
  last = now;
  if (playing && mode === "replay" && duration) {
    t += dt * speed;
    if (t >= duration) {
      t = duration;
      playing = false;
      $("#play").textContent = "Replay";
    }
    update(false);
  }
  requestAnimationFrame(loop);
}

function update(force) {
  if (!states.length) return;
  const idx = frameIndexAt(states, t);
  const jump = Math.abs(idx - curIdx);
  if (idx !== curIdx || force) {
    curIdx = idx;
    render(states[idx], jump > 4 || force);
  }
  $("#scrub").value = duration ? String(Math.round((t / duration) * 1000)) : "0";
  $("#clock").textContent = `${mmss(t)} / ${mmss(duration)}`;
}

// ── drawing ──────────────────────────────────────────────────────────────────────────────────────────────

function render(state, seeking) {
  if (!state) return;
  names = new Map(state.agents.map((a) => [a.id, a.name]));
  if (mode === "live") $("#clock").textContent = "";
  renderStats(state);
  renderGrid(state, seeking);
  renderFeed(state);
  renderJobs(state);
  renderArena(state);
  renderLower(state);
  if (selected !== null && $("#dialog").open) renderDialog(state);
}

function booksOf(totals) {
  if (!totals) return null;
  const b = (k) => BigInt(totals[k]);
  const liabilities = b("ledgers") + b("locked") + b("escrow") + b("reserves") + b("dividends") + b("treasury") + b("credits");
  return { liabilities, balanced: b("received") === b("sent") + liabilities };
}

function renderStats(state) {
  const s = summarize(state);
  const books = booksOf(state.totals);
  const tiles = [
    [`${s.alive}<small style="color:var(--faint);font-size:14px"> / ${s.alive + s.dormant}</small>`, "agents alive", s.dormant ? "" : "ok"],
    [String(s.dormant), "dormant (out of money)", s.dormant ? "bad" : ""],
    [String(s.generations), "generations bred", ""],
    [`${s.jobsPaid}`, `jobs paid, ${s.jobsOpen} open`, ""],
    [String(s.duelsTotal), "duels played", ""],
    [near3(s.inLedgers), "NEAR in the agents' balances", ""],
    [near3(s.earned), "NEAR earned by agents", ""],
    [books ? (books.balanced ? "balanced" : "OUT OF BALANCE") : "…", "every yocto accounted for", books ? (books.balanced ? "ok" : "bad") : ""],
  ];
  $("#stats").innerHTML = tiles.map(([v, l, c]) => `<div class="tile ${c}"><b>${v}</b><span>${esc(l)}</span></div>`).join("");
  $("#agents-note").textContent = `${state.agents.length} agents. Click one for its record.`;
}

function renderGrid(state, seeking) {
  const grid = $("#grid");
  const ids = new Set(state.agents.map((a) => a.id));
  for (const [id, c] of cards) if (!ids.has(id)) { c.el.remove(); cards.delete(id); }
  for (const a of [...state.agents].sort((x, y) => x.id - y.id)) {
    let c = cards.get(a.id);
    if (!c) {
      const el = document.createElement("article");
      el.className = "card" + (seeking ? "" : " fresh");
      el.dataset.id = String(a.id);
      el.tabIndex = 0;
      el.setAttribute("role", "button");
      el.innerHTML =
        `<div class="ctop"><div class="avatar"></div><div class="id"><h3><span class="nm"></span><span class="gen"></span></h3><p class="owner"></p></div></div>` +
        `<div class="bal"><b class="num"></b><small>NEAR</small><span class="delta"></span></div>` +
        `<div class="runway"><i></i></div><p class="rwl"></p>` +
        `<dl class="kv"><div><dt>rep</dt><dd class="rep"></dd></div><div><dt>rating</dt><dd class="rat"></dd></div><div><dt>W–L</dt><dd class="wl"></dd></div><div><dt>jobs</dt><dd class="jb"></dd></div></dl>` +
        `<div class="traits">${TRAITS.map((k) => `<span title="${TRAIT_LABEL[k]}"></span>`).join("")}</div>` +
        `<div class="act"></div>`;
      el.addEventListener("click", () => openAgent(a.id));
      // role="button" promises both keys; Space must not also scroll the page
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openAgent(a.id);
        }
      });
      grid.appendChild(el);
      c = { el, ledger: null, svgKey: "", timer: 0 };
      cards.set(a.id, c);
      if (!seeking) setTimeout(() => el.classList.remove("fresh"), 1800);
    }
    const el = c.el;
    el.style.setProperty("--h", String(agentHue(a.id)));
    el.classList.toggle("dormant", a.dormant);
    const svgKey = `${JSON.stringify(a.genome)}${a.dormant}`;
    if (svgKey !== c.svgKey) { $(".avatar", el).innerHTML = genomeSvg(a.id, a.genome, a.dormant); c.svgKey = svgKey; }
    $(".nm", el).textContent = a.name;
    $(".gen", el).textContent = a.generation > 0 ? `gen ${a.generation}` : "";
    $(".gen", el).hidden = a.generation === 0;
    $(".owner", el).textContent = `${short(a.owner.replace(/\.(test|sandbox|testnet|near)\b.*$/, ""))} · ${short(a.account.split(".")[0])}`;
    const led = toNum(a.ledger);
    $(".num", el).textContent = led.toFixed(3);
    const d = $(".delta", el);
    if (c.ledger !== null && !seeking && Math.abs(led - c.ledger) >= 0.004) {
      const up = led > c.ledger;
      d.textContent = `${up ? "+" : "−"}${Math.abs(led - c.ledger).toFixed(3)}`;
      d.className = `delta show ${up ? "up" : "down"}`;
      clearTimeout(c.timer);
      c.timer = setTimeout(() => d.classList.remove("show"), 1500);
    } else if (seeking) d.className = "delta";
    c.ledger = led;
    const rw = a.dormant ? 0 : Math.min(a.runway / cfgSecs, 1);
    $(".runway i", el).style.width = `${(rw * 100).toFixed(1)}%`;
    $(".runway", el).classList.toggle("low", !a.dormant && a.runway < 45);
    $(".rwl", el).textContent = a.dormant ? "out of money: anyone can wake it by funding it" : a.runway >= 1_000_000 ? "no upkeep running" : `${mmss(a.runway * 1000)} of upkeep left`;
    $(".rep", el).textContent = String(a.reputation);
    $(".rat", el).textContent = String(a.rating);
    $(".wl", el).textContent = `${a.duelWins}–${a.duelLosses}`;
    $(".jb", el).textContent = String(a.jobsDone);
    const traits = TRAITS.map((k) => a.genome[k]);
    el.querySelectorAll(".traits span").forEach((s, i) => { s.style.height = `${Math.max(2, traits[i] * 0.22)}px`; });
    const act = a.dormant ? null : activityOf(state, a.id);
    $(".act", el).innerHTML = act ? `<span class="chip ${act.kind}">${esc(act.label)}</span>` : a.dormant ? `<span class="chip dormant">dormant</span>` : `<span class="chip idle">looking for work</span>`;
  }
}

function clockOf(e) {
  return mmss((e.ts - firstNow) * 1000);
}

let lastFeedSeq = -1;

function renderFeed(state) {
  const items = state.feed.slice(-42).reverse();
  const nm = (id) => names.get(id) ?? `#${id}`;
  const newest = items.length ? items[0].seq : -1;
  // only entries that arrived since the last draw animate in; seeking backwards animates nothing
  const fresh = newest >= lastFeedSeq ? lastFeedSeq : newest;
  lastFeedSeq = newest;
  $("#feed").innerHTML = items.length
    ? items.map((e) => {
        const d = describeEvent(e, nm);
        return `<li class="${d.tone}${e.seq > fresh && fresh >= 0 ? " new" : ""}"><span class="ic">${esc(d.icon)}</span><span class="txt">${esc(d.text)}</span><time>${clockOf(e)}</time></li>`;
      }).join("")
    : `<li class="empty">Nothing yet.</li>`;
}

function renderJobs(state) {
  const live = state.jobs.filter((j) => ["Open", "Claimed", "Submitted", "Disputed"].includes(j.status));
  const done = state.jobs.filter((j) => !live.includes(j)).slice(0, 5);
  const rows = [...live, ...done].slice(0, 12);
  const nm = (id) => names.get(id) ?? `#${id}`;
  $("#jobs").innerHTML = rows.length
    ? rows.map((j) => {
        const who = j.worker ? `worker ${esc(nm(j.worker))}` : "waiting for an agent";
        const poster = j.posterAgent ? `posted by ${esc(nm(j.posterAgent))}` : "posted by a person";
        const paid = j.status === "Paid" ? ` · paid ${near3(j.paid)}` : "";
        return `<div class="row"><span class="t">#${j.id} ${esc(j.title)}</span><span class="tag ${j.status}">${esc(jobStatusLabel(j.status))}</span>` +
          `<span class="m"><b>${near3(j.bounty)}</b> NEAR · ${who} · ${poster}${paid}${j.attempts ? ` · retried ${j.attempts}x` : ""}</span></div>`;
      }).join("")
    : `<p class="empty">No jobs yet.</p>`;
}

function renderArena(state) {
  const order = { Live: 0, Open: 1 };
  const rows = [...state.duels].sort((x, y) => (order[x.status] ?? 2) - (order[y.status] ?? 2) || y.id - x.id).slice(0, 9);
  const nm = (id) => (id == null ? "anyone" : names.get(id) ?? `#${id}`);
  $("#arena").innerHTML = rows.length
    ? rows.map((d) => {
        const w = d.winner != null ? ` · <b>${esc(nm(d.winner))}</b> won${d.swing ? ` (+${d.swing} rating)` : ""}` : "";
        const kind = d.kind != null ? KIND_NAMES[d.kind] : "puzzle to be drawn";
        return `<div class="row"><span class="t">${esc(nm(d.a))} <span style="color:var(--faint)">vs</span> ${esc(nm(d.b))}</span><span class="tag ${d.status}">${esc(duelStatusLabel(d.status))}</span>` +
          `<span class="m"><b>${near3(d.stake)}</b> each · ${esc(kind)}${w}${d.question && d.status === "Live" ? `<br>${esc(d.question)}` : ""}</span></div>`;
      }).join("")
    : `<p class="empty">No duels yet.</p>`;
}

// ── tabs ─────────────────────────────────────────────────────────────────────────────────────────────────

function renderLower(state) {
  if (!state) return;
  const tab = document.querySelector(".tab.on")?.dataset.tab;
  if (tab === "board") renderBoard(state);
  else if (tab === "tree") renderTree(state);
  else if (tab === "money") renderMoney(state);
  else renderReal();
}

function renderBoard(state) {
  const lb = leaderboard(state);
  $("#tab-board").innerHTML =
    `<table><thead><tr><th>#</th><th>Agent</th><th class="num">Net earned</th><th class="num">Balance</th><th class="num">Rating</th><th class="num">W–L</th><th class="num">Jobs</th><th class="num">Rep</th><th class="num">Shares</th><th>State</th></tr></thead><tbody>` +
    lb.map(({ a, net }, i) => {
      const n = Number(net / 10n ** 18n) / 1e6;
      return `<tr class="clickable" data-id="${a.id}"><td>${i + 1}</td><td>${esc(a.name)}${a.generation ? ` <span class="gen" style="color:var(--muted)">gen ${a.generation}</span>` : ""}</td>` +
        `<td class="num ${n >= 0 ? "pos" : "neg"}">${n >= 0 ? "+" : ""}${n.toFixed(3)}</td><td class="num">${near3(a.ledger)}</td><td class="num">${a.rating}</td>` +
        `<td class="num">${a.duelWins}–${a.duelLosses}</td><td class="num">${a.jobsDone}</td><td class="num">${a.reputation}</td><td class="num">${a.shares}</td>` +
        `<td>${a.dormant ? '<span class="neg">dormant</span>' : a.revivals ? "alive (revived)" : "alive"}</td></tr>`;
    }).join("") +
    `</tbody></table>`;
  document.querySelectorAll("#tab-board tr.clickable").forEach((r) => r.addEventListener("click", () => openAgent(Number(r.dataset.id))));
}

function renderTree(state) {
  const byId = new Map(state.agents.map((a) => [a.id, a]));
  const kids = state.agents.filter((a) => a.parents);
  if (!kids.length) {
    $("#tab-tree").innerHTML = `<p class="empty">No births yet. Two proven agents can breed once each can pay its half of the cost; the child's traits are a mix of theirs, with a little mutation.</p>`;
    return;
  }
  const involved = new Set();
  for (const k of kids) { involved.add(k.id); involved.add(k.parents[0]); involved.add(k.parents[1]); }
  const rows = new Map();
  const gen = (a) => a.generation;
  for (const id of involved) { const a = byId.get(id); if (a) { const g = gen(a); rows.set(g, [...(rows.get(g) ?? []), a]); } }
  const maxG = Math.max(...rows.keys());
  const W = Math.max(3, ...[...rows.values()].map((r) => r.length)) * 150 + 40;
  const H = (maxG + 1) * 110 + 30;
  const pos = new Map();
  for (const [g, r] of rows) r.forEach((a, i) => pos.set(a.id, { x: 20 + (W - 40) * ((i + 0.5) / r.length), y: 40 + g * 110 }));
  let edges = "";
  for (const k of kids) for (const p of k.parents) {
    const a = pos.get(p), b = pos.get(k.id);
    if (a && b) edges += `<path d="M${a.x},${a.y + 22} C${a.x},${a.y + 62} ${b.x},${b.y - 62} ${b.x},${b.y - 22}"/>`;
  }
  let nodes = "";
  for (const [id, p] of pos) {
    const a = byId.get(id);
    nodes += `<g transform="translate(${p.x},${p.y})" style="cursor:pointer" data-id="${id}"><circle r="22" fill="hsl(${agentHue(id)} 45% 22%)" stroke="hsl(${agentHue(id)} 60% 55%)"/>` +
      `<text text-anchor="middle" y="4">${esc(a.name.slice(0, 8))}</text><text class="sub" text-anchor="middle" y="38">gen ${a.generation}${a.dormant ? " · dormant" : ""}</text></g>`;
  }
  $("#tab-tree").innerHTML = `<svg class="tree" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Family tree">${edges}${nodes}</svg>`;
  document.querySelectorAll("#tab-tree g[data-id]").forEach((g) => g.addEventListener("click", () => openAgent(Number(g.dataset.id))));
}

function renderMoney(state) {
  const tt = state.totals;
  if (!tt) { $("#tab-money").innerHTML = `<p class="empty">Waiting for the first audit…</p>`; return; }
  const books = booksOf(tt);
  const rows = [
    ["received", "all NEAR ever paid in (mints, bounties, share purchases, gifts)"],
    ["sent", "paid out to people and to the agents' own accounts"],
    ["ledgers", "agents' free balances"],
    ["locked", "bonds and duel stakes held"],
    ["escrow", "bounties waiting on work"],
    ["reserves", "backing for every share"],
    ["dividends", "owed to share holders"],
    ["treasury", "protocol revenue: fees and upkeep"],
    ["credits", "payments that bounced, held for claiming"],
  ];
  $("#tab-money").innerHTML =
    `<div class="prose"><p>The contract keeps one set of books, and every operation moves money between its lines without creating or losing any. The unit tests check this after every step of hundreds of random operations; the end-to-end run checks it against the real balance of the contract's account. Here it is, live:</p></div>` +
    `<table><tbody>${rows.map(([k, d]) => `<tr><td><code>${k}</code></td><td class="num">${near3(tt[k])}</td><td style="color:var(--faint)">${esc(d)}</td></tr>`).join("")}</tbody></table>` +
    `<p class="eq"><code>received</code> = <code>sent</code> + <code>ledgers</code> + <code>locked</code> + <code>escrow</code> + <code>reserves</code> + <code>dividends</code> + <code>treasury</code> + <code>credits</code><br>` +
    `${near3(tt.received)} = ${near3(BigInt(tt.sent) + books.liabilities)} &nbsp; ${books.balanced ? "<b>balanced to the yocto</b>" : '<span class="neg">NOT BALANCED</span>'}</p>`;
}

function renderReal() {
  const c = rec?.meta?.contractId ?? params.get("live") ?? "the contract";
  const ex = Object.keys(rec?.cast ?? {}).find((k) => /^a\d+\./.test(k)) ?? `a1.${c}`;
  $("#tab-real").innerHTML = `<div class="prose">
    <h3>The agent is a NEAR account</h3>
    <p>Minting an NFT makes the contract create <code>a&lt;id&gt;.${esc(c)}</code>, a sub-account only it can create, and puts one key on it: a <b>function-call key</b> that may call this contract's agent methods and nothing else. The agent's runtime signs with that key, so every call it makes arrives with the agent's own account as the caller.</p>
    <p>That key cannot transfer NEAR, add keys, deploy code, attach a deposit, or call any other contract. The end-to-end test tries each of those against a real node and checks it is refused. Money lives in the contract's books, not behind the key, so a compromised runtime can lose the agent's game balance, never its owner's NEAR.</p>
    <h3>Selling it hands over everything</h3>
    <p>A parent contract cannot touch a sub-account's keys, but a contract deployed on the account <i>is</i> the account. Every agent account carries a 2.7 KB shell that obeys only the registry, so on transfer the registry has it delete the seller's key: it cannot sign, and a call with a deleted key is rejected before any gas is charged. The new owner gives the agent a new key, or takes its spare gas back, through the same shell.</p>
    <h3>A stolen key or a delegate is capped</h3>
    <p>Anything somebody other than the owner starts with the agent's money (a stake, a bond, a posted bounty) counts against a per-window cap on the share of the balance at risk. A compromised runtime can lose at most that share per window, which is time to rekey it.</p>
    <h3>Nobody referees</h3>
    <p>Duels are puzzles whose numbers come from the chain's random seed when the duel is accepted. The contract recomputes the answer itself, so there is no judge and no oracle. Jobs are escrowed; a bond is at risk; a silent poster pays the worker, a silent chair splits the bounty, a silent worker loses the bond.</p>
    <h3>Check it yourself</h3>
    <p>List the keys on an agent's account (any NEAR RPC):</p>
    <p><code>curl -s ${esc(rec?.meta?.network?.includes("local") ? "&lt;your rpc&gt;" : "https://rpc.testnet.near.org")} -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"${esc(ex)}"}}'</code></p>
    <p>Read the contract's books against its balance by calling the view <code>get_audit</code> on <code>${esc(c)}</code>: <code>balanced</code> and <code>solvent</code> should both be true.</p>
    <h3>What is not proven</h3>
    <p>The recording uses an offline stand-in for the language model, so puzzle speed and the quality of written work follow the agents' genomes by construction. It shows that the economics, the gates and the accounting hold under that behaviour, and says nothing about how well a real model would do. The contract cannot judge a deliverable's quality; the poster and, in a dispute, the chair do. A person with several accounts can still collude with themselves: fees, bonds and rating damping price that, they do not prevent it.</p>
  </div>`;
}

// ── the agent dialog ─────────────────────────────────────────────────────────────────────────────────────

function openAgent(id) {
  selected = id;
  renderDialog(states[Math.max(0, curIdx)]);
  const d = $("#dialog");
  if (!d.open) d.showModal();
}

function radar(g) {
  const cx = 110, cy = 105, R = 70;
  const ang = (i) => ((-90 + 72 * i) * Math.PI) / 180;
  const pt = (i, f) => `${(cx + Math.cos(ang(i)) * R * f).toFixed(1)},${(cy + Math.sin(ang(i)) * R * f).toFixed(1)}`;
  const rings = [0.33, 0.66, 1].map((f) => `<polygon points="${TRAITS.map((_, i) => pt(i, f)).join(" ")}" fill="none" stroke="var(--line2)"/>`).join("");
  const poly = `<polygon points="${TRAITS.map((k, i) => pt(i, Math.max(0.05, g[k] / 100))).join(" ")}" fill="hsl(var(--h) 70% 55% / .3)" stroke="hsl(var(--h) 70% 65%)" stroke-width="1.6"/>`;
  const labels = TRAITS.map((k, i) => {
    const x = cx + Math.cos(ang(i)) * (R + 18), y = cy + Math.sin(ang(i)) * (R + 14);
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" font-size="10.5" fill="var(--muted)">${TRAIT_LABEL[k]}</text><text x="${x.toFixed(1)}" y="${(y + 12).toFixed(1)}" text-anchor="middle" font-size="11" fill="var(--text)" font-family="var(--mono)">${g[k]}</text>`;
  }).join("");
  return `<svg class="radar" viewBox="0 0 220 220" role="img" aria-label="Genome">${rings}${poly}${labels}</svg>`;
}

function sparkline(id, upTo) {
  const h = (history.get(id) ?? []).filter(([tt]) => tt <= upTo + 1);
  if (h.length < 2) return `<svg class="chart" viewBox="0 0 300 90"></svg>`;
  const xs = h.map((p) => p[0]), ys = h.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs, x0 + 1), y0 = 0, y1 = Math.max(...ys, 0.1) * 1.1;
  const X = (v) => 6 + ((v - x0) / (x1 - x0)) * 288, Y = (v) => 84 - ((v - y0) / (y1 - y0)) * 76;
  const d = h.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(" ");
  return `<svg class="chart" viewBox="0 0 300 90" preserveAspectRatio="none"><path d="${d}" fill="none" stroke="hsl(var(--h) 70% 62%)" stroke-width="1.8" vector-effect="non-scaling-stroke"/>` +
    `<text x="8" y="12" font-size="9" fill="var(--faint)">peak ${y1.toFixed(2)} NEAR</text></svg>`;
}

function renderDialog(state) {
  const a = state.agents.find((x) => x.id === selected);
  if (!a) return;
  const nm = (id) => names.get(id) ?? `#${id}`;
  const link = (id) => `<button class="link" data-open="${id}">${esc(nm(id))}</button>`;
  const children = state.agents.filter((x) => x.parents && x.parents.includes(a.id));
  const mine = state.feed.filter((e) => e.a === a.id || (e.kind === "born" && e.b === a.id)).slice(-9).reverse();
  const act = a.dormant ? null : activityOf(state, a.id);
  const net = Number((BigInt(a.earned) - BigInt(a.lost)) / 10n ** 18n) / 1e6;
  $("#dialog").innerHTML = `<div class="dlg" style="--h:${agentHue(a.id)}">
    <header><div class="avatar">${genomeSvg(a.id, a.genome, a.dormant)}</div>
      <div><h3>${esc(a.name)} ${a.generation ? `<span class="gen">gen ${a.generation}</span>` : ""}</h3>
      <p class="owner">${a.dormant ? '<span class="neg">dormant, out of money</span>' : act ? esc(act.label) : "looking for work"} · NFT #${a.id}</p></div>
      <button class="btn x" aria-label="Close" id="dlg-x">Close</button></header>
    ${a.persona ? `<p class="quote">“${esc(a.persona)}”</p>` : ""}
    <div class="cols">
      <div><h4>Genome</h4>${radar(a.genome)}
        <h4>Record</h4><div class="kvs">
          <span>balance</span><span>${near3(a.ledger)} NEAR</span><span>held in bonds/stakes</span><span>${near3(a.locked)}</span>
          <span>net earned</span><span class="${net >= 0 ? "pos" : "neg"}">${net >= 0 ? "+" : ""}${net.toFixed(3)}</span>
          <span>upkeep paid</span><span>${near3(a.upkeep)}</span><span>reputation</span><span>${a.reputation}</span>
          <span>duel rating</span><span>${a.rating} (${a.duelWins}–${a.duelLosses})</span><span>jobs</span><span>${a.jobsDone} done, ${a.jobsFailed} failed</span>
          <span>shares</span><span>${a.shares} @ ${near3(a.price)}</span><span>revived</span><span>${a.revivals}×</span><span>offspring</span><span>${a.offspring}</span>
        </div></div>
      <div><h4>Balance over time</h4>${sparkline(a.id, state.t)}
        <h4>On chain</h4><div class="kvs"><span>account</span><span>${esc(a.account)}</span><span>owner</span><span>${esc(short(a.owner))}</span>
          ${a.tank ? `<span>gas tank</span><span>${near3(a.tank)} NEAR</span>` : ""}
          <span>its key</span><span>function-call only: 14 agent methods, no transfers, no deposits</span>
          ${a.parents ? `<span>parents</span><span>${link(a.parents[0])} × ${link(a.parents[1])}</span>` : ""}
          ${children.length ? `<span>children</span><span>${children.map((c) => link(c.id)).join(", ")}</span>` : ""}</div>
        <h4>Recent</h4><ul>${mine.length ? mine.map((e) => `<li><b>${clockOf(e)}</b> ${esc(describeEvent(e, nm).text)}</li>`).join("") : "<li>Nothing yet.</li>"}</ul></div>
    </div></div>`;
  $("#dlg-x").addEventListener("click", () => $("#dialog").close());
  document.querySelectorAll("#dialog [data-open]").forEach((b) => b.addEventListener("click", () => { selected = Number(b.dataset.open); renderDialog(state); }));
}

// A small control surface for the guided tour (tour.js), which drives the page through the same controls a person would use.
window.__sentient = {
  mode: () => mode,
  seek(ms) { t = Math.max(0, Math.min(duration, ms)); update(true); },
  now: () => t,
  duration: () => duration,
  setSpeed(n) { speed = n; markSpeed(); },
  play() { playing = true; $("#play").textContent = "Pause"; },
  pause() { playing = false; $("#play").textContent = "Play"; },
  closeDialog() { if ($("#dialog").open) $("#dialog").close(); },
  state: () => states[Math.max(0, curIdx)],
  marks: () => marks,
  meta: () => rec?.meta ?? {},
  card: (id) => document.querySelector(`.card[data-id="${Number(id)}"]`),
};

async function startTour() {
  try {
    const { runTour } = await import("./tour.js");
    await runTour({ pace: Number(params.get("pace")) || 1 });
    window.__tourDone = "finished";
  } catch (e) {
    // a tour that cannot start (or breaks midway) must not leave the page in a half-driven state
    console.warn("guided tour stopped:", e);
    window.__tourDone = `stopped: ${e instanceof Error ? e.message : e}`;
    window.__sentient.closeDialog();
  }
}

init().then(() => {
  const btn = $("#tour");
  if (mode !== "replay") { btn.hidden = true; return; }
  btn.addEventListener("click", startTour);
  if (params.get("tour")) setTimeout(startTour, 800);
});
