import { describe, expect, it } from "vitest";

import {
  runCliApplication,
  type CliApplicationDependencies,
} from "./cli-application.js";

describe("CLI application dispatcher", () => {
  it("lets auth commands handle argv before chat commands", async () => {
    const calls: string[] = [];
    const dependencies: CliApplicationDependencies = {
      write: () => undefined,
      runAuth: async () => {
        calls.push("auth");
        return true;
      },
      runChat: async () => {
        calls.push("chat");
        return true;
      },
    };

    await expect(runCliApplication(["status"], dependencies)).resolves.toBe(0);
    expect(calls).toEqual(["auth"]);
  });

  it("prints focused help and returns a non-zero code for unknown commands", async () => {
    const output: string[] = [];
    const dependencies: CliApplicationDependencies = {
      write: (line) => output.push(line),
      runAuth: async () => false,
      runChat: async () => false,
    };

    await expect(runCliApplication(["unknown"], dependencies)).resolves.toBe(1);
    expect(output.join("\n")).toContain("login [--device]");
    expect(output.join("\n")).toContain("chat [--model");
  });
});
