import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSafePayloadPath,
  requiredPayloadFiles,
  runtimeScripts,
  validatePayload,
  validateRedistribution,
} from "../../packaging/build-windows-app.mjs";
import {
  npmCommand,
  sha256,
  validateArchiveEntries,
} from "../../packaging/windows-build-tools.mjs";
import { browserRegistrationArguments } from "../../packaging/windows-maintenance.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { dotnetRuntime } = JSON.parse(
  await readFile(join(root, "packaging/windows-toolchain-lock.json"), "utf8"),
);
const temporary: string[] = [];
afterEach(async () => {
  for (const directory of temporary.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "hoshi-packaging-"));
  temporary.push(path);
  return path;
}
async function payload() {
  const path = await directory();
  for (const file of requiredPayloadFiles) {
    await mkdir(dirname(join(path, file)), { recursive: true });
    await writeFile(join(path, file), "fixture");
  }
  for (const file of [
    "HoshiStream.runtimeconfig.json",
    "native-host/HoshiStream.NativeHost.runtimeconfig.json",
  ])
    await writeFile(
      join(path, file),
      JSON.stringify({
        runtimeOptions: {
          includedFrameworks: [
            { name: "Microsoft.NETCore.App", version: dotnetRuntime },
            ...(file.startsWith("native-host/")
              ? []
              : [
                  {
                    name: "Microsoft.WindowsDesktop.App",
                    version: dotnetRuntime,
                  },
                ]),
          ],
        },
      }),
    );
  return path;
}

describe("Windows packaging contract", () => {
  it("requires both self-contained applications and every media runtime", async () => {
    const path = await payload();
    expect(await validatePayload(path)).toContain("bin/node.exe");
    await rm(join(path, "vendor/mpv/win32-x64/mpv.exe"));
    await expect(validatePayload(path)).rejects.toThrow();
  });

  it("rejects a framework-dependent publish instead of requiring end-user .NET", async () => {
    const path = await payload();
    await writeFile(
      join(path, "HoshiStream.runtimeconfig.json"),
      JSON.stringify({
        runtimeOptions: { framework: { name: "Microsoft.NETCore.App" } },
      }),
    );
    await expect(validatePayload(path)).rejects.toThrow("Framework-dependent");
  });

  it.each(["Microsoft.NETCore.App", "Microsoft.WindowsDesktop.App"])(
    "rejects an SDK-default unserviced %s runtime",
    async (framework) => {
      const path = await payload();
      const file = join(path, "HoshiStream.runtimeconfig.json");
      const config = JSON.parse(await readFile(file, "utf8"));
      config.runtimeOptions.includedFrameworks.find(
        (entry: { name: string }) => entry.name === framework,
      ).version = "10.0.3";
      await writeFile(file, JSON.stringify(config));
      await expect(validatePayload(path)).rejects.toThrow("serviced .NET");
    },
  );

  it.each([
    ".env",
    "addon/.env.local",
    "logs/server.log",
    "cache/file",
    "media/private.mp4",
    "library.json",
    "state/settings.json",
    "scripts/.git/config",
    "run/runtime.lock",
    "host-config.json",
  ])("rejects private/developer payload path %s", (path) => {
    expect(() => assertSafePayloadPath(path)).toThrow();
  });

  it("allows runtime paths but rejects staged development dependencies", async () => {
    expect(() =>
      assertSafePayloadPath("addon/node_modules/zod/package.json"),
    ).not.toThrow();
    const path = await payload();
    await mkdir(join(path, "addon/node_modules/typescript"));
    await writeFile(
      join(path, "addon/node_modules/typescript/package.json"),
      "{}",
    );
    await expect(validatePayload(path)).rejects.toThrow(
      "Development dependency",
    );
  });

  it("stages the entire relative runtime-script import closure", async () => {
    for (const script of [...runtimeScripts, "smoke-native.mjs"]) {
      const text = await readFile(join(root, "scripts", script), "utf8");
      for (const match of text.matchAll(
        /(?:from\s+|import\s*)["']\.\/([^"']+\.mjs)["']/g,
      ))
        expect(runtimeScripts, `${script} imports ${match[1]}`).toContain(
          match[1],
        );
    }
  });

  it("keeps the smoke harness out of the release runtime contract", () => {
    expect(runtimeScripts).not.toContain("smoke-native.mjs");
  });

  it("passes the same explicit private state to browser registration and removal", () => {
    const runtimeRoot = "C:\\Program files\\HoshiStream";
    const stateRoot = "D:\\Private state\\HoshiStream";
    const args = browserRegistrationArguments(runtimeRoot, stateRoot);
    expect(args.slice(1)).toEqual([
      `--runtime-root=${runtimeRoot}`,
      `--project-root=${stateRoot}`,
      `--state-dir=${stateRoot}`,
    ]);
    expect(browserRegistrationArguments(runtimeRoot, stateRoot, true)).toEqual([
      ...args,
      "--unregister",
    ]);
  });

  it("invokes npm as JavaScript with argument arrays, not npm.cmd or a shell", async () => {
    const path = await directory();
    const cli = join(path, "npm-cli.js");
    await writeFile(cli, "");
    const [executable, args] = await npmCommand({
      npm_execpath: cli,
      PATH: "",
    });
    expect(executable).toBe(process.execPath);
    expect(args).toEqual([cli]);
  });

  it("retains the binary digest verified against the upstream mpv asset", async () => {
    const lock = JSON.parse(
      await readFile(join(root, "packaging/mpv-lock.json"), "utf8"),
    );
    expect(lock["win32-x64"].sha256).toBe(
      "418dbfb5feb851cbed33d6c05d8481ba71802621bfd6efe8974522b28d42ac97",
    );
    expect(lock["win32-x64"].url).not.toContain("/latest/");
    expect(lock["win32-x64"].name).not.toContain("x86_64-v3");
  });
});

