import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ReadTool } from "./read-tool.js";

describe("ReadTool", () => {
  test("declares and parses the sole path input", () => {
    const tool = new ReadTool("C:/workspace");

    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    });
    expect(tool.parse({ path: "notes.txt" })).toEqual({ path: "notes.txt" });
  });

  test("rejects missing, non-string, and additional input fields", () => {
    const tool = new ReadTool("C:/workspace");

    expect(() => tool.parse({})).toThrow("Expected exactly one string property: path");
    expect(() => tool.parse({ path: 1 })).toThrow("Expected exactly one string property: path");
    expect(() => tool.parse({ path: "file.txt", mode: "write" })).toThrow(
      "Expected exactly one string property: path",
    );
  });

  test("reads a UTF-8 file below its configured root", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pi-clone-read-"));
    cleanupPaths.push(rootDir);
    await writeFile(join(rootDir, "greeting.txt"), "안녕하세요\n", "utf8");

    await expect(new ReadTool(rootDir).execute({ path: "greeting.txt" })).resolves.toEqual({
      content: "안녕하세요\n",
    });
  });

  test("rejects path traversal outside its configured root", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pi-clone-read-"));
    cleanupPaths.push(rootDir);

    await expect(new ReadTool(rootDir).execute({ path: "../outside.txt" })).rejects.toThrow(
      "Path must stay within the configured root directory",
    );
  });

  test("rejects an absolute path outside its configured root", async () => {
    // ".."가 없어도 절대 경로 자체가 configured root를 무시할 수 있음을 검증한다.
    const rootDir = await mkdtemp(join(tmpdir(), "pi-clone-read-root-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "pi-clone-read-outside-"));
    cleanupPaths.push(rootDir, outsideDir);
    const outsideFile = join(outsideDir, "secret.txt");
    await writeFile(outsideFile, "secret", "utf8");

    await expect(new ReadTool(rootDir).execute({ path: outsideFile })).rejects.toThrow(
      "Path must stay within the configured root directory",
    );
  });

  test("rejects a symlink or junction that resolves outside its configured root", async () => {
    // lexical 경로는 root 안이지만 realpath는 밖인 우회 경로를 실제 파일시스템으로 재현한다.
    const sandbox = await mkdtemp(join(tmpdir(), "pi-clone-read-link-"));
    cleanupPaths.push(sandbox);
    const rootDir = join(sandbox, "root");
    const outsideDir = join(sandbox, "outside");
    await Promise.all([
      mkdir(rootDir),
      mkdir(outsideDir),
    ]);
    await writeFile(join(outsideDir, "secret.txt"), "secret", "utf8");
    await symlink(
      outsideDir,
      join(rootDir, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(new ReadTool(rootDir).execute({ path: "escape/secret.txt" })).rejects.toThrow(
      "Path must stay within the configured root directory",
    );
  });

});

const cleanupPaths: string[] = [];
afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
