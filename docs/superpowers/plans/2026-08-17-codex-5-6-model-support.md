# ChatGPT Codex GPT-5.6 Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the ChatGPT OAuth Codex provider work against the current backend, add the GPT-5.6 Sol/Terra/Luna catalog with Sol as the default, preserve the legacy `gpt-5.6` session alias, and stop retrying permanent HTTP failures.

**Architecture:** Keep output reservation in the common model/context contracts but omit the unsupported `max_output_tokens` field only from the ChatGPT Codex wire adapter. Put Codex model metadata and alias translation in a provider-local catalog, and represent HTTP failures with a generic retry classification consumed by `RetryingModelRuntime`.

**Tech Stack:** TypeScript 7, Node.js 22.12+, Vitest, ChatGPT Codex Responses SSE, append-only JSONL.

## Global Constraints

- Base every change on `shellnaut/main@9a765576dfd8e761ed3c2fdca8536da5dc87389e`.
- Keep llama.cpp `max_tokens` and OpenAI-compatible `max_tokens` behavior unchanged.
- Keep `Model.maxOutputTokens` and `ModelRequest.maxOutputTokens` for context reservation and continuation policy.
- Do not add a Codex App Server runtime dependency.
- Do not rewrite existing session JSONL or change session schema version 2.
- Treat `gpt-5.6` as a session-compatible alias that translates to `gpt-5.6-sol` only on the Codex wire.
- Never log OAuth tokens, response headers, complete external error bodies, or response text from live smoke tests.
- Use test-first RED/GREEN cycles for every production behavior change.

---

### Task 1: Codex model catalog and CLI defaults

**Files:**
- Create: `src/providers/openai-codex-models.ts`
- Create: `src/providers/openai-codex-models.test.ts`
- Modify: `src/cli/main.ts`
- Modify: `src/cli/main.test.ts`

**Interfaces:**
- Consumes: `Model` from `src/model/types.ts`.
- Produces: `CODEX_DEFAULT_MODEL_ID`, `CODEX_SUPPORTED_MODEL_IDS`, `createCodexModel(id: string): Model`, and `codexWireModelId(id: string): string`.

- [ ] **Step 1: Write failing catalog and CLI tests**

```ts
test("defines current ChatGPT Codex models and the legacy alias", () => {
  expect(CODEX_DEFAULT_MODEL_ID).toBe("gpt-5.6-sol");
  expect(CODEX_SUPPORTED_MODEL_IDS).toEqual([
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.6",
  ]);
  expect(createCodexModel("gpt-5.6-terra")).toMatchObject({
    id: "gpt-5.6-terra",
    provider: "openai-codex",
    contextWindow: 272_000,
    maxOutputTokens: 4_096,
  });
  expect(codexWireModelId("gpt-5.6")).toBe("gpt-5.6-sol");
});

test("rejects unknown Codex models before network", () => {
  expect(() => createCodexModel("gpt-9"))
    .toThrow(/gpt-5\.6-sol.*gpt-5\.6-terra.*gpt-5\.6-luna.*gpt-5\.5/s);
});

test("defaults openai-codex chat to GPT-5.6 Sol", () => {
  expect(parseChatOptions(["chat", "--provider", "openai-codex"]).model)
    .toBe("gpt-5.6-sol");
});
```

- [ ] **Step 2: Run targeted tests and verify RED**

Run:

```powershell
npx vitest run src/providers/openai-codex-models.test.ts src/cli/main.test.ts
```

Expected: FAIL because the catalog exports do not exist and the CLI still defaults to `gpt-5.5`.

- [ ] **Step 3: Implement the minimal provider-local catalog**

```ts
export const CODEX_DEFAULT_MODEL_ID = "gpt-5.6-sol";
export const CODEX_SUPPORTED_MODEL_IDS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.6",
] as const;

export function createCodexModel(id: string): Model {
  if (!CODEX_SUPPORTED_MODEL_IDS.some((candidate) => candidate === id)) {
    throw new Error(
      `Unsupported ChatGPT Codex model "${id}". Supported models: ` +
        CODEX_SUPPORTED_MODEL_IDS.join(", "),
    );
  }
  return {
    id,
    name: id,
    provider: "openai-codex",
    contextWindow: 272_000,
    maxOutputTokens: 4_096,
  };
}

export function codexWireModelId(id: string): string {
  return id === "gpt-5.6" ? "gpt-5.6-sol" : id;
}
```

