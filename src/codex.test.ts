import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

import {
  codexSessionClose,
  codexSessionInterrupt,
  codexSessionSendTurn,
} from "./codex";

function setTauriAvailable(value: boolean): void {
  if (value) {
    (globalThis as unknown as { window: unknown }).window = {
      __TAURI_INTERNALS__: {},
    };
  } else {
    (globalThis as unknown as { window?: unknown }).window = undefined;
  }
}

describe("codex wrappers", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    setTauriAvailable(true);
  });

  it("wraps send-turn params under the input key", async () => {
    invokeMock.mockResolvedValue({ threadId: "thread-1" });

    await codexSessionSendTurn({
      runtimeId: "runtime-1",
      cwd: "/repo",
      prompt: "inspect",
      profilePrompt: "be concise",
      threadId: "thread-0",
    });

    expect(invokeMock).toHaveBeenCalledWith("codex_session_send_turn", {
      input: {
        runtimeId: "runtime-1",
        cwd: "/repo",
        prompt: "inspect",
        profilePrompt: "be concise",
        threadId: "thread-0",
      },
    });
  });

  it("wraps interrupt params under the input key", async () => {
    invokeMock.mockResolvedValue(undefined);

    await codexSessionInterrupt("runtime-2");

    expect(invokeMock).toHaveBeenCalledWith("codex_session_interrupt", {
      input: { runtimeId: "runtime-2" },
    });
  });

  it("wraps close params under the input key", async () => {
    invokeMock.mockResolvedValue(undefined);

    await codexSessionClose("runtime-3");

    expect(invokeMock).toHaveBeenCalledWith("codex_session_close", {
      input: { runtimeId: "runtime-3" },
    });
  });
});
