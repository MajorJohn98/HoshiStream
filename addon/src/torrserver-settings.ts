import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  TUNABLE_SETTING_KEYS,
  type TunableSettingKey,
  type TunableSettings,
} from "./torrserver-client.ts";

// Phase 10: the six TorrServer knobs the management UI exposes. Units match
// TorrServer (btserver.go at the pinned commit): rate limits in KiB/s with 0
// meaning unlimited, CacheSize in bytes, TorrentDisconnectTimeout in
// seconds, ReaderReadAHead a percentage clamped 5–100 server-side.

const nonNegativeInt = z.number().int().min(0);

export const tunablePatchSchema = z
  .object({
    UploadRateLimit: nonNegativeInt.max(10_000_000),
    DownloadRateLimit: nonNegativeInt.max(10_000_000),
    ConnectionsLimit: z.number().int().min(1).max(10_000),
    CacheSize: z
      .number()
      .int()
      .min(32 * 1024 * 1024)
      .max(1024 * 1024 * 1024 * 1024),
    ReaderReadAHead: z.number().int().min(5).max(100),
    TorrentDisconnectTimeout: z.number().int().min(1).max(86_400),
  })
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "No settings supplied",
  });

export type TunablePatch = z.infer<typeof tunablePatchSchema>;

// Shipped defaults come from the file the supervisor seeds into TorrServer's
// config directory. `addon/dist` (or `addon/src` in dev) and `packaging/`
// sit side by side in both the repo and the bundle.
export const SHIPPED_SETTINGS_URL = new URL(
  "../../packaging/torrserver-settings.json",
  import.meta.url,
);

const shippedFileSchema = z.object({
  BitTorr: z.record(z.string(), z.unknown()),
});

export function loadShippedSettings(
  source: URL | string = SHIPPED_SETTINGS_URL,
): TunableSettings {
  const parsed = shippedFileSchema.parse(
    JSON.parse(readFileSync(source, "utf8")),
  );
  const out = {} as TunableSettings;
  for (const key of TUNABLE_SETTING_KEYS) {
    const value = parsed.BitTorr[key];
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new Error(`Shipped TorrServer settings lack ${key}`);
    out[key] = value;
  }
  return out;
}

export function pickTunableSettings(
  source: Partial<Record<TunableSettingKey, number | undefined>>,
): Partial<TunableSettings> {
  const out: Partial<TunableSettings> = {};
  for (const key of TUNABLE_SETTING_KEYS) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

const MIN_SUGGESTED_UPLOAD_KIBPS = 64;

// Offered, never applied: cap upload at ~10 % of the measured download line
// while the viewer has not touched the shipped value. Mbps → KiB/s is
// ×1000²/8/1024; the result is rounded to a tidy multiple of 8.
export function suggestUploadRateLimit(
  current: Partial<TunableSettings>,
  shipped: TunableSettings,
  measured: { mbps: number; source: "measured" | "configured" } | undefined,
): { UploadRateLimit: number } | undefined {
  if (!measured || measured.source !== "measured" || measured.mbps <= 0)
    return undefined;
  if (current.UploadRateLimit !== shipped.UploadRateLimit) return undefined;
  const kibps = (measured.mbps * 1_000_000) / 8 / 1024;
  const capped = Math.max(
    MIN_SUGGESTED_UPLOAD_KIBPS,
    Math.round((kibps * 0.1) / 8) * 8,
  );
  if (capped === shipped.UploadRateLimit) return undefined;
  return { UploadRateLimit: capped };
}
