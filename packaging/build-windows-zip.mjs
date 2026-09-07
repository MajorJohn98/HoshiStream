// Compatibility entry point: the ZIP is the full self-contained desktop app.
import { buildWindowsApp } from "./build-windows-app.mjs";

await buildWindowsApp({
  installer: false,
  stageOnly: process.argv.includes("--stage-only"),
});
