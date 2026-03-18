import { describe, expect, it } from "vitest";
import {
  parseFileReferenceHref,
  parsePlainTextFileReference,
  resolveFileReferencePath,
} from "./markdownFileReferences";

describe("markdownFileReferences", () => {
  it("parses plain text path:line[:column] references", () => {
    expect(parsePlainTextFileReference("src/materialSymbols.ts:21")).toEqual({
      path: "src/materialSymbols.ts",
      line: 21,
    });
    expect(parsePlainTextFileReference("src/materialSymbols.ts:25:7")).toEqual({
      path: "src/materialSymbols.ts",
      line: 25,
      column: 7,
    });
  });

  it("parses local markdown href variants with #L anchors", () => {
    expect(parseFileReferenceHref("src/materialSymbols.ts#L21")).toEqual({
      path: "src/materialSymbols.ts",
      line: 21,
    });
    expect(parseFileReferenceHref("src/materialSymbols.ts#L25C7")).toEqual({
      path: "src/materialSymbols.ts",
      line: 25,
      column: 7,
    });
  });

  it("resolves workspace-relative references against cwd", () => {
    expect(resolveFileReferencePath("src/materialSymbols.ts", "/repo")).toBe(
      "/repo/src/materialSymbols.ts",
    );
  });

  it("rejects url-like hosts and unresolved relative references", () => {
    expect(parsePlainTextFileReference("example.com:80")).toBeNull();
    expect(resolveFileReferencePath("src/materialSymbols.ts")).toBeNull();
  });
});
