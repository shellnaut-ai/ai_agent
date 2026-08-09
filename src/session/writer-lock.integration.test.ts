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
const windowsCi =
  process.platform === "win32" && process.env["CI"] === "true";
const childOutputTimeoutMs = windowsCi ? 30_000 : 10_000;
const liveOwnerTestTimeoutMs = windowsCi ? 45_000 : 5_000;
const synchronizedWriterTestTimeoutMs = windowsCi ? 60_000 : 20_000;
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
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    os.mkdir(lock_path)
    with open(os.path.join(lock_path, "owner.json"), "w", encoding="utf-8") as output:
        json.dump({
            "version": 1,
            "token": token,
            "pid": os.getpid(),
            "host": socket.gethostname(),
            "livenessPort": listener.getsockname()[1],
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
        const retained = await readdir(rootDir);
        expect(retained).toContain(`session.writer.lock.reaped-${token}`);
        expect(retained).toHaveLength(2);
        expect(
          retained.every((entry) =>
            entry.startsWith("session.writer.lock.reaped-"),
          ),
        ).toBe(true);
      } finally {
        holder.kill("SIGUSR1");
        await waitForClose(holder);
        children.delete(holder);
      }
    },
    15_000,
  );

  test(
    "recovers a socket-backed lease when its owner port is closed",
    async () => {
      const rootDir = await mkdtemp(
        join(tmpdir(), "ai-agent-writer-closed-port-"),
      );
      cleanup.push(rootDir);
      const lockPath = join(rootDir, "session.writer.lock");
      const writerLockUrl = pathToFileURL(
        resolve("src/session/writer-lock.ts"),
      ).href;
      const script = `
        import { createServer } from "node:net";
        import { mkdir, writeFile } from "node:fs/promises";
        import { hostname } from "node:os";
        Object.defineProperty(process, "platform", {
          configurable: true,
          value: "darwin",
        });
        const {
          sessionWriterLockRuntime,
          withSessionWriterLock,
        } = await import(${JSON.stringify(writerLockUrl)});
        const publish = sessionWriterLockRuntime.publishPosixCandidate;
        sessionWriterLockRuntime.publishPosixCandidate = async (...args) => {
          try {
            await publish(...args);
          } catch (error) {
            if (error?.code !== "EPERM") throw error;
            throw Object.assign(new Error("simulated POSIX contention"), {
              code: "EEXIST",
            });
          }
        };
        const listener = createServer();
        await new Promise((resolve, reject) => {
          listener.once("error", reject);
          listener.listen({ host: "127.0.0.1", port: 0 }, resolve);
        });
        const address = listener.address();
        if (typeof address !== "object" || address === null) {
          throw new Error("fixture did not bind a TCP port");
        }
        await new Promise((resolve, reject) => listener.close((error) => {
          if (error) reject(error); else resolve();
        }));
        await mkdir(process.argv[1]);
        await writeFile(
          process.argv[1] + "/owner.json",
          JSON.stringify({
            version: 1,
            token: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            pid: process.pid,
            host: hostname(),
            livenessPort: address.port,
          }) + "\\n",
          "utf8",
        );
        const result = await withSessionWriterLock(
          process.argv[1],
          async () => "recovered-closed-port",
          { timeoutMs: 250 },
        );
        process.stdout.write(result + "\\n");
      `;
      const contender = spawnNode(script, [lockPath], { PATH: "" });

      await expect(
        waitForLine(contender, "recovered-closed-port"),
      ).resolves.toBe("recovered-closed-port");
      await waitForClose(contender);
      children.delete(contender);
      const retained = await readdir(rootDir);
      expect(retained).toContain(
        "session.writer.lock.reaped-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      );
      expect(retained).toHaveLength(2);
      expect(
        retained.every((entry) =>
          entry.startsWith("session.writer.lock.reaped-"),
        ),
      ).toBe(true);
    },
  );

  test(
    "fails closed when the dependency-free liveness probe is ambiguous",
    async () => {
      const rootDir = await mkdtemp(
        join(tmpdir(), "ai-agent-writer-probe-uncertain-"),
      );
      cleanup.push(rootDir);
      const lockPath = join(rootDir, "session.writer.lock");
      const callbackMarker = join(rootDir, "callback-entered");
      const writerLockUrl = pathToFileURL(
        resolve("src/session/writer-lock.ts"),
      ).href;
      const script = `
        import { mkdir, writeFile } from "node:fs/promises";
        import { hostname } from "node:os";
        Object.defineProperty(process, "platform", {
          configurable: true,
          value: "darwin",
        });
        const {
          sessionWriterLockRuntime,
          withSessionWriterLock,
        } = await import(${JSON.stringify(writerLockUrl)});
        const publish = sessionWriterLockRuntime.publishPosixCandidate;
        sessionWriterLockRuntime.publishPosixCandidate = async (...args) => {
          try {
            await publish(...args);
          } catch (error) {
            if (error?.code !== "EPERM") throw error;
            throw Object.assign(new Error("simulated POSIX contention"), {
              code: "EEXIST",
            });
          }
        };
        await mkdir(process.argv[1]);
        await writeFile(
          process.argv[1] + "/owner.json",
          JSON.stringify({
            version: 1,
            token: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            pid: process.pid,
            host: hostname(),
            livenessPort: 49152,
          }) + "\\n",
          "utf8",
        );
        sessionWriterLockRuntime.probePosixLivenessPort = async () => {
          throw Object.assign(new Error("simulated loopback timeout"), {
            code: "ETIMEDOUT",
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

  test(
    "a stale recovery observer cannot move a live replacement lease",
    async () => {
      const rootDir = await mkdtemp(
        join(tmpdir(), "ai-agent-writer-release-aba-"),
      );
      cleanup.push(rootDir);
      const lockPath = join(rootDir, "session.writer.lock");
      const callbackMarker = join(rootDir, "stale-callback-entered");
      const writerLockUrl = pathToFileURL(
        resolve("src/session/writer-lock.ts"),
      ).href;
      const ownerScript = `
        Object.defineProperty(process, "platform", {
          configurable: true,
          value: "darwin",
        });
        const { withSessionWriterLock } = await import(
          ${JSON.stringify(writerLockUrl)});
        process.stdin.setEncoding("utf8");
        await withSessionWriterLock(process.argv[1], async () => {
          process.stdout.write("acquired\\n");
          await new Promise((resolve) => process.stdin.once("data", resolve));
        });
        process.stdout.write("released\\n");
      `;
      const contenderScript = `
        import { writeFile } from "node:fs/promises";
        Object.defineProperty(process, "platform", {
          configurable: true,
          value: "darwin",
        });
        const {
          sessionWriterLockRuntime,
          withSessionWriterLock,
        } = await import(${JSON.stringify(writerLockUrl)});
        const publish = sessionWriterLockRuntime.publishPosixCandidate;
        sessionWriterLockRuntime.publishPosixCandidate = async (...args) => {
          try {
            await publish(...args);
          } catch (error) {
            if (error?.code !== "EPERM") throw error;
            throw Object.assign(new Error("simulated POSIX contention"), {
              code: "EEXIST",
            });
          }
        };
        const probe = sessionWriterLockRuntime.probePosixLivenessPort;
        let probeCount = 0;
        process.stdin.setEncoding("utf8");
        sessionWriterLockRuntime.probePosixLivenessPort = async (port) => {
          probeCount += 1;
          if (probeCount === 1) {
            process.stdout.write("observed-owner-a\\n");
            await new Promise((resolve) => process.stdin.once("data", resolve));
            return false;
          }
          return probe(port);
        };
        try {
          await withSessionWriterLock(process.argv[1], async () => {
            await writeFile(process.argv[2], "entered\\n", "utf8");
            process.stdout.write("stale-callback-entered\\n");
          }, { timeoutMs: 1_500 });
          process.stdout.write("unexpected-success\\n");
        } catch (error) {
          process.stdout.write("error:" + error.message + "\\n");
        }
      `;
      const ownerA = spawnNode(ownerScript, [lockPath]);
      let ownerB: ChildProcessWithoutNullStreams | undefined;
      let contender: ChildProcessWithoutNullStreams | undefined;

      try {
        await waitForLine(ownerA, "acquired");
        const recordA = JSON.parse(
          await readFile(join(lockPath, "owner.json"), "utf8"),
        ) as { token: string };
        contender = spawnNode(contenderScript, [lockPath, callbackMarker]);
        await waitForLine(contender, "observed-owner-a");

        ownerA.stdin.end("release\\n");
        await waitForLine(ownerA, "released");
        await waitForClose(ownerA);
        children.delete(ownerA);

        ownerB = spawnNode(ownerScript, [lockPath]);
        await waitForLine(ownerB, "acquired");
        const recordB = JSON.parse(
          await readFile(join(lockPath, "owner.json"), "utf8"),
        ) as { token: string };
        expect(recordB.token).not.toBe(recordA.token);

        contender.stdin.write("continue\\n");
        await expect(
          waitForLine(
            contender,
            /^(?:error:|stale-callback-entered|unexpected-success)/u,
          ),
        ).resolves.toMatch(/^error:.*(?:lock|acquisition)/iu);
        contender.stdin.end();
        await waitForClose(contender);
        children.delete(contender);
        contender = undefined;

        await expect(access(callbackMarker)).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(
          JSON.parse(
            await readFile(join(lockPath, "owner.json"), "utf8"),
          ).token,
        ).toBe(recordB.token);
        expect(
          JSON.parse(
            await readFile(
              `${lockPath}.reaped-${recordA.token}/owner.json`,
              "utf8",
            ),
          ).token,
        ).toBe(recordA.token);
      } finally {
        if (contender !== undefined) {
          contender.kill();
          await waitForClose(contender);
          children.delete(contender);
        }
        if (ownerB !== undefined) {
          ownerB.stdin.end("release\\n");
          await waitForClose(ownerB);
          children.delete(ownerB);
        }
        if (children.has(ownerA)) {
          ownerA.kill();
          await waitForClose(ownerA);
          children.delete(ownerA);
        }
      }
    },
    15_000,
  );

  test(
    "keeps the liveness socket open through the lease and closes it on release",
    async () => {
      const rootDir = await mkdtemp(
        join(tmpdir(), "ai-agent-writer-liveness-release-"),
      );
      cleanup.push(rootDir);
      const lockPath = join(rootDir, "session.writer.lock");
      const writerLockUrl = pathToFileURL(
        resolve("src/session/writer-lock.ts"),
      ).href;
      const script = `
        import { createConnection } from "node:net";
        import { readFile } from "node:fs/promises";
        Object.defineProperty(process, "platform", {
          configurable: true,
          value: "darwin",
        });
        const { withSessionWriterLock } = await import(
          ${JSON.stringify(writerLockUrl)});
        const connect = (port) => new Promise((resolve, reject) => {
          const socket = createConnection({ host: "127.0.0.1", port });
          socket.once("connect", () => {
            socket.destroy();
            resolve();
          });
          socket.once("error", reject);
        });
        let port;
        await withSessionWriterLock(process.argv[1], async () => {
          const record = JSON.parse(await readFile(
            process.argv[1] + "/owner.json", "utf8"));
          port = record.livenessPort;
          if (!Number.isInteger(port)) {
            throw new Error("lease did not publish a liveness port");
          }
          await connect(port);
        });
        try {
          await connect(port);
          throw new Error("released liveness port still accepts connections");
        } catch (error) {
          if (error?.code !== "ECONNREFUSED") throw error;
        }
        process.stdout.write("liveness-closed\\n");
      `;
      const owner = spawnNode(script, [lockPath]);

      await expect(waitForLine(owner, "liveness-closed")).resolves.toBe(
        "liveness-closed",
      );
      await waitForClose(owner);
      children.delete(owner);
      await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  test(
    "closes the liveness socket when lease publication fails",
    async () => {
      const rootDir = await mkdtemp(
        join(tmpdir(), "ai-agent-writer-liveness-failure-"),
      );
      cleanup.push(rootDir);
      const lockPath = join(rootDir, "session.writer.lock");
      const writerLockUrl = pathToFileURL(
        resolve("src/session/writer-lock.ts"),
      ).href;
      const script = `
        import { createConnection } from "node:net";
        import { readFile } from "node:fs/promises";
        Object.defineProperty(process, "platform", {
          configurable: true,
          value: "darwin",
        });
        const {
          sessionWriterLockRuntime,
          withSessionWriterLock,
        } = await import(${JSON.stringify(writerLockUrl)});
        let port;
        sessionWriterLockRuntime.publishPosixCandidate = async (candidate) => {
          const record = JSON.parse(await readFile(
            candidate + "/owner.json", "utf8"));
          port = record.livenessPort;
          throw Object.assign(new Error("simulated publication failure"), {
            code: "EACCES",
          });
        };
        try {
          await withSessionWriterLock(process.argv[1], async () => undefined);
          throw new Error("publication unexpectedly succeeded");
        } catch (error) {
          if (!/publication failure/i.test(error.message)) throw error;
        }
        await new Promise((resolve, reject) => {
          const socket = createConnection({ host: "127.0.0.1", port });
          socket.once("connect", () => {
            socket.destroy();
            reject(new Error("failed acquisition left liveness port open"));
          });
          socket.once("error", (error) => {
            socket.destroy();
            if (error.code === "ECONNREFUSED") resolve(); else reject(error);
          });
        });
        process.stdout.write("failed-acquisition-cleaned\\n");
      `;
      const owner = spawnNode(script, [lockPath]);

      await expect(
        waitForLine(owner, "failed-acquisition-cleaned"),
      ).resolves.toBe("failed-acquisition-cleaned");
      await waitForClose(owner);
      children.delete(owner);
      expect(await readdir(rootDir)).toEqual([]);
    },
  );

  test(
    "closes the liveness socket when lease release fails closed",
    async () => {
      const rootDir = await mkdtemp(
        join(tmpdir(), "ai-agent-writer-liveness-release-failure-"),
      );
      cleanup.push(rootDir);
      const lockPath = join(rootDir, "session.writer.lock");
      const writerLockUrl = pathToFileURL(
        resolve("src/session/writer-lock.ts"),
      ).href;
      const script = `
        import { createConnection } from "node:net";
        import { readFile, writeFile } from "node:fs/promises";
        Object.defineProperty(process, "platform", {
          configurable: true,
          value: "darwin",
        });
        const { withSessionWriterLock } = await import(
          ${JSON.stringify(writerLockUrl)});
        let port;
        try {
          await withSessionWriterLock(process.argv[1], async () => {
            const ownerPath = process.argv[1] + "/owner.json";
            const record = JSON.parse(await readFile(ownerPath, "utf8"));
            port = record.livenessPort;
            await writeFile(ownerPath, "{}\\n", "utf8");
          });
          throw new Error("compromised release unexpectedly succeeded");
        } catch (error) {
          if (error?.name !== "SessionWriterLockCompromisedError") throw error;
        }
        await new Promise((resolve, reject) => {
          const socket = createConnection({ host: "127.0.0.1", port });
          socket.once("connect", () => {
            socket.destroy();
            reject(new Error("failed release left liveness port open"));
          });
          socket.once("error", (error) => {
            socket.destroy();
            if (error.code === "ECONNREFUSED") resolve(); else reject(error);
          });
        });
        process.stdout.write("failed-release-cleaned\\n");
      `;
      const owner = spawnNode(script, [lockPath]);

      await expect(waitForLine(owner, "failed-release-cleaned")).resolves.toBe(
        "failed-release-cleaned",
      );
      await waitForClose(owner);
      children.delete(owner);
      expect(await readdir(lockPath)).toEqual(["owner.json"]);
    },
  );

  test.skipIf(process.platform === "win32")(
    "does not steal a live socket-backed lease while its owner is paused",
    async () => {
      const rootDir = await mkdtemp(
        join(tmpdir(), "ai-agent-writer-paused-owner-"),
      );
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
      try {
        expect(owner.kill("SIGSTOP")).toBe(true);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
        let callbackEntered = false;
        await expect(
          withSessionWriterLock(lockPath, async () => {
            callbackEntered = true;
          }, { timeoutMs: 150 }),
        ).rejects.toThrow(/lock|acquisition/i);
        expect(callbackEntered).toBe(false);
      } finally {
        owner.kill("SIGCONT");
        owner.kill();
        await waitForClose(owner);
        children.delete(owner);
      }
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
  }, liveOwnerTestTimeoutMs);

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
  }, synchronizedWriterTestTimeoutMs);
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
  timeoutMs = childOutputTimeoutMs,
): Promise<string> {
  return new Promise<string>((resolveLine, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      cleanupListeners();
      reject(new Error("Timed out waiting for child-process output."));
    }, timeoutMs);
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
