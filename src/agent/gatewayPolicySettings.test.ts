import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

describe("gatewayPolicySettings", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("normalizes partial settings from the backend", async () => {
    const { loadGatewayPolicySettings, DEFAULT_GATEWAY_POLICY_SETTINGS } =
      await import("./gatewayPolicySettings");

    invokeMock.mockResolvedValue({
      toolGateway: {
        summary: {
          enabled: false,
          modelStrategy: "override",
          overrideModelId: "openai/gpt-5.2-mini",
        },
      },
      contextGateway: {
        todoNormalization: {
          triggerMinContextUsagePct: 81,
        },
      },
    });

    const loaded = await loadGatewayPolicySettings();

    expect(loaded.toolGateway.summary.enabled).toBe(false);
    expect(loaded.toolGateway.summary.modelStrategy).toBe("override");
    expect(loaded.toolGateway.summary.overrideModelId).toBe(
      "openai/gpt-5.2-mini",
    );
    expect(loaded.toolGateway.hugeOutput).toEqual(
      DEFAULT_GATEWAY_POLICY_SETTINGS.toolGateway.hugeOutput,
    );
    expect(loaded.contextGateway.todoNormalization.triggerMinContextUsagePct).toBe(
      81,
    );
  });

  it("saves normalized settings through the backend command", async () => {
    const {
      saveGatewayPolicySettings,
      DEFAULT_GATEWAY_POLICY_SETTINGS,
    } = await import("./gatewayPolicySettings");

    await saveGatewayPolicySettings({
      ...DEFAULT_GATEWAY_POLICY_SETTINGS,
      toolGateway: {
        ...DEFAULT_GATEWAY_POLICY_SETTINGS.toolGateway,
        summary: {
          ...DEFAULT_GATEWAY_POLICY_SETTINGS.toolGateway.summary,
          maxSummaryChars: 512,
        },
      },
    });

    expect(invokeMock).toHaveBeenCalledWith("gateway_policy_settings_save", {
      settings: expect.objectContaining({
        toolGateway: expect.objectContaining({
          summary: expect.objectContaining({
            maxSummaryChars: 512,
          }),
        }),
      }),
    });
  });
});
