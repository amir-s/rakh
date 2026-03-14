import materialSymbolsOutlined from "@/data/materialSymbolsOutlined.json";

export const MATERIAL_SYMBOLS_OUTLINED = materialSymbolsOutlined as string[];
export const DEFAULT_MATERIAL_SYMBOLS_OUTLINED_SUGGESTIONS = [
  "folder",
  "folder_open",
  "folder_code",
  "account_tree",
  "terminal",
  "code",
  "api",
  "dns",
  "build",
  "settings",
  "dashboard",
  "rocket_launch",
] as const;

const MATERIAL_SYMBOLS_OUTLINED_SET = new Set(MATERIAL_SYMBOLS_OUTLINED);

export function hasMaterialSymbolOutlined(name: string): boolean {
  return MATERIAL_SYMBOLS_OUTLINED_SET.has(name.trim());
}

export function searchMaterialSymbolsOutlined(
  query: string,
  limit = 48,
): string[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return DEFAULT_MATERIAL_SYMBOLS_OUTLINED_SUGGESTIONS.filter((icon) =>
      MATERIAL_SYMBOLS_OUTLINED_SET.has(icon),
    ).slice(0, limit);
  }

  const prefixMatches: string[] = [];
  const containsMatches: string[] = [];

  for (const icon of MATERIAL_SYMBOLS_OUTLINED) {
    const normalizedIcon = icon.toLowerCase();
    if (normalizedIcon.startsWith(normalizedQuery)) {
      prefixMatches.push(icon);
      continue;
    }
    if (normalizedIcon.includes(normalizedQuery)) {
      containsMatches.push(icon);
    }
  }

  return [...prefixMatches, ...containsMatches].slice(0, limit);
}
