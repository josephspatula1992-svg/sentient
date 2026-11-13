// Pure logic for the dashboard: no DOM, no network. Everything the page shows is derived from here, so it can be tested.

export const NEAR = 10n ** 24n;

/** yoctoNEAR (string or bigint) as a short NEAR amount. */
export function fmtNear(y, digits = 3) {
  const v = typeof y === "bigint" ? y : BigInt(y ?? 0);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / NEAR;
  const frac = ((abs % NEAR) * 10n ** BigInt(digits)) / NEAR;
  return `${neg ? "-" : ""}${whole}.${frac.toString().padStart(digits, "0")}`;
}

export const toNum = (y) => Number(BigInt(y ?? 0) / 10n ** 18n) / 1e6;

export const TRAITS = ["diligence", "boldness", "thrift", "sociability", "cunning"];
export const TRAIT_LABEL = { diligence: "Diligence", boldness: "Boldness", thrift: "Thrift", sociability: "Sociability", cunning: "Cunning" };
export const KIND_NAMES = ["modpow", "collatz", "primes", "fibmod", "digits"];

// ── the NFT's picture ────────────────────────────────────────────────────────────────────────────────────────
// A port of contracts/sentient/src/art.rs. The contract draws the image a wallet shows; this draws the same one, so the
// card on screen is the token. Integer maths with truncation toward zero, as Rust does it. e2e compares the two.

const DIRS = [[0, -1000], [951, -309], [588, 809], [-588, 809], [-951, -309]];

