import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { EditTool } from "./edit-tool.js";

describe("EditTool", () => {
  test("declares and parses path, oldText, and newText only", () => {
    const tool = new EditTool("C:/workspace");

    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: {
        path: { type: "string" },
        oldText: { type: "string" },
        newText: { type: "string" },
      },
      required: ["path", "oldText", "newText"],
      additionalProperties: false,
    });
    expect(tool.parse({ path: "notes.txt", oldText: "before", newText: "after" })).toEqual({
      path: "notes.txt",
      oldText: "before",
      newText: "after",
    });
  });

  test("rejects missing, non-string, additional, and empty oldText inputs", () => {
    const tool = new EditTool("C:/workspace");

    expect(() => tool.parse({ path: "notes.txt", oldText: "before" })).toThrow(
      "Expected exactly three string properties: path, oldText, and newText",
    );
    expect(() => tool.parse({ path: "notes.txt", oldText: 1, newText: "after" })).toThrow(
      "Expected exactly three string properties: path, oldText, and newText",
    );
    expect(() =>
      tool.parse({ path: "notes.txt", oldText: "before", newText: "after", all: true }),
    ).toThrow("Expected exactly three string properties: path, oldText, and newText");
    expect(() => tool.parse({ path: "notes.txt", oldText: "", newText: "after" })).toThrow(
      "oldText must not be empty",
    );
  });

  test("replaces the single exact oldText occurrence", async () => {
    const rootDir = await temporaryWorkspace();
    await writeFile(join(rootDir, "notes.txt"), "alpha\nbefore\nomega\n", "utf8");

    await expect(
      new EditTool(rootDir).execute({ path: "notes.txt", oldText: "before", newText: "after" }),
    ).resolves.toEqual({ content: "Edited notes.txt" });
    await expect(readFile(join(rootDir, "notes.txt"), "utf8")).resolves.toBe(
      "alpha\nafter\nomega\n",
    );
  });

  test("rejects zero matches without changing the file", async () => {
    const rootDir = await temporaryWorkspace();
    const filePath = join(rootDir, "notes.txt");
    await writeFile(filePath, "original", "utf8");

    await expect(
      new EditTool(rootDir).execute({ path: "notes.txt", oldText: "missing", newText: "after" }),
    ).rejects.toThrow("oldText must occur exactly once; found 0 occurrences");
    await expect(readFile(filePath, "utf8")).resolves.toBe("original");
  });

  test("rejects multiple matches without changing the file", async () => {
    const rootDir = await temporaryWorkspace();
    const filePath = join(rootDir, "notes.txt");
    await writeFile(filePath, "same and same", "utf8");

    await expect(
      new EditTool(rootDir).execute({ path: "notes.txt", oldText: "same", newText: "after" }),
    ).rejects.toThrow("oldText must occur exactly once; found 2 occurrences");
    await expect(readFile(filePath, "utf8")).resolves.toBe("same and same");
  });

  test("rejects a symlink or junction that resolves outside the workspace", async () => {
    const sandbox = await temporaryWorkspace("pi-clone-edit-link-");
    const rootDir = join(sandbox, "root");
    const outsideDir = join(sandbox, "outside");
    await Promise.all([mkdir(rootDir), mkdir(outsideDir)]);
    const outsideFile = join(outsideDir, "secret.txt");
    await writeFile(outsideFile, "before", "utf8");
    await symlink(
      outsideDir,
      join(rootDir, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      new EditTool(rootDir).execute({
        path: "escape/secret.txt",
        oldText: "before",
        newText: "after",
      }),
    ).rejects.toThrow("Path must stay within the configured root directory");
    await expect(readFile(outsideFile, "utf8")).resolves.toBe("before");
  });
});

const cleanupPaths: string[] = [];

async function temporaryWorkspace(prefix = "pi-clone-edit-"): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  cleanupPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
