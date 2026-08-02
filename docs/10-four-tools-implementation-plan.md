# Four Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 현재 `read` 하나인 Agent runtime을 승인 없는 `read / write / edit / bash` 네 도구로 확장한다.

**Architecture:** `WorkspacePaths`가 세 파일 도구의 lexical path와 realpath 경계를 한 곳에서 소유한다. 각 Tool은 `inputSchema`, `parse(unknown)`, `execute(typedArgs)`만 담당하며 기존 `ToolRegistry`가 JSON parse, 오류 정규화, source-order 순차 실행을 유지한다. `BashTool`은 workspace를 cwd로 사용하고 timeout과 출력 상한을 자체 적용한다.

**Tech Stack:** TypeScript 7, Node.js 22 `node:fs/promises`·`node:child_process`, Vitest 4, JSONL SessionStore.

## Global Constraints

- 도구 실행 전 사용자 승인, command allowlist, 별도 sandbox를 추가하지 않는다.
- 모든 파일 경로는 workspace lexical 경계와 `realpath` 경계를 모두 통과해야 한다.
- `write`는 UTF-8 파일을 생성하거나 기존 일반 파일 전체를 덮어쓴다.
- `edit`는 비어 있지 않은 `oldText`가 정확히 한 번 있을 때만 교체한다.
- `bash` 기본 timeout은 30,000ms, 최대 timeout은 120,000ms다.
- `bash` stdout과 stderr 합계 상한은 1,048,576 bytes다.
- 한 assistant의 여러 호출은 source order대로 순차 실행하고 실패 뒤에도 다음 호출을 계속한다.
- 기존 Provider 후속 호출 상한은 tool batch 뒤 정확히 한 번으로 유지한다.
- 모든 제품 동작은 실패 테스트를 먼저 확인한 뒤 최소 구현한다.
- 각 작업은 관련 테스트와 typecheck가 통과한 상태에서 별도 학습 커밋으로 끝낸다.

## 파일 책임 지도

- `src/tools/workspace-paths.ts`: workspace 경로의 lexical/realpath 검증과 새 파일 부모 준비.
- `src/tools/read-tool.ts`: 검증된 기존 UTF-8 파일 읽기.
- `src/tools/write-tool.ts`: `{ path, content }` parse와 전체 파일 쓰기.
- `src/tools/edit-tool.ts`: `{ path, oldText, newText }` parse와 단일 정확 교체.
- `src/tools/bash-tool.ts`: `{ command, timeoutMs? }` parse와 제한된 shell 실행.
- `src/cli/runtime.ts`: 네 도구 인스턴스를 `ToolRegistry`에 등록.
- `src/index.ts`: 새 도구와 인자 타입을 공개 API로 export.
- 각 `*.test.ts`: 실제 임시 workspace 또는 실제 Node 자식 process로 경계를 검증.

```mermaid
flowchart LR
    Plan["승인된 설계"] --> Paths["Task 1<br/>WorkspacePaths"]
    Paths --> Write["Task 2<br/>WriteTool"]
    Write --> Edit["Task 3<br/>EditTool"]
    Edit --> Bash["Task 4<br/>BashTool"]
    Bash --> Runtime["Task 5<br/>Runtime 통합"]
    Runtime --> Verify["Task 6<br/>문서 · 전체 검증 · PR"]

    classDef done fill:#DBEAFE,stroke:#2563EB,color:#0F172A,stroke-width:2px;
    classDef tool fill:#DCFCE7,stroke:#16A34A,color:#052E16,stroke-width:2px;
    classDef finish fill:#FEF3C7,stroke:#D97706,color:#451A03,stroke-width:2px;
    class Plan,Paths done;
    class Write,Edit,Bash,Runtime tool;
    class Verify finish;
```

> **그림 읽기:** 각 화살표는 다음 Task가 앞 Task의 공개 계약과 GREEN 테스트를
> 전제로 한다는 뜻이다. 경로 경계를 먼저 고정해 write와 edit가 보안 로직을 복제하지
> 않으며, 네 Tool이 독립적으로 검증된 뒤에만 Runtime에 함께 등록한다.

---

### Task 1: 공통 Workspace 경로 경계

