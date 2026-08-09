import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";

import type { Model } from "../model/types.js";
import { JsonlSessionStore } from "./jsonl-store.js";
import { Session } from "./session.js";

export type ForkPosition = "before" | "at";

export interface SessionForkResult {
  readonly session: Session;
  readonly store: JsonlSessionStore;
}

export class SessionRepository {
  private readonly rootDir: string;
  private readonly model: Model;

  constructor(rootDir: string, model: Model) {
    this.rootDir = rootDir;
    this.model = model;
  }

  async fork(
    source: Session,
    entryId: string,
    position: ForkPosition = "before",
  ): Promise<SessionForkResult> {
    const sourceStore = source.getStore();
    const target = sourceStore.getEntry(entryId);

    if (!target || target.type === "leaf") {
      throw new Error(`Session entry "${entryId}" was not found.`);
    }

    let targetLeafId: string | null;

    if (position === "at") {
      targetLeafId = target.id;
    } else {
      if (
        target.type !== "message" ||
        target.message.role !== "user"
      ) {
        throw new Error(
          "Forking before an entry requires a user message entry.",
        );
      }

      targetLeafId = target.parentId;
    }

    const entriesToCopy = sourceStore.getPathToRoot(targetLeafId);
    const store = new JsonlSessionStore({
      rootDir: this.rootDir,
      sessionId: randomUUID(),
      model: this.model,
      parentSessionPath: sourceStore.filePath,
    });

    await store.load();

    try {
      await store.appendEntries(entriesToCopy);
    } catch (error: unknown) {
      try {
        await unlink(store.filePath);
      } catch {
        // Preserve the original fork error if cleanup also fails.
      }

      throw error;
    }

    return {
      session: new Session(store),
      store,
    };
  }

  async clone(source: Session): Promise<SessionForkResult> {
    const leafId = source.getLeafId();

    if (!leafId) {
      throw new Error("There is nothing to clone in the session.");
    }

    return this.fork(source, leafId, "at");
  }
}