Change `createModel()` so only the Codex path delegates to `createCodexModel()`; keep the other providers' 8,192/1,024 metadata unchanged.

- [ ] **Step 4: Run targeted tests and verify GREEN**

Run:

```powershell
npx vitest run src/providers/openai-codex-models.test.ts src/cli/main.test.ts
```

Expected: both files pass.

- [ ] **Step 5: Commit the catalog slice**

```powershell
git add src/providers/openai-codex-models.ts src/providers/openai-codex-models.test.ts src/cli/main.ts src/cli/main.test.ts
git commit -m "feat: add current Codex model catalog"
```

### Task 2: Correct the ChatGPT Codex wire and preserve the alias

**Files:**
- Modify: `src/providers/openai-codex-provider.ts`
- Modify: `src/providers/openai-codex-provider.test.ts`
- Modify: `src/providers/provider-contract.test.ts`

**Interfaces:**
- Consumes: `codexWireModelId(id: string): string` from Task 1.
- Produces: ChatGPT Codex request bodies without `max_output_tokens`, with only the legacy alias translated.

- [ ] **Step 1: Change request assertions to the current backend contract**

```ts
const body = await captured?.json() as Record<string, unknown>;
expect(body).toMatchObject({
  model: "gpt-5.1-codex-mini",
  stream: true,
  store: false,
});
expect(body).not.toHaveProperty("max_output_tokens");

test("translates the legacy GPT-5.6 alias only on the wire", async () => {
  const alias = createCodexModel("gpt-5.6");
  let captured: Request | undefined;
  const provider = new OpenAICodexProvider({
    model: alias,
    resolver: { resolve: async () => credential },
    fetch: async (input, init) => {
      captured = new Request(input, init);
      return terminalResponse();
    },
  });
  const normalized = (await provider.listModels())[0]!;
  await collect(provider.stream({
    model: normalized,
    messages: [{ role: "user", content: "hello" }],
    tools: [],
  }));
  const body = await captured?.json() as Record<string, unknown>;
  expect(body.model).toBe("gpt-5.6-sol");
  expect(alias.id).toBe("gpt-5.6");
  expect(normalized.id).toBe("gpt-5.6");
});
```

Update the shared provider contract to assert that Codex omits the field while llama.cpp and OpenAI-compatible still serialize their existing output limits.

- [ ] **Step 2: Run Provider tests and verify RED**

Run:

```powershell
npx vitest run src/providers/openai-codex-provider.test.ts src/providers/provider-contract.test.ts
```

Expected: FAIL because the body still contains `max_output_tokens` and the alias is not translated.

- [ ] **Step 3: Implement the wire-only correction**

```ts
const body = JSON.stringify({
  model: codexWireModelId(request.model.id),
  ...(instructions === undefined ? {} : { instructions }),
  input: serializeMessages(request.messages),
  tools: request.tools.map(serializeTool),
  tool_choice: "auto",
  parallel_tool_calls: true,
  stream: true,
  store: false,
  include: ["reasoning.encrypted_content"],
});
```

Do not remove `maxOutputTokens` from any common request or model type.

- [ ] **Step 4: Run Provider tests and verify GREEN**

Run:

```powershell
npx vitest run src/providers/openai-codex-provider.test.ts src/providers/provider-contract.test.ts
```

Expected: both files pass and the non-Codex output-limit assertions remain unchanged.

- [ ] **Step 5: Commit the wire fix**

```powershell
git add src/providers/openai-codex-provider.ts src/providers/openai-codex-provider.test.ts src/providers/provider-contract.test.ts
git commit -m "fix: align Codex requests with ChatGPT backend"
```

### Task 3: Classify HTTP errors and stop permanent retries

**Files:**
- Create: `src/model/errors.ts`
- Create: `src/model/errors.test.ts`
- Modify: `src/model/retry.ts`
- Modify: `src/model/retry.test.ts`
- Modify: `src/providers/openai-codex-provider.ts`
- Modify: `src/providers/openai-codex-provider.test.ts`

