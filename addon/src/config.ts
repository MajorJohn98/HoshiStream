import { parseConfig } from "./config-schema.ts";

export const config = parseConfig(process.env);
