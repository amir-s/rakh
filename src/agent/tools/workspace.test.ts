import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  applyEditChanges,
  editFile,
  glob,
  listDir,
  readFile,
  searchFiles,
  statFile,
  writeFile,
} from "./workspace";

const invokeMock = vi.mocked(invoke);

function setTauriAvailable(value: boolean): void {
  if (value) {
    (globalThis as unknown as { window: unknown }).window = {
      __TAURI_INTERNALS__: {},
    };
  } else {
    (globalThis as unknown as { window?: unknown }).window = undefined;
  }
}

describe("workspace tools", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    setTauriAvailable(true);
  });

  afterEach(() => {
    setTauriAvailable(false);
  });

  describe("path validation", () => {
    it("allows empty path for workspace root", async () => {
      invokeMock.mockResolvedValueOnce({
        path: "/test/cwd",
        entries: [],
        truncated: false,
      });

      const result = await listDir("/test/cwd", { path: "" });
      expect(result.ok).toBe(true);
      expect(invokeMock).toHaveBeenCalledWith("list_dir", {
        path: "/test/cwd",
        includeHidden: false,
        maxEntries: 200,
      });
    });

    it("rejects absolute paths", async () => {
      const result = await readFile("/test/cwd", { path: "/etc/passwd" });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected error");
      expect(result.error.code).toBe("INVALID_ARGUMENT");
      expect(result.error.message).toMatch(/Path must be workspace-relative/);
    });

    it("rejects missing required path fields without throwing", async () => {
      const result = await readFile("/test/cwd", {} as never);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected error");
      expect(result.error.code).toBe("INVALID_ARGUMENT");
      expect(result.error.message).toMatch(/Path is required/);
      expect(invokeMock).not.toHaveBeenCalled();
    });

    it("rejects path traversal segments", async () => {
      const writeResult = await writeFile("/test/cwd", {
        path: "../secrets.txt",
        content: "test",
      });
      expect(writeResult.ok).toBe(false);
      if (writeResult.ok) throw new Error("expected error");
      expect(writeResult.error.code).toBe("INVALID_ARGUMENT");

      const listResult = await listDir("/test/cwd", { path: "src/../../etc" });
      expect(listResult.ok).toBe(false);
      if (listResult.ok) throw new Error("expected error");
      expect(listResult.error.code).toBe("INVALID_ARGUMENT");
    });

    it("returns INTERNAL when Tauri runtime is unavailable", async () => {
      setTauriAvailable(false);
      const result = await listDir("/test/cwd", { path: "src" });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected error");
      expect(result.error.code).toBe("INTERNAL");
      expect(result.error.message).toMatch(/Tauri is not available/);
    });
  });

  describe("command wrappers", () => {
    it("maps statFile success responses", async () => {
      invokeMock.mockResolvedValueOnce({
        exists: true,
        path: "/test/cwd/src/main.ts",
        kind: "file",
      });

      const result = await statFile("/test/cwd", { path: "src/main.ts" });
      expect(result.ok).toBe(true);
      expect(invokeMock).toHaveBeenCalledWith("stat_file", {
        path: "/test/cwd/src/main.ts",
      });
    });

    it("maps readFile not found errors to NOT_FOUND", async () => {
      invokeMock.mockRejectedValueOnce(new Error("No such file or directory"));
      const result = await readFile("/test/cwd", { path: "missing.txt" });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected error");
      expect(result.error.code).toBe("NOT_FOUND");
    });

    it("rejects oversized write payloads before invoking Tauri", async () => {
      const result = await writeFile("/test/cwd", {
        path: "big.txt",
        content: "12345",
        maxBytes: 4,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected error");
      expect(result.error.code).toBe("TOO_LARGE");
      expect(invokeMock).not.toHaveBeenCalled();
    });

    it("maps write conflict errors to CONFLICT", async () => {
      invokeMock.mockRejectedValueOnce(new Error("CONFLICT: file exists"));
      const result = await writeFile("/test/cwd", {
        path: "existing.txt",
        content: "next",
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected error");
      expect(result.error.code).toBe("CONFLICT");
    });

    it("passes cwd overrides to glob and search wrappers", async () => {
      invokeMock
        .mockResolvedValueOnce({ matches: ["a.ts"], truncated: false })
        .mockResolvedValueOnce({
          matches: [],
          truncated: false,
          searchedFiles: 1,
          matchCount: 0,
        });

      const globResult = await glob("/test/cwd", {
        cwd: "src",
        patterns: ["**/*.ts"],
      });
      expect(globResult.ok).toBe(true);
      expect(invokeMock).toHaveBeenNthCalledWith(1, "glob_files", {
        patterns: ["**/*.ts"],
        cwd: "/test/cwd/src",
        maxMatches: 2000,
        includeDirs: false,
        includeHidden: false,
      });

      const searchResult = await searchFiles("/test/cwd", {
        pattern: "TODO",
        rootDir: "src",
      });
      expect(searchResult.ok).toBe(true);
      expect(invokeMock).toHaveBeenNthCalledWith(2, "search_files_grep", {
        pattern: "TODO",
        rootDir: "/test/cwd/src",
        includeGlobs: [],
        excludeGlobs: [],
        maxMatches: 200,
        caseSensitive: false,
        includeHidden: false,
        contextLines: 0,
        followSymlinks: false,
      });
    });

    it("rejects non-string cwd/rootDir in glob/search", async () => {
      const globResult = await glob("/test/cwd", {
        patterns: ["**/*.ts"],
        cwd: 42 as unknown as string,
      });
      expect(globResult.ok).toBe(false);
      if (globResult.ok) throw new Error("expected error");
      expect(globResult.error.code).toBe("INVALID_ARGUMENT");
      expect(globResult.error.message).toMatch(/Path must be a string/);

      const searchResult = await searchFiles("/test/cwd", {
        pattern: "TODO",
        rootDir: { bad: true } as unknown as string,
      });
      expect(searchResult.ok).toBe(false);
      if (searchResult.ok) throw new Error("expected error");
      expect(searchResult.error.code).toBe("INVALID_ARGUMENT");
      expect(searchResult.error.message).toMatch(/Path must be a string/);
      expect(invokeMock).not.toHaveBeenCalled();
    });
  });

  describe("editFile", () => {
    it("rejects path traversal", async () => {
      const result = await editFile("/test/cwd", {
        path: "../secrets.txt",
        changes: [{ oldString: "a", newString: "b" }],
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected error");
      expect(result.error.code).toBe("INVALID_ARGUMENT");
    });

    it("rejects empty changes array", async () => {
      const result = await editFile("/test/cwd", {
        path: "file.txt",
        changes: [],
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected error");
      expect(result.error.code).toBe("INVALID_ARGUMENT");
    });

    it("returns NOT_FOUND when file cannot be read", async () => {
      invokeMock.mockRejectedValueOnce(new Error("No such file"));
      const result = await editFile("/test/cwd", {
        path: "missing.txt",
        changes: [{ oldString: "a", newString: "b" }],
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected error");
      expect(result.error.code).toBe("NOT_FOUND");
    });

    it("returns CONFLICT when oldString is not found", async () => {
      invokeMock.mockResolvedValueOnce({
        path: "/test/cwd/file.txt",
        encoding: "utf8",
        content: "hello world",
        fileSizeBytes: 11,
        truncated: false,
      });
      const result = await editFile("/test/cwd", {
        path: "file.txt",
        changes: [{ oldString: "not present", newString: "anything" }],
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected error");
      expect(result.error.code).toBe("CONFLICT");
      expect(result.error.message).toMatch(/not present/);
    });

    it("replaces the single occurrence when replaceAll is false", async () => {
      invokeMock
        .mockResolvedValueOnce({
          path: "/test/cwd/file.txt",
          encoding: "utf8",
          content: "foo bar baz",
          fileSizeBytes: 11,
          truncated: false,
        })
        .mockResolvedValueOnce({
          path: "/test/cwd/file.txt",
          encoding: "utf8",
          content: "foo bar baz",
          fileSizeBytes: 11,
          truncated: false,
        })
        .mockResolvedValueOnce({
          path: "/test/cwd/file.txt",
          bytesWritten: 11,
          created: false,
          overwritten: true,
        });

      const result = await editFile("/test/cwd", {
        path: "file.txt",
        changes: [{ oldString: "foo", newString: "qux" }],
      });
      expect(result.ok).toBe(true);
      const writeCall = invokeMock.mock.calls[2];
      expect(writeCall[0]).toBe("write_file");
      expect((writeCall[1] as Record<string, unknown>).content).toBe(
        "qux bar baz",
      );
    });

    it("fails with CONFLICT when oldString appears multiple times and replaceAll is false", async () => {
      invokeMock.mockResolvedValueOnce({
        path: "/test/cwd/file.txt",
        encoding: "utf8",
        content: "foo foo foo",
        fileSizeBytes: 11,
        truncated: false,
      });

      const result = await editFile("/test/cwd", {
        path: "file.txt",
        changes: [{ oldString: "foo", newString: "bar" }],
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error.code).toBe("CONFLICT");
      expect(result.error.message).toMatch(/multiple times/);
    });

    it("replaces all occurrences when replaceAll is true", async () => {
      invokeMock
        .mockResolvedValueOnce({
          path: "/test/cwd/file.txt",
          encoding: "utf8",
          content: "foo foo foo",
          fileSizeBytes: 11,
          truncated: false,
        })
        .mockResolvedValueOnce({
          path: "/test/cwd/file.txt",
          encoding: "utf8",
          content: "foo foo foo",
          fileSizeBytes: 11,
          truncated: false,
        })
        .mockResolvedValueOnce({
          path: "/test/cwd/file.txt",
          bytesWritten: 11,
          created: false,
          overwritten: true,
        });

      const result = await editFile("/test/cwd", {
        path: "file.txt",
        changes: [{ oldString: "foo", newString: "bar", replaceAll: true }],
      });
      expect(result.ok).toBe(true);
      const writeCall = invokeMock.mock.calls[2];
      expect((writeCall[1] as Record<string, unknown>).content).toBe(
        "bar bar bar",
      );
    });

    it("applies multiple changes in sequence", async () => {
      invokeMock
        .mockResolvedValueOnce({
          path: "/test/cwd/file.txt",
          encoding: "utf8",
          content: "const x = 1; const y = 2;",
          fileSizeBytes: 24,
          truncated: false,
        })
        .mockResolvedValueOnce({
          path: "/test/cwd/file.txt",
          encoding: "utf8",
          content: "const x = 1; const y = 2;",
          fileSizeBytes: 24,
          truncated: false,
        })
        .mockResolvedValueOnce({
          path: "/test/cwd/file.txt",
          bytesWritten: 24,
          created: false,
          overwritten: true,
        });

      const result = await editFile("/test/cwd", {
        path: "file.txt",
        changes: [
          { oldString: "const x = 1;", newString: "const x = 10;" },
          { oldString: "const y = 2;", newString: "const y = 20;" },
        ],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected success");
      expect(result.data.appliedChanges).toBe(2);
      const writeCall = invokeMock.mock.calls[2];
      expect((writeCall[1] as Record<string, unknown>).content).toBe(
        "const x = 10; const y = 20;",
      );
    });
  });
});

describe("applyEditChanges", () => {
  it("replaces the single occurrence by default", () => {
    expect(applyEditChanges("abc", [{ oldString: "a", newString: "b" }])).toBe(
      "bbc",
    );
  });

  it("throws when oldString appears multiple times and replaceAll is false", () => {
    expect(() =>
      applyEditChanges("aaa", [{ oldString: "a", newString: "b" }]),
    ).toThrow(/multiple times/);
  });

  it("replaces all occurrences when replaceAll is true", () => {
    expect(
      applyEditChanges("aaa", [
        { oldString: "a", newString: "b", replaceAll: true },
      ]),
    ).toBe("bbb");
  });

  it("throws when oldString is not found", () => {
    expect(() =>
      applyEditChanges("hello", [{ oldString: "xyz", newString: "abc" }]),
    ).toThrow(/xyz/);
  });

  it("applies multiple changes in sequence", () => {
    const result = applyEditChanges("foo bar baz", [
      { oldString: "foo", newString: "qux" },
      { oldString: "bar", newString: "quux" },
    ]);
    expect(result).toBe("qux quux baz");
  });

  it("second change sees result of first", () => {
    // After replacing 'foo' with 'foobar', the second change targets 'foobar'
    const result = applyEditChanges("foo", [
      { oldString: "foo", newString: "foobar" },
      { oldString: "foobar", newString: "done" },
    ]);
    expect(result).toBe("done");
  });

  it("handles empty replacement (deletion)", () => {
    expect(
      applyEditChanges("hello world", [{ oldString: " world", newString: "" }]),
    ).toBe("hello");
  });
});
