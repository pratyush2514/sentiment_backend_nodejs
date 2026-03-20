import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const sourceDir = path.join(projectRoot, "src/db/migrations");
const targetDir = path.join(projectRoot, "dist/db/migrations");

if (!fs.existsSync(sourceDir)) {
  console.warn(`Migration source directory not found: ${sourceDir}`);
  process.exit(0);
}

fs.mkdirSync(targetDir, { recursive: true });

for (const entry of fs.readdirSync(sourceDir)) {
  if (!entry.endsWith(".sql")) continue;
  fs.copyFileSync(path.join(sourceDir, entry), path.join(targetDir, entry));
}

console.log(`Copied SQL migrations into ${targetDir}`);
