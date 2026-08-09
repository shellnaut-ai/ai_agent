import { describe, expect, test } from "vitest";

import type { ModelStreamRunner } from "../model/runtime.js";
import type { ModelRequest, StreamEvent } from "../model/types.js";
import { CompactionService } from "./compaction.js";

describe("CompactionService integration", () => {
  test("summarizes old turns while preserving the newest complete turn", async () => {
    const runner: ModelStreamRunner = {
      async *stream(_request: ModelRequest): AsyncIterable<StreamEvent> {
        yield { type: "start" };
        yield { type: "text-delta", delta: "stable summary" };
        yield { type: "done", reason: "stop" };
      },
    };
    const service = new CompactionService(runner, {
      reserveTokens: 100,
      keepRecentTokens: 180,
      charsPerToken: 1,
      maxSummaryOutputTokens: 100,
      toolResultMaxChars: 100,
    });
    const long = "x".repeat(420);
    const preparation = service.prepare({
      model: {
        id: "fake-model",
        name: "Fake",
        provider: "fake",
        contextWindow: 1_000,
        maxOutputTokens: 100,
      },
      turns: [
        {
          firstEntryId: "turn-1",
          messages: [
            { role: "user", content: long },
            { role: "assistant", content: long, toolCalls: [] },
          ],
        },
        {
          firstEntryId: "turn-2",
          messages: [
            { role: "user", content: long },
            { role: "assistant", content: long, toolCalls: [] },
          ],
        },
        {
          firstEntryId: "turn-3",
          messages: [
            { role: "user", content: "recent question" },
            { role: "assistant", content: "recent answer", toolCalls: [] },
          ],
        },
      ],
      pendingUserMessage: { role: "user", content: "continue" },
      toolDefinitions: [],
    });

    expect(preparation).toBeDefined();
    expect(preparation?.turnsToSummarize.map((turn) => turn.firstEntryId))
      .toEqual(["turn-1", "turn-2"]);
    expect(preparation?.firstKeptEntryId).toBe("turn-3");

    const result = await service.compact(preparation!);

    expect(result.summary).toContain("stable summary");
    expect(result.firstKeptEntryId).toBe("turn-3");
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
  });
});
