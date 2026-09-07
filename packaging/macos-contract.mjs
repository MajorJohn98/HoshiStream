import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyAssetReceipt } from "./asset-receipt.mjs";
import {
  assertSafePayloadPath,
  validateRedistribution,
} from "./build-windows-app.mjs";
import { verifyMacApp } from "./release-identity.mjs";
import { regularFiles, sha256, writeChecksum } from "./windows-build-tools.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = "darwin-arm64";
const runtimePrefix = "Contents/Resources/runtime/";
export const macRuntimeScripts = [
  "native-server.mjs",
  "native-runtime.mjs",
  "native-control.mjs",
  "private-files.mjs",
  "bootstrap.mjs",
  "lan-ip.mjs",
  "register-browser-bridge.mjs",
];
export const requiredMacRuntimeFiles = [
  "bin/node",
  `vendor/torrserver/${target}/TorrServer`,
  `vendor/ffmpeg/${target}/ffmpeg`,
  `vendor/ffmpeg/${target}/ffprobe`,
  "addon/dist/index.js",
  "addon/dist/browser/host.js",
  "addon/assets/manage/app.js",
  "addon/assets/manage/styles.css",
  "addon/assets/chrome-extension/manifest.json",
  "addon/package.json",
  "addon/package-lock.json",
  "addon/release.json",
  "addon/node_modules/zod/package.json",
  "packaging/node-lock.json",
  "packaging/torrserver-lock.json",
  "packaging/ffmpeg-lock.json",
  "packaging/torrserver-settings.json",
  "third-party/NOTICE.txt",
  "third-party/node-LICENSE.txt",
  "third-party/node-receipt.json",
  "third-party/ffmpeg-receipt.json",
  ...macRuntimeScripts.map((file) => `scripts/${file}`),
];
const json = async (file) => JSON.parse(await readFile(file, "utf8"));

export async function verifyMacVendor(directory = root) {
  const node = await json(join(directory, "packaging/node-lock.json"));
  const ffmpeg = (await json(join(directory, "packaging/ffmpeg-lock.json")))[
    target
  ];
  const torrserver = (
    await json(join(directory, "packaging/torrserver-lock.json"))
  )[target];
  await verifyAssetReceipt(
    join(directory, "vendor/node", target),
    { node: node[target].sha256 },
    ["node", "LICENSE"],
  );
  await verifyAssetReceipt(
    join(directory, "vendor/ffmpeg", target),
    { ffmpeg: ffmpeg.ffmpeg.sha256, ffprobe: ffmpeg.ffprobe.sha256 },
    ["ffmpeg", "ffprobe"],
  );
  if (
    sha256(
      await readFile(
        join(directory, "vendor/torrserver", target, "TorrServer"),
      ),
    ) !== torrserver.sha256
  )
    throw new Error(
      "TorrServer checksum mismatch; run packaging/fetch-torrserver.mjs.",
    );
}

export function assertPortableMachO(
  dependencies,
  loadCommands,
  minimum = "13.5",
) {
  const linked = dependencies
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean);
  if (
    !linked.length ||
    linked.some(
      (line) =>
        !line.startsWith("/usr/lib/") && !line.startsWith("/System/Library/"),
    )
  )
    throw new Error("Non-system dynamic dependency in macOS executable");
  const versions = [
    ...loadCommands.matchAll(
      /cmd LC_(?:BUILD_VERSION|VERSION_MIN_MACOSX)\s[\s\S]*?(?:minos|version)\s+(\d+(?:\.\d+){1,2})/g,
    ),
  ].map((match) => match[1]);
  const number = (version) =>
    version
      .split(".")
      .reduce((sum, part, index) => sum + Number(part) * 100 ** (2 - index), 0);
  if (
    !versions.length ||
    versions.some((version) => number(version) > number(minimum))
  )
    throw new Error(`Executable requires a newer macOS than ${minimum}`);
  const rpaths = [
    ...loadCommands.matchAll(
      /cmd LC_RPATH\s+cmdsize \d+\s+path ([^\n]+) \(offset \d+\)/g,
    ),
  ];
  if (
    rpaths.length !== [...loadCommands.matchAll(/cmd LC_RPATH\b/g)].length ||
    rpaths.some((match) => match[1] !== "/usr/lib/swift")
  )
    throw new Error(
      "Unexpected dynamic-library search path in macOS executable",
    );
}

function execute(file, args) {
  return execFileSync(file, args, {
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
    },
  });
}

