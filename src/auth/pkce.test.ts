import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createPkcePair, createOAuthState } from "./pkce.js";

describe("PKCE helpers", () => {
  it("derives an S256 base64url challenge from the verifier", () => {
    const pair = createPkcePair(() => Buffer.alloc(32, 7));
    const expected = createHash("sha256").update(pair.verifier).digest("base64url");

    expect(pair.challenge).toBe(expected);
    expect(pair.method).toBe("S256");
    expect(pair.verifier).not.toContain("=");
  });

  it("creates an independently random base64url state value", () => {
    expect(createOAuthState(() => Buffer.from([251, 255, 239]))).toBe("-__v");
  });
});