**Files:**
- Create: `src/tools/workspace-paths.ts`
- Create: `src/tools/workspace-paths.test.ts`
- Modify: `src/tools/read-tool.ts`
- Test: `src/tools/read-tool.test.ts`

**Interfaces:**
- Produces: `new WorkspacePaths(rootDir: string)`
- Produces: `existingFile(requestedPath: string): Promise<string>`
- Produces: `writableFile(requestedPath: string): Promise<string>`
- Consumes: Node `resolve`, `relative`, `dirname`, `realpath`, `lstat`, `stat`, `mkdir`.

- [x] **Step 1: 새 파일 부모의 외부 symlink 탈출 실패 테스트 작성**

```ts
it("rejects a new file whose existing parent symlink leaves the workspace", async () => {
  const paths = new WorkspacePaths(rootDir);
  await symlink(outsideDir, join(rootDir, "escape"), "junction");
  await expect(paths.writableFile("escape/new.txt")).rejects.toThrow(
    "Path must stay within the configured root directory",
  );
});
```

- [x] **Step 2: RED 확인**

Run: `npm test -- src/tools/workspace-paths.test.ts`

Expected: `Cannot find module './workspace-paths.js'`로 실패.

- [x] **Step 3: 최소 `WorkspacePaths` 구현**

```ts
export class WorkspacePaths {
  readonly #rootPath: string;

  constructor(rootDir: string) {
    this.#rootPath = resolve(rootDir);
  }

  async existingFile(requestedPath: string): Promise<string> {
    const target = this.#lexicalTarget(requestedPath);
    const [realRoot, realTarget] = await Promise.all([
      realpath(this.#rootPath),
      realpath(target),
    ]);
    this.#assertInside(realRoot, realTarget);
    if (!(await stat(realTarget)).isFile()) throw new Error("Path must point to a file");
    return realTarget;
  }

  async writableFile(requestedPath: string): Promise<string> {
    const target = this.#lexicalTarget(requestedPath);
    const realRoot = await realpath(this.#rootPath);
    try {
      await lstat(target);
      const realTarget = await realpath(target);
      this.#assertInside(realRoot, realTarget);
      if (!(await stat(realTarget)).isFile()) throw new Error("Path must point to a file");
      return realTarget;
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
    const parent = dirname(target);
    const ancestor = await nearestExistingAncestor(parent);
    this.#assertInside(realRoot, await realpath(ancestor));
    await mkdir(parent, { recursive: true });
    this.#assertInside(realRoot, await realpath(parent));
    return target;
  }
}
```

`#lexicalTarget()`은 빈 path와 root 자체를 거부하고 `relative(root, target)`이 `..`로 시작하거나 절대이면 실패시킨다. `nearestExistingAncestor()`는 `lstat()`가 성공할 때까지 `dirname()`으로 위로 이동한다.

```ts
#lexicalTarget(requestedPath: string): string {
  if (requestedPath === "") throw new Error("Path must not be empty");
  const target = resolve(this.#rootPath, requestedPath);
  const fromRoot = relative(this.#rootPath, target);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error("Path must stay within the configured root directory");
  }
  return target;
}

#assertInside(realRoot: string, realTarget: string): void {
  const fromRoot = relative(realRoot, realTarget);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error("Path must stay within the configured root directory");
  }
}

async function nearestExistingAncestor(startPath: string): Promise<string> {
  let candidate = startPath;
  while (true) {
    try {
      await lstat(candidate);
      return candidate;
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
```

- [x] **Step 4: 기존 ReadTool을 공통 경계로 이동**

```ts
export class ReadTool implements AgentTool<ReadToolArguments> {
  readonly #paths: WorkspacePaths;

  constructor(rootDir: string) {
    this.#paths = new WorkspacePaths(rootDir);
  }

  async execute(argumentsValue: ReadToolArguments): Promise<ToolExecution> {
    return { content: await readFile(await this.#paths.existingFile(argumentsValue.path), "utf8") };
  }
}
```

- [x] **Step 5: GREEN과 회귀 확인**

Run: `npm test -- src/tools/workspace-paths.test.ts src/tools/read-tool.test.ts`

Expected: 새 경로 테스트와 기존 ReadTool 테스트 전부 통과.

Run: `npm run typecheck`

Expected: exit 0.

- [x] **Step 6: 커밋**

