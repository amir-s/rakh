import { describe, expect, it } from "vitest";
import {
  findSubagentByTrigger,
  getAllSubagents,
  getSubagent,
  getSubagentThemeColorMap,
  getSubagentThemeColorToken,
  getSubagentThemeColorVariable,
} from "./index";

describe("getAllSubagents", () => {
  it("returns a non-empty list", () => {
    expect(getAllSubagents().length).toBeGreaterThan(0);
  });

  it("returns a shallow copy (mutations do not affect the registry)", () => {
    const first = getAllSubagents();
    first.pop();
    const second = getAllSubagents();
    expect(second.length).toBeGreaterThan(first.length);
  });

  it("every entry has required fields", () => {
    for (const s of getAllSubagents()) {
      expect(typeof s.id).toBe("string");
      expect(s.id.length).toBeGreaterThan(0);
      expect(typeof s.name).toBe("string");
      expect(typeof s.icon).toBe("string");
      expect(s.icon.length).toBeGreaterThan(0);
      expect(typeof s.color).toBe("object");
      expect(typeof s.color.dark).toBe("string");
      expect(typeof s.color.light).toBe("string");
      expect(s.color.dark.length).toBeGreaterThan(0);
      expect(s.color.light.length).toBeGreaterThan(0);
      expect(typeof s.description).toBe("string");
      expect(typeof s.systemPrompt).toBe("string");
      expect(Array.isArray(s.recommendedModels)).toBe(true);
      expect(Array.isArray(s.tools)).toBe(true);
      expect(typeof s.requiresApproval).toBe("boolean");
      expect(s.output).toBeDefined();
      expect(Array.isArray(s.output?.artifacts)).toBe(true);
      expect(typeof s.output?.finalMessageInstructions).toBe("string");
    }
  });

  it("declares artifact-backed outputs instead of OUTPUT_JSON instructions", () => {
    for (const s of getAllSubagents()) {
      expect(s.systemPrompt).not.toContain("OUTPUT_JSON");
      expect(s.output?.finalMessageInstructions).not.toContain("OUTPUT_JSON");
      for (const artifact of s.output?.artifacts ?? []) {
        expect(typeof artifact.artifactType).toBe("string");
        expect(artifact.artifactType.length).toBeGreaterThan(0);
        expect(typeof artifact.kind).toBe("string");
        expect(artifact.kind.length).toBeGreaterThan(0);
        expect(typeof artifact.contentFormat).toBe("string");
        if (artifact.validator) {
          expect(typeof artifact.validator.id).toBe("string");
          expect(["reject", "warn"]).toContain(artifact.validator.validationMode);
        }
      }
    }
  });
});

describe("subagent theme color helpers", () => {
  it("builds stable variable names and tokens", () => {
    expect(getSubagentThemeColorVariable("planner")).toBe(
      "--color-subagent-planner",
    );
    expect(getSubagentThemeColorToken("planner")).toBe(
      "var(--color-subagent-planner, var(--color-primary))",
    );
  });

  it("returns all registered subagent colors for a mode", () => {
    const dark = getSubagentThemeColorMap("dark");
    const light = getSubagentThemeColorMap("light");

    expect(Object.keys(dark).length).toBeGreaterThan(0);
    expect(Object.keys(dark)).toEqual(Object.keys(light));

    expect(dark["--color-subagent-planner"]).toBeDefined();
    expect(light["--color-subagent-copywriter"]).toBeDefined();
    expect(dark["--color-subagent-reviewer"]).toBeDefined();
    expect(light["--color-subagent-security"]).toBeDefined();
  });
});

describe("getSubagent", () => {
  it("returns the subagent for a known id", () => {
    const sa = getSubagent("planner");
    expect(sa).toBeDefined();
    expect(sa?.id).toBe("planner");
  });

  it("returns the reviewer subagent for id=reviewer", () => {
    const sa = getSubagent("reviewer");
    expect(sa).toBeDefined();
    expect(sa?.id).toBe("reviewer");
  });

  it("returns the security subagent for id=security", () => {
    const sa = getSubagent("security");
    expect(sa).toBeDefined();
    expect(sa?.id).toBe("security");
  });

  it("returns the github subagent for id=github", () => {
    const sa = getSubagent("github");
    expect(sa).toBeDefined();
    expect(sa?.id).toBe("github");
  });

  it("returns undefined for an unknown id", () => {
    expect(getSubagent("does-not-exist")).toBeUndefined();
  });

  it("returns undefined for an empty string", () => {
    expect(getSubagent("")).toBeUndefined();
  });
});

