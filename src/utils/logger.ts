import pino from "pino";
import { config } from "../config.js";

export const logger = pino({
  level: config.LOG_LEVEL,
  ...(config.NODE_ENV !== "production" && {
    transport: {
      target: "pino-pretty",
      options: { colorize: true },
    },
  }),
  serializers: {
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
    err: pino.stdSerializers.err,
  },
  redact: {
    paths: [
      // Message text
      "text", "*.text", "body.text", "event.text",
      // Auth headers
      "headers.authorization", "req.headers.authorization", "*.headers.authorization",
      // Tokens & secrets
      "token", "*.token", "secret", "*.secret",
      "apiKey", "*.apiKey",
      "password", "*.password",
      // DB connection strings
      "connectionString", "*.connectionString",
      "databaseUrl", "*.databaseUrl",
    ],
    censor: "[REDACTED]",
  },
});

export function createChildLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}