**Interfaces:**
- Produces: `ModelHttpError`, `isRetryableModelError(error: Error): boolean`.
- Consumes: structured `error.{type,code,param,message}` or top-level `message/detail` from an HTTP response.

- [ ] **Step 1: Write failing error classification and sanitization tests**

```ts
test("classifies permanent and transient HTTP statuses", () => {
  expect(new ModelHttpError(400, "bad request").retryable).toBe(false);
  expect(new ModelHttpError(429, "slow down").retryable).toBe(true);
  expect(new ModelHttpError(503, "unavailable").retryable).toBe(true);
});

test("does not retry a permanent model error", async () => {
  let attempts = 0;
  const runner: ModelStreamRunner = {
    async *stream() {
      attempts += 1;
      yield { type: "start" };
      yield {
        type: "error",
        reason: "error",
        error: new ModelHttpError(400, "Unsupported parameter"),
      };
    },
  };
  const events = await collect(new RetryingModelRuntime(runner, {
    maxRetries: 2,
    initialDelayMs: 0,
  }).stream(request));
  expect(attempts).toBe(1);
  expect(events.some((event) => event.type === "retry")).toBe(false);
});

test("shows a bounded redacted structured server error", async () => {
  const provider = new OpenAICodexProvider({
    model,
    resolver: { resolve: async () => credential },
    fetch: async () => Response.json({
      error: { message: "bad\nBearer secret-value eyJabc.def.ghi" },
    }, { status: 400 }),
  });
  const events = await collect(provider.stream(request()));
  const error = events.at(-1);
  expect(error).toMatchObject({
    type: "error",
    error: { name: "ModelHttpError", message: expect.stringContaining("bad") },
  });
  if (error?.type !== "error") throw new Error("Expected provider error");
  expect(error.error.message).not.toMatch(/[\r\n]|secret-value|eyJabc/);
  expect(error.error.message.length).toBeLessThanOrEqual(360);
});
```

- [ ] **Step 2: Run targeted tests and verify RED**

Run:

```powershell
npx vitest run src/model/errors.test.ts src/model/retry.test.ts src/providers/openai-codex-provider.test.ts
```

Expected: FAIL because `ModelHttpError` and retry classification do not exist and Provider hides the message.

- [ ] **Step 3: Implement status classification and safe message extraction**

```ts
export class ModelHttpError extends Error {
  readonly retryable: boolean;

  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ModelHttpError";
    this.retryable = status === 408 || status === 409 || status === 429 ||
      (status >= 500 && status <= 599);
  }
}

export function isRetryableModelError(error: Error): boolean {
  return !(error instanceof ModelHttpError) || error.retryable;
}
```

Provider error extraction must only accept the documented scalar fields, normalize control characters to spaces, redact bearer/JWT/key-like substrings, truncate to 300 characters, and otherwise return only the HTTP status.

In `RetryingModelRuntime`, yield the first terminal error immediately when `isRetryableModelError(event.error)` is false, before scheduling delay or emitting `retry`.

- [ ] **Step 4: Run targeted tests and verify GREEN**

Run:

```powershell
npx vitest run src/model/errors.test.ts src/model/retry.test.ts src/providers/openai-codex-provider.test.ts
```

Expected: all targeted tests pass; existing transient retry tests still pass.

- [ ] **Step 5: Commit error behavior**

```powershell
git add src/model/errors.ts src/model/errors.test.ts src/model/retry.ts src/model/retry.test.ts src/providers/openai-codex-provider.ts src/providers/openai-codex-provider.test.ts
git commit -m "fix: stop retrying permanent model errors"
```

### Task 4: Session compatibility, exports, and operator documentation

**Files:**
- Modify: `src/session/session-compatibility.test.ts`
- Modify: `src/index.ts`
- Modify: `src/index.test.ts`
- Modify: `README.md`
- Modify: `docs/07-token-limit-resilience.md`

**Interfaces:**
- Consumes: catalog and wire behavior from Tasks 1–3.
- Produces: public model/error exports and exact CLI commands for current Codex models.

- [ ] **Step 1: Add a public-export RED test and a session characterization test**

