import { z } from "zod/v4";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

function normalizeEnvBoolean(value: unknown): unknown {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized.length === 0) {
      return undefined;
    }
    if (TRUE_VALUES.has(normalized)) {
      return true;
    }
    if (FALSE_VALUES.has(normalized)) {
      return false;
    }
  }

  return value;
}

export function envBoolean(defaultValue?: boolean) {
  const schema = z.preprocess(normalizeEnvBoolean, z.boolean().optional());
  return defaultValue === undefined ? schema : schema.default(defaultValue);
}

