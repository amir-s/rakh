// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const githubIntegrationMocks = vi.hoisted(() => ({
  probeGitHubRepositoryMock: vi.fn(),
}));

vi.mock("@/githubIntegration", () => ({
  probeGitHubRepository: (...args: unknown[]) =>
    githubIntegrationMocks.probeGitHubRepositoryMock(...args),
  getGitHubRepoUnavailableMessage: (probe: { reason?: string } | null) => {
    if (!probe || probe.reason === "error") {
      return "GitHub integration is unavailable right now.";
    }
    if (probe.reason === "not_git") {
      return "GitHub integration is unavailable because this project is not a git repository.";
    }
    if (probe.reason === "missing_origin") {
      return "GitHub integration is unavailable because this project has no origin remote.";
    }
    if (probe.reason === "not_github") {
      return "GitHub integration is unavailable because this project is not connected to GitHub.";
    }
    return "Show recent GitHub issues from this repository in the command bar.";
  },
}));

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
    githubIntegrationMocks.probeGitHubRepositoryMock.mockReset();
    githubIntegrationMocks.probeGitHubRepositoryMock.mockResolvedValue({
      eligible: true,
      reason: "eligible",
      repoRoot: "/repo",
      repoSlug: "owner/repo",
      remoteUrl: "git@github.com:owner/repo.git",
    });
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
      screen.getByRole("textbox", { name: "Project name" }),
      { target: { value: " Repo Tools " } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Selected project icon folder" }),
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Search project icons" }),
      { target: { value: "term" } },
    );
    fireEvent.click(screen.getByRole("option", { name: "terminal" }));
    fireEvent.change(
      screen.getByPlaceholderText("npm install && npm run build"),
      { target: { value: "  npm install  " } },
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      screen.getByTitle("Toggle GitHub integration").hasAttribute("disabled"),
    ).toBe(false);
    fireEvent.click(screen.getByTitle("Toggle GitHub integration"));
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

    expect(screen.queryByText("Run app")).toBeNull();
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
        name: "Repo Tools",
        icon: "terminal",
        setupCommand: "npm install",
        githubIntegrationEnabled: true,
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
        name: "Repo Tools",
        icon: "terminal",
        setupCommand: "npm install",
        githubIntegrationEnabled: true,
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

  it("filters project icon suggestions and applies the selected icon", () => {
    render(
      <ProjectSettingsModal
        project={{ path: "/repo", name: "Repo" }}
        onClose={() => undefined}
        onSave={() => undefined}
        onCreateProjectConfig={() => undefined}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Selected project icon folder" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Search project icons" }), {
      target: { value: "term" },
    });

    fireEvent.click(screen.getByRole("option", { name: "terminal" }));

    expect(
      screen.getByRole("button", { name: "Selected project icon terminal" }),
    ).not.toBeNull();
    expect(
      screen.queryByRole("dialog", { name: "Project icon picker" }),
    ).toBeNull();
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
        icon: "folder",
      },
      writeProjectConfig: true,
    });
  });

  it("disables GitHub integration when the project is not connected to GitHub", async () => {
    githubIntegrationMocks.probeGitHubRepositoryMock.mockResolvedValue({
      eligible: false,
      reason: "not_github",
      repoRoot: "/repo",
      repoSlug: null,
      remoteUrl: "git@gitlab.com:owner/repo.git",
    });

    render(
      <ProjectSettingsModal
        project={{ path: "/repo", name: "Repo" }}
        onClose={() => undefined}
        onSave={() => undefined}
        onCreateProjectConfig={() => undefined}
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(
      screen.getByText(
        "GitHub integration is unavailable because this project is not connected to GitHub.",
      ),
    ).not.toBeNull();

    expect(screen.getByTitle("Toggle GitHub integration").hasAttribute("disabled")).toBe(
      true,
    );
  });
});