```ts
test("exports current Codex catalog and HTTP error contracts", async () => {
  const api = await import("./index.js");
  expect(api.CODEX_DEFAULT_MODEL_ID).toBe("gpt-5.6-sol");
  expect(api.createCodexModel("gpt-5.6-luna").id).toBe("gpt-5.6-luna");
  expect(new api.ModelHttpError(400, "bad").retryable).toBe(false);
});

test("loads a legacy GPT-5.6 session without rewriting its model ID", async () => {
  const model = createCodexModel("gpt-5.6");
  const store = new JsonlSessionStore({ rootDir, sessionId: "legacy-56", model });
  await store.load();
  await store.appendEntry(userEntry);

  const reloaded = new JsonlSessionStore({ rootDir, sessionId: "legacy-56", model });
  await expect(reloaded.load()).resolves.toBeDefined();
  const header = JSON.parse((await readFile(reloaded.filePath, "utf8")).split("\n")[0]);
  expect(header.model.id).toBe("gpt-5.6");
});
```

- [ ] **Step 2: Run the index and session tests**

Run:

```powershell
npx vitest run src/index.test.ts src/session/session-compatibility.test.ts
```

Expected: the index test fails because the new contracts are not publicly exported; the session characterization passes and proves no schema change is required.

- [ ] **Step 3: Update exports and documentation**

Export the catalog helpers and `ModelHttpError` from `src/index.ts`. Update README commands to include:

```powershell
npm run cli -- chat --provider openai-codex
npm run cli -- chat --provider openai-codex --model gpt-5.6-sol
npm run cli -- chat --provider openai-codex --model gpt-5.6-terra
npm run cli -- chat --provider openai-codex --model gpt-5.6-luna
npm run cli -- chat --provider openai-codex --model gpt-5.5
```

Correct the optional smoke examples in `docs/07-token-limit-resilience.md` so Ollama and llama.cpp commands include the required `chat` subcommand. Explain that Codex keeps an internal 4,096-token reservation but omits a wire output-limit field because the ChatGPT endpoint rejects it.

- [ ] **Step 4: Run docs/session/index tests and verify GREEN**

Run:

```powershell
npx vitest run src/session/session-compatibility.test.ts src/index.test.ts src/cli/main.test.ts
```

Expected: all targeted tests pass.

- [ ] **Step 5: Commit compatibility and docs**

```powershell
git add src/session/session-compatibility.test.ts src/index.ts src/index.test.ts README.md docs/07-token-limit-resilience.md
git commit -m "docs: explain current Codex model usage"
```

### Task 5: Full verification and live OAuth acceptance

**Files:**
- Modify only if verification exposes a scoped defect covered by a new failing test.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: local and live evidence suitable for PR review.

- [ ] **Step 1: Run static and full automated acceptance**

```powershell
git diff --check shellnaut/main...HEAD
$env:CI = "true"
npm run check
```

Expected: typecheck passes; all Vitest files pass; build, installed-package smoke, and CLI EOF smoke pass.

- [ ] **Step 2: Run a secret-safe live matrix**

For `gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`, use the normal `OpenAICodexProvider` with the existing OAuth resolver and a one-word prompt. Record only:

```json
{"model":"gpt-5.6-sol","httpStatus":200,"textSeen":true,"terminal":"done"}
```

Never print the response text, OAuth credential, account ID, request body, or headers.

- [ ] **Step 3: Reproduce the original session path**

Run the existing session with the matching alias:

```powershell
npm run cli -- chat --provider openai-codex --model gpt-5.6 --session 60f7da6c-8da8-4b4e-8216-5abb7b6c4233
```

Use a non-interactive test harness or controlled EOF so the test does not append unrelated prompts. Verify the session header remains `gpt-5.6` and a request reaches Sol without `max_output_tokens`.

- [ ] **Step 4: Review branch scope and commit any final evidence-only documentation**

```powershell
git status --short --branch
git log --oneline shellnaut/main..HEAD
git diff --stat shellnaut/main...HEAD
git diff --check shellnaut/main...HEAD
```

Expected: only design, plan, catalog, Provider/error/retry, focused tests, and operator docs are changed.

- [ ] **Step 5: Push and open a ready PR after review**

```powershell
git push -u shellnaut codex/codex-5-6-support
```

Open a ready PR into `shellnaut/main` with the root cause, model matrix, automated verification, and secret-safe live acceptance results.
