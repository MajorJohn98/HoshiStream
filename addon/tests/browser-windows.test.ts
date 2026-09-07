import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hostConfigSchema,
  isManagementEntryUrl,
  nativeOpener,
  type NativeLauncher,
} from "../src/browser/client.ts";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore native packaging script
import {
  createWindowsRegistry,
  extensionIdFromKey,
  registerBrowserBridge,
  unregisterBrowserBridge,
  HOST_NAME,
} from "../../scripts/register-browser-bridge.mjs";

const extensionId = "haijooeeommbnonlnkmcihmcgjmbfjgo";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hoshi-browser-windows-"));
  roots.push(root);
  const runtimeRoot = join(root, "Hoshi Stream's & runtime");
  const stateRoot = join(root, "private state");
  const extension = JSON.parse(
    await readFile(
      new URL("../assets/chrome-extension/manifest.json", import.meta.url),
      "utf8",
    ),
  );
  for (const file of [
    "native-host/HoshiStream.NativeHost.exe",
    "HoshiStream.exe",
    "bin/node.exe",
    "addon/dist/browser/host.js",
    "addon/assets/chrome-extension/manifest.json",
  ]) {
    const path = join(runtimeRoot, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      file.endsWith("manifest.json") ? JSON.stringify(extension) : "",
    );
  }
  const values = new Map<number, string | null>([
    [32, null],
    [64, null],
  ]);
  const events: string[] = [];
  const registry = {
    read: vi.fn(async (view: number) => values.get(view) ?? null),
    write: vi.fn(
      async (view: number, path: string, expected: string | null) => {
        expect(values.get(view)).toBe(expected);
        values.set(view, path);
        events.push(`write:${view}`);
      },
    ),
    remove: vi.fn(async (view: number, expected: string) => {
      expect(values.get(view)).toBe(expected);
      values.set(view, null);
    }),
  };
  const restrictAccess = vi.fn(
    async (path: string, options?: { directory?: boolean }) => {
      events.push(`acl:${options?.directory ? "directory" : "file"}:${path}`);
    },
  );
  return {
    values,
    registry,
    events,
    restrictAccess,
    extension,
    options: {
      platform: "win32",
      runtimeRoot,
      projectRoot: stateRoot,
      stateRoot,
      registry,
      restrictAccess,
    },
  };
}

