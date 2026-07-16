import { config } from "dotenv";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(packageRoot, ".env") });

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GMAIL_PUBSUB_TOPIC } = process.env;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error(
    "[corsair:setup] Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in packages/corsair/.env"
  );
  process.exit(1);
}

const gmailArgs = [
  "--gmail",
  `client_id=${GOOGLE_CLIENT_ID}`,
  `client_secret=${GOOGLE_CLIENT_SECRET}`,
];
if (GMAIL_PUBSUB_TOPIC) {
  gmailArgs.push(`topic_id=${GMAIL_PUBSUB_TOPIC}`);
}

const result = spawnSync(
  "npx",
  [
    "corsair",
    "setup",
    ...gmailArgs,
    "--googlecalendar",
    `client_id=${GOOGLE_CLIENT_ID}`,
    `client_secret=${GOOGLE_CLIENT_SECRET}`,
  ],
  { stdio: "inherit", cwd: packageRoot, shell: process.platform === "win32" }
);

process.exit(result.status ?? 1);