export async function validateMacPayload(app) {
  const runtime = join(app, runtimePrefix);
  for (const file of requiredMacRuntimeFiles) await access(join(runtime, file));
  const files = await regularFiles(app);
  for (const file of files) {
    assertSafePayloadPath(file);
    if (!file.startsWith(runtimePrefix)) continue;
    const relative = file.slice(runtimePrefix.length);
    assertSafePayloadPath(relative);
    if (
      ![
        "bin",
        "scripts",
        "addon",
        "vendor",
        "packaging",
        "third-party",
      ].includes(relative.split("/")[0])
    )
      throw new Error(`Unexpected runtime payload: ${relative}`);
    if (
      relative.startsWith("addon/") &&
      ![
        "dist",
        "assets",
        "node_modules",
        "package.json",
        "package-lock.json",
        "release.json",
      ].includes(relative.split("/")[1])
    )
      throw new Error(`Unexpected add-on payload: ${relative}`);
    if (
      /\.(?:log|mp4|mkv|torrent)$/i.test(relative) ||
      /(?:^|\/)(?:native-data|\.env|host-config\.json|library\.json)(?:\/|$)/.test(
        relative,
      )
    )
      throw new Error(`Private data in macOS payload: ${relative}`);
  }
  for (const name of ["typescript", "vitest", "eslint", "prettier"])
    if (
      files.includes(`${runtimePrefix}addon/node_modules/${name}/package.json`)
    )
      throw new Error(`Development dependency leaked into payload: ${name}`);
  return files;
}

export async function inspectMacExecutables(app) {
  const runtime = join(app, runtimePrefix);
  const minimum = execute("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :LSMinimumSystemVersion",
    join(app, "Contents/Info.plist"),
  ]).trim();
  if (minimum !== "13.5") throw new Error("Unexpected macOS candidate minimum");
  for (const file of [
    "Contents/MacOS/HoshiStream",
    ...requiredMacRuntimeFiles.slice(0, 4).map((file) => runtimePrefix + file),
  ]) {
    const binary = join(app, file);
    await access(binary, constants.X_OK);
    execute("/usr/bin/lipo", [binary, "-verify_arch", "arm64"]);
    assertPortableMachO(
      execute("/usr/bin/otool", ["-L", binary]),
      execute("/usr/bin/otool", ["-l", binary]),
      minimum,
    );
  }
  const node = await json(join(runtime, "packaging/node-lock.json"));
  if (execute(join(runtime, "bin/node"), ["--version"]).trim() !== node.version)
    throw new Error("Bundled Node version does not match its pin");
  const ffmpeg = (await json(join(runtime, "packaging/ffmpeg-lock.json")))[
    target
  ];
  for (const tool of ["ffmpeg", "ffprobe"])
    if (
      !execute(join(runtime, `vendor/ffmpeg/${target}/${tool}`), [
        "-version",
      ]).startsWith(`${tool} version ${ffmpeg.version}-`)
    )
      throw new Error(`Bundled ${tool} version does not match its pin`);
}

export async function stampMacPayload(app) {
  const identity = verifyMacApp(app);
  const files = await validateMacPayload(app);
  await inspectMacExecutables(app);
  const digests = {};
  for (const file of files)
    digests[file] = sha256(await readFile(join(app, file)));
  await writeFile(
    `${app}.payload.json`,
    JSON.stringify(
      {
        version: 1,
        buildId: identity.buildId,
        files: digests,
      },
      null,
      2,
    ) + "\n",
  );
}

export async function verifyMacInventory(app, buildId) {
  const inventory = await json(`${app}.payload.json`);
  const files = await validateMacPayload(app);
  if (
    inventory.version !== 1 ||
    inventory.buildId !== buildId ||
    files.join("\n") !==
      Object.keys(inventory.files ?? {})
        .sort()
        .join("\n")
  )
    throw new Error(
      "Mac payload inventory is missing, stale or has unexpected files; rebuild.",
    );
  for (const file of files)
    if (inventory.files[file] !== sha256(await readFile(join(app, file))))
      throw new Error(`Mac payload checksum mismatch: ${file}; rebuild.`);
}

export async function verifyMacPayload(app) {
  const identity = verifyMacApp(app);
  await verifyMacInventory(app, identity.buildId);
  const project = execute("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :HoshiStreamProjectRoot",
    join(app, "Contents/Info.plist"),
  ]).trim();
  if (project !== "PROJECT_ROOT")
    throw new Error(
      "DMG requires a portable app; unset HOSHISTREAM_PROJECT_ROOT and rebuild.",
    );
  execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  return identity;
}

export async function validateMacRedistribution(directory, runtime) {
  return validateRedistribution(directory, runtime, {
    platform: "macos",
    locks: {
      node: "packaging/node-lock.json",
      torrserver: "packaging/torrserver-lock.json",
      ffmpeg: "packaging/ffmpeg-lock.json",
      npm: "addon/package-lock.json",
    },
    sourceRequired: ["torrserver", "ffmpeg"],
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [command, file, extra] = process.argv.slice(2);
  if (command === "vendor") await verifyMacVendor();
  else if (command === "stamp" && file) await stampMacPayload(resolve(file));
  else if (command === "verify" && file)
    process.stdout.write((await verifyMacPayload(resolve(file))).buildId);
  else if (command === "redistribution" && file && extra)
    await validateMacRedistribution(resolve(file), resolve(extra));
  else if (command === "checksum" && file) await writeChecksum(file);
  else
    throw new Error(
      "Usage: macos-contract.mjs vendor | stamp/verify/checksum <path> | redistribution <materials> <runtime>",
    );
}