describe("Windows Chrome registration", () => {
  it("registers both current-user views only after protecting token-free files", async () => {
    const f = await fixture();
    const result = await registerBrowserBridge(f.options);
    expect(result.extensionId).toBe(extensionIdFromKey(f.extension.key));
    expect(result.launcherPath).toBe(
      join(f.options.runtimeRoot, "native-host", "HoshiStream.NativeHost.exe"),
    );
    expect(result.manifestPath).toBe(
      join(f.options.stateRoot, "browser-bridge", HOST_NAME + ".json"),
    );
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    expect(manifest).toMatchObject({
      name: HOST_NAME,
      type: "stdio",
      path: result.launcherPath,
      allowed_origins: [`chrome-extension://${result.extensionId}/`],
    });
    const config = JSON.parse(await readFile(result.configPath, "utf8"));
    expect(config).toEqual({
      version: 2,
      platform: "win32",
      extensionId: result.extensionId,
      projectRoot: f.options.projectRoot,
      appPath: join(f.options.runtimeRoot, "HoshiStream.exe"),
    });
    expect(JSON.stringify({ config, manifest })).not.toMatch(
      /ACCESS_TOKEN|magnet:|Bearer /,
    );
    expect([...f.values.values()]).toEqual([
      result.manifestPath,
      result.manifestPath,
    ]);
    expect(f.events.at(-2)).toBe("write:32");
    expect(f.events.at(-1)).toBe("write:64");
    expect(f.restrictAccess).toHaveBeenCalledWith(result.configPath);
    expect(f.restrictAccess).toHaveBeenCalledWith(result.manifestPath);
    expect(f.events.filter((event) => event.includes(".tmp"))).toHaveLength(2);
    await registerBrowserBridge(f.options);
    expect([...f.values.values()]).toEqual([
      result.manifestPath,
      result.manifestPath,
    ]);
  });

  it("does not register source mode without all installed executables", async () => {
    const f = await fixture();
    await rm(
      join(f.options.runtimeRoot, "native-host", "HoshiStream.NativeHost.exe"),
    );
    await expect(registerBrowserBridge(f.options)).rejects.toThrow(
      /Install the Windows desktop build/,
    );
    expect(f.registry.write).not.toHaveBeenCalled();
    expect(f.restrictAccess).not.toHaveBeenCalled();
  });

  it("does not cold-start a different library for split source and desktop state", async () => {
    const f = await fixture();
    await expect(
      registerBrowserBridge({
        ...f.options,
        projectRoot: f.options.runtimeRoot,
      }),
    ).rejects.toMatchObject({ code: "browser_bridge_unavailable" });
    expect(f.registry.write).not.toHaveBeenCalled();
  });

  it("handles Windows sharing the current-user key between registry views", async () => {
    const f = await fixture();
    f.registry.write.mockImplementation(async (_view, path) => {
      f.values.set(32, path);
      f.values.set(64, path);
    });
    f.registry.remove.mockImplementation(async () => {
      f.values.set(32, null);
      f.values.set(64, null);
    });
    const result = await registerBrowserBridge(f.options);
    expect(f.registry.write).toHaveBeenCalledTimes(1);
    expect([...f.values.values()]).toEqual([
      result.manifestPath,
      result.manifestPath,
    ]);
    expect(await unregisterBrowserBridge(f.options)).toEqual({ removed: true });
    expect(f.registry.remove).toHaveBeenCalledTimes(1);
  });

  it("does not override the manifest's stable extension identity", async () => {
    const f = await fixture();
    await expect(
      registerBrowserBridge({ ...f.options, extensionId: "a".repeat(32) }),
    ).rejects.toThrow(/extension ID/);
    expect(f.registry.write).not.toHaveBeenCalled();
  });

  it("does not overwrite another installation in either registry view", async () => {
    const f = await fixture();
    f.values.set(64, "C:\\Other\\manifest.json");
    await expect(registerBrowserBridge(f.options)).rejects.toThrow(
      /another installation/,
    );
    expect(f.registry.write).not.toHaveBeenCalled();
    expect(f.restrictAccess).not.toHaveBeenCalled();
  });

  it("does not replace a same-name manifest pointing to another executable", async () => {
    const f = await fixture();
    const directory = join(f.options.stateRoot, "browser-bridge");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, HOST_NAME + ".json"),
      JSON.stringify({
        name: HOST_NAME,
        path: "C:\\Other\\native-host.exe",
      }),
    );
    await expect(registerBrowserBridge(f.options)).rejects.toThrow(
      /another installation/,
    );
    expect(f.registry.write).not.toHaveBeenCalled();
  });

  it("fails closed when NTFS protection cannot be applied", async () => {
    const f = await fixture();
    f.restrictAccess.mockRejectedValue(new Error("ACL failed"));
    await expect(registerBrowserBridge(f.options)).rejects.toThrow(
      "ACL failed",
    );
    expect(f.registry.write).not.toHaveBeenCalled();
  });

  it("restores an already changed view when registration of the other fails", async () => {
    const f = await fixture();
    f.registry.write.mockImplementation(async (view, path, expected) => {
      expect(f.values.get(view)).toBe(expected);
      if (view === 64) throw new Error("Registry denied");
      f.values.set(view, path);
    });
    await expect(registerBrowserBridge(f.options)).rejects.toThrow(
      "Registry denied",
    );
    expect([...f.values.values()]).toEqual([null, null]);
    expect(f.registry.remove).toHaveBeenCalledWith(
      32,
      join(f.options.stateRoot, "browser-bridge", HOST_NAME + ".json"),
    );
  });

  it("unregisters only matching default values and preserves configuration and other installs", async () => {
    const f = await fixture();
    const result = await registerBrowserBridge(f.options);
    f.values.set(64, "C:\\Other\\manifest.json");
    expect(await unregisterBrowserBridge(f.options)).toEqual({ removed: true });
    expect(f.values.get(32)).toBeNull();
    expect(f.values.get(64)).toBe("C:\\Other\\manifest.json");
    expect(f.registry.remove).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(await readFile(result.configPath, "utf8")).projectRoot,
    ).toBe(f.options.projectRoot);
    expect(await unregisterBrowserBridge(f.options)).toEqual({
      removed: false,
    });
  });

  it("makes uninstall a no-op when the manifest now belongs to another installation", async () => {
    const f = await fixture();
    const result = await registerBrowserBridge(f.options);
    const foreign = JSON.stringify({
      name: HOST_NAME,
      path: "C:\\Other Installation\\native-host\\HoshiStream.NativeHost.exe",
    });
    await writeFile(result.manifestPath, foreign);
    expect(await unregisterBrowserBridge(f.options)).toEqual({
      removed: false,
    });
    expect(f.registry.remove).not.toHaveBeenCalled();
    expect([...f.values.values()]).toEqual([
      result.manifestPath,
      result.manifestPath,
    ]);
    expect(await readFile(result.manifestPath, "utf8")).toBe(foreign);
  });

  it("preserves unverifiable manifests on uninstall without aborting removal of the app", async () => {
    const f = await fixture();
    const result = await registerBrowserBridge(f.options);
    for (const contents of [
      "null",
      "{unreadable",
      JSON.stringify({ name: "com.other.host" }),
    ]) {
      await writeFile(result.manifestPath, contents);
      expect(await unregisterBrowserBridge(f.options)).toEqual({
        removed: false,
      });
      expect(f.registry.remove).not.toHaveBeenCalled();
      expect(await readFile(result.manifestPath, "utf8")).toBe(contents);
    }
  });

  it("uses static PowerShell with explicit HKCU views and separate path arguments", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: "null\n" });
    const registry = createWindowsRegistry({ run });
    const path = "C:\\Users\\Test's & Name\\native hosts\\host.json";
    expect(await registry.read(32)).toBeNull();
    await registry.write(64, path, null);
    await registry.remove(64, path);
    expect(run.mock.calls[0][1]).toEqual(run.mock.calls[1][1]);
    const script = run.mock.calls[0][1].at(-1);
    expect(script).toContain("RegistryHive]::CurrentUser");
    expect(script).toContain("RegistryView]::Registry32");
    expect(script).toContain("RegistryView]::Registry64");
    expect(script).not.toContain(path);
    expect(script).toContain("DeleteValue('', $false)");
    expect(script).not.toContain("DeleteSubKey");
    expect(run.mock.calls[1][2]).toMatchObject({
      windowsHide: true,
      timeout: 10_000,
      env: {
        HOSHI_REG_PATH: path,
        HOSHI_REG_VIEW: "64",
        HOSHI_REG_EXPECTED_PRESENT: "false",
      },
    });
    expect(run.mock.calls[2][2].env.HOSHI_REG_EXPECTED).toBe(path);
  });

  it("does not leak runner diagnostics and rejects malformed registry values", async () => {
    const run = vi
      .fn()
      .mockRejectedValue(new Error("secret child command line"));
    await expect(createWindowsRegistry({ run }).read(32)).rejects.toThrow(
      /current-user registry/,
    );
    run.mockResolvedValue({ stdout: '{"wrong":true}' });
    await expect(createWindowsRegistry({ run }).read(32)).rejects.toThrow(
      /current-user registry/,
    );
  });
});

