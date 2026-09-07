import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "hoshistream_docs/site");
const reviewedVersion = "0.14.0";
const publicFiles = new Set([
  "index.html",
  "styles.css",
  "site.js",
  ".nojekyll",
]);
export const guideSections = [
  ["before-you-start", "Before you start"],
  ["install-macos", "Install on macOS"],
  ["first-run", "First launch"],
  ["add-media", "Add your media"],
  ["connect-players", "Connect a player"],
  ["configuration", "Configuration reference"],
  ["storage", "Storage & external drives"],
  ["remote-access", "Network & remote access"],
  ["chrome-companion", "Chrome & magnet links"],
  ["windows-and-source", "Windows & source builds"],
  ["backups-and-updates", "Backups & updates"],
  ["troubleshooting", "Troubleshooting"],
];

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function validateGuide(html) {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  if (new Set(ids).size !== ids.length) {
    throw new Error("The documentation contains duplicate anchor IDs.");
  }
  for (const [id] of guideSections) {
    if (!ids.includes(id)) throw new Error(`Missing guide section: ${id}`);
  }
  for (const [, id] of html.matchAll(/\bhref="#([^"]+)"/g)) {
    if (!ids.includes(id))
      throw new Error(`Broken documentation anchor: ${id}`);
  }
  if (/\{\{[a-z]+\}\}/i.test(html)) {
    throw new Error("An unrendered documentation placeholder remains.");
  }
  if (
    /\b(?:src|href)="(?:file:|https?:\/\/(?:localhost|127\.0\.0\.1)[/:])/i.test(
      html,
    )
  ) {
    throw new Error("The documentation links to a private local resource.");
  }
}

export async function buildDocsSite(output = join(root, "build/docs-site")) {
  const version = JSON.parse(
    await readFile(join(root, "addon/package.json"), "utf8"),
  ).version;
  if (version !== reviewedVersion) {
    throw new Error(
      `Review the setup guide for ${version}, then update reviewedVersion.`,
    );
  }
  const template = await readFile(join(source, "template.html"), "utf8");
  const guide = await readFile(join(source, "guide.html"), "utf8");
  const navigation = guideSections
    .map(([id, title]) => `<a href="#${id}">${escapeHtml(title)}</a>`)
    .join("\n");
  const html = template
    .replace("{{navigation}}", () => navigation)
    .replace("{{version}}", () => escapeHtml(version))
    .replace("{{guide}}", () => guide);
  validateGuide(html);
  // Publish an explicit allowlist, never a copy of the repository or build/.
  await mkdir(output, { recursive: true });
  if ((await lstat(output)).isSymbolicLink()) {
    throw new Error("The documentation output must not be a symbolic link.");
  }
  for (const entry of await readdir(output, { withFileTypes: true })) {
    if (!publicFiles.has(entry.name) || !entry.isFile()) {
      throw new Error(`Unexpected documentation output: ${entry.name}`);
    }
  }
  await writeFile(join(output, "index.html"), html);
  for (const asset of ["styles.css", "site.js"]) {
    await copyFile(join(source, asset), join(output, asset));
  }
  await writeFile(join(output, ".nojekyll"), "");
  return output;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  console.log(await buildDocsSite());
}
