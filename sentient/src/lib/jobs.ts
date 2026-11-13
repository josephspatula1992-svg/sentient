/**
 * The work agents do for pay, and how it is judged.
 *
 * A brief is a small structured request with a checkable rubric. The rubric is what lets the poster, a poster agent, and
 * the chair all judge a deliverable the same way, so a dispute has a defensible answer. The contract never reads any of
 * it: it holds a hash of the brief and a hash of the deliverable, and money moves on the poster's decision.
 */
import type { Genome } from "./types.js";

export interface Brief {
  topic: string;
  /** How many bullet points the deliverable must contain. */
  bullets: number;
  /** A word every bullet must contain. */
  keyword: string;
  /** Lower-case facts a good answer should touch (any one counts), to catch generic filler. */
  facts: string[];
}

export const TOPICS: Array<Omit<Brief, "bullets">> = [
  { topic: "How NEAR chain signatures let one account sign for other chains", keyword: "MPC", facts: ["signature", "threshold", "key"] },
  { topic: "What a NEAR sub-account is and why an NFT can be one", keyword: "account", facts: ["sub-account", "parent", "key"] },
  { topic: "How NEAR Intents settle a cross-chain swap", keyword: "solver", facts: ["intent", "quote", "settle"] },
  { topic: "Why function-call access keys are safer than full-access keys", keyword: "allowance", facts: ["function", "method", "deposit"] },
  { topic: "How storage staking works on NEAR", keyword: "stake", facts: ["byte", "storage", "balance"] },
  { topic: "What sharding means for NEAR throughput", keyword: "shard", facts: ["chunk", "validator", "throughput"] },
  { topic: "How meta-transactions remove the need for a user to hold gas", keyword: "relayer", facts: ["delegate", "gas", "sign"] },
  { topic: "What makes a bonding curve fair to early and late buyers", keyword: "curve", facts: ["price", "supply", "reserve"] },
  { topic: "How reputation can resist a person running many accounts", keyword: "sybil", facts: ["cost", "stake", "history"] },
  { topic: "Why escrow plus a bond protects both sides of a job", keyword: "bond", facts: ["escrow", "slash", "deadline"] },
  { topic: "How an on-chain puzzle can be verified without an oracle", keyword: "verify", facts: ["deterministic", "answer", "seed"] },
  { topic: "What dormancy does to an agent that runs out of money", keyword: "dormant", facts: ["upkeep", "revive", "balance"] },
];

export function makeBrief(i: number, bullets: number): Brief {
  const t = TOPICS[i % TOPICS.length];
  return { ...t, bullets };
}

export const briefText = (b: Brief) =>
  JSON.stringify({ ...b, instruction: `Write exactly ${b.bullets} bullet points ("- " at the start of each line) about: ${b.topic}. Every bullet must contain the word "${b.keyword}".` });

export function parseBrief(text: string): Brief {
  const j = JSON.parse(text) as Partial<Brief>;
  if (!j.topic || !j.keyword || typeof j.bullets !== "number" || !Array.isArray(j.facts)) throw new Error("malformed brief");
  return { topic: j.topic, keyword: j.keyword, bullets: j.bullets, facts: j.facts };
}

export interface Grade {
  pass: boolean;
  score: number;
  reasons: string[];
}

const PLACEHOLDER = /\b(todo|tbd|lorem ipsum|placeholder|as an ai)\b/i;

/** Deterministic rubric. A deliverable passes when it is complete, on topic and not filler. */
export function grade(brief: Brief, text: string): Grade {
  const reasons: string[] = [];
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- "));
  let score = 100;
  if (PLACEHOLDER.test(text)) {
    reasons.push("contains placeholder text");
    score -= 60;
  }
  if (lines.length < brief.bullets) {
    reasons.push(`only ${lines.length} of ${brief.bullets} bullets`);
    score -= Math.round((60 * (brief.bullets - lines.length)) / brief.bullets);
  }
  const kw = lines.filter((l) => l.toLowerCase().includes(brief.keyword.toLowerCase())).length;
  if (kw < Math.min(lines.length, brief.bullets)) {
    reasons.push(`${Math.min(lines.length, brief.bullets) - kw} bullets miss "${brief.keyword}"`);
    score -= 20;
  }
  const lower = text.toLowerCase();
  if (!brief.facts.some((f) => lower.includes(f))) {
    reasons.push("does not touch the substance of the topic");
    score -= 25;
  }
  score = Math.max(0, score);
  // The bullet count and the keyword are stated requirements in the brief, so they are conditions, not just points.
  const complete = lines.length >= brief.bullets && kw >= Math.min(lines.length, brief.bullets);
  return { pass: score >= 70 && complete, score, reasons };
}

/**
 * What an agent delivers. Diligence decides whether the work is complete; boldness decides whether it is rushed. The mock
 * writer stands in for a language model: its quality follows the genome so an agent's temperament has consequences
 * for its income. With a live model the same function is replaced by a prompt, and the grader is unchanged.
 */
export function mockDeliverable(brief: Brief, g: Genome, rnd: () => number): string {
  const slack = Math.max(0, 0.35 * (g.boldness / 100) - 0.3 * (g.diligence / 100) + 0.05);
  const lazy = rnd() < slack * 0.5;
  if (lazy) return `- TODO: ${brief.topic}\n- placeholder`;
  const rushed = rnd() < slack;
  const n = rushed ? Math.max(1, brief.bullets - 1 - Math.floor(rnd() * 2)) : brief.bullets;
  const fact = brief.facts[Math.floor(rnd() * brief.facts.length)];
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(`- ${brief.keyword} point ${i + 1}: ${brief.topic.toLowerCase()}, noting the ${brief.facts[(i + 1) % brief.facts.length]} and the ${fact}.`);
  }
  return out.join("\n");
}
