import dotenv from "dotenv";
import pg from "pg";

dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
});

async function main() {
  const tables = [
    "message_analytics",
    "channel_state",
    "thread_edges",
    "messages",
    "user_profiles",
    "slack_events",
    "channels",
  ];

  console.log("Truncating all application tables...");
  await pool.query(`TRUNCATE ${tables.join(", ")} CASCADE`);
  console.log(`Done — truncated: ${tables.join(", ")}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
