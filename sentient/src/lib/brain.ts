/**
 * Where an agent's thinking happens. The contract does not care: it checks answers and the poster judges deliverables.
 *
 * `MockBrain` is offline and deterministic enough to test: puzzles are solved exactly, then slowed down and occasionally
 * spoiled according to the genome (a stand-in for the speed/accuracy trade-off a real model has), deliverables are
 * templated with quality that follows the genome, and review uses the rubric. It proves the economics and the gates and
 * says nothing about model quality. `LlmBrain` sends the same three questions to NEAR AI Cloud; it has been written to the
 * documented OpenAI-compatible schema and exercised only against a stub.
 */
import { grade, mockDeliverable, briefText, type Brief, type Grade } from "./jobs.js";
import { solve, KIND_NAMES } from "./puzzle.js";
import { solveProfile } from "./policy.js";
import type { Duel, Genome } from "./types.js";

export interface Brain {
  readonly name: string;
  /** false for the offline mock; every screen and log says so. */
  readonly live: boolean;
  answer(duel: Duel, g: Genome, rnd: () => number): Promise<{ answer: number; thinkMs: number }>;
  write(brief: Brief, g: Genome, rnd: () => number): Promise<string>;
  review(brief: Brief, deliverable: string): Promise<Grade>;
}

export class MockBrain implements Brain {
  readonly name = "mock (offline)";
  readonly live = false;

  async answer(duel: Duel, g: Genome, rnd: () => number) {
    const right = solve(duel.kind ?? -1, duel.params);
    if (right === null) throw new Error("puzzle outside the solver's range");
    const { thinkMs, errorRate } = solveProfile(g);
    const answer = rnd() < errorRate ? right + 1 + Math.floor(rnd() * 5) : right;
    return { answer, thinkMs: thinkMs * (0.8 + 0.4 * rnd()) };
  }

  async write(brief: Brief, g: Genome, rnd: () => number) {
    return mockDeliverable(brief, g, rnd);
  }

  async review(brief: Brief, deliverable: string) {
    return grade(brief, deliverable);
  }
}

export interface ChatFn {
  (system: string, user: string, maxTokens: number): Promise<string>;
}

/** A model-backed brain. `chat` is injected so it can be tested against a stub and pointed at NEAR AI Cloud in use. */
export class LlmBrain implements Brain {
  readonly live = true;
  constructor(readonly name: string, private readonly chat: ChatFn) {}

  async answer(duel: Duel, g: Genome) {
    const t0 = Date.now();
    const kind = KIND_NAMES[duel.kind ?? 0];
    const text = await this.chat(
      "You solve arithmetic puzzles. Reply with a single integer and nothing else.",
      `Puzzle (${kind}): ${duel.question}`,
      g.diligence >= 50 ? 800 : 120,
    );
    // The LAST integer: a model that shows its working ("12 x 34 = 408") ends with the answer, and the first number would be an operand.
    const nums = text.replace(/,/g, "").match(/-?\d+/g);
    if (!nums) throw new Error("the model did not answer with a number");
    const answer = Number(nums[nums.length - 1]);
    if (!Number.isSafeInteger(answer)) throw new Error("the model's answer is not a safe integer");
    return { answer, thinkMs: Date.now() - t0 };
  }

  async write(brief: Brief, g: Genome) {
    const careful = g.diligence >= 50 ? "Check that every bullet contains the required word before you answer." : "Be quick.";
    return this.chat(
      "You write short, accurate technical bullet points. Output only the bullets, each starting with '- '.",
      `${briefText(brief)}\n${careful}`,
      700,
    );
  }

  async review(brief: Brief, deliverable: string) {
    // The rubric is deterministic on purpose: a model grader that disagreed with the chair's rubric would make every
    // dispute a coin toss. So review is the rubric, in live mode too.
    return grade(brief, deliverable);
  }
}
