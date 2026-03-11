// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AutoScrollArea from "./AutoScrollArea";

function setElementRect(
  element: Element,
  rect: {
    top: number;
    bottom: number;
    left?: number;
    right?: number;
    width?: number;
    height?: number;
  },
) {
  const left = rect.left ?? 0;
  const width = rect.width ?? 320;
  const height = rect.height ?? rect.bottom - rect.top;
  const right = rect.right ?? left + width;

  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      top: rect.top,
      bottom: rect.bottom,
      left,
      right,
      width,
      height,
      x: left,
      y: rect.top,
      toJSON: () => null,
    }),
  });
}

function setScrollerMetrics(
  element: HTMLElement,
  metrics: { clientHeight: number; scrollHeight: number; scrollTop: number },
) {
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    value: metrics.clientHeight,
  });
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    value: metrics.scrollHeight,
  });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    writable: true,
    value: metrics.scrollTop,
  });
}

describe("AutoScrollArea", () => {
  const scrollIntoViewMock = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "requestAnimationFrame",
      ((callback: FrameRequestCallback) =>
        window.setTimeout(() => callback(0), 0)) as typeof requestAnimationFrame,
    );
    vi.stubGlobal(
      "cancelAnimationFrame",
      ((id: number) => window.clearTimeout(id)) as typeof cancelAnimationFrame,
    );
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoViewMock,
    });
    scrollIntoViewMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("shows action arrows for off-screen targets and scrolls to the nearest one", () => {
    const topScrollIntoView = vi.fn();
    const bottomScrollIntoView = vi.fn();
    const { container } = render(
      <AutoScrollArea className="chat-messages">
        <div data-testid="top-target" data-chat-attention-target="approval">
          Approval above
        </div>
        <div data-testid="body">Visible content</div>
        <div data-testid="bottom-target" data-chat-attention-target="cta">
          Action below
        </div>
      </AutoScrollArea>,
    );

    const scroller = container.firstElementChild as HTMLDivElement;
    const topTarget = screen.getByTestId("top-target");
    const bottomTarget = screen.getByTestId("bottom-target");

    setScrollerMetrics(scroller, {
      clientHeight: 200,
      scrollHeight: 900,
      scrollTop: 300,
    });
    setElementRect(scroller, { top: 0, bottom: 200 });
    setElementRect(topTarget, { top: -96, bottom: -24 });
    setElementRect(bottomTarget, { top: 252, bottom: 332 });
    Object.defineProperty(topTarget, "scrollIntoView", {
      configurable: true,
      value: topScrollIntoView,
    });
    Object.defineProperty(bottomTarget, "scrollIntoView", {
      configurable: true,
      value: bottomScrollIntoView,
    });

    act(() => {
      fireEvent.scroll(scroller);
      vi.runAllTimers();
    });

    const upArrow = screen.getByRole("button", {
      name: "Jump to the previous approval request",
    });
    const downArrow = screen.getByRole("button", {
      name: "Jump to the next action",
    });

    expect(upArrow.querySelector(".new-messages-marker__dot")).not.toBeNull();
    expect(downArrow.querySelector(".new-messages-marker__dot")).not.toBeNull();

    fireEvent.click(upArrow);
    fireEvent.click(downArrow);

    expect(topScrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
    expect(bottomScrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
  });

  it("keeps the new-content arrow behavior and falls back to scrolling to bottom", () => {
    const { container, rerender } = render(
      <AutoScrollArea className="chat-messages">
        <div>First</div>
      </AutoScrollArea>,
    );

    const scroller = container.firstElementChild as HTMLDivElement;
    setScrollerMetrics(scroller, {
      clientHeight: 120,
      scrollHeight: 280,
      scrollTop: 40,
    });
    setElementRect(scroller, { top: 0, bottom: 120 });

    act(() => {
      vi.runAllTimers();
    });

    rerender(
      <AutoScrollArea className="chat-messages">
        <div>First</div>
      </AutoScrollArea>,
    );

    act(() => {
      vi.runAllTimers();
    });

    scrollIntoViewMock.mockClear();

    setScrollerMetrics(scroller, {
      clientHeight: 120,
      scrollHeight: 520,
      scrollTop: 40,
    });

    rerender(
      <AutoScrollArea className="chat-messages">
        <div>First</div>
        <div>Second</div>
      </AutoScrollArea>,
    );

    act(() => {
      vi.runAllTimers();
    });

    const downArrow = screen.getByRole("button", {
      name: "Scroll to the newest messages",
    });

    expect(
      downArrow.querySelector(".new-messages-marker__dot"),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Jump to the previous action" }),
    ).toBeNull();

    fireEvent.click(downArrow);

    expect(scrollIntoViewMock).toHaveBeenCalledWith({ behavior: "smooth" });
  });
});
