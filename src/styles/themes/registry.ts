import {
  getAllSubagents,
  getSubagentThemeColorMap,
  getSubagentThemeColorVariable,
  type ThemeMode as SubagentThemeMode,
} from "@/agent/subagents";

export const THEME_NAMES = [
  "rakh",
  "kitsune",
  "rush",
  "solar",
  "cyber",
  "neon-sentinel",
  "monolith",
  "verdant-ember",
  "iridescent-alloy",
  "github",
  "primer",
] as const;

export type ThemeName = (typeof THEME_NAMES)[number];
export type ThemeMode = SubagentThemeMode;

export interface ThemeSubagentDescriptor {
  id: string;
  name: string;
  colorVariable: string;
}

export function isThemeName(value: unknown): value is ThemeName {
  return typeof value === "string" && THEME_NAMES.includes(value as ThemeName);
}

export function coerceThemeName(value: unknown): ThemeName {
  return isThemeName(value) ? value : "rakh";
}

export function formatThemeName(name: ThemeName): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Registered subagents exposed to the theme layer as token descriptors. */
export function getThemeSubagents(): ThemeSubagentDescriptor[] {
  return getAllSubagents().map((subagent) => ({
    id: subagent.id,
    name: subagent.name,
    colorVariable: getSubagentThemeColorVariable(subagent.id),
  }));
}

/** Resolve all subagent color CSS variables for the active mode. */
export function getThemeSubagentColorVariables(
  mode: ThemeMode,
): Record<string, string> {
  return getSubagentThemeColorMap(mode);
}
