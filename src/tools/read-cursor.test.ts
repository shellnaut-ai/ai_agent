import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  FileReadCursorKeyStore,
  ReadCursorCodec,
  type ReadCursorPayload,
} from "./read-cursor.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const payload: ReadCursorPayload = {
  version: 1,
  rootHash: "root-hash",
  relativePath: "docs/한글🙂.txt",
  realPathHash: "real-path-hash",
  offsetBytes: 4096,
  file: {
    dev: "1",
    ino: "2",
    size: "9000",
    mtimeNs: "3000000",
    ctimeNs: "4000000",
  },
  expiresAtMs: 20_000,
};

describe("ReadCursorCodec", () => {
  test("round-trips the canonical payload and rejects a tampered cursor", () => {
    const codec = new ReadCursorCodec({
      key: Buffer.alloc(32, 7),
      rootHash: payload.rootHash,
      now: () => 10_000,
    });
    const cursor = codec.encode(payload);

    expect(codec.decode(cursor)).toEqual(payload);
    const final = cursor.at(-1);
    const tampered = `${cursor.slice(0, -1)}${final === "A" ? "B" : "A"}`;
    expect(() => codec.decode(tampered)).toThrow(/invalid read cursor/i);
  });

  test("rejects expired, wrong-root, wrong-path, and malformed cursors", () => {
    const key = Buffer.alloc(32, 9);
    const codec = new ReadCursorCodec({
      key,
      rootHash: payload.rootHash,
      now: () => 10_000,
    });
    const cursor = codec.encode(payload);

    expect(() => new ReadCursorCodec({
      key,
      rootHash: payload.rootHash,
      now: () => payload.expiresAtMs,
    }).decode(cursor)).toThrow(/expired read cursor/i);
    expect(() => new ReadCursorCodec({
      key,
      rootHash: "another-root",
      now: () => 10_000,
    }).decode(cursor)).toThrow(/invalid read cursor/i);
    expect(() => codec.decode(cursor, { relativePath: "other.txt" }))
      .toThrow(/invalid read cursor/i);
    expect(() => codec.decode("not-base64url.%%%"))
      .toThrow(/invalid read cursor/i);
  });

  test("requires exactly 32 bytes of key material", () => {
    expect(() => new ReadCursorCodec({
      key: Buffer.alloc(31),
      rootHash: payload.rootHash,
    })).toThrow(/32-byte/i);
  });
});

describe("FileReadCursorKeyStore", () => {
  test("persists one exclusive raw key that survives restart", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pi-clone-read-key-"));
    cleanup.push(rootDir);
    const first = new FileReadCursorKeyStore(rootDir);
    const [firstKey, concurrentKey] = await Promise.all([
      first.loadOrCreate(),
      new FileReadCursorKeyStore(rootDir).loadOrCreate(),
    ]);
    const reloadedKey = await new FileReadCursorKeyStore(rootDir).loadOrCreate();

    expect(firstKey).toHaveLength(32);
    expect(concurrentKey).toEqual(firstKey);
    expect(reloadedKey).toEqual(firstKey);

    const firstCodec = new ReadCursorCodec({
      key: firstKey,
      rootHash: payload.rootHash,
      now: () => 10_000,
    });
    const reloadedCodec = new ReadCursorCodec({
      key: reloadedKey,
      rootHash: payload.rootHash,
      now: () => 10_000,
    });
    expect(reloadedCodec.decode(firstCodec.encode(payload))).toEqual(payload);
  });
});