```powershell
git add src/tools/workspace-paths.ts src/tools/workspace-paths.test.ts src/tools/read-tool.ts src/tools/read-tool.test.ts
git commit -m "refactor(tools): workspace 경로 경계 공유"
```

---

### Task 2: WriteTool

**Files:**
- Create: `src/tools/write-tool.ts`
- Create: `src/tools/write-tool.test.ts`

**Interfaces:**
- Consumes: `WorkspacePaths.writableFile(path)`
- Produces: `WriteTool implements AgentTool<WriteToolArguments>`
- Produces: `WriteToolArguments = { readonly path: string; readonly content: string }`

- [x] **Step 1: schema·parse·생성·덮어쓰기·symlink RED 테스트 작성**

```ts
it("creates parents and overwrites a UTF-8 file", async () => {
  const tool = new WriteTool(rootDir);
  await expect(tool.execute({ path: "notes/a.md", content: "처음" })).resolves.toEqual({
    content: "Wrote 6 bytes to notes/a.md",
  });
  await tool.execute({ path: "notes/a.md", content: "다음" });
  await expect(readFile(join(rootDir, "notes/a.md"), "utf8")).resolves.toBe("다음");
});

it("rejects extra or incorrectly typed arguments", () => {
  expect(() => new WriteTool(rootDir).parse({ path: "a", content: "b", extra: true }))
    .toThrow("Expected exactly two string properties: path and content");
});
```

- [x] **Step 2: RED 확인**

Run: `npm test -- src/tools/write-tool.test.ts`

Expected: `Cannot find module './write-tool.js'`로 실패.

- [x] **Step 3: 최소 WriteTool 구현**

```ts
export class WriteTool implements AgentTool<WriteToolArguments> {
  readonly name = "write";
  readonly description = "Writes a complete UTF-8 file inside the workspace.";
  readonly inputSchema: JsonObject = {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
    additionalProperties: false,
  };
  readonly #paths: WorkspacePaths;

  parse(value: unknown): WriteToolArguments {
    if (
      typeof value !== "object"
      || value === null
      || Array.isArray(value)
      || Object.keys(value).length !== 2
      || !("path" in value)
      || !("content" in value)
      || typeof value.path !== "string"
      || typeof value.content !== "string"
    ) {
      throw new Error("Expected exactly two string properties: path and content");
    }
    return { path: value.path, content: value.content };
  }

  async execute(value: WriteToolArguments): Promise<ToolExecution> {
    const target = await this.#paths.writableFile(value.path);
    await writeFile(target, value.content, "utf8");
    return { content: `Wrote ${Buffer.byteLength(value.content, "utf8")} bytes to ${value.path}` };
  }
}
```

- [x] **Step 4: GREEN 확인**

Run: `npm test -- src/tools/write-tool.test.ts src/tools/workspace-paths.test.ts`

Run: `npm run typecheck`

Expected: 모두 exit 0.

- [x] **Step 5: 커밋**

```powershell
git add src/tools/write-tool.ts src/tools/write-tool.test.ts
git commit -m "feat(tools): 검증된 write 도구 추가"
```

---

### Task 3: EditTool

**Files:**
- Create: `src/tools/edit-tool.ts`
- Create: `src/tools/edit-tool.test.ts`

**Interfaces:**
- Consumes: `WorkspacePaths.existingFile(path)`
- Produces: `EditTool implements AgentTool<EditToolArguments>`
- Produces: `EditToolArguments = { path: string; oldText: string; newText: string }`

- [x] **Step 1: 정확히 한 곳 교체와 모호성 RED 테스트 작성**

```ts
it("replaces exactly one match", async () => {
  await writeFile(join(rootDir, "a.txt"), "before middle after", "utf8");
  await new EditTool(rootDir).execute({ path: "a.txt", oldText: "middle", newText: "changed" });
  await expect(readFile(join(rootDir, "a.txt"), "utf8")).resolves.toBe("before changed after");
});

it.each([
  ["missing", "Edit target was not found"],
  ["same same", "Edit target appears more than once"],
])("rejects zero or multiple matches", async (contents, message) => {
  await writeFile(join(rootDir, "a.txt"), contents, "utf8");
  await expect(new EditTool(rootDir).execute({ path: "a.txt", oldText: "same", newText: "new" }))
    .rejects.toThrow(message);
});
```

