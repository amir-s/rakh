import { describe, expect, it } from "vitest";
import { computeDiffFile } from "./patchToDiff";

describe("patchToDiff - computeDiffFile", () => {
  it("returns no diff lines for identical content", () => {
    const diff = computeDiffFile("same.ts", "a\nb\n", "a\nb\n");
    expect(diff).toEqual({
      filename: "same.ts",
      adds: 0,
      removes: 0,
      lines: [],
    });
  });

  it("computes add/remove counts and escapes HTML", () => {
    const original = "line one\nline two\n";
    const current = "line one\n<changed>&\"value\"\n";

    const diff = computeDiffFile("file.ts", original, current, 3);
    expect(diff.adds).toBe(1);
    expect(diff.removes).toBe(1);
    expect(diff.lines.some((l) => l.type === "add" && l.html.includes("&lt;changed&gt;&amp;"))).toBe(
      true,
    );
    expect(diff.lines.some((l) => l.type === "remove" && l.lineNum === null)).toBe(true);
  });

  it("trims long unchanged regions and inserts meta separators", () => {
    const original = [
      "a1",
      "a2",
      "a3",
      "a4",
      "a5",
      "keep",
      "b1",
      "b2",
      "b3",
      "b4",
      "b5",
    ].join("\n");

    const current = [
      "a1",
      "a2 changed",
      "a3",
      "a4",
      "a5",
      "keep",
      "b1",
      "b2",
      "b3",
      "b4",
      "b5 changed",
    ].join("\n");

    const diff = computeDiffFile("trim.ts", original, current, 1);
    expect(diff.adds).toBe(2);
    expect(diff.removes).toBe(2);
    expect(diff.lines.some((l) => l.type === "meta" && l.html === "…")).toBe(true);
  });
});
