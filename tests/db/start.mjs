// A throwaway copy of the TripVibz database, built from this repo, for tests
// that really save (tests/database.mjs). Nothing here touches the live project.
//
// What it builds, in a database it creates and drops itself:
//   1. tests/db/supabase-shim.sql   the Supabase pieces the schema assumes (roles, auth.uid(), extensions)
//   2. supabase/schema.sql           the snapshot of the live schema: tables, policies, triggers, functions, grants
//   3. supabase/migrations/*.sql     every migration newer than the snapshot (its "Includes migrations through" line)
// and puts PostgREST in front of it: the same server Supabase runs between the
// site and Postgres, so each request goes through the real permissions.
//
// Needs: a Postgres server with PostGIS that this can create a database on
//   (default: 127.0.0.1:5432, user and password "postgres", the same as the CI service
//   and the docker command in tests/README.md; TEST_PG_URL overrides it),
//   psql, and the postgrest binary (POSTGREST_BIN, default "postgrest").
//   CI provides all three (.github/workflows/tests.yml).
import { spawn, spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { createHmac, randomBytes } from "node:crypto";

const ADMIN_URL = process.env.TEST_PG_URL || (() => {
  const u = new URL("postgres://127.0.0.1:5432/postgres");
  u.username = "postgres"; u.password = "postgres";   // a throwaway local server, not a secret
  return u.toString();
})();
const DB_NAME = "tripvibz_test";
const REST_PORT = Number(process.env.TEST_REST_PORT || 3055);

function psql(url, sql, { vars = {}, options = "" } = {}) {
  const args = [url, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"];
  for (const [k, v] of Object.entries(vars)) args.push("-v", `${k}=${v}`);
  args.push("-f", "-");
  const r = spawnSync("psql", args, { input: sql, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PGOPTIONS: options, PGCLIENTENCODING: "UTF8" } });
  if (r.error) throw new Error(`could not run psql: ${r.error.message}`);
  if (r.status !== 0) throw new Error((r.stderr || "psql failed").trim().split("\n").slice(0, 6).join("\n"));
  return r.stdout.trim();
}

const b64 = x => Buffer.from(typeof x === "string" ? x : JSON.stringify(x)).toString("base64url");
/** A token PostgREST accepts: the same shape Supabase sign-in issues, signed with this run's secret. */
export function signToken(secret, claims) {
  const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

export async function startTestDatabase() {
  const admin = new URL(ADMIN_URL);
  // This creates and drops a database. Only ever on a local or CI-service Postgres, never a hosted one.
  if (!["127.0.0.1", "localhost", "[::1]", "postgres"].includes(admin.hostname))
    throw new Error(`TEST_PG_URL points at ${admin.hostname}. The test database is only ever built on a local Postgres (127.0.0.1, localhost) or the CI service named "postgres"`);
  const dbUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = "/" + DB_NAME; return u.toString(); })();

  // ---- 1. a fresh, empty database ----
  psql(ADMIN_URL, `drop database if exists ${DB_NAME} with (force);\ncreate database ${DB_NAME};`);
  psql(dbUrl, await readFile("tests/db/supabase-shim.sql", "utf8"), { vars: { DBNAME: DB_NAME } });

  // ---- 2. the schema snapshot ----
  let schema = await readFile("supabase/schema.sql", "utf8");
  const through = (schema.match(/^-- Includes migrations through (\d{14})\b/m) || [])[1];
  if (!through) throw new Error("supabase/schema.sql has no '-- Includes migrations through <version>' line, so there is no telling which migrations it already contains. The schema-snapshot workflow writes it.");
  schema = schema.replace(/^CREATE SCHEMA public;$/m, "");   // already there in a new database
  const version = Number(psql(dbUrl, "show server_version_num;"));
  if (version < 170000) schema = schema.replace(/,MAINTAIN\b|\bMAINTAIN,/g, "");   // a Postgres 17 privilege; older servers (local runs) don't know it
  // The dump defines functions before the tables they read, as pg_dump always does.
  psql(dbUrl, schema, { options: "-c check_function_bodies=false" });
  // Supabase creates a profile for every new account; the trigger sits on auth.users, outside the public dump.
  psql(dbUrl, `create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();`);

  // ---- 3. migrations the snapshot doesn't have yet, in order, exactly as a merge would apply them ----
  const applied = [];
  for (const f of (await readdir("supabase/migrations")).filter(f => /^\d{14}_.+\.sql$/.test(f)).sort()) {
    if (f.slice(0, 14) <= through) continue;
    try { psql(dbUrl, await readFile(`supabase/migrations/${f}`, "utf8")); }
    catch (e) { throw new Error(`migration ${f} does not apply on top of the schema snapshot:\n${e.message}`); }
    applied.push(f);
  }

  // ---- 4. PostgREST in front, as on Supabase ----
  const secret = randomBytes(32).toString("hex");
  const restDb = new URL(dbUrl); restDb.username = "authenticator"; restDb.password = "test-authenticator";
  const rest = spawn(process.env.POSTGREST_BIN || "postgrest", [], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
    PGRST_DB_URI: restDb.toString(), PGRST_DB_SCHEMAS: "public", PGRST_DB_ANON_ROLE: "anon", PGRST_DB_EXTRA_SEARCH_PATH: "public, extensions",
    PGRST_JWT_SECRET: secret, PGRST_SERVER_HOST: "127.0.0.1", PGRST_SERVER_PORT: String(REST_PORT), PGRST_DB_POOL: "10", PGRST_LOG_LEVEL: "error" } });
  let restLog = ""; rest.stdout.on("data", d => { restLog += d; }); rest.stderr.on("data", d => { restLog += d; });
  let spawnError = null; rest.on("error", e => { spawnError = e; });
  const restUrl = `http://127.0.0.1:${REST_PORT}`;
  for (let i = 0; ; i++) {
    if (spawnError) throw new Error(`could not start postgrest (${spawnError.message}). Install it or set POSTGREST_BIN`);
    try { if ((await fetch(restUrl + "/")).ok) break; } catch {}
    if (i > 100 || rest.exitCode != null) { rest.kill(); throw new Error(`PostgREST did not come up:\n${restLog.slice(-800)}`); }
    await new Promise(r => setTimeout(r, 150));
  }

  const sql = text => psql(dbUrl, text);
  return {
    rest: restUrl, secret, through, applied, serverVersion: version,
    host: `${admin.hostname}:${admin.port || 5432}`,
    sql,
    /** rows of a query, as objects */
    rows: text => JSON.parse(sql(`select coalesce(jsonb_agg(t), '[]'::jsonb) from (${text.replace(/;\s*$/, "")}) t;`) || "[]"),
    token: claims => signToken(secret, claims),
    restLog: () => restLog,
    async stop() {
      rest.kill();
      await new Promise(r => { if (rest.exitCode != null) r(); else rest.on("exit", r); setTimeout(r, 2000); });
      try { psql(ADMIN_URL, `drop database if exists ${DB_NAME} with (force);`); } catch {}
    }
  };
}
