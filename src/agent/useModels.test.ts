import { describe, expect, it } from "vitest";
import { filterModelsForQuery, type GatewayModel } from "./useModels";

const MODELS: GatewayModel[] = [
  {
    id: "team-openai/openai/codex-mini",
    name: "Codex Mini",
    providerId: "provider-openai",
    owned_by: "openai",
    tags: ["tool-use", "reasoning"],
    sdk_id: "codex-mini-latest",
  },
  {
    id: "team-openai/openai/gpt-5.3-codex",
    name: "GPT-5.3 Codex",
    providerId: "provider-openai",
    owned_by: "openai",
    tags: ["tool-use", "reasoning"],
    sdk_id: "gpt-5.3-codex",
  },
  {
    id: "team-anthropic/anthropic/claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    providerId: "provider-anthropic",
    owned_by: "anthropic",
    tags: ["tool-use", "reasoning"],
    sdk_id: "claude-sonnet-4-5",
  },
  {
    id: "team-anthropic/anthropic/claude-opus-4-6",
    name: "Claude Opus 4.6",
    providerId: "provider-anthropic",
    owned_by: "anthropic",
    tags: ["tool-use", "reasoning"],
    sdk_id: "claude-opus-4-6",
  },
  {
    id: "my-gateway/meta/llama-3.3-70b",
    name: "Llama 3.3 70B",
    providerId: "provider-compatible",
    owned_by: "openai-compatible",
    tags: ["chat"],
    sdk_id: "meta/llama-3.3-70b",
  },
];

describe("filterModelsForQuery", () => {
  it("matches provider names", () => {
    const ids = filterModelsForQuery(MODELS, "anthropic").map((m) => m.id);
    expect(ids).toEqual([
      "team-anthropic/anthropic/claude-sonnet-4-5",
      "team-anthropic/anthropic/claude-opus-4-6",
    ]);
  });

  it("matches fuzzy ids like gpt53codex", () => {
    const results = filterModelsForQuery(MODELS, "gpt53codex");
    expect(results[0]?.id).toBe("team-openai/openai/gpt-5.3-codex");
  });

  it("supports multi-token matching across fields", () => {
    const results = filterModelsForQuery(MODELS, "openai mini");
    expect(results[0]?.id).toBe("team-openai/openai/codex-mini");
  });

  it("supports searching openai-compatible models via custom alias", () => {
    const results = filterModelsForQuery(MODELS, "custom llama");
    expect(results[0]?.id).toBe("my-gateway/meta/llama-3.3-70b");
  });
});
