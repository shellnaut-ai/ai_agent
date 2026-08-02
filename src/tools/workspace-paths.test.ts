import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkspacePaths } from "./workspace-paths.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("WorkspacePaths", () => {
  it("resolves an existing regular file below the workspace", async () => {
    const rootDir = await temporaryDirectory("pi-clone-path-root-");
    const filePath = join(rootDir, "a.txt");
    await writeFile(filePath, "A", "utf8");

    await expect(new WorkspacePaths(rootDir).existingFile("a.txt"))
      .resolves.toBe(await realpath(filePath));
  });

  it("prepares missing parent directories for a new writable file", async () => {
    const rootDir = await temporaryDirectory("pi-clone-path-root-");
    const target = await new WorkspacePaths(rootDir).writableFile("nested/deep/a.txt");

    expect(target).toBe(join(rootDir, "nested", "deep", "a.txt"));
    await expect(stat(join(rootDir, "nested", "deep"))).resolves.toMatchObject({});
  });

  it("rejects an absolute existing file outside the workspace", async () => {
    const rootDir = await temporaryDirectory("pi-clone-path-root-");
    const outsideDir = await temporaryDirectory("pi-clone-path-outside-");
    const outsideFile = join(outsideDir, "secret.txt");
    await writeFile(outsideFile, "secret", "utf8");

    await expect(new WorkspacePaths(rootDir).existingFile(outsideFile)).rejects.toThrow(
      "Path must stay within the configured root directory",
    );
  });

  it("rejects an existing file reached through an outside symlink", async () => {
    const { rootDir, outsideDir } = await linkedWorkspace();
    await writeFile(join(outsideDir, "secret.txt"), "secret", "utf8");

    await expect(new WorkspacePaths(rootDir).existingFile("escape/secret.txt"))
      .rejects.toThrow("Path must stay within the configured root directory");
  });

  it("rejects a new file whose existing parent symlink leaves the workspace", async () => {
    const { rootDir } = await linkedWorkspace();

    await expect(new WorkspacePaths(rootDir).writableFile("escape/new.txt"))
      .rejects.toThrow("Path must stay within the configured root directory");
  });

  it("rejects the workspace root and existing directories as files", async () => {
    const rootDir = await temporaryDirectory("pi-clone-path-root-");
    await mkdir(join(rootDir, "directory"));
    const paths = new WorkspacePaths(rootDir);

    await expect(paths.writableFile(".")).rejects.toThrow("Path must point below the workspace root");
    await expect(paths.existingFile("directory")).rejects.toThrow("Path must point to a file");
  });
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  cleanupPaths.push(path);
  return path;
}

async function linkedWorkspace(): Promise<{ rootDir: string; outsideDir: string }> {
  const sandbox = await temporaryDirectory("pi-clone-path-link-");
  const rootDir = join(sandbox, "root");
  const outsideDir = join(sandbox, "outside");
  await Promise.all([mkdir(rootDir), mkdir(outsideDir)]);
  await symlink(
    outsideDir,
    join(rootDir, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  return { rootDir, outsideDir };
}
