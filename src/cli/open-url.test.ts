import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { openExternalUrl, type SpawnProcess } from "./open-url.js";

describe("openExternalUrl", () => {
  it("uses the Windows URL handler without invoking a shell", async () => {
    let command = "";
    let args: readonly string[] = [];
    const child = new EventEmitter() as ReturnType<SpawnProcess>;
    Object.assign(child, { unref() {} });

    const opened = await openExternalUrl("https://example.test/login", {
      platform: "win32",
      spawn(commandValue, argsValue) {
        command = commandValue;
        args = argsValue;
        queueMicrotask(() => child.emit("spawn"));
        return child;
      },
    });

    expect(opened).toBe(true);
    expect(command).toBe("rundll32.exe");
    expect(args).toEqual([
      "url.dll,FileProtocolHandler",
      "https://example.test/login",
    ]);
  });
});
