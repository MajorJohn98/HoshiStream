import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  downloadPinned,
  npmCommand,
  regularFiles,
  run,
  sha256,
  writeChecksum,
} from "./windows-build-tools.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const runtimeScripts = [
  "native-server.mjs",
  "native-runtime.mjs",
  "native-control.mjs",
  "private-files.mjs",
  "bootstrap.mjs",
  "lan-ip.mjs",
  "register-browser-bridge.mjs",
  "start-native.ps1",
  "stop-native.ps1",
  "install-login-task.ps1",
  "uninstall-login-task.ps1",
];
export const requiredPayloadFiles = [
  "HoshiStream.exe",
  "HoshiStream.dll",
  "HoshiStream.runtimeconfig.json",
  "coreclr.dll",
  "hostfxr.dll",
  "System.Windows.Forms.dll",
  "native-host/HoshiStream.NativeHost.exe",
  "native-host/HoshiStream.NativeHost.dll",
  "native-host/HoshiStream.NativeHost.runtimeconfig.json",
  "native-host/coreclr.dll",
  "native-host/hostfxr.dll",
  "bin/node.exe",
  "addon/dist/index.js",
  "addon/dist/browser/host.js",
  "addon/assets/chrome-extension/manifest.json",
  "addon/package.json",
  "addon/package-lock.json",
  "addon/node_modules/zod/package.json",
  "vendor/torrserver/win32-x64/TorrServer.exe",
  "vendor/mpv/win32-x64/mpv.exe",
  "vendor/mpv/win32-x64/d3dcompiler_43.dll",
  "vendor/mpv/win32-x64/mpv/fonts.conf",
  "vendor/mpv/win32-x64/licenses/LICENSE.GPL",
  "vendor/ffmpeg/win32-x64/ffmpeg.exe",
  "vendor/ffmpeg/win32-x64/ffprobe.exe",
  "packaging/torrserver-settings.json",
  "packaging/windows-maintenance.mjs",
  "README.txt",
  "third-party/NOTICE.txt",
  "third-party/node-LICENSE.txt",
  "third-party/torrserver-LICENSE.txt",
  "third-party/dotnet/LICENSE.TXT",
  "third-party/dotnet/THIRD-PARTY-NOTICES.TXT",
  "third-party/windowsdesktop/LICENSE",
  ...runtimeScripts.map((script) => `scripts/${script}`),
];

export function assertSafePayloadPath(path) {
  const parts = path.toLowerCase().split("/");
  if (
    parts.some(
      (part) =>
        part === ".env" ||
        part.startsWith(".env.") ||
        [".git", ".ds_store"].includes(part),
    ) ||
    ["logs", "cache", "state", "media", "library", "uploads", "run"].includes(
      parts[0],
    ) ||
    /(^|\/)(runtime\.lock|native-control\.json|library\.json|host-config\.json|token)(\/|$)/i.test(
      path,
    )
  )
    throw new Error(
      `Private/developer data is forbidden in the payload: ${path}`,
    );
}

export async function validatePayload(bundle) {
  const { dotnetRuntime } = JSON.parse(
    await readFile(join(root, "packaging/windows-toolchain-lock.json"), "utf8"),
  );
  for (const file of requiredPayloadFiles) await access(join(bundle, file));
  for (const file of [
    "HoshiStream.runtimeconfig.json",
    "native-host/HoshiStream.NativeHost.runtimeconfig.json",
  ]) {
    const runtime = JSON.parse(
      await readFile(join(bundle, file), "utf8"),
    ).runtimeOptions;
    if (
      !Array.isArray(runtime?.includedFrameworks) ||
      !runtime.includedFrameworks.length ||
      runtime.framework ||
      runtime.frameworks
    )
      throw new Error(`Framework-dependent publish is forbidden: ${file}`);
    const expected = file.startsWith("native-host/")
      ? ["Microsoft.NETCore.App"]
      : ["Microsoft.NETCore.App", "Microsoft.WindowsDesktop.App"];
    if (
      runtime.includedFrameworks.length !== expected.length ||
      expected.some(
        (name) =>
          !runtime.includedFrameworks.some(
            (framework) =>
              framework.name === name && framework.version === dotnetRuntime,
          ),
      )
    )
      throw new Error(
        `Published runtime must match the serviced .NET ${dotnetRuntime} pin: ${file}`,
      );
  }
  const files = await regularFiles(bundle);
  for (const file of files) assertSafePayloadPath(file);
  for (const name of ["typescript", "vitest", "eslint", "prettier"]) {
    if (files.includes(`addon/node_modules/${name}/package.json`))
      throw new Error(`Development dependency leaked into payload: ${name}`);
  }
  return files;
}

