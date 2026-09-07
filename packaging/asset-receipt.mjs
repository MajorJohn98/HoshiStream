import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "./windows-build-tools.mjs";

// Call only after verifying the downloaded archive against its lockfile.
export async function writeAssetReceipt(directory, archives, files) {
  const digests = {};
  for (const file of files)
    digests[file] = sha256(await readFile(join(directory, file)));
  await writeFile(
    join(directory, "asset-receipt.json"),
    JSON.stringify({ version: 1, archives, files: digests }, null, 2) + "\n",
  );
}

export async function verifyAssetReceipt(directory, archives, files) {
  let receipt;
  try {
    receipt = JSON.parse(
      await readFile(join(directory, "asset-receipt.json"), "utf8"),
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new Error(
      `Missing runtime provenance in ${directory}; rerun its packaging/fetch-*.mjs script.`,
    );
  }
  if (
    receipt.version !== 1 ||
    Object.keys(receipt.archives ?? {})
      .sort()
      .join() !== Object.keys(archives).sort().join() ||
    Object.entries(archives).some(
      ([name, digest]) => receipt.archives[name] !== digest,
    ) ||
    Object.keys(receipt.files ?? {})
      .sort()
      .join() !== [...files].sort().join()
  )
    throw new Error(
      `Stale runtime provenance in ${directory}; fetch it again.`,
    );
  for (const file of files)
    if (receipt.files[file] !== sha256(await readFile(join(directory, file))))
      throw new Error(`Runtime checksum mismatch: ${file}; fetch it again.`);
}
