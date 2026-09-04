import { describe, expect, it } from "vitest";
import { bearerToken, validToken } from "../src/security.ts";

describe("token validation", () => {
  it("accepts only the complete shared token", () => {
    expect(validToken("correct-long-token-123", "correct-long-token-123")).toBe(
      true,
    );
    expect(validToken("wrong", "correct-long-token-123")).toBe(false);
    expect(bearerToken("Bearer correct-long-token-123")).toBe(
      "correct-long-token-123",
    );
  });
});
