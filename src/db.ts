import postgres from "postgres";
import { config } from "./config.js";

// Shared postgres.js connection — one pool for the whole process.
// TEST_DATABASE_URL is preferred when running tests.
const url = process.env.TEST_DATABASE_URL ?? config.databaseUrl;
if (!url) throw new Error("DATABASE_URL (or TEST_DATABASE_URL) must be set");
export const sql = postgres(url, {
  max: 10,
  // Return JS Date objects for timestamptz columns automatically.
  types: {
    // keep default
  },
});

export type Sql = typeof sql;
