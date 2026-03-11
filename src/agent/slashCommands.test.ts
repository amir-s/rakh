import { describe, expect, it, vi } from "vitest";

vi.mock("./subagents", () => ({
  getAllSubagents: () => [
    {
      id: "planner",
      name: "Planner",
      description: "Writes execution plans.",
      triggerCommand: "/plan",
      triggerCommandDisplay: "/plan <task>",
      triggerCommandTakesArguments: true,
    },
  ],
}));

import {
  filterSlashCommands,
  formatSlashCommandHelpMarkdown,
  getSlashCommandCatalog,
} from "./slashCommands";

describe("slashCommands", () => {
  it("includes the grouped tool toggle command in the catalog", () => {
    const commands = getSlashCommandCatalog();

    expect(
      commands.some((command) => command.command === "/toggle-group-tools"),
    ).toBe(true);
  });

  it("includes the grouped tool toggle command in help output", () => {
    const helpMarkdown = formatSlashCommandHelpMarkdown(getSlashCommandCatalog());

    expect(helpMarkdown).toContain("`/toggle-group-tools`");
  });

  it("surfaces the grouped tool toggle in slash autocomplete", () => {
    const commands = getSlashCommandCatalog();

    expect(filterSlashCommands(commands, "/toggle", 10)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "/toggle-group-tools" }),
      ]),
    );
  });
});
