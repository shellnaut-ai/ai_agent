import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import { JsonlSessionStore } from "./jsonl-store.js";
import { Session } from "./session.js";
import { withSessionWriterLock } from "./writer-lock.js";

const cleanup: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();
const model = {
  id: "fake-model",
  name: "Fake",
  provider: "fake" as const,
  contextWindow: 4096,
  maxOutputTokens: 1024,
};

afterEach(async () => {
  for (const child of children) {
    child.kill();
  }

  await Promise.all([...children].map((child) => waitForClose(child)));
  children.clear();
  await Promise.all(
    cleanup.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("cross-process session writer lock", () => {
  test(
    "the non-Windows lease has no native-addon or executable dependency",
    async () => {
      const rootDir = await mkdtemp(
        join(tmpdir(), "ai-agent-writer-no-path-"),
      );
      cleanup.push(rootDir);
      const lockPath = join(rootDir, "session.writer.lock");
      const writerLockUrl = pathToFileURL(
        resolve("src/session/writer-lock.ts"),
      ).href;
      const script = `
      import Module from "node:module";
      const originalLoad = Module._load;
      Module._load = function (request, parent, isMain) {
        if (request === "fs-native-extensions") {
          throw new Error("native addons are unavailable");
        }
        return originalLoad.call(this, request, parent, isMain);
      };
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: "linux",
      });
      const { withSessionWriterLock } = await import(
        ${JSON.stringify(writerLockUrl)});
      await withSessionWriterLock(process.argv[1], async () => {
        process.stdout.write("acquired-without-runtime-dependency\\n");
      });
    `;
      const owner = spawnNode(script, [lockPath], { PATH: "" });

      await expect(
        waitForLine(owner, "acquired-without-runtime-dependency"),
      ).resolves.toBe("acquired-without-runtime-dependency");
      await waitForClose(owner);
      children.delete(owner);
    },
  );

  test.skipIf(process.platform === "win32")(
    "migrates an unlocked legacy artifact after a quiescent upgrade",
    async () => {
      const rootDir = await mkdtemp(
        join(tmpdir(), "ai-agent-writer-stale-"),
      );
      cleanup.push(rootDir);
      const lockPath = join(rootDir, "session.writer.lock");
      await writeFile(lockPath, "abandoned-owner-metadata\n", "utf8");
      const old = new Date(Date.now() - 86_400_000);
      await utimes(lockPath, old, old);

      await expect(
        withSessionWriterLock(lockPath, async () => "recovered", {
          timeoutMs: 5_000,
        }),
      ).resolves.toBe("recovered");
      expect(await readdir(rootDir)).toEqual([
        expect.stringMatching(/^session\.writer\.lock\.reaped-legacy-/u),
      ]);
    },
  );

  test("does not steal a live lease and recovers after its owner process dies", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ai-agent-writer-lock-"));
    cleanup.push(rootDir);
    const lockPath = join(rootDir, "session.writer.lock");
    const writerLockUrl = pathToFileURL(
      resolve("src/session/writer-lock.ts"),
    ).href;
    const script = `
      import { withSessionWriterLock } from ${JSON.stringify(writerLockUrl)};
      await withSessionWriterLock(process.argv[1], async () => {
        process.stdout.write("acquired\\n");
        await new Promise(() => undefined);
      });
    `;
    const owner = spawnNode(script, [lockPath]);
    await waitForLine(owner, "acquired");

    if (process.platform !== "win32") {
      const old = new Date(Date.now() - 86_400_000);
      await utimes(lockPath, old, old);
    }

    await expect(
      withSessionWriterLock(
        lockPath,
        async () => "must not enter",
        { timeoutMs: 100 },
      ),
    ).rejects.toThrow(/lock|acquisition|code/i);

    owner.kill();
    await waitForClose(owner);
    children.delete(owner);

    await expect(
      withSessionWriterLock(lockPath, async () => "recovered", {
        timeoutMs: 5_000,
      }),
    ).resolves.toBe("recovered");
  });

  test("allows only one stale-parent append across synchronized processes", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ai-agent-store-process-"));
    cleanup.push(rootDir);
    const sessionId = "cross-process-stale-parent";
    const initial = new JsonlSessionStore({ rootDir, sessionId, model });
    await initial.load();
    const storeUrl = pathToFileURL(
      resolve("src/session/jsonl-store.ts"),
    ).href;
    const sessionUrl = pathToFileURL(resolve("src/session/session.ts")).href;
    const script = `
      import { JsonlSessionStore } from ${JSON.stringify(storeUrl)};
      import { Session } from ${JSON.stringify(sessionUrl)};
      const model = JSON.parse(process.argv[3]);
      const store = new JsonlSessionStore({
        rootDir: process.argv[1],
        sessionId: process.argv[2],
        model,
      });
      await store.load();
      process.stdout.write("loaded\\n");
      process.stdin.setEncoding("utf8");
      await new Promise((resolve) => process.stdin.once("data", resolve));
      try {
        await new Session(store).appendMessage({
          role: "user",
          content: String(process.pid),
        });
        process.stdout.write("result:committed\\n");
      } catch (error) {
        const stale = error instanceof Error && /current leaf/i.test(error.message);
        process.stdout.write("result:" + (stale ? "stale" : "unexpected") + "\\n");
      }
    `;
    const args = [rootDir, sessionId, JSON.stringify(model)];
    const first = spawnNode(script, args);
    const second = spawnNode(script, args);
    await Promise.all([
      waitForLine(first, "loaded"),
      waitForLine(second, "loaded"),
    ]);
    first.stdin.end("go\n");
    second.stdin.end("go\n");
    const results = await Promise.all([
      waitForLine(first, /^result:/u),
      waitForLine(second, /^result:/u),
    ]);

    expect(results.sort()).toEqual([
      "result:committed",
      "result:stale",
    ]);
    await Promise.all([waitForClose(first), waitForClose(second)]);
    children.delete(first);
    children.delete(second);

    const reloaded = new JsonlSessionStore({ rootDir, sessionId, model });
    await reloaded.load();
    expect(new Session(reloaded).getMessages()).toHaveLength(1);
  }, 20_000);
});

function spawnNode(
  script: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = {},
): ChildProcessWithoutNullStreams {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script, ...args],
    {
      cwd: process.cwd(),
      env: {
        PATH: process.env["PATH"] ?? "",
        SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows",
        ...environment,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  children.add(child);
  return child;
}

function waitForLine(
  child: ChildProcessWithoutNullStreams,
  expected: string | RegExp,
): Promise<string> {
  return new Promise<string>((resolveLine, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      cleanupListeners();
      reject(new Error("Timed out waiting for child-process output."));
    }, 10_000);
    timer.unref();

    const cleanupListeners = (): void => {
      clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("close", onClose);
    };
    const onStdout = (chunk: Buffer): void => {
      stdout += chunk.toString("utf8");

      for (const line of stdout.split(/\r?\n/u)) {
        if (
          (typeof expected === "string" && line === expected) ||
          (expected instanceof RegExp && expected.test(line))
        ) {
          cleanupListeners();
          resolveLine(line);
          return;
        }
      }
    };
    const onStderr = (chunk: Buffer): void => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2_000);
    };
    const onError = (error: Error): void => {
      cleanupListeners();
      reject(error);
    };
    const onClose = (code: number | null): void => {
      cleanupListeners();
      reject(
        new Error(
          `Child exited with code ${String(code)} before expected output` +
            (stderr.trim().length === 0 ? "." : `: ${stderr.trim()}`),
        ),
      );
    };

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

function waitForClose(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise<void>((resolveClose) => {
    child.once("close", () => resolveClose());
  });
}
