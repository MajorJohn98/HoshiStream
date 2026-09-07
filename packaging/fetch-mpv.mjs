import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  downloadPinned,
  extractArchive,
  regularFiles,
  sha256,
} from "./windows-build-tools.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const lock = JSON.parse(
  await readFile(join(root, "packaging/mpv-lock.json"), "utf8"),
);
const target =
  process.env.HOSHISTREAM_TARGET ?? `${process.platform}-${process.arch}`;
const asset = lock[target];
if (!asset)
  throw new Error(
    `No pinned mpv build for ${target}; use HOSHISTREAM_TARGET=win32-x64`,
  );
const parent = join(root, "vendor/mpv");
await mkdir(parent, { recursive: true });
const temporary = await mkdtemp(join(parent, ".fetch-"));
const output = join(parent, target);
try {
  const archive = join(temporary, asset.name);
  const tree = join(temporary, "payload");
  await mkdir(tree);
  await writeFile(archive, await downloadPinned(asset));
  // Windows 11's bsdtar reads 7z as well as ZIP; no installed 7-Zip is needed.
  await extractArchive(archive, tree);
  await readFile(join(tree, "mpv.exe"));
  await mkdir(join(tree, "licenses"));
  for (const notice of lock.notices)
    await writeFile(
      join(tree, "licenses", notice.name),
      await downloadPinned(notice),
    );
  await writeFile(
    join(tree, "licenses/SOURCE-REFERENCES.txt"),
    `mpv source: ${lock.source}\nBuild recipes: ${lock.buildRecipe}\n` +
      "These links are provenance, not a complete corresponding-source distribution.\n" +
      "See the release redistribution gate in packaging/windows-third-party.txt.\n",
  );
  const files = {};
  for (const file of await regularFiles(tree))
    files[file] = sha256(await readFile(join(tree, file)));
  await writeFile(
    join(tree, "asset-receipt.json"),
    JSON.stringify({ archiveSha256: asset.sha256, files }, null, 2) + "\n",
  );
  await rm(output, { recursive: true, force: true });
  await cp(tree, output, { recursive: true });
} finally {
  await rm(temporary, { recursive: true, force: true });
}
console.log(`Installed mpv ${lock.version} for ${target}`);
