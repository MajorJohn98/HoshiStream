import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join, resolve, sep } from "node:path";
import bencode from "bencode";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnalysisSlot } from "../src/analysis-slot.ts";
import { ImportService } from "../src/imports/service.ts";
import { Library } from "../src/library.ts";
import { NativePicker } from "../src/native-picker.ts";
import { createHandler } from "../src/routes.ts";
import { StreamTests } from "../src/stream-tests.ts";
import {
  TorrServerError,
  type TorrServerClient,
} from "../src/torrserver-client.ts";

const token = "stream-test-api-fixture-token";
const HASH = "a".repeat(40);
const MAGNET = `magnet:?xt=urn:btih:${HASH}&dn=Secret.Movie&tr=http%3A%2F%2Ftracker.example%2Fannounce`;
const headers = {
  authorization: "Bearer " + token,
  "content-type": "application/json",
};

let server: Server | undefined;
let streamTests: StreamTests | undefined;
let imports: ImportService | undefined;
let root: string | undefined;

function torrentFixture() {
  const info = {
    length: 100,
    name: Buffer.from("Secret.Movie.2024.mkv"),
    "piece length": 16_384,
    pieces: Buffer.alloc(20, 1),
  };
  return {
    bytes: Buffer.from(bencode.encode({ info })),
    hash: createHash("sha1").update(bencode.encode(info)).digest("hex"),
  };
}

// Metadata never arrives, so a started test stays running until it is
// deleted, its draft is discarded or the service closes.
function fakeTorrServer() {
  const status = (hash: string) => ({
    hash,
    title: "",
    stat: 1,
    stat_string: "Torrent getting info",
    file_stats: [],
  });
  return {
    get: vi.fn(async () => {
      throw new TorrServerError("Torrent not found", "not_found", 404);
    }),
    addMagnet: vi.fn(async () => status(HASH)),
    addTorrentFile: vi.fn(async () => status(torrentFixture().hash)),
    waitForFiles: vi.fn(
      (_hash: string, _timeoutMs: number, signal?: AbortSignal) =>
        new Promise<never>((_, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new TorrServerError("Cancelled", "cancelled")),
            { once: true },
          );
        }),
    ),
    cacheState: vi.fn(async () => undefined),
    settings: vi.fn(async () => ({})),
    remove: vi.fn(async () => undefined),
    streamUrl: vi.fn(() => "http://torrserver.test/play"),
  };
}

async function fixture(options: { service?: boolean } = {}) {
  root = await mkdtemp(join(process.cwd(), ".test-stream-tests-api-"));
  const uploadRoot = join(root, "media");
  await mkdir(uploadRoot);
  const library = new Library(join(root, "library.json"));
  const torrServer = fakeTorrServer();
  imports = new ImportService({
    library,
    torrServer: {} as TorrServerClient,
    uploadRoot,
  });
  if (options.service !== false)
    streamTests = new StreamTests({
      library,
      torrServer,
      slot: new AnalysisSlot(),
      drafts: imports,
      lastStreamActivity: () => 0,
      lineSpeed: () => ({ mbps: 100, source: "configured" }),
      isManagedPath: async (path) => resolve(path).startsWith(uploadRoot + sep),
    });
  server = createServer(
    createHandler({
      library,
      torrServer: torrServer as unknown as TorrServerClient,
      imports,
      streamTests,
      addon: {
        manifest: { id: "fixture", name: "Fixture" },
        get: async () => ({}),
      },
      nativePicker: new NativePicker(join(root, "missing.sock")),
      accessToken: token,
      homeSpeedMbps: 100,
      publicUrls: {
        addonUrl: "http://localhost",
        torrServerUrl: "http://localhost",
      },
    }),
  );
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const url = `http://127.0.0.1:${address.port}/api/stream-tests`;
  const post = (body: unknown) =>
    fetch(url, {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const get = (id: string) =>
    fetch(`${url}/${encodeURIComponent(id)}`, { headers });
  const remove = (id: string) =>
    fetch(`${url}/${encodeURIComponent(id)}`, { method: "DELETE", headers });
  return {
    root,
    uploadRoot,
    url,
    torrServer,
    imports,
    post,
    get,
    remove,
  };
}

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((done) => server!.close(() => done()));
  }
  await streamTests?.close();
  await imports?.close();
  if (root) await rm(root, { recursive: true, force: true });
  server = undefined;
  streamTests = undefined;
  imports = undefined;
  root = undefined;
  vi.restoreAllMocks();
});

