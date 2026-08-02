import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  AgentEvent,
  Message,
  SessionRecord,
  SessionStore,
} from "../core/contracts.js";
import { ScriptedProvider } from "../providers/scripted-provider.js";
import { JsonlSessionStore } from "../session/jsonl-session-store.js";
import { ReadTool } from "../tools/read-tool.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { Agent } from "./agent.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function createWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-clone-agent-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function collectRecords(store: JsonlSessionStore): Promise<SessionRecord[]> {
  const records: SessionRecord[] = [];
  for await (const record of store.replay()) {
    records.push(record);
  }
  return records;
}

function queuedFactory(values: readonly string[]): () => string {
  const queue = [...values];
  return () => {
    const value = queue.shift();
    if (value === undefined) {
      throw new Error("Deterministic id queue is exhausted");
    }
    return value;
  };
}

class RejectOneUserAppendStore implements SessionStore {
  readonly records: SessionRecord[] = [];
  #hasRejected = false;

  async append(record: SessionRecord): Promise<void> {
    if (
      !this.#hasRejected
      && record.type === "message_appended"
      && record.message.role === "user"
    ) {
      this.#hasRejected = true;
      throw new Error("simulated disk failure");
    }
    this.records.push(record);
  }

  async *replay(): AsyncIterable<SessionRecord> {
    yield* this.records;
  }
}

