// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProjectSettingsModal from "./ProjectSettingsModal";

const PROJECT_COMMAND_ICONS = [
  "play_arrow",
  "settings",
  "pest_control",
  "cleaning_services",
  "science",
  "package_2",
  "install_desktop",
];

describe("ProjectSettingsModal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("arms repo config creation and then shows the repo config path in the footer", async () => {
    const onClose = vi.fn();
    const onSave = vi.fn();
    const onCreateProjectConfig = vi.fn();

    render(
      <ProjectSettingsModal
        project={{ path: "/repo", name: "Repo" }}
        onClose={onClose}
        onSave={onSave}
        onCreateProjectConfig={onCreateProjectConfig}
      />,
    );

    screen.getByText("/repo");
    expect(
      screen.getByRole("button", { name: "CREATE REPO CONFIG FILE" }),
    ).not.toBeNull();

    fireEvent.change(
      screen.getByPlaceholderText("npm install && npm run build"),
      { target: { value: "  npm install  " } },
    );
    fireEvent.click(screen.getByRole("button", { name: "ADD" }));
    fireEvent.change(screen.getByPlaceholderText("Label (e.g. Run app)"), {
      target: { value: " Run app " },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Command icon No icon" }),
    );
    for (const icon of PROJECT_COMMAND_ICONS) {
      screen.getByRole("option", { name: icon });
    }
    fireEvent.click(screen.getByRole("option", { name: "play_arrow" }));
    fireEvent.change(
      screen.getByPlaceholderText("Command (e.g. npm run dev)"),
      {
        target: { value: " npm run dev " },
      },
    );
    fireEvent.click(screen.getByTitle("Toggle label visibility"));
    fireEvent.click(screen.getAllByRole("button", { name: "SAVE" })[0]);

    fireEvent.click(
      screen.getByRole("button", { name: "Edit command Run app" }),
    );
    screen.getByRole("button", { name: "DELETE" });
    fireEvent.click(screen.getAllByRole("button", { name: "CANCEL" })[0]);

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "CREATE REPO CONFIG FILE" }),
      );
    });

    expect(
      screen.getByRole("button", { name: "CREATING REPO CONFIG FILE" }),
    ).not.toBeNull();
    expect(onCreateProjectConfig).toHaveBeenCalledWith({
      project: {
        path: "/repo",
        name: "Repo",
        setupCommand: "npm install",
        commands: [
          {
            id: expect.any(String),
            label: "Run app",
            command: "npm run dev",
            icon: "play_arrow",
            showLabel: false,
          },
        ],
      },
      writeProjectConfig: true,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2400);
    });

    expect(
      screen.queryByRole("button", { name: "CREATE REPO CONFIG FILE" }),
    ).toBeNull();
    expect(screen.queryByText("Project Config File")).toBeNull();
    screen.getByText(/stored in/i);
    screen.getByText("/repo/.rakh/scripts.json");

    fireEvent.click(screen.getByRole("button", { name: "SAVE" }));

    expect(onSave).toHaveBeenCalledWith({
      project: {
        path: "/repo",
        name: "Repo",
        setupCommand: "npm install",
        commands: [
          {
            id: expect.any(String),
            label: "Run app",
            command: "npm run dev",
            icon: "play_arrow",
            showLabel: false,
          },
        ],
      },
      writeProjectConfig: true,
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows repo config path in the footer immediately when the repo config already exists", () => {
    const onSave = vi.fn();
    const onCreateProjectConfig = vi.fn();

    render(
      <ProjectSettingsModal
        project={{
          path: "/repo",
          name: "Repo",
          setupCommand: "npm install",
          hasProjectConfigFile: true,
        }}
        onClose={() => undefined}
        onSave={onSave}
        onCreateProjectConfig={onCreateProjectConfig}
      />,
    );

    expect(screen.queryByText("Project Config File")).toBeNull();
    screen.getByText(/stored in/i);
    screen.getByText("/repo/.rakh/scripts.json");
    expect(
      screen.queryByRole("button", { name: "CREATE REPO CONFIG FILE" }),
    ).toBeNull();

    fireEvent.change(
      screen.getByPlaceholderText("npm install && npm run build"),
      { target: { value: "   " } },
    );
    fireEvent.click(screen.getByRole("button", { name: "SAVE" }));

    expect(onSave).toHaveBeenCalledWith({
      project: {
        path: "/repo",
        name: "Repo",
      },
      writeProjectConfig: true,
    });
  });
});