export async function validateRedistribution(
  directory,
  locksRoot = join(root, "packaging"),
) {
  let manifest;
  try {
    manifest = JSON.parse(
      await readFile(join(directory, "manifest.json"), "utf8"),
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new Error(
      "Release blocked: reviewed vendor/windows-redistribution/manifest.json is missing. See packaging/windows-third-party.txt. Use --stage-only for local validation, not sharing.",
    );
  }
  if (
    manifest.version !== 1 ||
    typeof manifest.reviewedBy !== "string" ||
    !manifest.reviewedBy.trim()
  )
    throw new Error("Redistribution review is missing");
  for (const [name, lock] of Object.entries({
    node: "node-lock.json",
    dotnet: "windows-toolchain-lock.json",
    torrserver: "torrserver-lock.json",
    mpv: "mpv-lock.json",
    ffmpeg: "ffmpeg-lock.json",
  })) {
    const component = manifest.components?.[name];
    if (
      !component ||
      component.pinSha256 !== sha256(await readFile(join(locksRoot, lock))) ||
      !Array.isArray(component.files) ||
      !component.files.length ||
      (["torrserver", "mpv", "ffmpeg"].includes(name) &&
        component.completeCorrespondingSource !== true)
    )
      throw new Error(`Incomplete or stale redistribution review: ${name}`);
    for (const file of component.files) {
      if (
        typeof file.path !== "string" ||
        !file.path ||
        file.path.startsWith("/") ||
        file.path.includes("\\") ||
        file.path.includes(":") ||
        file.path.split("/").some((part) => part === ".." || part === "")
      )
        throw new Error(`Unsafe redistribution path: ${name}`);
      const bytes = await readFile(join(directory, file.path));
      if (!bytes.length || file.sha256 !== sha256(bytes))
        throw new Error(`Redistribution checksum mismatch: ${name}`);
    }
  }
  await regularFiles(directory);
}

async function verifyMpv() {
  const directory = join(root, "vendor/mpv/win32-x64");
  const lock = JSON.parse(
    await readFile(join(root, "packaging/mpv-lock.json"), "utf8"),
  );
  const receipt = JSON.parse(
    await readFile(join(directory, "asset-receipt.json"), "utf8"),
  );
  if (
    receipt.archiveSha256 !== lock["win32-x64"].sha256 ||
    !receipt.files?.["mpv.exe"]
  )
    throw new Error(
      "mpv receipt does not match the pinned archive; run fetch-mpv.mjs",
    );
  const actual = (await regularFiles(directory)).filter(
    (path) => path !== "asset-receipt.json",
  );
  if (actual.join("\n") !== Object.keys(receipt.files).sort().join("\n"))
    throw new Error(
      "mpv vendor tree has unexpected or missing files; run fetch-mpv.mjs",
    );
  for (const [file, digest] of Object.entries(receipt.files))
    if (sha256(await readFile(join(directory, file))) !== digest)
      throw new Error(`mpv vendor file changed: ${file}`);
}

async function compiler(toolchain) {
  if (process.platform !== "win32")
    throw new Error(
      "Inno Setup requires Windows; use build-windows-zip.mjs or --stage-only on macOS.",
    );
  const directory = join(
    root,
    "build/windows-tools",
    `inno-${toolchain.innoSetup.version}`,
  );
  const executable = join(directory, "ISCC.exe");
  // Always use our checksum-verified tool installer, never an unknown global ISCC.
  await mkdir(directory, { recursive: true });
  const download = join(directory, toolchain.innoSetup.name);
  await writeFile(download, await downloadPinned(toolchain.innoSetup));
  await run(
    download,
    [
      "/VERYSILENT",
      "/SUPPRESSMSGBOXES",
      "/NORESTART",
      "/SP-",
      "/CURRENTUSER",
      `/DIR=${directory}`,
    ],
    root,
  );
  await access(executable);
  return executable;
}

export async function buildWindowsApp({
  installer = true,
  stageOnly = false,
  validationInstaller = false,
} = {}) {
  const toolchain = JSON.parse(
    await readFile(join(root, "packaging/windows-toolchain-lock.json"), "utf8"),
  );
  if (installer && !stageOnly && process.platform !== "win32")
    throw new Error(
      "Installer compilation requires Windows. Use --stage-only or build-windows-zip.mjs.",
    );
  if (validationInstaller && (!stageOnly || process.platform !== "win32"))
    throw new Error("--validate-installer requires --stage-only on Windows");
  for (const file of [
    "vendor/node/win32-x64/node.exe",
    "vendor/torrserver/win32-x64/TorrServer.exe",
    "vendor/mpv/win32-x64/mpv.exe",
    "vendor/ffmpeg/win32-x64/ffmpeg.exe",
    "vendor/ffmpeg/win32-x64/ffprobe.exe",
    ...runtimeScripts.map((script) => `scripts/${script}`),
  ]) {
    try {
      await access(join(root, file));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      throw new Error(
        `Required payload file missing: ${file}. Fetch all win32-x64 runtimes before building; no PATH fallback is packaged.`,
      );
    }
  }
  await verifyMpv();
  const redistribution = join(root, "vendor/windows-redistribution");
  if (!stageOnly) await validateRedistribution(redistribution);
  const [npm, npmArgs] = await npmCommand();
  const { version } = JSON.parse(
    await readFile(join(root, "addon/package.json"), "utf8"),
  );
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error("Installer requires a numeric three-part package version");
  const stage = join(root, "build/windows-stage");
  const bundle = join(stage, "HoshiStream");
  await mkdir(join(root, "build"), { recursive: true });
  const working = await mkdtemp(join(root, "build/windows-build-"));
  try {
    await writeFile(
      join(working, "global.json"),
      JSON.stringify({
        sdk: { version: toolchain.dotnetSdk, rollForward: "disable" },
      }),
    );
    if (
      (
        await run("dotnet", ["--version"], working, { capture: true })
      ).trim() !== toolchain.dotnetSdk
    )
      throw new Error(
        `Build requires the pinned .NET SDK ${toolchain.dotnetSdk}`,
      );
    await run(
      npm,
      [
        ...npmArgs,
        "run",
        "build",
        "--",
        "--outDir",
        join(working, "addon-dist"),
      ],
      join(root, "addon"),
    );
    for (const [name, output] of [
      ["HoshiStream.Windows", "tray"],
      ["HoshiStream.NativeHost", "native-host"],
    ])
      await run(
        "dotnet",
        [
          "publish",
          join(root, "supervisor/windows", name, `${name}.csproj`),
          "-c",
          "Release",
          "-r",
          "win-x64",
          "--self-contained",
          "true",
          "-p:EnableWindowsTargeting=true",
          "-p:PublishTrimmed=false",
          "-p:PublishSingleFile=false",
          `-p:RuntimeFrameworkVersion=${toolchain.dotnetRuntime}`,
          `-p:AppHostRuntimeFrameworkVersion=${toolchain.dotnetRuntime}`,
          "-p:DebugType=None",
          "-p:DebugSymbols=false",
          `-p:RestorePackagesPath=${join(root, "build/windows-nuget")}`,
          `-p:Version=${version}`,
          "--artifacts-path",
          join(working, "dotnet"),
          "-o",
          join(working, output),
        ],
        working,
      );
    await rm(stage, { recursive: true, force: true });
    await mkdir(bundle, { recursive: true });
    await cp(join(working, "tray"), bundle, { recursive: true });
    await cp(join(working, "native-host"), join(bundle, "native-host"), {
      recursive: true,
    });
    for (const directory of [
      "bin",
      "scripts",
      "packaging",
      "addon",
      "third-party",
    ])
      await mkdir(join(bundle, directory), { recursive: true });
    await cp(
      join(root, "vendor/node/win32-x64/node.exe"),
      join(bundle, "bin/node.exe"),
    );
    for (const directory of ["torrserver", "mpv", "ffmpeg"])
      await cp(
        join(root, "vendor", directory, "win32-x64"),
        join(bundle, "vendor", directory, "win32-x64"),
        { recursive: true },
      );
    for (const script of runtimeScripts)
      await cp(join(root, "scripts", script), join(bundle, "scripts", script));
    if (stageOnly)
      await cp(
        join(root, "scripts/smoke-native.mjs"),
        join(bundle, "scripts/smoke-native.mjs"),
      );
    for (const file of [
      "torrserver-settings.json",
      "windows-maintenance.mjs",
      "node-lock.json",
      "torrserver-lock.json",
      "ffmpeg-lock.json",
      "mpv-lock.json",
      "windows-toolchain-lock.json",
    ])
      await cp(join(root, "packaging", file), join(bundle, "packaging", file));
    await cp(join(working, "addon-dist"), join(bundle, "addon/dist"), {
      recursive: true,
    });
    for (const name of ["assets", "package.json", "package-lock.json"])
      await cp(join(root, "addon", name), join(bundle, "addon", name), {
        recursive: true,
      });
    const dependencies = join(working, "dependencies");
    await mkdir(dependencies);
    for (const file of ["package.json", "package-lock.json"])
      await cp(join(root, "addon", file), join(dependencies, file));
    await run(
      npm,
      [
        ...npmArgs,
        "ci",
        "--cache",
        join(root, "build/windows-npm"),
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ],
      dependencies,
    );
    // npm's .bin links are developer conveniences; the runtime imports modules directly.
    await rm(join(dependencies, "node_modules/.bin"), {
      recursive: true,
      force: true,
    });
    await cp(
      join(dependencies, "node_modules"),
      join(bundle, "addon/node_modules"),
      { recursive: true },
    );
    await cp(
      join(root, "packaging/windows-readme.txt"),
      join(bundle, "README.txt"),
    );
    await cp(
      join(root, "packaging/windows-third-party.txt"),
      join(bundle, "third-party/NOTICE.txt"),
    );
    for (const notice of toolchain.notices) {
      const componentLock = JSON.parse(
        await readFile(
          join(root, "packaging", `${notice.component}-lock.json`),
          "utf8",
        ),
      );
      if (componentLock.version !== notice.version)
        throw new Error(`Outdated ${notice.component} license pin`);
      await writeFile(
        join(bundle, "third-party", notice.name),
        await downloadPinned(notice),
      );
    }
    const frameworks = JSON.parse(
      await readFile(join(bundle, "HoshiStream.runtimeconfig.json"), "utf8"),
    ).runtimeOptions.includedFrameworks;
    for (const [framework, folder, names] of [
      [
        "Microsoft.NETCore.App",
        "dotnet",
        ["LICENSE.TXT", "THIRD-PARTY-NOTICES.TXT"],
      ],
      ["Microsoft.WindowsDesktop.App", "windowsdesktop", ["LICENSE"]],
    ]) {
      const version = frameworks.find(
        (entry) => entry.name === framework,
      )?.version;
      if (!version || !/^\d+\.\d+\.\d+$/.test(version))
        throw new Error(`Missing published runtime: ${framework}`);
      await mkdir(join(bundle, "third-party", folder));
      for (const name of names)
        await cp(
          join(
            root,
            "build/windows-nuget",
            `${framework.toLowerCase()}.runtime.win-x64`,
            version,
            name,
          ),
          join(bundle, "third-party", folder, name),
        );
    }
    if (!stageOnly)
      await cp(redistribution, join(bundle, "third-party/redistribution"), {
        recursive: true,
      });
    const files = await validatePayload(bundle);
    const digests = {};
    for (const file of files)
      digests[file] = sha256(await readFile(join(bundle, file)));
    await writeFile(
      join(bundle, "payload-manifest.json"),
      JSON.stringify(
        {
          version,
          target: "win-x64",
          redistributionReviewed: !stageOnly,
          files: digests,
        },
        null,
        2,
      ) + "\n",
    );
    if (stageOnly) {
      if (validationInstaller) {
        const output = join(root, "build/windows-validation");
        await mkdir(output, { recursive: true });
        await run(
          await compiler(toolchain),
          [
            `/DAppVersion=${version}`,
            `/DPayloadDir=${bundle}`,
            `/DOutputDir=${output}`,
            join(root, "packaging/windows-installer.iss"),
          ],
          root,
        );
      }
      console.log(`Validation staging only (not for distribution): ${bundle}`);
      return { bundle, version };
    }
    const zip = join(root, "build", `HoshiStream-${version}-win-x64.zip`);
    await rm(zip, { force: true });
    await run("tar", ["-C", stage, "-a", "-cf", zip, "HoshiStream"], root);
    await writeChecksum(zip);
    const companion = join(
      root,
      "build",
      `HoshiStream-Chrome-Companion-${version}.zip`,
    );
    await rm(companion, { force: true });
    await run(
      "tar",
      [
        "-C",
        join(bundle, "addon/assets/chrome-extension"),
        "-a",
        "-cf",
        companion,
        ".",
      ],
      root,
    );
    await writeChecksum(companion);
    if (installer) {
      await run(
        await compiler(toolchain),
        [
          `/DAppVersion=${version}`,
          `/DPayloadDir=${bundle}`,
          `/DOutputDir=${join(root, "build")}`,
          join(root, "packaging/windows-installer.iss"),
        ],
        root,
      );
      await writeChecksum(
        join(root, "build", `HoshiStream-${version}-win-x64-setup.exe`),
      );
    }
    console.log(
      `Built reviewed Windows ${version} payload and archives in build/`,
    );
    return { bundle, version, zip };
  } finally {
    await rm(working, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await buildWindowsApp({
    stageOnly: process.argv.includes("--stage-only"),
    validationInstaller: process.argv.includes("--validate-installer"),
  });