describe("Agent", () => {
  it("runs a sequential multi-tool batch, appends results, then calls the provider once", async () => {
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "a.txt"), "A", "utf8");
    await writeFile(join(workspace, "b.txt"), "B", "utf8");
    const session = new JsonlSessionStore(join(workspace, "session.jsonl"));
    const provider = new ScriptedProvider([
      [
        {
          type: "tool_call_delta",
          index: 1,
          id: "call-b",
          name: "read",
          argumentsDelta: "{\"path\":\"b.txt\"}",
        },
        {
          type: "tool_call_delta",
          index: 0,
          id: "call-a",
          name: "read",
          argumentsDelta: "{\"path\":\"a.txt\"}",
        },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text_delta", delta: "두 파일은 A와 B입니다." },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const tools = new ToolRegistry([new ReadTool(workspace)], {
      createResultId: queuedFactory(["result-a", "result-b"]),
      now: () => "2026-07-26T00:00:00.000Z",
    });
    const agent = new Agent({
      sessionId: "session-1",
      model: "scripted-model",
      provider,
      tools,
      session,
      createMessageId: queuedFactory(["user-1", "assistant-1", "assistant-2"]),
      now: () => "2026-07-26T00:00:00.000Z",
    });
    const events: AgentEvent[] = [];
    agent.subscribe((event) => events.push(event));

    const messages = await agent.prompt("a.txt와 b.txt를 읽어줘");

    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "assistant",
    ]);
    expect(messages[1]).toMatchObject({
      role: "assistant",
      toolCalls: [
        { id: "call-a", name: "read", argumentsJson: "{\"path\":\"a.txt\"}" },
        { id: "call-b", name: "read", argumentsJson: "{\"path\":\"b.txt\"}" },
      ],
    });
    expect(messages[2]).toMatchObject({
      role: "tool",
      toolCallId: "call-a",
      ok: true,
      content: "A",
    });
    expect(messages[3]).toMatchObject({
      role: "tool",
      toolCallId: "call-b",
      ok: true,
      content: "B",
    });
    expect(messages[4]).toMatchObject({
      role: "assistant",
      content: "두 파일은 A와 B입니다.",
      toolCalls: [],
    });

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
    ]);
    expect(provider.requests[1]?.messages[2]).toMatchObject({
      toolCallId: "call-a",
      content: "A",
    });
    expect(provider.requests[1]?.messages[3]).toMatchObject({
      toolCallId: "call-b",
      content: "B",
    });

    expect(
      events
        .filter((event) => event.type === "turn_start")
        .map((event) => event.turn),
    ).toEqual([1, 2]);
    expect(
      events
        .filter((event) => event.type === "tool_execution_start")
        .map((event) => event.toolCall.id),
    ).toEqual(["call-a", "call-b"]);
    expect(
      events
        .filter((event) => event.type === "tool_execution_end")
        .map((event) => event.result.toolCallId),
    ).toEqual(["call-a", "call-b"]);
    expect(
      events
        .filter((event) => event.type === "text_delta")
        .map((event) => event.delta),
    ).toEqual(["두 파일은 A와 B입니다."]);
    // 결과만 맞는지 보는 것으로는 UI가 의존하는 lifecycle 회귀를 잡을 수 없다.
    // 첫 turn의 조립/도구 실행과 두 번째 turn의 최종 답이 정확한 순서인지 전체를 고정한다.
    expect(events.map((event) => event.type)).toEqual([
      "agent_start",
      "turn_start",
      "message_start",
      "tool_call_delta",
      "tool_call_delta",
      "message_end",
      "tool_execution_start",
      "tool_execution_end",
      "tool_execution_start",
      "tool_execution_end",
      "turn_end",
      "turn_start",
      "message_start",
      "text_delta",
      "message_end",
      "turn_end",
      "agent_end",
    ]);
    expect(events.at(-1)?.type).toBe("agent_end");

    const records = await collectRecords(session);
    expect(records.map((record) => record.type)).toEqual([
      "session_started",
      "message_appended",
      "message_appended",
      "message_appended",
      "message_appended",
      "message_appended",
      "run_finished",
    ]);
    expect(
      records
        .filter((record) => record.type === "message_appended")
        .map((record) => record.message),
    ).toEqual(messages);
  });

  it("reinjects a validation failure as a tool result instead of ending the run", async () => {
    const workspace = await createWorkspace();
    const session = new JsonlSessionStore(join(workspace, "session.jsonl"));
    const provider = new ScriptedProvider([
      [
        {
          type: "tool_call_delta",
          index: 0,
          id: "call-missing",
          name: "missing",
          argumentsDelta: "{}",
        },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text_delta", delta: "사용할 수 없는 도구였습니다." },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const tools = new ToolRegistry([new ReadTool(workspace)], {
      createResultId: () => "result-error",
      now: () => "2026-07-26T00:00:00.000Z",
    });
    const agent = new Agent({
      sessionId: "session-2",
      model: "scripted-model",
      provider,
      tools,
      session,
      createMessageId: queuedFactory(["user-2", "assistant-3", "assistant-4"]),
      now: () => "2026-07-26T00:00:00.000Z",
    });

    const messages = await agent.prompt("없는 도구를 호출해봐");

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.messages[2]).toMatchObject({
      role: "tool",
      toolCallId: "call-missing",
      ok: false,
      error: {
        code: "unknown_tool",
        message: "Unknown tool: missing",
      },
    });
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "사용할 수 없는 도구였습니다.",
    });
  });

  it("publishes an agent_error event when the provider cannot continue", async () => {
    const workspace = await createWorkspace();
    const session = new JsonlSessionStore(join(workspace, "session.jsonl"));
    const provider = new ScriptedProvider([]);
    const agent = new Agent({
      sessionId: "session-3",
      model: "scripted-model",
      provider,
      tools: new ToolRegistry([]),
      session,
      createMessageId: queuedFactory(["user-3", "assistant-5"]),
      now: () => "2026-07-26T00:00:00.000Z",
    });
    const events: AgentEvent[] = [];
    agent.subscribe((event) => events.push(event));

    await expect(agent.prompt("응답해줘")).rejects.toThrow(
      "ScriptedProvider has no script for call 0",
    );
    expect(events.at(-1)).toMatchObject({
      type: "agent_error",
      error: {
        message: "ScriptedProvider has no script for call 0",
      },
    });
  });

  it("rejects a second tool batch instead of starting a third provider turn", async () => {
    const workspace = await createWorkspace();
    const provider = new ScriptedProvider([
      [
        {
          type: "tool_call_delta",
          index: 0,
          id: "call-1",
          name: "missing",
          argumentsDelta: "{}",
        },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        {
          type: "tool_call_delta",
          index: 0,
          id: "call-2",
          name: "missing",
          argumentsDelta: "{}",
        },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text_delta", delta: "세 번째 turn" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const agent = new Agent({
      sessionId: "session-4",
      model: "scripted-model",
      provider,
      tools: new ToolRegistry([], {
        createResultId: queuedFactory(["result-1", "result-2"]),
      }),
      session: new JsonlSessionStore(join(workspace, "session.jsonl")),
      createMessageId: queuedFactory([
        "user-4",
        "assistant-6",
        "assistant-7",
        "assistant-8",
      ]),
      now: () => "2026-07-26T00:00:00.000Z",
    });

    await expect(agent.prompt("도구를 계속 호출해")).rejects.toThrow(
      "The follow-up assistant response must be final text without tool calls",
    );
    expect(provider.requests).toHaveLength(2);
  });

  it("does not expose an unpersisted message to a later provider request", async () => {
    const session = new RejectOneUserAppendStore();
    const provider = new ScriptedProvider([[
      { type: "text_delta", delta: "기록된 요청만 보입니다." },
      { type: "finish", reason: "stop" },
    ]]);
    const agent = new Agent({
      sessionId: "session-5",
      model: "scripted-model",
      provider,
      tools: new ToolRegistry([]),
      session,
      createMessageId: queuedFactory(["lost-user", "kept-user", "assistant-9"]),
      now: () => "2026-07-26T00:00:00.000Z",
    });

    await expect(agent.prompt("저장 실패 메시지")).rejects.toThrow(
      "simulated disk failure",
    );
    const messages = await agent.prompt("저장 성공 메시지");

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.messages.map((message: Message) => message.content)).toEqual([
      "저장 성공 메시지",
    ]);
    expect(messages.map((message) => message.id)).toEqual(["kept-user", "assistant-9"]);
    expect(
      session.records
        .filter((record) => record.type === "message_appended")
        .map((record) => record.message.id),
    ).toEqual(["kept-user", "assistant-9"]);
  });

  it("finishes a direct text response in one provider turn without tool execution", async () => {
    // 도구 경로만 테스트하면 가장 단순한 text-only 종료 분기가 깨져도 놓칠 수 있다.
    const workspace = await createWorkspace();
    const provider = new ScriptedProvider([[
      { type: "text_delta", delta: "바로 답합니다." },
      { type: "finish", reason: "stop" },
    ]]);
    const events: AgentEvent[] = [];
    const agent = new Agent({
      sessionId: "session-6",
      model: "scripted-model",
      provider,
      tools: new ToolRegistry([]),
      session: new JsonlSessionStore(join(workspace, "session.jsonl")),
      createMessageId: queuedFactory(["user-6", "assistant-10"]),
      now: () => "2026-07-26T00:00:00.000Z",
    });
    agent.subscribe((event) => events.push(event));

    const messages = await agent.prompt("도구 없이 답해");

    expect(provider.requests).toHaveLength(1);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "바로 답합니다.",
      toolCalls: [],
    });
    expect(events.map((event) => event.type)).toEqual([
      "agent_start",
      "turn_start",
      "message_start",
      "text_delta",
      "message_end",
      "turn_end",
      "agent_end",
    ]);
  });
});
