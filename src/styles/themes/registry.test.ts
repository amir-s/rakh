import { describe, expect, it } from "vitest";
import {
  THEME_NAMES,
  coerceThemeName,
  formatThemeName,
  getThemeSubagentColorVariables,
  getThemeSubagents,
  isThemeName,
} from "./registry";

describe("theme registry", () => {
  it("contains expected default theme", () => {
    expect(THEME_NAMES.includes("rakh")).toBe(true);
  });

  it("type-guards known names", () => {
    expect(isThemeName("rakh")).toBe(true);
    expect(isThemeName("kitsune")).toBe(true);
    expect(isThemeName("unknown-theme")).toBe(false);
    expect(isThemeName(42)).toBe(false);
  });

  it("coerces unknown stored values to rakh", () => {
    expect(coerceThemeName("primer")).toBe("primer");
    expect(coerceThemeName("legacy-theme")).toBe("rakh");
    expect(coerceThemeName(null)).toBe("rakh");
  });

  it("formats kebab names for labels", () => {
    expect(formatThemeName("rakh")).toBe("Rakh");
    expect(formatThemeName("neon-sentinel")).toBe("Neon Sentinel");
  });

  it("exposes registered subagents to the theme layer", () => {
    const subagents = getThemeSubagents();
    expect(subagents.length).toBeGreaterThan(0);
    expect(subagents.some((s) => s.id === "planner")).toBe(true);
    expect(subagents.some((s) => s.id === "security")).toBe(true);
    expect(
      subagents.some((s) => s.colorVariable === "--color-subagent-reviewer"),
    ).toBe(true);
    expect(
      subagents.some((s) => s.colorVariable === "--color-subagent-security"),
    ).toBe(true);
  });

  it("resolves subagent color variables by mode", () => {
    const dark = getThemeSubagentColorVariables("dark");
    const light = getThemeSubagentColorVariables("light");

    expect(dark["--color-subagent-planner"]).toBeDefined();
    expect(light["--color-subagent-planner"]).toBeDefined();
    expect(dark["--color-subagent-planner"]).not.toBe(
      light["--color-subagent-planner"],
    );
  });
});