describe("stream test API", () => {
  it("starts, polls and deletes a magnet test without echoing the source", async () => {
    const logs = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ];
    const { post, get, remove, torrServer } = await fixture();
    const started = await post({ source: { magnetUri: MAGNET } });
    expect(started.status).toBe(202);
    expect(started.headers.get("cache-control")).toContain("no-store");
    const text = await started.text();
    expect(text).not.toContain("magnet:");
    expect(text).not.toContain("tracker.example");
    const state = JSON.parse(text) as { testId: string; phase: string };
    expect(state).toMatchObject({ mode: "basic", hash: HASH });
    expect(["queued", "metadata"]).toContain(state.phase);

    const polled = await get(state.testId);
    expect(polled.status).toBe(200);
    expect(polled.headers.get("cache-control")).toContain("no-store");
    expect(await polled.json()).toMatchObject({
      testId: state.testId,
      phase: "metadata",
    });

    const deleted = await remove(state.testId);
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe("");
    await vi.waitFor(() =>
      expect(torrServer.remove).toHaveBeenCalledWith(HASH),
    );

    const gone = await get(state.testId);
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({
      error: "The test expired or the server restarted. Test again.",
      code: "not_found",
    });
    expect((await remove(state.testId)).status).toBe(404);

    const output = logs.flatMap((spy) => spy.mock.calls.flat()).join("\n");
    expect(output).toContain("stream_test_started");
    expect(output).not.toContain(HASH);
    expect(output).not.toContain("magnet:");
    expect(output).not.toContain("Secret.Movie");
  });

  it("validates the request strictly", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { post, torrServer } = await fixture();
    const invalid: unknown[] = [
      {},
      { source: {} },
      { source: { magnetUri: "http://example.test/file.torrent" } },
      { source: { torrentFilePath: "/tmp/source.txt" } },
      { source: { draftId: "not-a-uuid" } },
      { source: { magnetUri: MAGNET, draftId: crypto.randomUUID() } },
      { source: { magnetUri: MAGNET }, mode: "forever" },
      { source: { magnetUri: MAGNET }, fileId: -1 },
      { source: { magnetUri: MAGNET }, type: "album" },
      { source: { magnetUri: MAGNET }, episodeHint: 0 },
      { source: { magnetUri: MAGNET }, extra: true },
      "{not json",
    ];
    for (const body of invalid) {
      const response = await post(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      const text = await response.text();
      expect(text).not.toContain("magnet:");
      expect(JSON.parse(text)).toEqual({ error: "Invalid request" });
    }
    expect(torrServer.addMagnet).not.toHaveBeenCalled();
  });

  it("requires the access token and answers only its own methods", async () => {
    const { url } = await fixture();
    const unauthorized = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: { magnetUri: MAGNET } }),
    });
    expect(unauthorized.status).toBe(401);
    expect((await fetch(url, { headers })).status).toBe(404);
    expect(
      (await fetch(`${url}/some-id`, { method: "POST", headers })).status,
    ).toBe(404);
  });

  it("reports when the host has no stream tests", async () => {
    const { post } = await fixture({ service: false });
    const response = await post({ source: { magnetUri: MAGNET } });
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({
      code: "stream_test_unavailable",
      error: "Stream tests are unavailable on this host.",
    });
  });

  it("only reads .torrent files from the upload root", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { post, root, uploadRoot, torrServer } = await fixture();
    const { bytes, hash } = torrentFixture();
    const outside = join(root, "outside.torrent");
    await writeFile(outside, bytes);
    for (const torrentFilePath of [
      outside,
      join(uploadRoot, "missing.torrent"),
    ]) {
      const response = await post({ source: { torrentFilePath } });
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).not.toContain(root);
      expect(JSON.parse(text)).toEqual({
        error: "Choose the .torrent file again, then test it.",
        code: "invalid_source",
      });
    }
    expect(torrServer.addTorrentFile).not.toHaveBeenCalled();

    const inside = join(uploadRoot, "batch", "source.TORRENT");
    await mkdir(join(uploadRoot, "batch"));
    await writeFile(inside, bytes);
    const started = await post({
      source: { torrentFilePath: inside },
      type: "series",
      seasonHint: 1,
      episodeHint: 2,
      mode: "extended",
    });
    expect(started.status).toBe(202);
    const text = await started.text();
    expect(text).not.toContain(root);
    expect(JSON.parse(text)).toMatchObject({ hash, mode: "extended" });
    await vi.waitFor(() =>
      expect(torrServer.addTorrentFile).toHaveBeenCalledWith(
        inside,
        undefined,
        expect.any(AbortSignal),
      ),
    );
  });

  it("tests a prepared draft and stops when the draft is discarded", async () => {
    const { post, get, imports } = await fixture();
    const draft = await imports!.prepareMagnet({ magnetUri: MAGNET });
    const started = await post({ source: { draftId: draft.draftId } });
    expect(started.status).toBe(202);
    const { testId } = (await started.json()) as { testId: string };
    await vi.waitFor(async () =>
      expect(await (await get(testId)).json()).toMatchObject({
        phase: "metadata",
      }),
    );

    await imports!.discardDraft(draft.draftId);
    await vi.waitFor(async () =>
      expect(await (await get(testId)).json()).toMatchObject({
        phase: "cancelled",
        code: "draft_discarded",
        message: "The import draft was discarded, so the test stopped.",
      }),
    );

    const expired = await post({ source: { draftId: draft.draftId } });
    expect(expired.status).toBe(410);
    expect(await expired.json()).toEqual({
      error: "This import draft expired. Prepare the source again.",
      code: "draft_expired",
    });
  });
});
