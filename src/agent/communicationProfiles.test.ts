import { describe, expect, it } from "vitest";

import {
  LEGACY_GLOBAL_COMMUNICATION_PROFILE_ID,
  getCommunicationProfileRecord,
  normalizeCommunicationProfileId,
  resolveCommunicationProfileId,
} from "./communicationProfiles";

const profiles = [
  { id: "pragmatic", name: "Pragmatic", promptSnippet: "Be pragmatic." },
  { id: "friendly", name: "Friendly", promptSnippet: "Be friendly." },
];

describe("communicationProfiles", () => {
  it("normalizes the legacy global sentinel to undefined", () => {
    expect(
      normalizeCommunicationProfileId(LEGACY_GLOBAL_COMMUNICATION_PROFILE_ID),
    ).toBeUndefined();
  });

  it("resolves legacy sessions to the configured default profile", () => {
    expect(
      resolveCommunicationProfileId("global", profiles, "friendly"),
    ).toBe("friendly");
  });

  it("falls back to the first available profile when the default is invalid", () => {
    expect(
      resolveCommunicationProfileId(undefined, profiles, "missing"),
    ).toBe("pragmatic");
  });

  it("preserves a concrete profile id when profiles are not loaded yet", () => {
    expect(resolveCommunicationProfileId("friendly", [], "pragmatic")).toBe(
      "friendly",
    );
  });

  it("returns the resolved profile record", () => {
    expect(
      getCommunicationProfileRecord(undefined, profiles, "friendly"),
    ).toEqual(profiles[1]);
  });
});