describe("runtime archive validation", () => {
  it("accepts the full upstream executable, DLL and data tree", () => {
    expect(() =>
      validateArchiveEntries(
        "mpv.exe\nd3dcompiler_43.dll\nmpv/fonts.conf\ndoc/\n",
      ),
    ).not.toThrow();
  });
  it.each([
    "../escape",
    "/absolute",
    "C:/escape",
    "..\\escape",
    "a/../../x",
    "file:stream",
    "",
  ])("rejects unsafe archive listing %s", (listing) => {
    expect(() => validateArchiveEntries(listing)).toThrow();
  });
});

describe("redistribution gate", () => {
  it("fails explicitly when reviewed corresponding sources are missing", async () => {
    await expect(validateRedistribution(await directory())).rejects.toThrow(
      "Release blocked",
    );
  });

  it("binds every reviewed source/notice to the exact lockfile and bytes", async () => {
    const path = await directory();
    const files = await directory();
    const components: Record<string, unknown> = {};
    for (const name of ["node", "dotnet", "torrserver", "mpv", "ffmpeg"]) {
      const lock =
        name === "dotnet" ? "windows-toolchain-lock.json" : `${name}-lock.json`;
      await writeFile(join(files, lock), name);
      await writeFile(join(path, `${name}.txt`), `source fixture ${name}`);
      components[name] = {
        pinSha256: sha256(Buffer.from(name)),
        completeCorrespondingSource: true,
        files: [
          {
            path: `${name}.txt`,
            sha256: sha256(Buffer.from(`source fixture ${name}`)),
          },
        ],
      };
    }
    await writeFile(
      join(path, "manifest.json"),
      JSON.stringify({
        version: 1,
        reviewedBy: "test fixture, not a release attestation",
        components,
      }),
    );
    await expect(validateRedistribution(path, files)).resolves.toBeUndefined();
    await writeFile(join(path, "mpv.txt"), "tampered");
    await expect(validateRedistribution(path, files)).rejects.toThrow(
      "checksum mismatch",
    );
    await writeFile(join(files, "mpv-lock.json"), "updated");
    await expect(validateRedistribution(path, files)).rejects.toThrow("stale");
  });

  it("keeps the installer per-user, startup opt-in and data-preserving", async () => {
    const text = await readFile(
      join(root, "packaging/windows-installer.iss"),
      "utf8",
    );
    expect(text).toContain("PrivilegesRequired=lowest");
    expect(text).toContain(
      "DefaultDirName={localappdata}\\Programs\\HoshiStream",
    );
    expect(text).not.toMatch(/^\[UninstallDelete\]/m);
    expect(text).not.toContain("Root: HKLM");
    expect(text).not.toContain("UserChoice");
    expect(text).not.toContain("taskkill");
    expect(text).toContain("Maintenance('shutdown')");
  });

  it("registers only optional current-user magnet capabilities with ownership guards", async () => {
    const text = await readFile(
      join(
        root,
        "supervisor/windows/HoshiStream.Windows/NativeIntegrations.cs",
      ),
      "utf8",
    );
    expect(text).toContain("Registry.CurrentUser");
    expect(text).not.toContain("LocalMachine");
    expect(text).not.toContain("UserChoice");
    expect(text).toContain('WindowsCommandLine.QuoteArgument("--magnet=%1")');
    expect(text).toContain("IntegrationCommands.IsOwned");
    expect(text).toContain("OwnedClass");
    expect(text).toContain("OwnedMarker");
    const maintenance = await readFile(
      join(root, "packaging/windows-maintenance.mjs"),
      "utf8",
    );
    expect(maintenance).not.toContain("windows-integrations.ps1");
    expect(maintenance).toContain('join(root, "HoshiStream.exe")');
  });
});
