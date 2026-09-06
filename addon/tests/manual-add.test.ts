import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import bencode from "bencode";
import { afterEach, describe, expect, it, vi } from "vitest";

const directories: string[] = [];
const originalUploadRoot = process.env.UPLOAD_ROOT;

async function testDirectory() {
  const directory = resolve(`.test-manual-add-${randomUUID()}`);
  directories.push(directory);
  await mkdir(directory);
  return directory;
}

afterEach(async () => {
  if (originalUploadRoot === undefined) delete process.env.UPLOAD_ROOT;
  else process.env.UPLOAD_ROOT = originalUploadRoot;
  vi.restoreAllMocks();
  vi.resetModules();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function loadManualModules(uploadRoot?: string) {
  vi.resetModules();
  if (uploadRoot === undefined) delete process.env.UPLOAD_ROOT;
  else process.env.UPLOAD_ROOT = uploadRoot;
  const [{ Library }, routes, localMedia, sourceIdentity] = await Promise.all([
    import("../src/library.ts"),
    import("../src/routes/library-api.ts"),
    import("../src/local-media.ts"),
    import("../src/imports/source-identity.ts"),
  ]);
  return { Library, ...routes, ...localMedia, ...sourceIdentity };
}

async function temporaryLibrary(
  Library: new (path: string) => {
    list(): Promise<unknown[]>;
  },
) {
  const directory = await testDirectory();
  const path = join(directory, "library.json");
  await writeFile(path, "[]\n");
  return { directory, library: new Library(path) };
}

function jsonRequest(value: unknown): IncomingMessage {
  return Readable.from([Buffer.from(JSON.stringify(value))]) as IncomingMessage;
}

function binaryRequest(
  chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
): IncomingMessage {
  return Readable.from(chunks) as IncomingMessage;
}

function route(
  method: string,
  pathname: string,
  request: IncomingMessage,
  response: ServerResponse,
) {
  return {
    method,
    url: new URL(pathname, "http://localhost"),
    request,
    response,
  };
}

function responseRecorder() {
  let status = 0;
  let payload = "";
  const response = {
    writeHead: vi.fn((code: number) => {
      status = code;
      return response;
    }),
    end: vi.fn((value?: string) => {
      payload = value ?? "";
    }),
  } as unknown as ServerResponse;
  return {
    response,
    status: () => status,
    json: () => (payload ? JSON.parse(payload) : null),
  };
}

function torrentBytes(
  infoOverrides: Record<string, unknown> = {},
  rootOverrides: Record<string, unknown> = {},
) {
  return Buffer.from(
    bencode.encode({
      ...rootOverrides,
      info: {
        length: 100,
        name: Buffer.from("fixture.mp4"),
        "piece length": 16_384,
        pieces: Buffer.alloc(20, 1),
        ...infoOverrides,
      },
    }),
  );
}

function manualCreateFingerprint(input: Record<string, unknown>) {
  const fingerprintInput = { ...input };
  delete fingerprintInput.idempotencyKey;
  return createHash("sha256")
    .update(
      JSON.stringify({
        operation: "manual-create",
        input: fingerprintInput,
      }),
    )
    .digest("hex");
}

describe("manual add idempotency", () => {
  it("replays the same create request without redeeming a native grant twice", async () => {
    const { Library, handleLibraryCollection } = await loadManualModules();
    const { library } = await temporaryLibrary(Library);
    const redeem = vi.fn(() => ({
      kind: "file" as const,
      path: "/granted/movie.mp4",
    }));
    const context = {
      library,
      nativePicker: { redeem },
    };
    const input = {
      type: "movie",
      name: "Granted film",
      nativePathGrant: "opaque-grant",
      idempotencyKey: randomUUID(),
    };

    const first = responseRecorder();
    await handleLibraryCollection(
      context as never,
      route("POST", "/api/library", jsonRequest(input), first.response),
    );
    expect(first.status()).toBe(201);
    const created = first.json();
    expect(created).toMatchObject({
      type: "movie",
      localFilePath: "/granted/movie.mp4",
    });
    expect(redeem).toHaveBeenCalledTimes(1);

    const replay = responseRecorder();
    await handleLibraryCollection(
      context as never,
      route("POST", "/api/library", jsonRequest(input), replay.response),
    );
    expect(replay.status()).toBe(200);
    expect(replay.json()).toEqual(created);
    expect(redeem).toHaveBeenCalledTimes(1);
    expect(await library.list()).toHaveLength(1);
  });

  it("rejects reuse of the same create key for different input", async () => {
    const { Library, handleLibraryCollection } = await loadManualModules();
    const { library } = await temporaryLibrary(Library);
    const idempotencyKey = randomUUID();
    const context = {
      library,
      nativePicker: { redeem: vi.fn() },
    };
    const first = responseRecorder();
    await handleLibraryCollection(
      context as never,
      route(
        "POST",
        "/api/library",
        jsonRequest({
          type: "movie",
          name: "Original",
          magnetUri: "magnet:?xt=urn:btih:original",
          idempotencyKey,
        }),
        first.response,
      ),
    );

    await expect(
      handleLibraryCollection(
        context as never,
        route(
          "POST",
          "/api/library",
          jsonRequest({
            type: "movie",
            name: "Changed",
            magnetUri: "magnet:?xt=urn:btih:original",
            idempotencyKey,
          }),
          responseRecorder().response,
        ),
      ),
    ).rejects.toMatchObject({
      code: "idempotency_conflict",
      status: 409,
      message: "This retry key was already used for different details.",
    });
  });

  it("uses the documented manual create fingerprint", async () => {
    const { Library, handleLibraryCollection } = await loadManualModules();
    const { library } = await temporaryLibrary(Library);
    const input = {
      type: "movie",
      name: "Manual fingerprint",
      magnetUri: "magnet:?xt=urn:btih:fingerprint",
      idempotencyKey: randomUUID(),
    };
    const recorder = responseRecorder();
    await handleLibraryCollection(
      { library, nativePicker: { redeem: vi.fn() } } as never,
      route("POST", "/api/library", jsonRequest(input), recorder.response),
    );
    const [entry] = await library.list();
    expect(entry).toMatchObject({
      searchReceipts: [
        {
          key: input.idempotencyKey,
          fingerprint: manualCreateFingerprint(input),
        },
      ],
    });
  });

  it("rejects forged sourceCheck metadata at create and patch boundaries", async () => {
    const { Library, handleLibraryCollection, handleLibraryItem } =
      await loadManualModules();
    const { library } = await temporaryLibrary(Library);
    const context = { library, nativePicker: { redeem: vi.fn() } };
    await expect(
      handleLibraryCollection(
        context as never,
        route(
          "POST",
          "/api/library",
          jsonRequest({
            type: "movie",
            name: "Forged",
            magnetUri: "magnet:?xt=urn:btih:forged",
            sourceCheck: { phase: "complete" },
          }),
          responseRecorder().response,
        ),
      ),
    ).rejects.toThrow("server-owned");
    await expect(
      handleLibraryItem(
        context as never,
        route(
          "PATCH",
          "/api/library/hoshi%3Amissing",
          jsonRequest({
            extraSources: [
              {
                magnetUri: "magnet:?xt=urn:btih:extra",
                sourceCheck: { phase: "complete" },
              },
            ],
          }),
          responseRecorder().response,
        ),
      ),
    ).rejects.toThrow("server-owned");
  });

  it("cancels only the previous check revision after a source change patch", async () => {
    const { Library, handleLibraryItem, entrySourceDefinitionRevision } =
      await loadManualModules();
    const { library } = await temporaryLibrary(Library);
    const created = await library.create({
      type: "movie",
      name: "Patch me",
      magnetUri: "magnet:?xt=urn:btih:before",
    });
    const cancel = vi.fn();
    const recorder = responseRecorder();

    await handleLibraryItem(
      {
        library,
        nativePicker: { redeem: vi.fn() },
        sourceChecks: { cancel },
      } as never,
      route(
        "PATCH",
        `/api/library/${encodeURIComponent(created.id)}`,
        jsonRequest({ magnetUri: "magnet:?xt=urn:btih:after" }),
        recorder.response,
      ),
    );

    expect(recorder.status()).toBe(200);
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith(
      created.id,
      entrySourceDefinitionRevision(created),
    );
  });

  it("does not cancel checks for metadata-only patches", async () => {
    const { Library, handleLibraryItem } = await loadManualModules();
    const { library } = await temporaryLibrary(Library);
    const created = await library.create({
      type: "movie",
      name: "Keep source",
      magnetUri: "magnet:?xt=urn:btih:stable",
    });
    const cancel = vi.fn();

    await handleLibraryItem(
      {
        library,
        nativePicker: { redeem: vi.fn() },
        sourceChecks: { cancel },
      } as never,
      route(
        "PATCH",
        `/api/library/${encodeURIComponent(created.id)}`,
        jsonRequest({ name: "Renamed" }),
        responseRecorder().response,
      ),
    );

    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("manual upload durability", () => {
  it("returns physical uploaded paths for the batch root", async () => {
    const directory = await testDirectory();
    const uploadRoot = join(directory, "real-upload-root");
    const uploadLink = join(directory, "upload-link");
    await mkdir(uploadRoot);
    await symlink(uploadRoot, uploadLink);
    const { handleMediaFiles } = await loadManualModules(uploadLink);
    const batch = randomUUID();
    const recorder = responseRecorder();

    await handleMediaFiles(
      { nativePicker: {} } as never,
      route(
        "POST",
        `/api/upload?batch=${batch}&path=Movies/clip.mp4`,
        binaryRequest([Buffer.from("video-data")]),
        recorder.response,
      ),
    );

    expect(recorder.status()).toBe(201);
    expect(recorder.json()).toEqual({
      path: join(await realpath(uploadRoot), batch, "Movies", "clip.mp4"),
      folderRoot: join(await realpath(uploadRoot), batch),
    });
  });

  it("treats identical retries as idempotent and preserves the original file on conflict", async () => {
    const directory = await testDirectory();
    const { saveUpload } = await loadManualModules(join(directory, "uploads"));
    const batch = randomUUID();
    const path = "Movies/clip.mp4";

    const first = await saveUpload(
      binaryRequest([Buffer.from("first-pass")]),
      batch,
      path,
    );
    const replay = await saveUpload(
      binaryRequest([Buffer.from("first-pass")]),
      batch,
      path,
    );
    expect(replay).toEqual(first);
    expect(await readFile(first.path, "utf8")).toBe("first-pass");

    await expect(
      saveUpload(binaryRequest([Buffer.from("different")]), batch, path),
    ).rejects.toMatchObject({
      code: "upload_conflict",
      status: 409,
      message: "A file already exists at this path with different content.",
    });
    expect(await readFile(first.path, "utf8")).toBe("first-pass");
  });

  it("cleans interrupted temporary files", async () => {
    const directory = await testDirectory();
    const { saveUpload } = await loadManualModules(join(directory, "uploads"));
    const batch = randomUUID();
    const relativePath = "Episodes/fail.mp4";
    const destination = join(directory, "uploads", batch, relativePath);

    await expect(
      saveUpload(
        binaryRequest(
          (async function* () {
            yield Buffer.from("partial");
            throw new Error("interrupted");
          })(),
        ),
        batch,
        relativePath,
      ),
    ).rejects.toThrow("interrupted");
    await expect(readFile(destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      await readdir(dirname(destination)).catch(() => []),
    ).not.toContainEqual(expect.stringContaining(".pending"));
  });

  it("rejects symlinked parent directories without touching outside files", async () => {
    const directory = await testDirectory();
    const uploadRoot = join(directory, "uploads");
    const outside = join(directory, "outside");
    const batch = randomUUID();
    await mkdir(outside, { recursive: true });
    await mkdir(join(uploadRoot, batch), { recursive: true });
    await symlink(outside, join(uploadRoot, batch, "escape"));
    const { saveUpload } = await loadManualModules(uploadRoot);

    await expect(
      saveUpload(
        binaryRequest([Buffer.from("do-not-write")]),
        batch,
        "escape/clip.mp4",
      ),
    ).rejects.toThrow("Invalid upload path");
    await expect(readFile(join(outside, "clip.mp4"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("cancels an active check before delete removes the entry", async () => {
    const { Library, handleLibraryItem, entrySourceDefinitionRevision } =
      await loadManualModules();
    const { library } = await temporaryLibrary(Library);
    const created = await library.create({
      type: "movie",
      name: "Delete me",
      magnetUri: "magnet:?xt=urn:btih:delete",
    });
    const cancel = vi.fn(async (entryId: string) => {
      expect(entryId).toBe(created.id);
      expect(await library.get(created.id)).toBeTruthy();
    });
    const recorder = responseRecorder();

    await handleLibraryItem(
      {
        library,
        nativePicker: { redeem: vi.fn() },
        sourceChecks: { cancel },
      } as never,
      route(
        "DELETE",
        `/api/library/${encodeURIComponent(created.id)}`,
        jsonRequest({}),
        recorder.response,
      ),
    );

    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith(
      created.id,
      entrySourceDefinitionRevision(created),
    );
    expect(recorder.status()).toBe(204);
    expect(await library.get(created.id)).toBeUndefined();
  });
});

describe("manual torrent validation", () => {
  it("accepts structurally valid private torrents for manual upload", async () => {
    const directory = await testDirectory();
    const uploadRoot = join(directory, "uploads");
    const { saveTorrentUpload, torrentIdentity } =
      await loadManualModules(uploadRoot);
    const batch = randomUUID();
    const data = torrentBytes({ private: 1 });

    await expect(torrentIdentity(data)).resolves.toMatchObject({
      suggestedName: "fixture.mp4",
    });
    const path = await saveTorrentUpload(
      binaryRequest([data]),
      batch,
      "private.torrent",
    );
    expect(await readFile(path)).toEqual(data);
  });

  it("rejects malformed torrent uploads", async () => {
    const directory = await testDirectory();
    const { saveTorrentUpload } = await loadManualModules(
      join(directory, "uploads"),
    );

    await expect(
      saveTorrentUpload(
        binaryRequest([Buffer.from("not-a-torrent")]),
        randomUUID(),
        "broken.torrent",
      ),
    ).rejects.toMatchObject({
      code: "invalid_torrent",
    });
  });

  it("accepts torrented metadata with explicit web seed hints for manual upload", async () => {
    const directory = await testDirectory();
    const uploadRoot = join(directory, "uploads");
    const { saveTorrentUpload, torrentIdentity } =
      await loadManualModules(uploadRoot);
    const batch = randomUUID();
    const data = torrentBytes(
      {},
      {
        "url-list": Buffer.from("https://user:pass@example.org/fixture.mp4"),
      },
    );

    await expect(torrentIdentity(data)).resolves.toMatchObject({
      suggestedName: "fixture.mp4",
    });
    const path = await saveTorrentUpload(
      binaryRequest([data]),
      batch,
      "hinted.torrent",
    );
    expect(await readFile(path)).toEqual(data);
  });
});
