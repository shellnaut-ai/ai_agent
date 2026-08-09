import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  access,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
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

  test(
    "fails closed on an unlocked legacy artifact until an operator removes it",
    async () => {
      const rootDir = await mkdtemp(
        join(tmpdir(), "ai-agent-writer-stale-"),
      );
      cleanup.push(rootDir);
      const lockPath = join(rootDir, "session.writer.lock");
      const callbackMarker = join(rootDir, "callback-entered");
      await writeFile(lockPath, "abandoned-owner-metadata\n", "utf8");
      const old = new Date(Date.now() - 86_400_000);
      await utimes(lockPath, old, old);
      const identityBefore = await lstat(lockPath, { bigint: true });
      const writerLockUrl = pathToFileURL(
        resolve("src/session/writer-lock.ts"),
      ).href;
      const script = `
        Object.defineProperty(process, "platform", {
          configurable: true,
          value: "linux",
        });
        const { withSessionWriterLock } = await import(
          ${JSON.stringify(writerLockUrl)});
        try {
          await withSessionWriterLock(process.argv[1], async () => {
            const { writeFile } = await import("node:fs/promises");
            await writeFile(process.argv[2], "entered\\n", "utf8");
            }, { timeoutMs: 5_000 });
          process.stdout.write("unexpected-success\\n");
        } catch (error) {
          process.stdout.write("error:" + error.message + "\\n");
        }
      `;
      const contender = spawnNode(script, [lockPath, callbackMarker]);

      await expect(waitForLine(contender, /^error:/u)).resolves.toMatch(
        /legacy.*quiescent.*remove/i,
      );
      await waitForClose(contender);
      children.delete(contender);
      expect(await readdir(rootDir)).toEqual(["session.writer.lock"]);
      const identityAfter = await lstat(lockPath, { bigint: true });
      expect([identityAfter.dev, identityAfter.ino]).toEqual([
        identityBefore.dev,
        identityBefore.ino,
      ]);
      expect(await readFile(lockPath, "utf8")).toBe(
        "abandoned-owner-metadata\n",
      );
      await expect(access(callbackMarker)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  test(
    "fails closed when a regular legacy artifact races the initial precheck",
    async () => {
      const rootDir = await mkdtemp(
        join(tmpdir(), "ai-agent-writer-raced-legacy-"),
      );
      cleanup.push(rootDir);
      const lockPath = join(rootDir, "session.writer.lock");
      const callbackMarker = join(rootDir, "callback-entered");
      const writerLockUrl = pathToFileURL(
        resolve("src/session/writer-lock.ts"),
      ).href;
      const script = `
        import { lstat, writeFile } from "node:fs/promises";
        Object.defineProperty(process, "platform", {
          configurable: true,
          value: "linux",
        });
        const {
          sessionWriterLockRuntime,
          withSessionWriterLock,
        } = await import(${JSON.stringify(writerLockUrl)});
        sessionWriterLockRuntime.publishPosixCandidate = async (
          _candidatePath,
          lockPath,
        ) => {
          await writeFile(lockPath, "raced-legacy-owner\\n", "utf8");
          const identity = await lstat(lockPath, { bigint: true });
          process.stdout.write(
            "published:" + identity.dev + ":" + identity.ino + "\\n");
          throw Object.assign(new Error("simulated publication contention"), {
            code: "EEXIST",
          });
        };
        try {
          await withSessionWriterLock(process.argv[1], async () => {
            await writeFile(process.argv[2], "entered\\n", "utf8");
          }, { timeoutMs: 5_000 });
          process.stdout.write("unexpected-success\\n");
        } catch (error) {
          process.stdout.write("error:" + error.message + "\\n");
        }
      `;
      const contender = spawnNode(script, [lockPath, callbackMarker]);
      const publishedLine = waitForLine(contender, /^published:/u);
      const errorLine = waitForLine(contender, /^error:/u);
      const published = await publishedLine;
      await expect(errorLine).resolves.toMatch(
        /legacy.*quiescent.*remove/i,
      );
      await waitForClose(contender);
      children.delete(contender);
      const [, expectedDev, expectedIno] = published.split(":");
      const identity = await lstat(lockPath, { bigint: true });

      expect([String(identity.dev), String(identity.ino)]).toEqual([
        expectedDev,
        expectedIno,
      ]);
      expect(await readFile(lockPath, "utf8")).toBe(
        "raced-legacy-owner\n",
      );
      await expect(access(callbackMarker)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  test.skipIf(process.platform !== "linux")(
    "fails closed while an old process holds a live kernel flock",
    async () => {
      const rootDir = await mkdtemp(
        join(tmpdir(), "ai-agent-writer-live-flock-"),
      );
      cleanup.push(rootDir);
      const lockPath = join(rootDir, "session.writer.lock");
      const owner = spawn(
        "flock",
        [
          "--no-fork",
          "--exclusive",
          lockPath,
          process.execPath,
          "--input-type=module",
          "--eval",
          'process.stdout.write("acquired\\n"); await new Promise(() => undefined);',
        ],
        {
          env: process.env,
          stdio: ["pipe", "pipe", "pipe"],
        },
      ) as ChildProcessWithoutNullStreams;
      children.add(owner);
      try {
        await waitForLine(owner, "acquired");
        const identityBefore = await lstat(lockPath, { bigint: true });
        let callbackEntered = false;

        await expect(
          withSessionWriterLock(lockPath, async () => {
            callbackEntered = true;
            return "must not enter";
          }, { timeoutMs: 5_000 }),
        ).rejects.toThrow(/legacy.*quiescent.*remove/i);
        expect(callbackEntered).toBe(false);
        expect(await readdir(rootDir)).toEqual(["session.writer.lock"]);
        const identityAfter = await lstat(lockPath, { bigint: true });
        expect([identityAfter.dev, identityAfter.ino]).toEqual([
          identityBefore.dev,
          identityBefore.ino,
        ]);
      } finally {
        owner.kill();
        await waitForClose(owner);
        children.delete(owner);
      }
    },
  );

  test.skipIf(process.platform !== "linux")(
    "recovers a same-version lease whose owner is a real zombie",
    async () => {
      const rootDir = await mkdtemp(
        join(tmpdir(), "ai-agent-writer-zombie-owner-"),
      );
      cleanup.push(rootDir);
      const lockPath = join(rootDir, "session.writer.lock");
      const token = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const fixture = String.raw`
import json, os, signal, socket, sys, time
lock_path, token = sys.argv[1], sys.argv[2]
zombie = os.fork()
if zombie == 0:
    os.mkdir(lock_path)
    with open(os.path.join(lock_path, "owner.json"), "w", encoding="utf-8") as output:
        json.dump({
            "version": 1,
            "token": token,
            "pid": os.getpid(),
            "host": socket.gethostname(),
        }, output)
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
    os._exit(0)

def reap_and_exit(_signal, _frame):
    os.waitpid(zombie, 0)
    sys.exit(0)

signal.signal(signal.SIGUSR1, reap_and_exit)
deadline = time.monotonic() + 5
while time.monotonic() < deadline:
    try:
        with open(f"/proc/{zombie}/stat", "r", encoding="utf-8") as source:
            stat = source.read()
        if stat[stat.rfind(")") + 2] == "Z":
            print(f"zombie:{zombie}", flush=True)
            break
    except FileNotFoundError:
        pass
    time.sleep(0.01)
else:
    raise RuntimeError("child did not become a zombie")

while True:
    signal.pause()
`;
      const holder = spawn("python3", ["-c", fixture, lockPath, token], {
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessWithoutNullStreams;
      children.add(holder);
      try {
        await expect(waitForLine(holder, /^zombie:\d+$/u)).resolves.toMatch(
          /^zombie:\d+$/u,
        );
        let callbackEntered = false;

        await expect(
          withSessionWriterLock(lockPath, async () => {
            callbackEntered = true;
            return "recovered-zombie";
          }, { timeoutMs: 1_000 }),
        ).resolves.toBe("recovered-zombie");
        expect(callbackEntered).toBe(true);
        expect(await readdir(rootDir)).toEqual([
          `session.writer.lock.reaped-${token}`,
        ]);
      } finally {
        holder.kill("SIGUSR1");
        await waitForClose(holder);
        children.delete(holder);
      }
    },
    15_000,
  );

  test(
    "fails closed when portable owner-state inspection is uncertain",
    async () => {
      const rootDir = await mkdtemp(
        join(tmpdir(), "ai-agent-writer-state-uncertain-"),
      );
      cleanup.push(rootDir);
      const lockPath = join(rootDir, "session.writer.lock");
      const callbackMarker = join(rootDir, "callback-entered");
      const writerLockUrl = pathToFileURL(
        resolve("src/session/writer-lock.ts"),
      ).href;
      const processTreeUrl = pathToFileURL(
        resolve("src/tools/process-tree.ts"),
      ).href;
      const script = `
        import { mkdir, writeFile } from "node:fs/promises";
        import { hostname } from "node:os";
        Object.defineProperty(process, "platform", {
          configurable: true,
          value: "darwin",
        });
        const { posixProcessStateRuntime } = await import(
          ${JSON.stringify(processTreeUrl)});
        const { withSessionWriterLock } = await import(
          ${JSON.stringify(writerLockUrl)});
        await mkdir(process.argv[1]);
        await writeFile(
          process.argv[1] + "/owner.json",
          JSON.stringify({
            version: 1,
            token: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            pid: process.pid,
            host: hostname(),
          }) + "\\n",
          "utf8",
        );
        posixProcessStateRuntime.execute = async () => {
          throw Object.assign(new Error("simulated ps permission failure"), {
            code: "EACCES",
          });
        };
        try {
          await withSessionWriterLock(process.argv[1], async () => {
            await writeFile(process.argv[2], "entered\\n", "utf8");
          }, { timeoutMs: 100 });
          process.stdout.write("unexpected-success\\n");
        } catch (error) {
          process.stdout.write("error:" + error.message + "\\n");
        }
      `;
      const contender = spawnNode(script, [lockPath, callbackMarker]);

      await expect(waitForLine(contender, /^error:/u)).resolves.toMatch(
        /lock|acquisition/i,
      );
      await waitForClose(contender);
      children.delete(contender);
      await expect(access(callbackMarker)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readdir(lockPath)).toEqual(["owner.json"]);
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
