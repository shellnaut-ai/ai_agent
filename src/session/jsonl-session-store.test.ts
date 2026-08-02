import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { SessionRecord } from "../core/contracts.js";
import { JsonlSessionStore } from "./jsonl-session-store.js";

const temporaryDirectories: string[] = [];

async function createSessionFilePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-clone-session-"));
  temporaryDirectories.push(directory);
  return join(directory, "session.jsonl");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

async function collectReplay(store: JsonlSessionStore): Promise<SessionRecord[]> {
  const records: SessionRecord[] = [];
  for await (const record of store.replay()) {
    records.push(record);
  }
  return records;
}

describe("JsonlSessionStore", () => {
  it("appends each record as exact JSONL without replacing earlier records", async () => {
    const filePath = await createSessionFilePath();
    const store = new JsonlSessionStore(filePath);
    const started: SessionRecord = {
      type: "session_started",
      sessionId: "session-1",
      createdAt: "2026-07-26T00:00:00.000Z",
    };
    const finished: SessionRecord = {
      type: "run_finished",
      createdAt: "2026-07-26T00:01:00.000Z",
    };

    await store.append(started);
    await store.append(finished);

    expect(await readFile(filePath, "utf8")).toBe(
      `${JSON.stringify(started)}\n${JSON.stringify(finished)}\n`,
    );
  });

  it("replays records in their persisted order", async () => {
    const filePath = await createSessionFilePath();
    const store = new JsonlSessionStore(filePath);
    const records: SessionRecord[] = [
      {
        type: "session_started",
        sessionId: "session-1",
        createdAt: "2026-07-26T00:00:00.000Z",
      },
      {
        type: "message_appended",
        message: {
          id: "user-1",
          role: "user",
          content: "hello",
          createdAt: "2026-07-26T00:00:01.000Z",
        },
      },
      { type: "run_finished", createdAt: "2026-07-26T00:00:02.000Z" },
    ];

    for (const record of records) {
      await store.append(record);
    }

    await expect(collectReplay(store)).resolves.toEqual(records);
  });

  it("returns no records when the session file is missing and ignores blank lines", async () => {
    const missingFilePath = await createSessionFilePath();
    const missingStore = new JsonlSessionStore(missingFilePath);
    expect(await collectReplay(missingStore)).toEqual([]);

    const filePath = await createSessionFilePath();
    const record: SessionRecord = {
      type: "run_finished",
      createdAt: "2026-07-26T00:01:00.000Z",
    };
    await writeFile(filePath, `\n  \n${JSON.stringify(record)}\n\n`, "utf8");

    await expect(collectReplay(new JsonlSessionStore(filePath))).resolves.toEqual([record]);
  });

  it("reports the physical line number when a JSONL record is malformed", async () => {
    const filePath = await createSessionFilePath();
    await writeFile(filePath, "\n{not-json}\n", "utf8");

    await expect(collectReplay(new JsonlSessionStore(filePath))).rejects.toThrow(/line 2/i);
  });

  it("rejects syntactically valid JSON whose structure is not a SessionRecord", async () => {
    const filePath = await createSessionFilePath();
    await writeFile(
      filePath,
      [
        JSON.stringify({
          type: "session_started",
          sessionId: "session-1",
          createdAt: "2026-07-26T00:00:00.000Z",
        }),
        JSON.stringify({
          type: "message_appended",
          message: {
            id: "bad-message",
            role: "unknown",
            content: "not a valid Message",
            createdAt: "2026-07-26T00:00:01.000Z",
          },
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    await expect(collectReplay(new JsonlSessionStore(filePath))).rejects.toThrow(
      "Invalid session record at line 2",
    );
  });
});
