import { getAllSubagents } from "./subagents";

export interface SlashCommandDefinition {
  command: string;
  description: string;
  aliases?: string[];
  displayLabel?: string;
  insertText?: string;
  takesArguments?: boolean;
}

const STATIC_SLASH_COMMANDS: SlashCommandDefinition[] = [
  {
    command: "/model",
    displayLabel: "/model [id]",
    description: "List available models or switch the active model.",
    insertText: "/model ",
    takesArguments: true,
  },
  {
    command: "/debug",
    description: "Toggle global debug mode (stream event logging).",
    insertText: "/debug ",
    takesArguments: false,
  },
  {
    command: "/toggle-group-tools",
    description: "Toggle grouped inline tool calls for the current session.",
    insertText: "/toggle-group-tools ",
    takesArguments: false,
  },
  {
    command: "/help",
    aliases: ["/?"],
    description: "Show this list.",
    insertText: "/help ",
    takesArguments: false,
  },
];

function normalizeSlashLookupValue(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeSlashSearchValue(value: string): string {
  return normalizeSlashLookupValue(value)
    .replace(/^\//, "")
    .replace(/\s+/g, " ");
}

function buildSubagentSlashCommand(
  input: {
    command: string;
    description: string;
    displayLabel?: string;
    takesArguments?: boolean;
  },
): SlashCommandDefinition {
  const takesArguments = input.takesArguments ?? true;
  return {
    command: input.command,
    description: input.description,
    displayLabel: input.displayLabel,
    insertText: `${input.command} `,
    takesArguments,
  };
}

export function getSlashCommandCatalog(): SlashCommandDefinition[] {
  const staticByCommand = new Map(
    STATIC_SLASH_COMMANDS.map((definition) => [definition.command, definition]),
  );
  const seen = new Set<string>();
  const commands: SlashCommandDefinition[] = [];

  const pushUnique = (definition?: SlashCommandDefinition) => {
    if (!definition || seen.has(definition.command)) return;
    commands.push(definition);
    seen.add(definition.command);
  };

  const subagentCommands = getAllSubagents()
    .map((subagent) => {
      if (!subagent.triggerCommand) return null;
      return buildSubagentSlashCommand({
        command: subagent.triggerCommand.trim(),
        description: subagent.description,
        displayLabel: subagent.triggerCommandDisplay,
        takesArguments: subagent.triggerCommandTakesArguments,
      });
    })
    .filter((definition): definition is SlashCommandDefinition => definition !== null);

  pushUnique(
    subagentCommands.find((definition) => definition.command === "/plan"),
  );
  pushUnique(staticByCommand.get("/model"));
  pushUnique(staticByCommand.get("/debug"));
  pushUnique(staticByCommand.get("/toggle-group-tools"));
  pushUnique(staticByCommand.get("/help"));

  for (const definition of subagentCommands) {
    pushUnique(definition);
  }

  return commands;
}

export function filterSlashCommands(
  commands: SlashCommandDefinition[],
  query: string,
  limit: number,
): SlashCommandDefinition[] {
  const normalizedQuery = normalizeSlashSearchValue(query);

  return commands
    .filter((definition) => {
      if (!normalizedQuery) return true;

      const searchFields = [
        definition.command,
        ...(definition.aliases ?? []),
        definition.displayLabel ?? "",
      ].map(normalizeSlashSearchValue);

      return searchFields.some((field) => field.startsWith(normalizedQuery));
    })
    .slice(0, limit);
}

export function matchesSlashCommandInput(
  input: string,
  definition: SlashCommandDefinition,
): boolean {
  const normalizedInput = normalizeSlashLookupValue(input);
  if (normalizedInput === normalizeSlashLookupValue(definition.command)) {
    return true;
  }

  return (definition.aliases ?? []).some(
    (alias) => normalizeSlashLookupValue(alias) === normalizedInput,
  );
}

export function formatSlashCommandHelpMarkdown(
  commands: SlashCommandDefinition[],
): string {
  const lines = commands.map((definition) => {
    const label = definition.displayLabel ?? definition.command;
    return `- \`${label}\` — ${definition.description}`;
  });

  return `**Available slash commands:**\n\n${lines.join("\n")}`;
}
