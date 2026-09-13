import { ZodError } from "zod";
import { DiskCopyError } from "../disk-copy.ts";
import {
  PickerCancelledError,
  PickerUnavailableError,
} from "../native-picker.ts";
import { PlayerError } from "../player.ts";
import { TagError } from "../tags.ts";
import { VolumeError } from "../volumes.ts";
import { ImportError } from "../imports/errors.ts";
import { TorrServerError } from "../torrserver-client.ts";
import { MediaSelectionError } from "../media-file-selection.ts";
import { MetadataError } from "../metadata-enrichment.ts";

// Domain errors whose message is safe and useful to show the caller.
const DESCRIPTIVE_CLIENT_ERRORS = [
  PickerCancelledError,
  PlayerError,
  VolumeError,
  DiskCopyError,
  TagError,
];

export function classifyError(error: unknown): {
  status: number;
  message: string;
  code?: string;
} {
  if (error instanceof ImportError)
    return { status: error.status, message: error.message, code: error.code };
  if (error instanceof TorrServerError)
    return {
      status:
        error.code === "not_found"
          ? 404
          : ["timeout", "metadata_timeout"].includes(error.code)
            ? 504
            : 503,
      message: error.message,
      code: error.code,
    };
  if (error instanceof MetadataError)
    return {
      status:
        error.code === "not-found"
          ? 404
          : error.code === "unavailable"
            ? 503
            : error.code === "invalid"
              ? 400
              : 409,
      message: error.message,
      code: `metadata-${error.code}`,
    };
  if (error instanceof MediaSelectionError)
    return { status: 422, message: error.message, code: "no_playable_file" };
  if (error instanceof PickerUnavailableError)
    return { status: 503, message: error.message };
  if (
    error instanceof Error &&
    DESCRIPTIVE_CLIENT_ERRORS.some((type) => error instanceof type)
  )
    return { status: 400, message: error.message };
  // Validation and malformed-JSON failures share a generic message so the
  // response never echoes schema internals.
  if (
    error instanceof ZodError ||
    error instanceof SyntaxError ||
    error instanceof URIError
  )
    return { status: 400, message: "Invalid request" };
  return { status: 500, message: "Internal server error" };
}
