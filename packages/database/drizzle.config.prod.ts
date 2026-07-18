import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// Drizzle Studio against the PRODUCTION database on the VPS, read through an
// SSH tunnel. Deliberately separate from drizzle.config.ts so that the normal
// db:migrate / db:generate scripts can never pick up prod credentials by
// accident — they read DATABASE_URL, this reads PROD_DATABASE_URL.
//
// Requires the tunnel to be open first (see db:studio:prod in package.json):
//   ssh -N -L 5433:127.0.0.1:5432 ubuntu@<VPS_IP>
//
// The VPS publishes Postgres on its own loopback only (-p 127.0.0.1:5432:5432
// in the deploy workflow), so 5432 there is not reachable from the internet —
// the tunnel is the only path in.
const url = process.env.PROD_DATABASE_URL;

if (!url) {
  throw new Error(
    "PROD_DATABASE_URL is not set. Add it to packages/database/.env — see the " +
      "host/encoding notes in this file.",
  );
}

// The container hostname resolves only inside mailroid-net on the VPS. Pasting
// the API's connection string in here is the easy mistake; fail loudly rather
// than with a bare ENOTFOUND.
if (url.includes("@mailroid-db")) {
  throw new Error(
    "PROD_DATABASE_URL points at the Docker hostname 'mailroid-db', which does " +
      "not resolve outside the VPS. Use 127.0.0.1:<tunnel-port> instead.",
  );
}

export default defineConfig({
  out: "./drizzle",
  schema: "./schema.ts",
  dialect: "postgresql",
  dbCredentials: { url },
});