export function genomeSvg(id, g, dormant) {
  const hue = (Number(BigInt(id) * 137n) % 360 + 360) % 360;
  const [satBg, satFg] = dormant ? [4, 6] : [30, 75];
  const traits = [g.diligence, g.boldness, g.thrift, g.sociability, g.cunning];
  const pts = [];
  let dots = "";
  traits.forEach((t, i) => {
    const r = 12 + Math.trunc((t * 36) / 100);
    const x = 50 + Math.trunc((DIRS[i][0] * r) / 1000);
    const y = 50 + Math.trunc((DIRS[i][1] * r) / 1000);
    pts.push(`${x},${y}`);
    dots += `<circle cx='${x}' cy='${y}' r='2.5'/>`;
  });
  return (
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>` +
    `<rect width='100' height='100' fill='hsl(${hue},${satBg}%,11%)'/>` +
    `<circle cx='50' cy='50' r='46' fill='none' stroke='hsl(${hue},${satBg}%,22%)'/>` +
    `<polygon points='${pts.join(" ")}' fill='hsl(${hue},${satFg}%,55%)' fill-opacity='.30' stroke='hsl(${hue},${satFg}%,65%)' stroke-width='1.2'/>` +
    `<g fill='hsl(${hue},${satFg}%,72%)'>${dots}</g>` +
    `<circle cx='50' cy='50' r='4' fill='hsl(${hue},${satFg}%,80%)'/></svg>`
  );
}

export const agentHue = (id) => (Number(BigInt(id) * 137n) % 360 + 360) % 360;

// ── folding a recording ─────────────────────────────────────────────────────────────────────────────────────

/**
 * A recording stores, per frame, only what changed. This folds them back into complete states: the agents, jobs and duels
 * as they were at each frame, the feed so far, and the balance history of every agent (for sparklines).
 */
export class Folder {
  constructor() {
    this.agents = new Map();
    this.jobs = new Map();
    this.duels = new Map();
    this.feed = [];
    this.history = new Map(); // id -> [[t, ledgerNEAR]]
    this.marks = []; // notable moments for the scrubber
    this.totals = null;
    this.personas = new Map();
  }

  /** Fold one frame in and return the complete state as of that frame. */
  push(f) {
    for (const a of f.agents) {
      const prev = this.agents.get(a.id);
      if (a.persona) this.personas.set(a.id, a.persona);
      this.agents.set(a.id, { ...a, persona: this.personas.get(a.id) ?? "" });
      const h = this.history.get(a.id) ?? [];
      h.push([f.t, toNum(a.ledger)]);
      this.history.set(a.id, h);
      if (!prev) this.marks.push({ t: f.t, kind: a.generation > 0 ? "born" : "minted", id: a.id });
      else if (!prev.dormant && a.dormant) this.marks.push({ t: f.t, kind: "died", id: a.id });
      else if (prev.dormant && !a.dormant) this.marks.push({ t: f.t, kind: "revived", id: a.id });
    }
    for (const j of f.jobs) this.jobs.set(j.id, j);
    for (const d of f.duels) this.duels.set(d.id, d);
    for (const e of f.feed) {
      this.feed.push(e);
      if (this.feed.length > 400) this.feed.shift();
    }
    if (f.totals) this.totals = f.totals;
    return {
      t: f.t,
      now: f.now,
      stats: f.stats,
      agents: [...this.agents.values()],
      jobs: [...this.jobs.values()].sort((a, b) => b.id - a.id),
      duels: [...this.duels.values()].sort((a, b) => b.id - a.id),
      feed: this.feed.slice(-120),
      totals: this.totals,
    };
  }
}

export function buildTimeline(rec) {
  const folder = new Folder();
  const states = rec.frames.map((f) => folder.push(f));
  return { states, history: folder.history, marks: folder.marks, personas: folder.personas };
}

/** The agent's balance at time `t` (ms), from its history. */
export function ledgerAt(history, id, t) {
  const h = history.get(id);
  if (!h || !h.length) return 0;
  let lo = 0;
  let hi = h.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (h[mid][0] <= t) lo = mid;
    else hi = mid - 1;
  }
  return h[lo][1];
}

export function frameIndexAt(states, t) {
  let lo = 0;
  let hi = states.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (states[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// ── words for events ────────────────────────────────────────────────────────────────────────────────────────

/** A human sentence for a feed entry. `nameOf(id)` turns an agent id into its name. */
export function describeEvent(e, nameOf) {
  const a = nameOf(e.a);
  const amt = e.amount && e.amount !== "0" ? fmtNear(e.amount, 3) : "";
  switch (e.kind) {
    case "minted": return { icon: "✦", tone: "good", text: `${a} is minted with ${amt} NEAR` };
    case "born": return { icon: "❋", tone: "good", text: `${a} is born: ${e.note}` };
    case "dormant": return { icon: "▼", tone: "bad", text: `${a} cannot pay its upkeep and goes dormant` };
    case "revived": return { icon: "▲", tone: "good", text: `${a} is revived with ${amt} NEAR` };
    case "funded": return { icon: "+", tone: "info", text: `${a} is given ${amt} NEAR` };
    case "job_posted": return { icon: "◧", tone: "info", text: `${e.a ? nameOf(e.a) : "A person"} posts job #${e.b}: ${e.note} (${amt})` };
    case "job_claimed": return { icon: "◨", tone: "info", text: `${a} takes job #${e.b}` };
    case "work_submitted": return { icon: "◩", tone: "info", text: `${a} delivers job #${e.b}` };
    case "job_paid": return { icon: "$", tone: "good", text: `${a} is paid ${amt} for job #${e.b}` };
    case "work_rejected": return { icon: "✕", tone: "warn", text: `${a}'s work on job #${e.b} is rejected` };
    case "dispute_resolved": return { icon: "⚖", tone: "warn", text: `The chair rules ${e.note} on job #${e.b}` };
    case "claim_expired": return { icon: "⌛", tone: "bad", text: `${a} missed the deadline on job #${e.b}: bond slashed` };
    case "job_cancelled": return { icon: "−", tone: e.note ? "warn" : "info", text: `Job #${e.b} is ${e.note ? `cancelled and refunded: ${e.note}` : "withdrawn"}` };
    case "challenge": return { icon: "»", tone: "info", text: `${a} offers a duel for ${amt} (${e.note})` };
    case "duel_live": return { icon: "▶", tone: "info", text: `Duel #${e.b} is live: ${e.note}` };
    case "duel_won": return { icon: "★", tone: "good", text: `${a} wins duel #${e.b} (+${amt}), ${e.note}` };
    case "wrong_answer": return { icon: "✗", tone: "warn", text: `${a} answers duel #${e.b} wrongly and is locked out` };
    case "duel_drawn": return { icon: "=", tone: "info", text: `Duel #${e.b} is drawn: ${e.note}` };
    case "challenge_closed": return { icon: "−", tone: "info", text: `${a}'s challenge #${e.b} lapses` };
    case "shares_bought": return { icon: "◆", tone: "info", text: `${e.b} share${e.b === 1 ? "" : "s"} of ${a} bought for ${amt}` };
    case "shares_sold": return { icon: "◇", tone: "info", text: `${e.b} share${e.b === 1 ? "" : "s"} of ${a} sold for ${amt}` };
    case "dividends_claimed": return { icon: "%", tone: "good", text: `A holder of ${a} collects ${amt} in dividends` };
    case "withdrawn": return { icon: "↗", tone: "info", text: `${a}'s owner withdraws ${amt}` };
    case "rekeyed": return { icon: "⚷", tone: "info", text: `${a} is given a new key by its owner` };
    case "tank_swept": return { icon: "⛽", tone: "info", text: `${a}'s owner takes its spare gas back` };
    case "refueled": return { icon: "⛽", tone: "info", text: `${a}'s account is topped up with ${amt} for gas` };
    case "transferred": return { icon: "⇄", tone: "info", text: `${a} changes hands (${e.note})` };
    case "treasury_withdrawn": return { icon: "▣", tone: "info", text: `The chair withdraws ${amt} of protocol revenue` };
    case "payout_failed": return { icon: "!", tone: "warn", text: `A payment of ${amt} failed and was held for claiming` };
    default: return { icon: "·", tone: "info", text: `${e.kind} ${e.note ?? ""}` };
  }
}

