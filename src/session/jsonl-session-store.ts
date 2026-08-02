import { appendFile, readFile } from "node:fs/promises";

import type { Message, SessionRecord, SessionStore } from "../core/contracts.js";

/**
 * 확정된 Agent 사실을 한 줄씩 추가하는 가장 작은 SessionStore 구현이다.
 *
 * JSONL은 각 record가 독립된 JSON이라 append와 순차 replay가 단순하다. 기존 기록을
 * 수정하지 않으므로 이후 compaction을 추가해도 원본 message history를 보존할 수 있다.
 */
export class JsonlSessionStore implements SessionStore {
  readonly #filePath: string;

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  async append(record: SessionRecord): Promise<void> {
    // 매 호출은 정확히 한 record와 줄바꿈만 추가한다. 기존 파일 전체를 다시 쓰지 않는다.
    await appendFile(this.#filePath, `${JSON.stringify(record)}\n`, "utf8");
  }

  async *replay(): AsyncIterable<SessionRecord> {
    let contents: string;
    try {
      contents = await readFile(this.#filePath, "utf8");
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        // 아직 한 번도 기록하지 않은 세션은 오류가 아니라 빈 history로 취급한다.
        return;
      }
      throw error;
    }

    for (const [index, line] of contents.split("\n").entries()) {
      // 빈 줄을 건너뛰어도 index는 유지해야 오류 메시지가 실제 파일 줄 번호를 가리킨다.
      if (line.trim() === "") {
        continue;
      }

      let parsed: unknown;
      try {
        // 파일 입력은 신뢰할 수 없으므로 parse 결과를 곧바로 SessionRecord로 cast하지 않는다.
        parsed = JSON.parse(line) as unknown;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Malformed JSON at line ${index + 1}: ${message}`, { cause: error });
      }
      // "유효한 JSON"과 "유효한 세션 record"는 다른 조건이다.
      if (!isSessionRecord(parsed)) {
        throw new Error(`Invalid session record at line ${index + 1}`);
      }
      yield parsed;
    }
  }
}

/**
 * replay가 약속한 SessionRecord 타입을 runtime에서도 보장하는 최상위 type guard다.
 * record의 discriminant를 확인한 뒤 각 변형의 필수 필드를 더 좁혀 간다.
 */
function isSessionRecord(value: unknown): value is SessionRecord {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "session_started") {
    return typeof value.sessionId === "string" && typeof value.createdAt === "string";
  }
  if (value.type === "run_finished") {
    return typeof value.createdAt === "string";
  }
  return value.type === "message_appended" && isMessage(value.message);
}

function isMessage(value: unknown): value is Message {
  // 모든 Message가 공유하는 필드를 먼저 확인한 뒤 role별 필드로 분기한다.
  if (
    !isRecord(value)
    || typeof value.id !== "string"
    || typeof value.content !== "string"
    || typeof value.createdAt !== "string"
  ) {
    return false;
  }
  if (value.role === "user") return true;
  if (value.role === "assistant") {
    return Array.isArray(value.toolCalls) && value.toolCalls.every(isToolCall);
  }
  if (value.role === "tool") {
    return (
      typeof value.toolCallId === "string"
      && typeof value.toolName === "string"
      && typeof value.ok === "boolean"
      && (value.error === undefined || isToolResultError(value.error))
    );
  }
  return false;
}

function isToolCall(value: unknown): boolean {
  return (
    isRecord(value)
    && typeof value.id === "string"
    && typeof value.name === "string"
    && typeof value.argumentsJson === "string"
  );
}

function isToolResultError(value: unknown): boolean {
  // 임의 문자열을 오류 코드로 허용하면 상위 계층의 분기 계약이 무너진다.
  return (
    isRecord(value)
    && (
      value.code === "execution_error"
      || value.code === "invalid_arguments"
      || value.code === "invalid_json"
      || value.code === "unknown_tool"
    )
    && typeof value.message === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