describe("Windows native activation", () => {
  const config = hostConfigSchema.parse({
    version: 2,
    platform: "win32",
    extensionId,
    projectRoot: "C:\\Users\\Owner\\AppData\\Local\\HoshiStream",
    appPath:
      "C:\\Users\\Owner's & Name\\Programs\\HoshiStream\\HoshiStream.exe",
  });
  const url =
    "http://127.0.0.1:7001/manage/private-test-token#/entry/hoshi%3Aone";

  it("retains an explicit configured default HTTP port", () => {
    expect(isManagementEntryUrl(url.replace(":7001/", ":80/"))).toBe(true);
  });

  it("accepts legacy macOS config and typed Windows paths", () => {
    expect(
      hostConfigSchema.safeParse({
        version: 1,
        extensionId,
        projectRoot: process.cwd(),
        appPath: "/Applications/HoshiStream.app",
      }).success,
    ).toBe(true);
    expect(config.version).toBe(2);
    for (const appPath of [
      "HoshiStream.exe",
      "C:HoshiStream.exe",
      "\\HoshiStream.exe",
      "\\\\remote\\share\\HoshiStream.exe",
      "\\\\?\\C:\\HoshiStream.exe",
      "C:\\Other.exe",
      'C:\\bad"\\HoshiStream.exe',
      "C:\\x.exe:evil\\HoshiStream.exe",
    ])
      expect(hostConfigSchema.safeParse({ ...config, appPath }).success).toBe(
        false,
      );
    expect(
      hostConfigSchema.safeParse({ ...config, accessToken: "forged" }).success,
    ).toBe(false);
  });

  it("sends library activation through the fixed shim rather than spawning the tray in Chrome's job", async () => {
    const launch = vi.fn<NativeLauncher>().mockResolvedValue();
    await nativeOpener(config, "win32", launch)(config.appPath!);
    expect(launch).toHaveBeenCalledWith(
      "C:\\Users\\Owner's & Name\\Programs\\HoshiStream\\native-host\\HoshiStream.NativeHost.exe",
      ["--activate"],
      JSON.stringify({ version: 1, command: "openLibrary" }),
    );
  });

  it("carries local entry navigation over stdin, never helper command arguments", async () => {
    const launch = vi.fn<NativeLauncher>().mockResolvedValue();
    await nativeOpener(config, "win32", launch)(url);
    expect(launch.mock.calls[0][1]).toEqual(["--activate"]);
    expect(JSON.parse(launch.mock.calls[0][2])).toEqual({
      version: 1,
      command: "openUrl",
      url,
    });
    expect(launch.mock.calls[0][1].join(" ")).not.toContain(
      "private-test-token",
    );
  });

  it("rejects arbitrary executables and noncanonical or nonlocal management URLs", async () => {
    const launch = vi.fn<NativeLauncher>();
    for (const target of [
      "C:\\Windows\\cmd.exe",
      "https://example.org/",
      "magnet:?xt=private",
      url.replace("127.0.0.1", "localhost"),
      url.replace("127.0.0.1", "127.1"),
      url.replace("127.0.0.1", "192.168.1.2"),
      url.replace("http:", "https:"),
      url.replace("127.0.0.1", "user@127.0.0.1"),
      url.replace("#/entry", "?evil=1#/entry"),
      url.replace("/manage/", "/api/"),
      url + "\n",
      url + '" --shutdown',
      url + "\\evil",
      url.replace("#/entry/hoshi%3Aone", "#/settings"),
    ]) {
      expect(isManagementEntryUrl(target)).toBe(false);
      await expect(
        nativeOpener(config, "win32", launch)(target),
      ).rejects.toMatchObject({ code: "invalid_open_target" });
    }
    expect(launch).not.toHaveBeenCalled();
  });

  it("reports a mismatched platform without invoking a launcher", async () => {
    const launch = vi.fn<NativeLauncher>();
    await expect(
      nativeOpener(config, "darwin", launch)(config.appPath!),
    ).rejects.toMatchObject({ code: "manual_start_required" });
    expect(launch).not.toHaveBeenCalled();
  });
});