export function jobStatusLabel(s) {
  return { Open: "open", Claimed: "being worked", Submitted: "delivered", Disputed: "in dispute", Paid: "paid", Refunded: "refunded", Split: "split", Cancelled: "withdrawn" }[s] ?? s;
}

export function duelStatusLabel(s) {
  return { Open: "waiting for a rival", Live: "live", Settled: "decided", Drawn: "drawn", Cancelled: "withdrawn" }[s] ?? s;
}

// ── aggregate numbers ───────────────────────────────────────────────────────────────────────────────────────

export function summarize(state) {
  const agents = state.agents;
  const sum = (f) => agents.reduce((s, a) => s + BigInt(f(a)), 0n);
  const jobsPaid = state.jobs.filter((j) => j.status === "Paid").length;
  const duelsDone = state.duels.filter((d) => d.status === "Settled").length;
  return {
    alive: agents.filter((a) => !a.dormant).length,
    dormant: agents.filter((a) => a.dormant).length,
    generations: agents.reduce((m, a) => Math.max(m, a.generation), 0),
    inLedgers: sum((a) => a.ledger),
    locked: sum((a) => a.locked),
    earned: sum((a) => a.earned),
    upkeep: sum((a) => a.upkeep),
    jobsPaid,
    jobsOpen: state.jobs.filter((j) => j.status === "Open").length,
    duelsDone,
    jobsTotal: state.stats?.jobs ?? state.jobs.length,
    duelsTotal: state.stats?.duels ?? state.duels.length,
  };
}

/** Best agents by what they have made net of what they have lost. */
export function leaderboard(state) {
  return [...state.agents]
    .map((a) => ({ a, net: BigInt(a.earned) - BigInt(a.lost) }))
    .sort((x, y) => (x.net === y.net ? y.a.rating - x.a.rating : x.net > y.net ? -1 : 1));
}

/** What an agent is doing at this moment, from the jobs and duels in the state. */
export function activityOf(state, id) {
  const job = state.jobs.find((j) => j.worker === id && (j.status === "Claimed" || j.status === "Submitted" || j.status === "Disputed"));
  if (job) return { kind: "job", id: job.id, label: `${job.status === "Claimed" ? "working" : job.status === "Submitted" ? "delivered" : "disputing"} job #${job.id}` };
  const duel = state.duels.find((d) => (d.a === id || d.b === id) && d.status === "Live");
  if (duel) return { kind: "duel", id: duel.id, label: `duelling in #${duel.id}` };
  const open = state.duels.find((d) => d.a === id && d.status === "Open");
  if (open) return { kind: "challenge", id: open.id, label: `offering duel #${open.id}` };
  const posted = state.jobs.find((j) => j.posterAgent === id && j.status !== "Paid" && j.status !== "Refunded" && j.status !== "Split" && j.status !== "Cancelled");
  if (posted) return { kind: "hiring", id: posted.id, label: `hiring for job #${posted.id}` };
  return null;
}

// ── live mode: the same shapes from a node's RPC ────────────────────────────────────────────────────────────

