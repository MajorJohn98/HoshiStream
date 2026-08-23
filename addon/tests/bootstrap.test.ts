import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultMediaDir,
  defaultStateRoot,
  ensureFirstRunSetup,
  generateAccessToken,
  needsAccessToken,
  parseEnvFile,
} from "../../scripts/bootstrap.mjs";

async function temporaryRoot() {
  return mkdtemp(join(tmpdir(), "hoshistream-bootstrap-"));
}

describe("parseEnvFile", () => {
  it("ignores comments and blank lines and strips quotes", () => {
    expect(
      parseEnvFile('# comment\n\nADDON_PORT=7001\nSTATE="/tmp/a b"\n'),
    ).toEqual({ ADDON_PORT: "7001", STATE: "/tmp/a b" });
  });

  it("keeps values containing an equals sign intact", () => {
    expect(parseEnvFile("ACCESS_TOKEN=abc=def").ACCESS_TOKEN).toBe("abc=def");
  });
});

describe("needsAccessToken", () => {
  it("rejects missing, short, and placeholder tokens", () => {
    expect(needsAccessToken(undefined)).toBe(true);
    expect(needsAccessToken("")).toBe(true);
    expect(needsAccessToken("short")).toBe(true);
    expect(needsAccessToken("replace-with-long-random-token")).toBe(true);
  });

  it("accepts a generated token", () => {
    expect(needsAccessToken(generateAccessToken())).toBe(false);
  });
});

describe("generateAccessToken", () => {
  it("produces distinct URL-safe tokens", () => {
    const first = generateAccessToken();
    const second = generateAccessToken();
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  });
});

describe("platform defaults", () => {
  it("uses LOCALAPPDATA on Windows and Application Support on macOS", () => {
    const windowsRoot = defaultStateRoot("win32", {
      LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local",
    });
    expect(windowsRoot).toContain("AppData");
    expect(windowsRoot).toContain("HoshiStream");
    expect(defaultStateRoot("darwin", {})).toContain(
      "Library/Application Support/HoshiStream",
    );
  });

  it("picks a per-platform media folder", () => {
    expect(defaultMediaDir("darwin")).toContain("Movies");
    expect(defaultMediaDir("win32")).toContain("Videos");
  });
});

describe("ensureFirstRunSetup", () => {
  it("creates .env with a generated token on a fresh machine", async () => {
    const projectRoot = join(await temporaryRoot(), "state");
    const { environment } = await ensureFirstRunSetup({
      projectRoot,
      mediaDir: "/tmp/media",
    });

    expect(needsAccessToken(environment.ACCESS_TOKEN)).toBe(false);
    expect(environment.MEDIA_DIR).toBe("/tmp/media");
    const written = await readFile(join(projectRoot, ".env"), "utf8");
    expect(written).toContain(`ACCESS_TOKEN=${environment.ACCESS_TOKEN}`);
  });

  it("writes .env with owner-only permissions", async () => {
    const projectRoot = await temporaryRoot();
    await ensureFirstRunSetup({ projectRoot });
    const mode = (await stat(join(projectRoot, ".env"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("preserves an existing token and unrelated settings", async () => {
    const projectRoot = await temporaryRoot();
    const token = generateAccessToken();
    await writeFile(
      join(projectRoot, ".env"),
      `ACCESS_TOKEN=${token}\nMEDIA_DIR=/keep\nHOME_SPEED_MBPS=50\n`,
    );

    const { environment } = await ensureFirstRunSetup({ projectRoot });

    expect(environment.ACCESS_TOKEN).toBe(token);
    expect(environment.MEDIA_DIR).toBe("/keep");
    expect(environment.HOME_SPEED_MBPS).toBe("50");
  });

  it("replaces a placeholder token in place, keeping other settings", async () => {
    const projectRoot = await temporaryRoot();
    await writeFile(
      join(projectRoot, ".env"),
      "ACCESS_TOKEN=replace-with-long-random-token\nMEDIA_DIR=/keep\n",
    );

    const { environment } = await ensureFirstRunSetup({ projectRoot });

    expect(needsAccessToken(environment.ACCESS_TOKEN)).toBe(false);
    expect(environment.MEDIA_DIR).toBe("/keep");
    const written = await readFile(join(projectRoot, ".env"), "utf8");
    expect(written).not.toContain("replace-with-long-random-token");
    expect(written).toContain("MEDIA_DIR=/keep");
  });

  it("appends a token when the file has none", async () => {
    const projectRoot = await temporaryRoot();
    await writeFile(join(projectRoot, ".env"), "MEDIA_DIR=/keep\n");

    const { environment } = await ensureFirstRunSetup({ projectRoot });

    expect(needsAccessToken(environment.ACCESS_TOKEN)).toBe(false);
    expect(environment.MEDIA_DIR).toBe("/keep");
  });

  it("is idempotent across repeated launches", async () => {
    const projectRoot = await temporaryRoot();
    const first = await ensureFirstRunSetup({ projectRoot });
    const second = await ensureFirstRunSetup({ projectRoot });
    expect(second.environment.ACCESS_TOKEN).toBe(
      first.environment.ACCESS_TOKEN,
    );
  });
});
