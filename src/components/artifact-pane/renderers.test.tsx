// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ArtifactManifest } from "@/agent/tools/artifacts";
import { ArtifactRenderer } from "./renderers";

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
    artifactId: "mcp_attachment_1",
    version: 1,
    kind: "mcp-attachment",
    summary: "Playwright screenshot",
    metadata: {},
    contentFormat: "json",
    blobHash: "hash",
    sizeBytes: 128,
    createdAt: 1_000,
    content: JSON.stringify(
      {
        type: "image",
        mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO0p8xkAAAAASUVORK5CYII=",
      },
      null,
      2,
    ),
    ...overrides,
  };
}

describe("ArtifactRenderer", () => {
  it("renders image previews for MCP attachment artifacts that contain image payloads", () => {
    render(<ArtifactRenderer artifact={makeArtifact()} mode="detail" />);

    const image = screen.getByRole("img", { name: "Playwright screenshot" });
    expect(image.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    expect(screen.getByText("image/png")).not.toBeNull();
    expect(screen.getByText(/"mimeType": "image\/png"/)).not.toBeNull();
  });
});
