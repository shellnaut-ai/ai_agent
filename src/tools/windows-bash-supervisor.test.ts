import { describe, expect, test } from "vitest";

import { parseWindowsBashExitStatus } from "./windows-bash-supervisor.js";

describe("parseWindowsBashExitStatus", () => {
  test.each(["", "7partial", " 7", "7\n", "-1", "4294967296"])(
    "rejects an incomplete or invalid status %j",
    (status) => {
      expect(() => parseWindowsBashExitStatus(status)).toThrow(
        "Invalid Windows Bash exit status",
      );
    },
  );

  test.each([
    ["0", 0],
    ["7", 7],
    ["4294967295", 4_294_967_295],
  ])("accepts the complete status %s", (status, expected) => {
    expect(parseWindowsBashExitStatus(status)).toBe(expected);
  });
});
