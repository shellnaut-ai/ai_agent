import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { WriteTool } from "./write-tool.js";

describe("WriteTool", () => {
  test("declares and parses path and content only", () => {
    const tool = new WriteTool("C:/workspace");

    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    });
    expect(tool.parse({ path: "notes.txt", content: "hello" })).toEqual({
      path: "notes.txt",
      content: "hello",
    });
  });

  test("rejects missing, non-string, and additional input fields", () => {
    const tool = new WriteTool("C:/workspace");

    expect(() => tool.parse({ path: "notes.txt" })).toThrow(
      "Expected exactly two string properties: path and content",
    );
    expect(() => tool.parse({ path: "notes.txt", content: 1 })).toThrow(
      "Expected exactly two string properties: path and content",
    );
    expect(() => tool.parse({ path: "notes.txt", content: "ok", append: true })).toThrow(
      "Expected exactly two string properties: path and content",
    );
  });

  test("creates missing parent directories and writes UTF-8 content", async () => {
    const rootDir = await temporaryWorkspace();
    const tool = new WriteTool(rootDir);

    await expect(tool.execute({ path: "notes/deep/greeting.txt", content: "안녕하세요\n" }))
      .resolves.toEqual({ content: "Wrote 16 bytes to notes/deep/greeting.txt" });
    await expect(readFile(join(rootDir, "notes/deep/greeting.txt"), "utf8")).resolves.toBe(
      "안녕하세요\n",
    );
  });

  test("replaces an existing file instead of appending", async () => {
    const rootDir = await temporaryWorkspace();
    await writeFile(join(rootDir, "notes.txt"), "old", "utf8");

    await new WriteTool(rootDir).execute({ path: "notes.txt", content: "new" });

    await expect(readFile(join(rootDir, "notes.txt"), "utf8")).resolves.toBe("new");
  });

  test("rejects traversal and an existing directory", async () => {
    const rootDir = await temporaryWorkspace();
    await mkdir(join(rootDir, "folder"));
    const tool = new WriteTool(rootDir);

    await expect(tool.execute({ path: "../outside.txt", content: "no" })).rejects.toThrow(
      "Path must stay within the configured root directory",
    );
    await expect(tool.execute({ path: "folder", content: "no" })).rejects.toThrow(
      "Path must point to a file",
    );
  });

  test("rejects a new file below a symlink or junction that leaves the workspace", async () => {
    const sandbox = await temporaryWorkspace("pi-clone-write-link-");
    const rootDir = join(sandbox, "root");
    const outsideDir = join(sandbox, "outside");
    await Promise.all([mkdir(rootDir), mkdir(outsideDir)]);
    await symlink(
      outsideDir,
      join(rootDir, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      new WriteTool(rootDir).execute({ path: "escape/new.txt", content: "secret" }),
    ).rejects.toThrow("Path must stay within the configured root directory");
    await expect(readFile(join(outsideDir, "new.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

const cleanupPaths: string[] = [];

async function temporaryWorkspace(prefix = "pi-clone-write-"): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  cleanupPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