describe("findSubagentByTrigger", () => {
  it("returns null when no subagent has a matching trigger", () => {
    expect(findSubagentByTrigger("hello world")).toBeNull();
    expect(findSubagentByTrigger("")).toBeNull();
    expect(findSubagentByTrigger("/unknown-command foo")).toBeNull();
  });

  it("matches an exact trigger command with an empty subMessage", () => {
    const result = findSubagentByTrigger("/plan");
    expect(result).not.toBeNull();
    expect(result?.subagent.id).toBe("planner");
    expect(result?.subMessage).toBe("");
  });

  it("matches trigger followed by a message and strips the command", () => {
    const result = findSubagentByTrigger("/plan refactor the auth module");
    expect(result).not.toBeNull();
    expect(result?.subagent.id).toBe("planner");
    expect(result?.subMessage).toBe("refactor the auth module");
  });

  it("trims leading/trailing whitespace from the input before matching", () => {
    const result = findSubagentByTrigger("  /plan   do the thing  ");
    expect(result).not.toBeNull();
    expect(result?.subMessage).toBe("do the thing");
  });

  it("does not partially match a trigger prefix", () => {
    // '/planner' should not match '/plan'
    expect(findSubagentByTrigger("/planner do stuff")).toBeNull();
  });

  it("matches the /copywrite trigger", () => {
    const result = findSubagentByTrigger("/copywrite review last commit");
    expect(result).not.toBeNull();
    expect(result?.subagent.id).toBe("copywriter");
    expect(result?.subMessage).toBe("review last commit");
  });

  it("exact /copywrite with no trailing message yields empty subMessage", () => {
    const result = findSubagentByTrigger("/copywrite");
    expect(result).not.toBeNull();
    expect(result?.subagent.id).toBe("copywriter");
    expect(result?.subMessage).toBe("");
  });

  it("matches the /review trigger", () => {
    const result = findSubagentByTrigger("/review auth service");
    expect(result).not.toBeNull();
    expect(result?.subagent.id).toBe("reviewer");
    expect(result?.subMessage).toBe("auth service");
  });

  it("exact /review with no trailing message yields empty subMessage", () => {
    const result = findSubagentByTrigger("/review");
    expect(result).not.toBeNull();
    expect(result?.subagent.id).toBe("reviewer");
    expect(result?.subMessage).toBe("");
  });

  it("matches the /security trigger", () => {
    const result = findSubagentByTrigger("/security src/server");
    expect(result).not.toBeNull();
    expect(result?.subagent.id).toBe("security");
    expect(result?.subMessage).toBe("src/server");
  });

  it("exact /security with no trailing message yields empty subMessage", () => {
    const result = findSubagentByTrigger("/security");
    expect(result).not.toBeNull();
    expect(result?.subagent.id).toBe("security");
    expect(result?.subMessage).toBe("");
  });

  it("matches the /github trigger", () => {
    const result = findSubagentByTrigger("/github create an issue for auth");
    expect(result).not.toBeNull();
    expect(result?.subagent.id).toBe("github");
    expect(result?.subMessage).toBe("create an issue for auth");
  });

  it("exact /github with no trailing message yields empty subMessage", () => {
    const result = findSubagentByTrigger("/github");
    expect(result).not.toBeNull();
    expect(result?.subagent.id).toBe("github");
    expect(result?.subMessage).toBe("");
  });
});

describe("reviewer tool safety", () => {
  it("reviewer tool allowlist excludes edit and write tools", () => {
    const reviewer = getSubagent("reviewer");
    expect(reviewer).toBeDefined();
    expect(reviewer?.tools).not.toContain("workspace_editFile");
    expect(reviewer?.tools).not.toContain("workspace_writeFile");
  });
});

describe("security tool safety", () => {
  it("security tool allowlist excludes edit and write tools", () => {
    const security = getSubagent("security");
    expect(security).toBeDefined();
    expect(security?.tools).not.toContain("workspace_editFile");
    expect(security?.tools).not.toContain("workspace_writeFile");
    expect(security?.tools).toContain("exec_run");
  });
});

describe("github subagent", () => {
  it("declares summary-only output with no artifacts", () => {
    const github = getSubagent("github");
    expect(github).toBeDefined();
    expect(github?.output?.artifacts).toEqual([]);
    expect(github?.output?.parentNote).toContain("does not create artifacts");
  });

  it("github tool allowlist excludes edit and write tools", () => {
    const github = getSubagent("github");
    expect(github).toBeDefined();
    expect(github?.tools).not.toContain("workspace_editFile");
    expect(github?.tools).not.toContain("workspace_writeFile");
    expect(github?.tools).toContain("exec_run");
  });
});

describe("subagent title ownership", () => {
  it("keeps agent_title_set out of all subagent tool allowlists", () => {
    for (const subagent of getAllSubagents()) {
      expect(subagent.tools).not.toContain("agent_title_set");
    }
  });
});
