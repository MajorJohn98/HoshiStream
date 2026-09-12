import { createServer, type Server } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Library } from "../src/library.ts";
import { NativePicker } from "../src/native-picker.ts";
import { createHandler } from "../src/routes.ts";
import type { AddonInterface } from "../src/server-types.ts";
import type { SubtitleService } from "../src/subtitle-service.ts";
import type { TorrServerClient } from "../src/torrserver-client.ts";

const TOKEN = "subtitle-route-token";
const HASH = "c".repeat(40);

const addon: AddonInterface = {
  manifest: { id: "test", name: "Test" } as AddonInterface["manifest"],
  get: async (resource, type) => ({ resource, type }),
};

const torrServer = {
  health: async () => "1.0",
  list: async () => [],
} as unknown as TorrServerClient;

let server: Server;
let baseUrl: string;
let library: Library;
let entryId: string;
let listCalls: unknown[][];
let fetchCalls: unknown[][];
let fetchResult: () => Promise<
  { body: Buffer; contentType: string } | undefined
>;

beforeEach(async () => {
  const directory = await mkdtemp(join(tmpdir(), "hoshistream-subs-routes-"));
  const libraryPath = join(directory, "library.json");
  await writeFile(libraryPath, "[]\n");
  library = new Library(libraryPath);
  entryId = (
    await library.create({
      type: "movie",
      name: "Route test",
      magnetUri: `magnet:?xt=urn:btih:${HASH}`,
    })
  ).id;
  listCalls = [];
  fetchCalls = [];
  fetchResult = async () => ({
    body: Buffer.from("WEBVTT\n\n", "utf8"),
    contentType: "text/vtt; charset=utf-8",
  });
  const subtitles = {
    list: async (...args: unknown[]) => {
      listCalls.push(args);
      return {
        subtitles: [
          {
            id: `${HASH}:2`,
            url: `${args[2]}/subtitles/${TOKEN}/${encodeURIComponent(String(args[1]))}/${HASH}:2.vtt`,
            lang: "eng",
            label: "English",
          },
        ],
      };
    },
    fetch: async (...args: unknown[]) => {
      fetchCalls.push(args);
      return fetchResult();
    },
  } as unknown as SubtitleService;
  server = createServer(
    createHandler({
      library,
      addon,
      torrServer,
      accessToken: TOKEN,
      homeSpeedMbps: 100,
      nativePicker: new NativePicker(join(directory, "missing.sock")),
      publicUrls: {
        addonUrl: "http://addon.test",
        torrServerUrl: "http://torrserver.test",
      },
      lanRedirect: "off",
      subtitles,
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("subtitles protocol resource", () => {
  it("answers under the tokenized prefix with URLs on the requested origin", async () => {
    const response = await fetch(
      `${baseUrl}/addon/${TOKEN}/subtitles/movie/${encodeURIComponent(entryId)}.json`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = (await response.json()) as {
      subtitles: { url: string; lang: string }[];
    };
    expect(body.subtitles[0]?.lang).toBe("eng");
    // The reached origin, not the configured http://addon.test, is handed on.
    expect(body.subtitles[0]?.url.startsWith(`${baseUrl}/`)).toBe(true);
    expect(listCalls).toEqual([["movie", entryId, baseUrl, TOKEN]]);
  });

  it("ignores Stremio's extra segment and rejects the wrong token", async () => {
    const withExtra = await fetch(
      `${baseUrl}/addon/${TOKEN}/subtitles/series/${encodeURIComponent(`${entryId}:1:2`)}/videoHash=abc.json`,
    );
    expect(withExtra.status).toBe(200);
    expect(listCalls[0]?.[1]).toBe(`${entryId}:1:2`);
    expect(
      (
        await fetch(
          `${baseUrl}/addon/wrong/subtitles/movie/${encodeURIComponent(entryId)}.json`,
        )
      ).status,
    ).toBe(404);
  });
});

describe("subtitle file route", () => {
  const path = () =>
    `/subtitles/${TOKEN}/${encodeURIComponent(entryId)}/${HASH}:2.vtt`;

  it("serves the sidecar with subtitle headers and CORS", async () => {
    const response = await fetch(`${baseUrl}${path()}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/vtt; charset=utf-8",
    );
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("cache-control")).toBe("max-age=3600");
    expect(await response.text()).toBe("WEBVTT\n\n");
    expect(fetchCalls).toEqual([[entryId, `${HASH}:2`, "vtt"]]);
    const head = await fetch(`${baseUrl}${path()}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("8");
  });

  it("accepts local keys and the raw ASS/SSA extensions", async () => {
    const localKey = `l:${Buffer.from("Subs/Movie.en.srt").toString("base64url")}`;
    const response = await fetch(
      `${baseUrl}/subtitles/${TOKEN}/${encodeURIComponent(entryId)}/${localKey}.ass`,
    );
    expect(response.status).toBe(200);
    expect(fetchCalls).toEqual([[entryId, localKey, "ass"]]);
  });

  it("answers 404 for unknown files, entries, tokens, and shapes", async () => {
    fetchResult = async () => undefined;
    expect((await fetch(`${baseUrl}${path()}`)).status).toBe(404);
    expect(
      (
        await fetch(
          `${baseUrl}/subtitles/${TOKEN}/hoshi%3Amissing/${HASH}:2.vtt`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(
          `${baseUrl}/subtitles/wrong/${encodeURIComponent(entryId)}/${HASH}:2.vtt`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(
          `${baseUrl}/subtitles/${TOKEN}/${encodeURIComponent(entryId)}/${HASH}:2.srt`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(
          `${baseUrl}/subtitles/${TOKEN}/${encodeURIComponent(entryId)}/..%2F..%2Fetc.vtt`,
        )
      ).status,
    ).toBe(404);
    expect(fetchCalls).toHaveLength(1);
  });

  it("answers 502 when the sidecar cannot be read from the source", async () => {
    fetchResult = async () => {
      throw new Error("TorrServer 404");
    };
    const response = await fetch(`${baseUrl}${path()}`);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "Subtitle source unavailable",
    });
  });
});
