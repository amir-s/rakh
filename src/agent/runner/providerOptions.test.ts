import { describe, expect, it } from "vitest";

import type { AdvancedModelOptions } from "../types";
import { DEFAULT_ADVANCED_OPTIONS } from "../types";
import { buildProviderOptions } from "./providerOptions";

describe("buildProviderOptions", () => {
  it("returns undefined for unknown / openai-compatible providers", () => {
    expect(buildProviderOptions(null)).toBeUndefined();
    expect(buildProviderOptions("openai-compatible")).toBeUndefined();
    expect(buildProviderOptions("custom")).toBeUndefined();
  });

  it("uses DEFAULT_ADVANCED_OPTIONS when opts is undefined (OpenAI)", () => {
    const result = buildProviderOptions("openai");
    expect(result).toBeDefined();
    expect(result!.openai.reasoningSummary).toBe("auto");
    expect(result!.openai.reasoningEffort).toBe(
      DEFAULT_ADVANCED_OPTIONS.reasoningEffort,
    );
    expect(result!.openai.serviceTier).toBe("auto");
  });

  it("uses DEFAULT_ADVANCED_OPTIONS when opts is undefined (Anthropic)", () => {
    const result = buildProviderOptions("anthropic");
    expect(result).toBeDefined();
    expect(result!.anthropic.thinking).toEqual({ type: "adaptive" });
    expect(result!.anthropic).not.toHaveProperty("effort");
    expect(result!.anthropic).not.toHaveProperty("speed");
  });

  describe("OpenAI mappings", () => {
    const base: AdvancedModelOptions = {
      reasoningVisibility: "auto",
      reasoningEffort: "medium",
      latencyCostProfile: "balanced",
    };

    it("reasoning visibility: off omits reasoningSummary", () => {
      const r = buildProviderOptions("openai", {
        ...base,
        reasoningVisibility: "off",
      });
      expect(r!.openai).not.toHaveProperty("reasoningSummary");
    });

    it("reasoning visibility: auto", () => {
      const r = buildProviderOptions("openai", {
        ...base,
        reasoningVisibility: "auto",
      });
      expect(r!.openai.reasoningSummary).toBe("auto");
    });

    it("reasoning visibility: detailed", () => {
      const r = buildProviderOptions("openai", {
        ...base,
        reasoningVisibility: "detailed",
      });
      expect(r!.openai.reasoningSummary).toBe("detailed");
    });

    it.each(["low", "medium", "high"] as const)(
      "reasoning effort: %s",
      (effort) => {
        const r = buildProviderOptions("openai", {
          ...base,
          reasoningEffort: effort,
        });
        expect(r!.openai.reasoningEffort).toBe(effort);
      },
    );

    it("latency balanced → serviceTier auto", () => {
      const r = buildProviderOptions("openai", {
        ...base,
        latencyCostProfile: "balanced",
      });
      expect(r!.openai.serviceTier).toBe("auto");
    });

    it("latency fast → serviceTier priority", () => {
      const r = buildProviderOptions("openai", {
        ...base,
        latencyCostProfile: "fast",
      });
      expect(r!.openai.serviceTier).toBe("priority");
    });

    it("latency cheap → serviceTier flex", () => {
      const r = buildProviderOptions("openai", {
        ...base,
        latencyCostProfile: "cheap",
      });
      expect(r!.openai.serviceTier).toBe("flex");
    });
  });

  describe("Anthropic mappings", () => {
    const base: AdvancedModelOptions = {
      reasoningVisibility: "auto",
      reasoningEffort: "medium",
      latencyCostProfile: "balanced",
    };

    it("reasoning visibility: off → thinking disabled", () => {
      const r = buildProviderOptions("anthropic", {
        ...base,
        reasoningVisibility: "off",
      });
      expect(r!.anthropic.thinking).toEqual({ type: "disabled" });
    });

    it("reasoning visibility: auto → thinking adaptive", () => {
      const r = buildProviderOptions("anthropic", {
        ...base,
        reasoningVisibility: "auto",
      });
      expect(r!.anthropic.thinking).toEqual({ type: "adaptive" });
    });

    it("reasoning visibility: detailed → thinking enabled with budgetTokens", () => {
      const r = buildProviderOptions("anthropic", {
        ...base,
        reasoningVisibility: "detailed",
      });
      expect(r!.anthropic.thinking).toEqual({
        type: "enabled",
        budgetTokens: 4096,
      });
    });

    it.each(["low", "medium", "high"] as const)(
      "reasoning effort on unsupported models is omitted: %s",
      (effort) => {
        const r = buildProviderOptions("anthropic", {
          ...base,
          reasoningEffort: effort,
        });
        expect(r!.anthropic).not.toHaveProperty("effort");
      },
    );

    it.each(["low", "medium", "high"] as const)(
      "reasoning effort on opus 4.5 is included: %s",
      (effort) => {
        const r = buildProviderOptions(
          "anthropic",
          {
            ...base,
            reasoningEffort: effort,
          },
          "claude-opus-4-5",
        );
        expect(r!.anthropic.effort).toBe(effort);
      },
    );

    it("latency balanced → speed omitted", () => {
      const r = buildProviderOptions(
        "anthropic",
        {
          ...base,
          latencyCostProfile: "balanced",
        },
        "claude-opus-4-6",
      );
      expect(r!.anthropic).not.toHaveProperty("speed");
    });

    it("latency fast on unsupported models → speed omitted", () => {
      const r = buildProviderOptions(
        "anthropic",
        {
          ...base,
          latencyCostProfile: "fast",
        },
        "claude-sonnet-4-6",
      );
      expect(r!.anthropic).not.toHaveProperty("speed");
    });

    it("latency fast on opus 4.6 → speed fast", () => {
      const r = buildProviderOptions(
        "anthropic",
        {
          ...base,
          latencyCostProfile: "fast",
        },
        "claude-opus-4-6",
      );
      expect(r!.anthropic.speed).toBe("fast");
    });
  });
});