- [x] **Step 2: RED 확인**

Run: `npm test -- src/tools/edit-tool.test.ts`

Expected: `Cannot find module './edit-tool.js'`로 실패.

- [x] **Step 3: 최소 EditTool 구현**

```ts
const first = contents.indexOf(value.oldText);
if (first === -1) throw new Error("Edit target was not found");
if (contents.indexOf(value.oldText, first + value.oldText.length) !== -1) {
  throw new Error("Edit target appears more than once");
}
const edited = contents.slice(0, first) + value.newText + contents.slice(first + value.oldText.length);
await writeFile(target, edited, "utf8");
return { content: `Edited ${value.path}` };
```

`parse()`는 정확히 `path`, `oldText`, `newText` 세 string만 허용하고 빈 `oldText`를 별도 오류로 거부한다.

```ts
parse(value: unknown): EditToolArguments {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.keys(value).length !== 3
    || !("path" in value)
    || !("oldText" in value)
    || !("newText" in value)
    || typeof value.path !== "string"
    || typeof value.oldText !== "string"
    || typeof value.newText !== "string"
  ) {
    throw new Error("Expected exactly three string properties: path, oldText, and newText");
  }
  if (value.oldText === "") throw new Error("oldText must not be empty");
  return { path: value.path, oldText: value.oldText, newText: value.newText };
}
```

- [x] **Step 4: GREEN 확인**

Run: `npm test -- src/tools/edit-tool.test.ts src/tools/workspace-paths.test.ts`

Run: `npm run typecheck`

Expected: 모두 exit 0.

- [x] **Step 5: 커밋**

```powershell
git add src/tools/edit-tool.ts src/tools/edit-tool.test.ts
git commit -m "feat(tools): 단일 정확 교체 edit 도구 추가"
```

---

### Task 4: BashTool

**Files:**
- Create: `src/tools/bash-tool.ts`
- Create: `src/tools/bash-tool.test.ts`

**Interfaces:**
- Produces: `BashTool implements AgentTool<BashToolArguments>`
- Produces: `BashToolArguments = { command: string; timeoutMs?: number }`
- Uses: `spawn(command, { cwd, shell: true, windowsHide: true })`

- [x] **Step 1: stdout·stderr·exit·timeout·cwd·출력 상한 RED 테스트 작성**

```ts
const nodeCommand = (script: string) => `"${process.execPath}" -e ${JSON.stringify(script)}`;

it("runs in the workspace and returns stdout", async () => {
  const result = await new BashTool(rootDir).execute({
    command: nodeCommand("process.stdout.write(process.cwd())"),
  });
  expect(result.content).toContain(rootDir);
  expect(result.content).toContain("Exit code: 0");
});

it("rejects non-zero exit with captured stderr", async () => {
  await expect(new BashTool(rootDir).execute({
    command: nodeCommand("process.stderr.write('bad'); process.exit(3)"),
  })).rejects.toThrow(/Exit code: 3[\s\S]*bad/);
});

it("stops at the requested timeout", async () => {
  await expect(new BashTool(rootDir).execute({
    command: nodeCommand("setTimeout(() => {}, 1000)"),
    timeoutMs: 30,
  })).rejects.toThrow("timed out after 30ms");
});
```

- [x] **Step 2: RED 확인**

Run: `npm test -- src/tools/bash-tool.test.ts`

Expected: `Cannot find module './bash-tool.js'`로 실패.

- [x] **Step 3: BashTool parse와 실행 구현**

```ts
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1_048_576;

parse(value: unknown): BashToolArguments {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || !("command" in value)
    || typeof value.command !== "string"
    || value.command.trim() === ""
    || Object.keys(value).some((key) => key !== "command" && key !== "timeoutMs")
    || ("timeoutMs" in value && (
      typeof value.timeoutMs !== "number"
      || !Number.isInteger(value.timeoutMs)
      || value.timeoutMs < 1
      || value.timeoutMs > MAX_TIMEOUT_MS
    ))
  ) {
    throw new Error("Expected command and optional timeoutMs between 1 and 120000");
  }
  return "timeoutMs" in value
    ? { command: value.command, timeoutMs: value.timeoutMs as number }
    : { command: value.command };
}

async execute(value: BashToolArguments): Promise<ToolExecution> {
  const timeoutMs = value.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const result = await runShellCommand(value.command, this.#workspace, timeoutMs);
  const content = formatCommandResult(result.exitCode, result.stdout, result.stderr);
  if (result.timedOut) throw new Error(`Command timed out after ${timeoutMs}ms\n${content}`);
  if (result.outputExceeded) throw new Error(`Command output exceeded ${MAX_OUTPUT_BYTES} bytes\n${content}`);
  if (result.exitCode !== 0) throw new Error(content);
  return { content };
}
```

