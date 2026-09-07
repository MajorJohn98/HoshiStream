import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Archiver } from "../src/archiver.ts";
import { parseConfig } from "../src/config-schema.ts";
import { startHoshiStream } from "../src/index.ts";

vi.mock("../src/config.ts", () => ({ config: undefined }));
vi.mock("../src/speedtest.ts", async (original) => ({
  ...(await original<typeof import("../src/speedtest.ts")>()),
  runSpeedTest: vi.fn().mockResolvedValue({ mbps: 10 }),
}));
afterEach(() => vi.restoreAllMocks());

it("releases its bound listener and workers when later startup fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "hoshi-startup-failure-"));
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const settings = parseConfig({
    ADDON_PORT: String(address.port),
    ACCESS_TOKEN: "test-lifecycle-token-not-for-real-use",
    TORRSERVER_INTERNAL_URL: "http://127.0.0.1:1",
    PUBLIC_TORRSERVER_URL: "http://127.0.0.1:1",
    PUBLIC_ADDON_URL: `http://127.0.0.1:${address.port}`,
    LIBRARY_PATH: join(root, "library.json"),
    ONBOARDING_PATH: join(root, "onboarding.json"),
    TAGS_PATH: join(root, "tags.json"),
    VOLUMES_PATH: join(root, "volumes.json"),
    DISK_SCHEDULE_PATH: join(root, "schedule.json"),
    DISK_CLEANUP_PATH: join(root, "cleanup.json"),
    DEVICE_NAMES_PATH: join(root, "devices.json"),
    UPLOAD_ROOT: join(root, "uploads"),
    MDNS_ENABLED: "false",
  });
  vi.spyOn(Archiver.prototype, "start").mockRejectedValueOnce(
    new Error("Startup interrupted"),
  );
  try {
    await expect(startHoshiStream(settings)).rejects.toThrow(
      "Startup interrupted",
    );
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(address.port, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
