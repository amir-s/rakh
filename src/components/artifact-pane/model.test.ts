import { describe, expect, it } from "vitest";
import type { ArtifactManifest } from "@/agent/tools/artifacts";
import {
  buildArtifactFilterOptions,
  buildArtifactInventoryFingerprint,
  buildSessionArtifactInventory,
  filterArtifactGroups,
  parseCopyReviewArtifact,
  parseReviewReportArtifact,
  parseSecurityReportArtifact,
  resolveArtifactRenderKind,
} from "./model";
import { ARTIFACT_FILTER_ALL } from "./types";

function makeArtifact(
  overrides: Partial<ArtifactManifest> = {},
): ArtifactManifest {
  return {
    sessionId: "tab-1",
    runId: "run-1",
    agentId: "agent_main",
    artifactSeq: 1,
    artifactId: "artifact_1",
    version: 1,
    kind: "plan",
    summary: "Summary",
    metadata: {},
    contentFormat: "markdown",
    blobHash: "hash",
    sizeBytes: 100,
    createdAt: 1_000,
    content: "# Plan",
    ...overrides,
  };
}

describe("artifact-pane model", () => {
  it("groups artifacts by id, sorts versions descending, and tracks latest plan", () => {
    const inventory = buildSessionArtifactInventory([
      makeArtifact({
        artifactId: "plan_a",
        version: 1,
        createdAt: 1_000,
        kind: "plan",
      }),
      makeArtifact({
        artifactId: "plan_a",
        version: 2,
        createdAt: 2_000,
        kind: "plan",
      }),
      makeArtifact({
        artifactId: "review_a",
        version: 1,
        createdAt: 3_000,
        kind: "review-report",
        contentFormat: "json",
      }),
    ]);

    expect(inventory.groups).toHaveLength(2);
    expect(inventory.groups[0].artifactId).toBe("review_a");
    expect(inventory.groups[1].artifactId).toBe("plan_a");
    expect(inventory.groups[1].versions.map((version) => version.version)).toEqual([
      2,
      1,
    ]);
    expect(inventory.latestPlanGroup?.artifactId).toBe("plan_a");
    expect(inventory.kindCounts).toEqual([
      { kind: "plan", count: 1 },
      { kind: "review-report", count: 1 },
    ]);
  });

  it("derives filter options and filters groups by raw kind", () => {
    const inventory = buildSessionArtifactInventory([
      makeArtifact({
        artifactId: "plan_a",
        kind: "plan",
      }),
      makeArtifact({
        artifactId: "review_a",
        kind: "review-report",
        contentFormat: "json",
        createdAt: 2_000,
      }),
      makeArtifact({
        artifactId: "review_b",
        kind: "review-report",
        contentFormat: "json",
        createdAt: 3_000,
      }),
    ]);

    const options = buildArtifactFilterOptions(inventory.kindCounts);
    expect(options[0]).toEqual({
      value: ARTIFACT_FILTER_ALL,
      label: "All",
      count: 3,
    });
    expect(options[1]).toEqual({ value: "plan", label: "plan", count: 1 });
    expect(options[2]).toEqual({
      value: "review-report",
      label: "review-report",
      count: 2,
    });

    expect(
      filterArtifactGroups(inventory.groups, "review-report").map(
        (group) => group.artifactId,
      ),
    ).toEqual(["review_b", "review_a"]);
  });

  it("builds a fingerprint that changes when the latest version changes", () => {
    const first = buildSessionArtifactInventory([
      makeArtifact({
        artifactId: "plan_a",
        version: 1,
        createdAt: 1_000,
      }),
    ]);
    const second = buildSessionArtifactInventory([
      makeArtifact({
        artifactId: "plan_a",
        version: 2,
        createdAt: 2_000,
      }),
    ]);

    expect(first.fingerprint).not.toBe(second.fingerprint);
    expect(buildArtifactInventoryFingerprint(first.groups)).toBe(first.fingerprint);
  });

  it("resolves render kind from framework metadata and falls back to content format", () => {
    expect(
      resolveArtifactRenderKind(
        makeArtifact({
          kind: "report",
          contentFormat: "json",
          metadata: { __rakh: { artifactType: "security-report" } },
        }),
      ),
    ).toBe("security-report");

    expect(
      resolveArtifactRenderKind(
        makeArtifact({
          kind: "custom-report",
          contentFormat: "json",
          metadata: { __rakh: { artifactType: "custom-report" } },
        }),
      ),
    ).toBe("json");
  });

  it("parses review-report JSON artifacts and falls back on invalid JSON", () => {
    const valid = parseReviewReportArtifact(
      JSON.stringify({
        summary: "Review summary",
        findings: [
          {
            file: "src/App.tsx",
            location: "line 42",
            severity: "high",
            issue: "Broken state update",
            suggestion: "Guard against undefined",
            reason: "Avoids runtime errors",
          },
        ],
      }),
    );

    expect(valid).toEqual({
      ok: true,
      data: {
        summary: "Review summary",
        findings: [
          {
            file: "src/App.tsx",
            location: "line 42",
            severity: "high",
            issue: "Broken state update",
            suggestion: "Guard against undefined",
            reason: "Avoids runtime errors",
          },
        ],
      },
    });

    const invalid = parseReviewReportArtifact("{bad json");
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.length).toBeGreaterThan(0);
    }
  });

  it("parses security and copy-review payloads", () => {
    const security = parseSecurityReportArtifact(
      JSON.stringify({
        summary: "Security summary",
        findings: [
          {
            file: "src/main.ts",
            location: "line 12",
            severity: "critical",
            confidence: "high",
            category: "authz",
            issue: "Bypass",
            impact: "Account takeover",
            remediation: "Validate access",
          },
        ],
      }),
    );
    expect(security.ok).toBe(true);

    const copy = parseCopyReviewArtifact(
      JSON.stringify({
        tone: "direct",
        summary: "Copy summary",
        suggestions: [
          {
            file: "src/App.tsx",
            location: "submit button",
            original: "Do it",
            suggested: "Save changes",
            reason: "More specific",
          },
        ],
      }),
    );
    expect(copy.ok).toBe(true);
  });
});
