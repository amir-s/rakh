// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Markdown from "./Markdown";

const invokeMock = vi.hoisted(() => vi.fn());
const { initializeMock, renderMock } = vi.hoisted(() => ({
  initializeMock: vi.fn(),
  renderMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("mermaid", () => ({
  default: {
    initialize: initializeMock,
    render: (...args: unknown[]) => renderMock(...args),
  },
}));

describe("Markdown", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    initializeMock.mockReset();
    renderMock.mockReset();
    renderMock.mockResolvedValue({
      svg: '<svg viewBox="0 0 100 60"><text x="0" y="16">Auth flow</text></svg>',
    });
    document.documentElement.dataset.theme = "dark";
    document.documentElement.dataset.themeName = "rakh";
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
  });

  afterEach(() => {
    cleanup();
    delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("auto-links plain text file references and opens them in the editor", async () => {
    invokeMock.mockResolvedValue(undefined);

    render(
      <Markdown cwd="/repo">
        {"Functions in files:\n- src/materialSymbols.ts:21"}
      </Markdown>,
    );

    fireEvent.click(screen.getByRole("link", { name: "src/materialSymbols.ts:21" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("open_editor_reference", {
        path: "/repo/src/materialSymbols.ts",
        line: 21,
      });
    });
  });

  it("intercepts explicit local markdown links with line and column anchors", async () => {
    invokeMock.mockResolvedValue(undefined);

    render(
      <Markdown cwd="/repo">{"[open symbol](src/materialSymbols.ts#L25C7)"}</Markdown>,
    );

    fireEvent.click(screen.getByRole("link", { name: "open symbol" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("open_editor_reference", {
        path: "/repo/src/materialSymbols.ts",
        line: 25,
        column: 7,
      });
    });
  });

  it("does not auto-link code spans", () => {
    render(<Markdown>{"`src/materialSymbols.ts:21`"}</Markdown>);

    expect(screen.queryByRole("link", { name: "src/materialSymbols.ts:21" })).toBeNull();
  });

  it("reports local-reference resolution errors through the callback", async () => {
    const onOpenFileReferenceError = vi.fn();

    render(
      <Markdown onOpenFileReferenceError={onOpenFileReferenceError}>
        {"src/materialSymbols.ts:21"}
      </Markdown>,
    );

    fireEvent.click(screen.getByRole("link", { name: "src/materialSymbols.ts:21" }));

    await waitFor(() => {
      expect(onOpenFileReferenceError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("Could not resolve the file reference path"),
        }),
      );
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("renders mermaid fences as diagrams", async () => {
    const { container } = render(<Markdown>{"```mermaid\ngraph TD\nA[Auth] --> B[Done]\n```"}</Markdown>);

    await waitFor(() => {
      expect(
        container.querySelector('.md-mermaid[data-mermaid-state="ready"] svg'),
      ).not.toBeNull();
    });

    expect(initializeMock).toHaveBeenCalledTimes(1);
    expect(renderMock).toHaveBeenCalledWith(
      expect.stringMatching(/^md-mermaid-[A-Za-z0-9_-]+-0$/),
      "graph TD\nA[Auth] --> B[Done]",
    );
    expect(screen.queryByText(/Mermaid render failed/i)).toBeNull();
  });

  it("preserves existing code block behavior and does not load mermaid for other languages", () => {
    const { container } = render(<Markdown>{"```ts\nconst value = 1;\n```"}</Markdown>);

    expect(container.textContent).toContain("const value = 1;");
    expect(container.querySelector(".md-mermaid")).toBeNull();
    expect(initializeMock).not.toHaveBeenCalled();
    expect(renderMock).not.toHaveBeenCalled();
  });

  it("falls back to the source block when mermaid render fails", async () => {
    renderMock.mockRejectedValueOnce(new Error("Parse error"));

    const { container } = render(
      <Markdown>{"```mermaid\ngraph TD\nA[Broken --> B[Done]\n```"}</Markdown>,
    );

    await waitFor(() => {
      expect(screen.getByText(/Mermaid render failed/i)).not.toBeNull();
    });

    expect(container.textContent).toContain("graph TD");
    expect(container.textContent).toContain("A[Broken --> B[Done]");
    expect(container.querySelector('.md-mermaid[data-mermaid-state="error"]')).not.toBeNull();
  });
});
