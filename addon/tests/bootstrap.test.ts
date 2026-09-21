import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  defaultMediaDir,
  defaultStateRoot,
  ensureFirstRunSetup,
  generateAccessToken,
  needsAccessToken,
  parseEnvFile,
} from "../../scripts/bootstrap.mjs";
import { windowsPowerShellEnvironment } from "../../scripts/private-files.mjs";

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

// Each setup ACL-restricts the .env twice on Windows; PowerShell 5.1 cold
// starts under parallel workers can take several seconds each.
describe("ensureFirstRunSetup", { timeout: 60_000 }, () => {
  it("does not mistake an unreadable existing environment for a fresh install", async () => {
    const projectRoot = await temporaryRoot();
    await mkdir(join(projectRoot, ".env"));
    await expect(ensureFirstRunSetup({ projectRoot })).rejects.toThrow();
    expect((await stat(join(projectRoot, ".env"))).isDirectory()).toBe(true);
  });
  it("creates .env with a generated token on a fresh machine", async () => {
    const projectRoot = join(await temporaryRoot(), "state");
    const { environment } = await ensureFirstRunSetup({
      projectRoot,
      mediaDir: "/tmp/media",
    });

    expect(needsAccessToken(environment.ACCESS_TOKEN)).toBe(false);
    expect(needsAccessToken(environment.POINTER_PUSH_SECRET)).toBe(false);
    expect(environment.POINTER_PUSH_SECRET).not.toBe(environment.ACCESS_TOKEN);
    expect(environment.MEDIA_DIR).toBe("/tmp/media");
    const written = await readFile(join(projectRoot, ".env"), "utf8");
    expect(written).toContain(`ACCESS_TOKEN=${environment.ACCESS_TOKEN}`);
  });

  it("writes .env with owner-only permissions", async () => {
    const projectRoot = await temporaryRoot();
    await ensureFirstRunSetup({ projectRoot });
    const path = join(projectRoot, ".env");
    if (process.platform === "win32") {
      const { stdout } = await promisify(execFile)(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$acl = Get-Acl -LiteralPath $env:HOSHISTREAM_TEST_PATH; $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; if (-not $acl.AreAccessRulesProtected) { throw 'Inherited ACL' }; foreach ($rule in $acl.Access) { $id = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; if ($id -ne $sid -and $id -ne 'S-1-5-18') { throw 'Unexpected ACL' } }; Write-Output 'private'",
        ],
        { env: windowsPowerShellEnvironment({ HOSHISTREAM_TEST_PATH: path }) },
      );
      expect(stdout.trim()).toBe("private");
    } else {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it("preserves an existing token and unrelated settings", async () => {
    const projectRoot = await temporaryRoot();
    const token = generateAccessToken();
    const secret = generateAccessToken();
    await writeFile(
      join(projectRoot, ".env"),
      `ACCESS_TOKEN=${token}\nMEDIA_DIR=/keep\nHOME_SPEED_MBPS=50\nPOINTER_PUSH_SECRET=${secret}\n`,
    );

    const { environment } = await ensureFirstRunSetup({ projectRoot });

    expect(environment.ACCESS_TOKEN).toBe(token);
    expect(environment.POINTER_PUSH_SECRET).toBe(secret);
    expect(environment.MEDIA_DIR).toBe("/keep");
    expect(environment.HOME_SPEED_MBPS).toBe("50");
  });

  it("appends a pointer push secret to a pre-0.11 .env", async () => {
    const projectRoot = await temporaryRoot();
    const token = generateAccessToken();
    await writeFile(
      join(projectRoot, ".env"),
      `ACCESS_TOKEN=${token}\nMEDIA_DIR=/keep\n`,
    );

    const { environment } = await ensureFirstRunSetup({ projectRoot });

    expect(environment.ACCESS_TOKEN).toBe(token);
    expect(needsAccessToken(environment.POINTER_PUSH_SECRET)).toBe(false);
    const written = await readFile(join(projectRoot, ".env"), "utf8");
    expect(written).toContain("MEDIA_DIR=/keep");
    expect(written).toContain(
      `POINTER_PUSH_SECRET=${environment.POINTER_PUSH_SECRET}`,
    );
  });

  it("does not replace a lost credential when a pointer endpoint was configured", async () => {
    const projectRoot = await temporaryRoot();
    const contents = `ACCESS_TOKEN=${generateAccessToken()}\nPOINTER_URL=https://pointer.example\n`;
    await writeFile(join(projectRoot, ".env"), contents);
    const { environment } = await ensureFirstRunSetup({ projectRoot });
    expect(environment.POINTER_PUSH_SECRET).toBeUndefined();
    expect(await readFile(join(projectRoot, ".env"), "utf8")).toBe(contents);
  });

  it("preserves a lost-credential recovery state from persisted UI setup", async () => {
    const projectRoot = await temporaryRoot();
    const pointerStateRoot = join(projectRoot, "state");
    await mkdir(pointerStateRoot);
    await writeFile(
      join(pointerStateRoot, "pointer-settings.json"),
      JSON.stringify({ enabled: true, pointerUrl: "https://pointer.example" }),
    );
    await writeFile(
      join(projectRoot, ".env"),
      `ACCESS_TOKEN=${generateAccessToken()}\nPOINTER_PUSH_SECRET=short\n`,
    );
    const { environment } = await ensureFirstRunSetup({
      projectRoot,
      pointerStateRoot,
    });
    expect(environment.POINTER_PUSH_SECRET).toBeUndefined();
    expect(await readFile(join(projectRoot, ".env"), "utf8")).toContain(
      "POINTER_PUSH_SECRET=short",
    );
  });

  it("refuses to recreate a missing environment over an existing pointer identity", async () => {
    const projectRoot = await temporaryRoot();
    const pointerStateRoot = join(projectRoot, "state");
    await mkdir(pointerStateRoot);
    await writeFile(join(pointerStateRoot, "pointer-state.json"), "{}");
    await expect(
      ensureFirstRunSetup({ projectRoot, pointerStateRoot }),
    ).rejects.toThrow("Restore the private configuration backup");
    await expect(readFile(join(projectRoot, ".env"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not rotate a missing access token for an already configured pointer", async () => {
    const projectRoot = await temporaryRoot();
    const contents = `POINTER_URL=https://pointer.example\nPOINTER_PUSH_SECRET=${generateAccessToken()}\n`;
    await writeFile(join(projectRoot, ".env"), contents);
    await expect(ensureFirstRunSetup({ projectRoot })).rejects.toThrow(
      "installation identity was not replaced",
    );
    expect(await readFile(join(projectRoot, ".env"), "utf8")).toBe(contents);
  });

  it("creates distinct recipient credentials and preserves them through upgrades", async () => {
    const roots = [await temporaryRoot(), await temporaryRoot()];
    const recipients = await Promise.all(
      roots.map((projectRoot) => ensureFirstRunSetup({ projectRoot })),
    );
    expect(recipients[0].environment.ACCESS_TOKEN).not.toBe(
      recipients[1].environment.ACCESS_TOKEN,
    );
    expect(recipients[0].environment.POINTER_PUSH_SECRET).not.toBe(
      recipients[1].environment.POINTER_PUSH_SECRET,
    );
    for (const [index, projectRoot] of roots.entries()) {
      expect(recipients[index].environment.POINTER_URL).toBeUndefined();
      const restarted = await ensureFirstRunSetup({ projectRoot });
      expect(restarted.environment).toEqual(recipients[index].environment);
    }
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
    expect(first.firstRun).toBe(true);
    expect(second.firstRun).toBe(false);
    expect(second.environment.ACCESS_TOKEN).toBe(
      first.environment.ACCESS_TOKEN,
    );
  });
});
