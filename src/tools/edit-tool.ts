import { readFile, writeFile } from "node:fs/promises";

import type { AgentTool, JsonObject, ToolExecution } from "../core/contracts.js";
import { WorkspacePaths } from "./workspace-paths.js";

export interface EditToolArguments {
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
}

/**
 * 기존 UTF-8 파일에서 정확히 한 번 등장하는 문자열만 교체한다.
 *
 * 줄 번호 기반 편집은 앞 단계 변경으로 쉽게 어긋나고, replace-all은 모델이 예상하지 못한
 * 위치까지 바꿀 수 있다. 그래서 oldText가 0개거나 2개 이상이면 쓰기 전에 실패시킨다.
 * 이 precondition이 "모델이 보았던 문맥과 현재 파일이 같은가"를 확인하는 작은 낙관적 잠금이다.
 */
export class EditTool implements AgentTool<EditToolArguments> {
  readonly name = "edit";
  readonly description =
    "Replace one exact oldText occurrence in an existing UTF-8 workspace file.";
  readonly inputSchema: JsonObject = {
    type: "object",
    properties: {
      path: { type: "string" },
      oldText: { type: "string" },
      newText: { type: "string" },
    },
    required: ["path", "oldText", "newText"],
    additionalProperties: false,
  };

  readonly #paths: WorkspacePaths;

  constructor(rootDir: string) {
    this.#paths = new WorkspacePaths(rootDir);
  }

  parse(argumentsValue: unknown): EditToolArguments {
    if (!isExactEditArguments(argumentsValue)) {
      throw new Error("Expected exactly three string properties: path, oldText, and newText");
    }
    if (argumentsValue.oldText === "") {
      // 빈 문자열은 모든 문자 경계에 일치하므로 "정확히 한 곳"이라는 계약을 만들 수 없다.
      throw new Error("oldText must not be empty");
    }
    return {
      path: argumentsValue.path,
      oldText: argumentsValue.oldText,
      newText: argumentsValue.newText,
    };
  }

  async execute(argumentsValue: EditToolArguments): Promise<ToolExecution> {
    const filePath = await this.#paths.existingFile(argumentsValue.path);
    const current = await readFile(filePath, "utf8");
    const occurrences = countNonOverlappingOccurrences(current, argumentsValue.oldText);
    if (occurrences !== 1) {
      throw new Error(`oldText must occur exactly once; found ${occurrences} occurrences`);
    }

    // 검사를 통과한 뒤에만 writeFile을 호출한다. 따라서 0/복수 일치 실패는 원본을 보존한다.
    const next = current.replace(argumentsValue.oldText, argumentsValue.newText);
    await writeFile(filePath, next, "utf8");
    return { content: `Edited ${argumentsValue.path}` };
  }
}

function isExactEditArguments(value: unknown): value is EditToolArguments {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const requiredKeys = ["path", "oldText", "newText"];
  if (keys.length !== requiredKeys.length || !requiredKeys.every((key) => keys.includes(key))) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return requiredKeys.every((key) => typeof candidate[key] === "string");
}

function countNonOverlappingOccurrences(content: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const match = content.indexOf(needle, offset);
    if (match === -1) return count;
    count += 1;
    offset = match + needle.length;
  }
}