`parse()`는 `command`가 비어 있지 않은 string인지, `timeoutMs`가 존재한다면 1 이상 120,000 이하 integer인지, 추가 필드가 없는지 검사한다. `runShellCommand()`는 stdout/stderr chunk를 Buffer로 받을 때마다 남은 byte까지만 저장하고 합계가 상한을 넘는 즉시 `child.kill()`을 호출한다. timeout timer도 같은 process를 종료하고 `close` event에서 아래 결과를 확정한다.

```ts
interface ShellCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly outputExceeded: boolean;
}

function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<ShellCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let timedOut = false;
    let outputExceeded = false;

    const capture = (target: Buffer[], chunk: Buffer): void => {
      const remaining = Math.max(0, MAX_OUTPUT_BYTES - capturedBytes);
      if (remaining > 0) target.push(chunk.subarray(0, remaining));
      capturedBytes += chunk.length;
      if (capturedBytes > MAX_OUTPUT_BYTES && !outputExceeded) {
        outputExceeded = true;
        child.kill();
      }
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.once("error", reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        outputExceeded,
      });
    });
  });
}

function formatCommandResult(exitCode: number | null, stdout: string, stderr: string): string {
  return [
    `Exit code: ${exitCode === null ? "unknown" : String(exitCode)}`,
    "stdout:",
    stdout,
    "stderr:",
    stderr,
  ].join("\n");
}
```

- [x] **Step 4: GREEN 확인**

Run: `npm test -- src/tools/bash-tool.test.ts`

Run: `npm run typecheck`

Expected: stdout, stderr, non-zero, timeout, cwd, output-limit 테스트 전부 통과.

- [x] **Step 5: 커밋**

```powershell
git add src/tools/bash-tool.ts src/tools/bash-tool.test.ts
git commit -m "feat(tools): 제한된 bash 실행 도구 추가"
```

---

### Task 5: Runtime 네 도구 통합

**Files:**
- Modify: `src/cli/runtime.ts`
- Modify: `src/cli/runtime.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `ReadTool`, `WriteTool`, `EditTool`, `BashTool`
- Produces: Provider request의 tool definition 순서 `read`, `write`, `edit`, `bash`
- Preserves: tool batch 뒤 Provider follow-up 정확히 한 번.

- [x] **Step 1: 첫 Provider 요청에 네 definition이 있는 RED 테스트 작성**

```ts
const firstBody = await requests[0]?.json() as { tools?: Array<{ name?: string }> };
expect(firstBody.tools?.map((tool) => tool.name)).toEqual(["read", "write", "edit", "bash"]);
```

- [x] **Step 2: RED 확인**

Run: `npm test -- src/cli/runtime.test.ts`

Expected: 실제 값 `["read"]` 때문에 실패.

- [x] **Step 3: Runtime과 공개 export에 네 도구 연결**

```ts
const tools = new ToolRegistry([
  new ReadTool(options.workspace),
  new WriteTool(options.workspace),
  new EditTool(options.workspace),
  new BashTool(options.workspace),
], {
  ...(options.createToolResultId === undefined
    ? {}
    : { createResultId: options.createToolResultId }),
  ...(options.now === undefined ? {} : { now: options.now }),
});
```

`src/index.ts`에서 `WriteToolArguments`, `EditToolArguments`, `BashToolArguments`와 각 Tool class를 export한다.

- [x] **Step 4: 실제 write→edit→read batch 통합 테스트 추가**

첫 SSE 응답이 source index 0, 1, 2로 `write`, `edit`, `read`를 호출하게 한다. 두 번째 Provider request의 `function_call_output` 세 개가 같은 순서이고, 실제 파일 내용이 edit 결과인지 검사한다. 전체 request 수는 2여야 한다.

```ts
const calls = [
  { id: "write-1", name: "write", args: { path: "result.txt", content: "before" } },
  { id: "edit-1", name: "edit", args: { path: "result.txt", oldText: "before", newText: "after" } },
  { id: "read-1", name: "read", args: { path: "result.txt" } },
];
const firstTurn = calls.flatMap((call, outputIndex) => [
  event({
    type: "response.output_item.added",
    output_index: outputIndex,
    item: { type: "function_call", call_id: call.id, name: call.name, arguments: "" },
  }),
  event({
    type: "response.function_call_arguments.delta",
    output_index: outputIndex,
    delta: JSON.stringify(call.args),
  }),
]);

