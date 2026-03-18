// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Markdown from "./Markdown";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

describe("Markdown", () => {
  beforeEach(() => {
    invokeMock.mockReset();
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
});
