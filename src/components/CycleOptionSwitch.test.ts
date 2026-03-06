import { describe, expect, it } from "vitest";
import {
  getNextOptionIndex,
  getThumbPositionClass,
} from "./CycleOptionSwitch";

describe("CycleOptionSwitch helpers", () => {
  it("cycles correctly for 2-option switches", () => {
    expect(getNextOptionIndex(0, 2)).toBe(1);
    expect(getNextOptionIndex(1, 2)).toBe(0);
  });

  it("cycles correctly for 3-option switches", () => {
    expect(getNextOptionIndex(0, 3)).toBe(1);
    expect(getNextOptionIndex(1, 3)).toBe(2);
    expect(getNextOptionIndex(2, 3)).toBe(0);
  });

  it("falls back safely for invalid indices/length", () => {
    expect(getNextOptionIndex(-1, 3)).toBe(0);
    expect(getNextOptionIndex(99, 3)).toBe(0);
    expect(getNextOptionIndex(0, 0)).toBe(-1);
  });

  it("maps thumb positions for 2-option switches", () => {
    expect(getThumbPositionClass(2, 0)).toBe("chat-cycle-thumb--left");
    expect(getThumbPositionClass(2, 1)).toBe("chat-cycle-thumb--right");
  });

  it("maps thumb positions for 3-option switches", () => {
    expect(getThumbPositionClass(3, 0)).toBe("chat-cycle-thumb--left");
    expect(getThumbPositionClass(3, 1)).toBe("chat-cycle-thumb--center");
    expect(getThumbPositionClass(3, 2)).toBe("chat-cycle-thumb--right");
  });
});
