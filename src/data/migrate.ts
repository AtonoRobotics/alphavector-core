import { createPool, migrate } from "./postgres.js";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is required to migrate. Field users do not run this.");
}
const pool = createPool(url);
await migrate(pool);
await pool.end();
console.log("migrated");
