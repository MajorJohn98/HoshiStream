import { z } from "zod";

export const SUGGESTED_POINTER_URL = "https://hoshistream-pointer.vercel.app";
export const SUGGESTED_POINTER_OPERATOR = "Major John's projects";

export const pointerUrlSchema = z
  .string()
  .max(2048)
  .refine(
    (value) => {
      if (
        value !== value.trim() ||
        /[\p{Cc}\s\\?#@%]/u.test(value) ||
        !/^https?:\/\/[^/]+\/?$/i.test(value)
      )
        return false;
      try {
        const url = new URL(value);
        const loopback =
          url.hostname === "localhost" ||
          url.hostname === "[::1]" ||
          /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
        return (
          !url.username &&
          !url.password &&
          (url.protocol === "https:" || (url.protocol === "http:" && loopback))
        );
      } catch {
        return false;
      }
    },
    {
      message:
        "Enter an HTTPS origin without credentials, path, query, or fragment (HTTP is allowed only on loopback).",
    },
  )
  .transform((value) => new URL(value).origin);

export const pointerSetupSchema = z
  .strictObject({
    enabled: z.boolean(),
    pointerUrl: z.union([z.literal(""), pointerUrlSchema]).optional(),
  })
  .refine((input) => !input.enabled || Boolean(input.pointerUrl), {
    message: "An enabled pointer requires a service origin.",
    path: ["pointerUrl"],
  });

export const pointerSettingsSchema = z
  .strictObject({
    enabled: z.boolean(),
    pointerUrl: z.union([z.literal(""), pointerUrlSchema]),
  })
  .refine((input) => !input.enabled || Boolean(input.pointerUrl), {
    message: "An enabled pointer requires a service origin.",
    path: ["pointerUrl"],
  });
