// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolCallDisplay } from "@/agent/types";
import GroupedInlineToolCall from "./GroupedInlineToolCall";

vi.mock("./CompactToolCall", () => ({
  default: ({ tc }: { tc: ToolCallDisplay }) => (
    <div data-testid="grouped-tool-child">{tc.id}</div>
  ),
}));

function makeToolCall(
  id: string,
  tool: string,
  args: Record<string, unknown>,
): ToolCallDisplay {
  return {
    id,
    tool,
    args,
    status: "done",
  };
}

describe("GroupedInlineToolCall", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows the latest tool call summary, unique icon strip, and count badge when collapsed", () => {
    render(
      <GroupedInlineToolCall
        toolCalls={[
          makeToolCall("tc-1", "workspace_listDir", { path: "src" }),
          makeToolCall("tc-2", "workspace_readFile", { path: "README.md" }),
          makeToolCall("tc-3", "workspace_readFile", { path: "package.json" }),
          makeToolCall("tc-4", "workspace_glob", { patterns: ["*.ts"] }),
        ]}
        onInspect={vi.fn()}
        showDebug={false}
      />,
    );

    expect(screen.getByText("GLOB FILES")).not.toBeNull();
    expect(screen.getByText("pattern: *.ts")).not.toBeNull();
    expect(screen.getByText("4")).not.toBeNull();
    expect(screen.getByTitle("LIST DIRECTORY")).not.toBeNull();
    expect(screen.getAllByTitle("READ FILE")).toHaveLength(1);
    expect(screen.getByTitle("GLOB FILES")).not.toBeNull();
  });

  it("expands to render all grouped tool calls", () => {
    const { container } = render(
      <GroupedInlineToolCall
        toolCalls={[
          makeToolCall("tc-1", "workspace_listDir", { path: "src" }),
          makeToolCall("tc-2", "workspace_readFile", { path: "README.md" }),
        ]}
        onInspect={vi.fn()}
        showDebug={false}
      />,
    );

    const toggle = screen.getByRole("button");
    fireEvent.click(toggle);

    expect(
      container.querySelector(".inline-tool-group__body--expanded"),
    ).not.toBeNull();
    expect(screen.getAllByTestId("grouped-tool-child")).toHaveLength(2);
  });

  it("hides the log viewer action when debug mode is off", () => {
    const onOpenLogs = vi.fn();

    render(
      <GroupedInlineToolCall
        toolCalls={[
          makeToolCall("tc-1", "workspace_listDir", { path: "src" }),
          makeToolCall("tc-2", "workspace_readFile", { path: "README.md" }),
        ]}
        onInspect={vi.fn()}
        onOpenLogs={onOpenLogs}
        showDebug={false}
      />,
    );

    expect(screen.queryByRole("button", { name: "Open logs" })).toBeNull();
    expect(onOpenLogs).not.toHaveBeenCalled();
  });

  it("shows the log viewer action when debug mode is on", () => {
    const onOpenLogs = vi.fn();

    render(
      <GroupedInlineToolCall
        toolCalls={[
          makeToolCall("tc-1", "workspace_listDir", { path: "src" }),
          makeToolCall("tc-2", "workspace_readFile", { path: "README.md" }),
        ]}
        onInspect={vi.fn()}
        onOpenLogs={onOpenLogs}
        showDebug
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open logs" }));

    expect(onOpenLogs).toHaveBeenCalledWith(
      expect.objectContaining({ id: "tc-2" }),
    );
  });
});
