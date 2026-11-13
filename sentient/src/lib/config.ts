import "dotenv/config";
import { LlmBrain, MockBrain, type Brain, type ChatFn } from "./brain.js";

export const LLM_MODE = process.env.LLM_MODE ?? "mock";
export const NEAR_AI_BASE = process.env.NEAR_AI_BASE ?? "https://cloud-api.near.ai/v1";
export const NEAR_AI_API_KEY = process.env.NEAR_AI_API_KEY ?? "";
export const NEAR_AI_MODEL = process.env.NEAR_AI_MODEL ?? "z-ai/glm-5.3-flash";

/** NEAR AI Cloud is an OpenAI-compatible API (https://docs.near.ai/cloud/quickstart). */
export function nearAiChat(base = NEAR_AI_BASE, apiKey = NEAR_AI_API_KEY, model = NEAR_AI_MODEL): ChatFn {
  if (!apiKey) throw new Error("NEAR_AI_API_KEY is not set");
  let checked = false;
  return async (system, user, maxTokens) => {
    if (!checked) {
      const r = await fetch(`${base}/model/list?limit=200`);
      if (!r.ok) throw new Error(`NEAR AI model list failed: HTTP ${r.status}`);
      const j = (await r.json()) as { models: Array<{ modelId: string }> };
      if (!j.models.some((m) => m.modelId === model)) {
        throw new Error(`model '${model}' is not served by NEAR AI Cloud; set NEAR_AI_MODEL to one it lists`);
      }
      checked = true;
    }
    let last: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            messages: [{ role: "system", content: system }, { role: "user", content: user }],
            max_tokens: maxTokens,
            temperature: 0.2,
          }),
          signal: AbortSignal.timeout(120_000),
        });
        if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
        if (!r.ok) throw Object.assign(new Error(`NEAR AI HTTP ${r.status}`), { fatal: true });
        const j = (await r.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
        // reasoning models can wrap their thinking in <think>…</think>, which is not part of the answer
        return (j.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
      } catch (e) {
        last = e;
        if ((e as { fatal?: boolean }).fatal) throw e;
        await new Promise((res) => setTimeout(res, 1_000 * 2 ** attempt));
      }
    }
    throw new Error(`NEAR AI request failed after retries: ${last instanceof Error ? last.message : last}`);
  };
}

export function makeBrain(): Brain {
  if (LLM_MODE === "near-ai") return new LlmBrain(`near-ai:${NEAR_AI_MODEL}`, nearAiChat());
  return new MockBrain();
}
