import { createHash, timingSafeEqual } from "node:crypto";

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function validToken(
  candidate: string | undefined,
  expected: string,
): boolean {
  return timingSafeEqual(digest(candidate ?? ""), digest(expected));
}

export function bearerToken(header: string | undefined): string | undefined {
  return /^Bearer (.+)$/i.exec(header ?? "")?.[1];
}
