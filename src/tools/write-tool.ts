import { writeFile } from "node:fs/promises";

import type { AgentTool, JsonObject, ToolExecution } from "../core/contracts.js";
import { WorkspacePaths } from "./workspace-paths.js";

export interface WriteToolArguments {
  readonly path: string;
  readonly content: string;
}

/**
 * workspace 안의 파일 하나를 새로 만들거나 전체 내용으로 덮어쓴다.
 *
 * 이 도구는 append 모드를 일부러 제공하지 않는다. `write`의 의미를 "호출에 담긴 content가
 * 실행 후 파일의 전체 내용"으로 고정하면 모델과 사용자가 결과를 예측하기 쉽다. 부분 변경은
 * oldText를 확인하는 EditTool이 맡으므로 두 쓰기 동작의 책임도 겹치지 않는다.
 */
export class WriteTool implements AgentTool<WriteToolArguments> {
  readonly name = "write";
  readonly description =
    "Create or replace a UTF-8 text file inside the configured workspace.";
  readonly inputSchema: JsonObject = {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  };

  readonly #paths: WorkspacePaths;

  constructor(rootDir: string) {
    this.#paths = new WorkspacePaths(rootDir);
  }

  parse(argumentsValue: unknown): WriteToolArguments {
    if (!isExactWriteArguments(argumentsValue)) {
      throw new Error("Expected exactly two string properties: path and content");
    }
    return { path: argumentsValue.path, content: argumentsValue.content };
  }

  async execute(argumentsValue: WriteToolArguments): Promise<ToolExecution> {
    // writableFile은 새 파일의 부모 생성까지 담당하지만 실제 bytes는 쓰지 않는다.
    // 경로 정책과 파일 내용 변경을 분리해 다른 도구도 같은 경계를 재사용하게 한다.
    const filePath = await this.#paths.writableFile(argumentsValue.path);
    await writeFile(filePath, argumentsValue.content, "utf8");
    return {
      content: `Wrote ${Buffer.byteLength(argumentsValue.content, "utf8")} bytes to ${argumentsValue.path}`,
    };
  }
}

function isExactWriteArguments(value: unknown): value is WriteToolArguments {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("path") || !keys.includes("content")) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.path === "string" && typeof candidate.content === "string";
}
