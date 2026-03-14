import type { AppUpdaterState } from "@/agent/atoms";
import type { BadgeVariant } from "@/components/ui/variants";

export type SettingsSectionId =
  | "appearance"
  | "notifications"
  | "providers"
  | "mcp"
  | "voice"
  | "command-list"
  | "developer"
  | "updates";

export type SettingsSectionGroupId = "general" | "ai" | "app";

export interface SettingsSectionDefinition {
  id: SettingsSectionId;
  groupId: SettingsSectionGroupId;
  label: string;
  description: string;
  icon: string;
}

export interface SettingsSectionGroupDefinition {
  id: SettingsSectionGroupId;
  label: string;
}

export interface SettingsSectionBadge {
  label: string;
  variant: BadgeVariant;
}

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = "appearance";

export const SETTINGS_SECTION_GROUPS: SettingsSectionGroupDefinition[] = [
  { id: "general", label: "General" },
  { id: "ai", label: "AI" },
  { id: "app", label: "App" },
];

export const SETTINGS_SECTIONS: SettingsSectionDefinition[] = [
  {
    id: "appearance",
    groupId: "general",
    label: "Appearance",
    description: "Theme, mode, and visual defaults.",
    icon: "palette",
  },
  {
    id: "notifications",
    groupId: "general",
    label: "Notifications",
    description: "Agent attention and alert behavior.",
    icon: "notifications",
  },
  {
    id: "providers",
    groupId: "ai",
    label: "AI Providers",
    description: "API keys, model sources, and imports.",
    icon: "hub",
  },
  {
    id: "mcp",
    groupId: "ai",
    label: "MCP Servers",
    description: "Global MCP server registry and discovery checks.",
    icon: "extension",
  },
  {
    id: "voice",
    groupId: "ai",
    label: "Voice Input",
    description: "Microphone access and Whisper model state.",
    icon: "mic",
  },
  {
    id: "command-list",
    groupId: "ai",
    label: "Command List",
    description: "Allow or deny commands for automatic approval control.",
    icon: "shield",
  },
  {
    id: "developer",
    groupId: "app",
    label: "Developer",
    description: "Debug mode, diagnostics, and developer-facing tooling.",
    icon: "bug_report",
  },
  {
    id: "updates",
    groupId: "app",
    label: "App Updates",
    description: "Current version, releases, and install status.",
    icon: "system_update_alt",
  },
];

export function getSettingsSectionDefinition(
  sectionId: SettingsSectionId,
): SettingsSectionDefinition {
  return (
    SETTINGS_SECTIONS.find((section) => section.id === sectionId) ??
    SETTINGS_SECTIONS[0]
  );
}

export function getSettingsSectionsForGroup(
  groupId: SettingsSectionGroupId,
): SettingsSectionDefinition[] {
  return SETTINGS_SECTIONS.filter((section) => section.groupId === groupId);
}

export function getSettingsSectionBadge(
  sectionId: SettingsSectionId,
  appUpdater: AppUpdaterState,
): SettingsSectionBadge | null {
  if (sectionId !== "updates") return null;
  if (appUpdater.status === "available" && appUpdater.availableVersion) {
    return { label: "Ready", variant: "primary" };
  }
  if (appUpdater.status === "error") {
    return { label: "Issue", variant: "danger" };
  }
  if (appUpdater.status === "up-to-date") {
    return { label: "Current", variant: "success" };
  }
  return null;
}
