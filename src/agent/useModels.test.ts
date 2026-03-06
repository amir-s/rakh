import { describe, expect, it } from "vitest";
import { filterModelsForQuery, type GatewayModel } from "./useModels";

const MODELS: GatewayModel[] = [
  {
    id: "team-openai/openai/gpt-4o-mini",
    name: "GPT-4o mini",
    providerId: "provider-openai",
    owned_by: "openai",
    tags: ["tool-use", "vision"],
    sdk_id: "gpt-4o-mini",
  },
  {
    id: "team-openai/openai/gpt-4.1",
    name: "GPT-4.1",
    providerId: "provider-openai",
    owned_by: "openai",
    tags: ["tool-use"],
    sdk_id: "gpt-4.1",
  },
  {
    id: "team-anthropic/anthropic/claude-sonnet-4.5",
    name: "Claude Sonnet 4.5",
    providerId: "provider-anthropic",
    owned_by: "anthropic",
    tags: ["tool-use", "reasoning"],
    sdk_id: "claude-sonnet-4-5",
  },
  {
    id: "team-anthropic/anthropic/claude-opus-4.1",
    name: "Claude Opus 4.1",
    providerId: "provider-anthropic",
    owned_by: "anthropic",
    tags: ["tool-use", "reasoning"],
    sdk_id: "claude-opus-4-1",
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
      "team-anthropic/anthropic/claude-sonnet-4.5",
      "team-anthropic/anthropic/claude-opus-4.1",
    ]);
  });

  it("matches fuzzy ids like gpt4o", () => {
    const results = filterModelsForQuery(MODELS, "gpt4o");
    expect(results[0]?.id).toBe("team-openai/openai/gpt-4o-mini");
  });

  it("supports multi-token matching across fields", () => {
    const results = filterModelsForQuery(MODELS, "openai mini");
    expect(results[0]?.id).toBe("team-openai/openai/gpt-4o-mini");
  });

  it("supports searching openai-compatible models via custom alias", () => {
    const results = filterModelsForQuery(MODELS, "custom llama");
    expect(results[0]?.id).toBe("my-gateway/meta/llama-3.3-70b");
  });
});
