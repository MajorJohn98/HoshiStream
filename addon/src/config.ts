import { parseConfig } from "./config-schema.js";

export const config = parseConfig(process.env);
