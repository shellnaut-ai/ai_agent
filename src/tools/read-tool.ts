import { readFile } from "node:fs/promises";

import type { AgentTool, JsonObject, ToolExecution } from "../core/contracts.js";
import { WorkspacePaths } from "./workspace-paths.js";

export interface ReadToolArguments {
  readonly path: string;
}

/**
 * workspace 안의 UTF-8 파일을 읽는 부작용 없는 기본 도구다.
 *
 * 경로 정책은 write/edit와 동일한 WorkspacePaths에 맡긴다. ReadTool은 인자 의미와
 * 파일 읽기만 알아야 세 도구가 symlink 경계를 서로 다르게 구현하지 않는다.
 */
export class ReadTool implements AgentTool<ReadToolArguments> {
  readonly name = "read";
  readonly description = "Reads a UTF-8 text file inside the configured root directory.";
  readonly inputSchema: JsonObject = {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  };

  readonly #paths: WorkspacePaths;

  constructor(rootDir: string) {
    this.#paths = new WorkspacePaths(rootDir);
  }

  parse(argumentsValue: unknown): ReadToolArguments {
    // additionalProperties:false 계약까지 직접 확인해 모델의 예상 밖 필드를 조용히 무시하지 않는다.
    if (
      typeof argumentsValue !== "object" ||
      argumentsValue === null ||
      Array.isArray(argumentsValue) ||
      Object.keys(argumentsValue).length !== 1 ||
      !("path" in argumentsValue) ||
      typeof argumentsValue.path !== "string"
    ) {
      throw new Error("Expected exactly one string property: path");
    }
    return { path: argumentsValue.path };
  }

  async execute(argumentsValue: ReadToolArguments): Promise<ToolExecution> {
    const filePath = await this.#paths.existingFile(argumentsValue.path);
    return { content: await readFile(filePath, "utf8") };
  }
}
