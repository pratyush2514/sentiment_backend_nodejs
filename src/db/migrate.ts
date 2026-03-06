import "dotenv/config";
import { logger } from "../utils/logger.js";
import { runMigrations, shutdown } from "./pool.js";

async function main(): Promise<void> {
  await runMigrations();
  logger.info("All migrations applied");
  await shutdown();
}

main().catch((err) => {
  logger.fatal({ err }, "Migration failed");
  process.exit(1);
});
