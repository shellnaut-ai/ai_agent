import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ReadTool, type ReadPageMetadata } from "./read.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("ReadTool paging", () => {
  test("reconstructs Korean and emoji UTF-8 with no gaps or overlaps", async () => {
    const rootDir = await temporaryDirectory("pi-clone-read-pages-");
    const original = "한글🙂boundary-".repeat(300);
    await writeFile(join(rootDir, "boundary.txt"), original, "utf8");
    const tool = new ReadTool({
      rootDir,
      maxBytes: 64 * 1024,
      cursorKey: randomBytes(32),
    });
    const outputs = await readAllPages(tool, "boundary.txt", 900);

    expect(outputs.map(({ content }) => Buffer.byteLength(content, "utf8")))
      .toSatisfy((sizes: number[]) => sizes.every((size) => size <= 900));
    expect(outputs.map(({ metadata }) => metadata.startByte))
      .toEqual(outputs.map(({ metadata }, index) =>
        index === 0 ? 0 : outputs[index - 1]!.metadata.endByte
      ));
    expect(outputs.map(({ page }) => page).join("")).toBe(original);
    expect(outputs.at(-1)?.metadata.nextCursor).toBeUndefined();
  });

  test("keeps empty and exactly-at-limit files raw, and pages one byte over", async () => {
    const rootDir = await temporaryDirectory("pi-clone-read-limits-");
    await writeFile(join(rootDir, "empty.txt"), "", "utf8");
    await writeFile(join(rootDir, "exact.txt"), "x".repeat(1024), "utf8");
    await writeFile(join(rootDir, "over.txt"), "x".repeat(1025), "utf8");
    const tool = new ReadTool({ rootDir, maxBytes: 1024, cursorKey: randomBytes(32) });

    await expect(tool.execute({ path: "empty.txt" })).resolves.toEqual({
      content: "",
      isError: false,
    });
    await expect(tool.execute({ path: "exact.txt" })).resolves.toEqual({
      content: "x".repeat(1024),
      isError: false,
    });
    const over = await tool.execute({ path: "over.txt" });
    expect(over.isError).toBe(false);
    expect(over.content).toContain("<read-page>");
  });

  test("rejects a stale file, invalid or expired cursors, and mixed input", async () => {
    const rootDir = await temporaryDirectory("pi-clone-read-stale-");
    const filePath = join(rootDir, "changing.txt");
    await writeFile(filePath, "a".repeat(3000), "utf8");
    let now = 1_000;
    const tool = new ReadTool({
      rootDir,
      maxBytes: 900,
      cursorKey: randomBytes(32),
      cursorTtlMs: 100,
      now: () => now,
    });
    const first = parsePage((await tool.execute({ path: "changing.txt" })).content);
    const cursor = first.metadata.nextCursor;
    if (cursor === undefined) throw new Error("Expected another page.");

    await writeFile(filePath, "b".repeat(3001), "utf8");
    await expect(tool.execute({ cursor })).resolves.toMatchObject({
      content: expect.stringMatching(/stale read cursor/i),
      isError: true,
    });
    await expect(tool.execute({ cursor: `${cursor}tampered` })).resolves.toMatchObject({
      content: expect.stringMatching(/invalid read cursor/i),
      isError: true,
    });
    await expect(tool.execute({ path: "changing.txt", cursor })).resolves.toMatchObject({
      isError: true,
    });

    await writeFile(filePath, "c".repeat(3000), "utf8");
    const fresh = parsePage((await tool.execute({ path: "changing.txt" })).content);
    now = 1_100;
    await expect(tool.execute({ cursor: fresh.metadata.nextCursor })).resolves.toMatchObject({
      content: expect.stringMatching(/expired read cursor/i),
      isError: true,
    });
  });

  test("splits one huge line and rejects invalid UTF-8 and workspace escapes", async () => {
    const sandbox = await temporaryDirectory("pi-clone-read-security-");
    const rootDir = join(sandbox, "root");
    const outsideDir = join(sandbox, "outside");
    await Promise.all([mkdir(rootDir), mkdir(outsideDir)]);
    await writeFile(join(rootDir, "line.txt"), "z".repeat(5000), "utf8");
    await writeFile(join(rootDir, "invalid.txt"), Buffer.from([0x61, 0xff, 0x62]));
    await writeFile(join(outsideDir, "secret.txt"), "secret", "utf8");
    await symlink(
      outsideDir,
      join(rootDir, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const tool = new ReadTool({ rootDir, maxBytes: 900, cursorKey: randomBytes(32) });

    const pages = await readAllPages(tool, "line.txt", 900);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.map(({ page }) => page).join("")).toBe("z".repeat(5000));
    await expect(tool.execute({ path: "invalid.txt" })).resolves.toMatchObject({
      content: expect.stringMatching(/utf-8/i),
      isError: true,
    });
    await expect(tool.execute({ path: "escape/secret.txt" })).resolves.toMatchObject({
      content: expect.stringMatching(/within|workspace/i),
      isError: true,
    });
  });

  test("honors abort before file access", async () => {
    const rootDir = await temporaryDirectory("pi-clone-read-abort-");
    await writeFile(join(rootDir, "a.txt"), "a", "utf8");
    const controller = new AbortController();
    controller.abort();

    await expect(new ReadTool({ rootDir }).execute(
      { path: "a.txt" },
      { signal: controller.signal },
    )).rejects.toThrow(/aborted/i);
  });
});

async function readAllPages(
  tool: ReadTool,
  path: string,
  maxBytes: number,
): Promise<Array<{
  readonly content: string;
  readonly page: string;
  readonly metadata: ReadPageMetadata;
}>> {
  const pages = [];
  let input: { path: string } | { cursor: string } = { path };
  while (true) {
    const result = await tool.execute(input, {
      resultBudget: { maxBytes, maxTokens: Math.floor(maxBytes / 4) },
    });
    if (result.isError) throw new Error(result.content);
    const parsed = parsePage(result.content);
    pages.push({ content: result.content, ...parsed });
    if (parsed.metadata.nextCursor === undefined) return pages;
    input = { cursor: parsed.metadata.nextCursor };
  }
}

function parsePage(content: string): {
  readonly page: string;
  readonly metadata: ReadPageMetadata;
} {
  const match = /\n\n<read-page>(.*)<\/read-page>$/u.exec(content);
  if (match?.[1] === undefined) throw new Error("Expected read page metadata.");
  return {
    page: content.slice(0, match.index),
    metadata: JSON.parse(match[1]) as ReadPageMetadata,
  };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(path);
  return path;
}
