import { ZodError } from "zod";
import { DiskCopyError } from "../disk-copy.js";
import {
  PickerCancelledError,
  PickerUnavailableError,
} from "../native-picker.js";
import { PlayerError } from "../player.js";
import { VolumeError } from "../volumes.js";

// Domain errors whose message is safe and useful to show the caller.
const DESCRIPTIVE_CLIENT_ERRORS = [
  PickerCancelledError,
  PlayerError,
  VolumeError,
  DiskCopyError,
];

export function classifyError(error: unknown): {
  status: number;
  message: string;
} {
  if (error instanceof PickerUnavailableError)
    return { status: 503, message: error.message };
  if (
    error instanceof Error &&
    DESCRIPTIVE_CLIENT_ERRORS.some((type) => error instanceof type)
  )
    return { status: 400, message: error.message };
  // Validation and malformed-JSON failures share a generic message so the
  // response never echoes schema internals.
  if (error instanceof ZodError || error instanceof SyntaxError)
    return { status: 400, message: "Invalid request" };
  return { status: 500, message: "Internal server error" };
}