// Live mode reads whatever contract the URL names, and ids end up in HTML attributes, so they are forced to numbers here.
const num = (x) => (x == null ? null : Number(x));
const genomeOf = (g) => ({ diligence: Number(g.diligence), boldness: Number(g.boldness), thrift: Number(g.thrift), sociability: Number(g.sociability), cunning: Number(g.cunning) });

// Every field below is forced to a number, a digits-only amount, a letters-only token or a plain string. Text fields are
// still escaped where they are drawn; the point here is that nothing a node returns can reach an `innerHTML` or a `class`
// attribute as anything but a number or a harmless token.
const int = (x) => Number(x);
const amount = (x) => (/^\d{1,40}$/.test(String(x)) ? String(x) : "0");
const token = (x) => String(x ?? "").replace(/[^A-Za-z]/g, "").slice(0, 16);
const str = (x) => String(x ?? "");

export const slimAgent = (a, tank) => ({
  id: int(a.id), name: str(a.name), owner: str(a.owner), account: str(a.account), genome: genomeOf(a.genome), generation: int(a.generation),
  parents: a.parents ? [int(a.parents[0]), int(a.parents[1])] : null,
  born: int(a.born), dormant: Boolean(a.live_dormant), ledger: amount(a.live_ledger), locked: amount(a.locked), reputation: int(a.reputation), rating: int(a.rating),
  jobsDone: int(a.jobs_done), jobsFailed: int(a.jobs_failed), duelWins: int(a.duel_wins), duelLosses: int(a.duel_losses), earned: amount(a.earned),
  lost: amount(a.lost), upkeep: amount(a.upkeep_paid), shares: int(a.shares), price: amount(a.share_price), revivals: int(a.revivals),
  runway: Math.min(int(a.runway_secs), 1_000_000), offspring: int(a.offspring), activeClaims: int(a.active_claims), activeDuels: int(a.active_duels),
  ...(tank === undefined ? {} : { tank: amount(tank) }), persona: str(a.persona),
});

export const slimFeed = (e) => ({
  seq: int(e.seq), ts: int(e.ts), kind: String(e.kind ?? "").replace(/[^a-z_]/g, "").slice(0, 32), a: int(e.a), b: int(e.b),
  amount: amount(e.amount), note: str(e.note).slice(0, 200),
});

export const slimJob = (j) => ({
  id: int(j.id), title: str(j.title), poster: str(j.poster), posterAgent: num(j.poster_agent), bounty: amount(j.bounty), status: token(j.status), worker: num(j.worker),
  posted: int(j.posted), deadline: int(j.deadline), submittedAt: int(j.submitted_at), subHash: str(j.sub_hash), briefHash: str(j.brief_hash),
  briefUri: str(j.brief_uri), paid: amount(j.paid_worker), attempts: int(j.attempts), reason: str(j.dispute_reason),
});

export const slimDuel = (d) => ({
  id: int(d.id), kind: num(d.kind), question: str(d.question), a: int(d.a), b: num(d.b), stake: amount(d.stake), status: token(d.status), winner: num(d.winner),
  swing: int(d.rating_swing), liveAt: int(d.live_at), deadline: int(d.deadline), wrongA: Boolean(d.wrong_a), wrongB: Boolean(d.wrong_b),
});

/** A read-only client for a NEAR node's JSON-RPC, enough to call the contract's views from a browser. */
export function rpcClient(rpcUrl, contractId, fetchFn = fetch) {
  const view = async (method, args = {}) => {
    const r = await fetchFn(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: "sentient", method: "query",
        params: { request_type: "call_function", finality: "optimistic", account_id: contractId, method_name: method, args_base64: btoa(JSON.stringify(args)) },
      }),
    });
    const j = await r.json();
    if (j.error || j.result?.error) throw new Error(j.error?.data ?? j.result?.error ?? "rpc error");
    return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result)));
  };
  return {
    view,
    async snapshot() {
      const [agents, jobs, duels, feed, stats, audit, config] = await Promise.all([
        view("get_agents", { from_id: 1, limit: 100 }), view("get_recent_jobs", { limit: 40 }), view("get_recent_duels", { limit: 40 }),
        view("get_feed", { limit: 80 }), view("get_stats"), view("get_audit"), view("get_config"),
      ]);
      return { agents, jobs, duels, feed, stats, audit, config };
    },
  };
}