expect(requests).toHaveLength(2);
await expect(readFile(join(workspace, "result.txt"), "utf8")).resolves.toBe("after");
const secondBody = await requests[1]?.json() as { input: Array<Record<string, unknown>> };
expect(secondBody.input.filter((item) => item.type === "function_call_output").map((item) => item.call_id))
  .toEqual(["write-1", "edit-1", "read-1"]);
```

- [x] **Step 5: GREEN 확인**

Run: `npm test -- src/cli/runtime.test.ts src/tools/tool-registry.test.ts`

Run: `npm run typecheck`

Expected: 네 definition, 실제 파일 batch, 후속 호출 1회가 모두 통과.

- [x] **Step 6: 커밋**

```powershell
git add src/cli/runtime.ts src/cli/runtime.test.ts src/index.ts
git commit -m "feat(runtime): 네 가지 기본 도구 등록"
```

---

### Task 6: 학습 문서와 최종 검증

**Files:**
- Modify: `docs/00-goals-and-scope.md`
- Modify: `docs/05-agent-loop.md`
- Modify: `docs/08-cli-usage.md`
- Modify: `docs/09-four-tools.md`
- Modify: `docs/README.md`

**Interfaces:**
- Documents: 구현된 네 도구, 승인 없음, path/shell 제한, 커밋 학습 순서.
- Preserves: 각 설명 문서당 관련 Mermaid 하나와 한국어 설명.

- [x] **Step 1: 의도적 미지원 목록에서 구현된 write/edit/bash 제거**

`00`, `05`, `08`, `README`에서 “write/edit/bash 미지원” 문장을 실제 상태로 바꾸고, 승인·sandbox·streaming shell output은 여전히 미지원임을 명시한다.

- [x] **Step 2: 구현 파일과 실제 오류 동작을 09 문서에 동기화**

`WorkspacePaths`, 네 Tool class, timeout 30초/최대 120초, 합계 1MiB, source-order batch, non-zero 실패 결과를 실제 명칭으로 연결한다.

- [x] **Step 3: 문서 검사**

Run: 모든 `docs/*.md`의 fence 수가 짝수인지, Mermaid fence가 문서당 정확히 하나인지, 한국어가 포함되는지, 상대 링크 대상이 존재하는지 검사하는 PowerShell 명령.

Expected: 모든 문서 통과.

- [x] **Step 4: 전체 검증**

Run: `npm run check`

Expected: typecheck, 전체 Vitest, build, CLI EOF smoke 모두 exit 0.

Run: `npm audit`

Expected: vulnerabilities 0.

Run: `npm pack --dry-run --json`

Expected: `dist/codex/*`, `dist/cli/cli-app.*` 같은 stale 이전 산출물 0.

Run: credential/secret 정규식 검사와 `git diff --check`.

Expected: secret 0, whitespace 오류 0.

- [x] **Step 5: 문서 커밋**

```powershell
git add docs/00-goals-and-scope.md docs/05-agent-loop.md docs/08-cli-usage.md docs/09-four-tools.md docs/README.md
git commit -m "docs(tools): 네 도구 구현 상태 동기화"
```

- [x] **Step 6: 원격과 Draft PR 갱신**

Run: `git push origin codex/pi-oauth-provider`

Expected: local HEAD와 `origin/codex/pi-oauth-provider`가 동일.

PR #2 본문의 지원 도구와 전체 테스트 수를 실제 최종 결과로 갱신하고 `gh pr view 2`에서 `OPEN`, `Draft`, merge state와 check 상태를 확인한다.
