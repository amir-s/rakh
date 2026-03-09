// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactManifest } from "@/agent/tools/artifacts";
import { buildSessionArtifactInventory } from "@/components/artifact-pane/model";
import type { ArtifactContentEntry } from "@/components/artifact-pane/types";
import ConversationCards, {
  buildExecutePlanArtifactMessage,
} from "./ConversationCards";

afterEach(() => {
  cleanup();
});

function makeArtifact(
  overrides: Partial<ArtifactManifest> = {},
): ArtifactManifest {
  return {
    sessionId: "tab-1",
    runId: "run-1",
    agentId: "agent_main",
    artifactSeq: 1,
    artifactId: "plan_123",
    version: 1,
    kind: "plan",
    summary: "Implementation plan",
    metadata: {},
    contentFormat: "markdown",
    blobHash: "hash",
    sizeBytes: 128,
    createdAt: 1_000,
    content: "# Plan\n\n1. Ship it.",
    ...overrides,
  };
}

function renderConversationCards(
  artifact: ArtifactManifest,
  options?: { executePlanDisabled?: boolean },
) {
  const onExecutePlan = vi.fn();
  const ensureArtifactContent = vi.fn(async () => undefined);
  const inventory = buildSessionArtifactInventory([artifact]);
  const entry: ArtifactContentEntry = {
    status: "loaded",
    artifact,
  };

  render(
    <ConversationCards
      cards={[
        {
          id: "card-1",
          kind: "artifact",
          artifactId: artifact.artifactId,
          version: artifact.version,
        },
      ]}
      artifactInventory={inventory}
      artifactInventoryLoading={false}
      getArtifactContentEntry={(artifactId, version) =>
        artifactId === artifact.artifactId && version === artifact.version
          ? entry
          : undefined
      }
      ensureArtifactContent={ensureArtifactContent}
      onExecutePlan={onExecutePlan}
      executePlanDisabled={options?.executePlanDisabled ?? false}
    />,
  );

  return { onExecutePlan, ensureArtifactContent };
}

describe("ConversationCards", () => {
  it("renders an execute button for plan artifacts and sends the artifact-aware prompt", () => {
    const artifact = makeArtifact();
    const { onExecutePlan } = renderConversationCards(artifact);

    fireEvent.click(screen.getByRole("button", { name: "Execute the plan" }));

    expect(onExecutePlan).toHaveBeenCalledWith(
      buildExecutePlanArtifactMessage(artifact.artifactId),
    );
  });

  it("does not render the execute button for non-plan artifacts", () => {
    renderConversationCards(
      makeArtifact({
        artifactId: "review_123",
        kind: "review-report",
        contentFormat: "json",
        content: JSON.stringify({ summary: "Looks fine", findings: [] }),
      }),
    );

    expect(
      screen.queryByRole("button", { name: "Execute the plan" }),
    ).toBeNull();
  });

  it("disables plan execution while the workspace is busy", () => {
    const artifact = makeArtifact();
    const { onExecutePlan } = renderConversationCards(artifact, {
      executePlanDisabled: true,
    });

    const button = screen.getByRole("button", { name: "Execute the plan" });
    expect((button as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(button);

    expect(onExecutePlan).not.toHaveBeenCalled();
  });
});
