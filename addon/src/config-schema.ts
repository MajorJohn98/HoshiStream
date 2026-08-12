import { z } from "zod";

const httpUrl = z
  .string()
  .url()
  .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
    message: "URL must use HTTP or HTTPS",
  });
const publicUrl = httpUrl.refine(
  (value) => !["addon", "torrserver"].includes(new URL(value).hostname),
  { message: "Public URL cannot use a Docker-internal hostname" },
);

export const configSchema = z.object({
  ADDON_PORT: z.coerce.number().int().min(1).max(65535).default(7000),
  TORRSERVER_INTERNAL_URL: httpUrl,
  PUBLIC_TORRSERVER_URL: publicUrl,
  PUBLIC_ADDON_URL: publicUrl,
  ACCESS_TOKEN: z.string().min(20),
  LIBRARY_PATH: z.string().min(1).default("/data/library.json"),
  MEDIA_ROOT: z.string().min(1).default("/media"),
  UPLOAD_ROOT: z.string().min(1).default("/data/media"),
  NATIVE_PICKER_SOCKET: z.string().min(1).default("/data/run/supervisor.sock"),
  HOME_SPEED_MBPS: z.coerce.number().positive().default(10),
  LAN_REDIRECT: z.enum(["auto", "off"]).default("auto"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export function parseConfig(environment: NodeJS.ProcessEnv) {
  return configSchema.parse(environment);
}
