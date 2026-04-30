import http from "node:http";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Pool } = pg;

const root = resolve(".");
const uiRoot = resolve("./ui");
const port = Number(process.env.PORT || 3000);
const databaseUrl = process.env.DATABASE_URL || "";
const allowStoreSecrets = process.env.ALLOW_STORE_SECRETS === "true";

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      max: Number(process.env.PG_POOL_MAX || 5),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    })
  : null;

let dbReady = false;
let dbError = "";

const secretKeys = new Set([
  "password",
  "sourceCaproverPassword",
  "targetCaproverPassword",
  "sourceMysqlPassword",
  "targetMysqlPassword",
  "targetDbPassword",
  "APP_SECRET_KEY",
  "DATABASE_URL",
  "POSTGRES_PASSWORD",
]);

function json(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function notFound(response) {
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found");
}

function maskValue(value) {
  if (!value) return value;
  const text = String(value);
  if (text.length <= 4) return "****";
  return `${text.slice(0, 2)}****${text.slice(-2)}`;
}

function sanitize(input) {
  if (Array.isArray(input)) return input.map(sanitize);
  if (!input || typeof input !== "object") return input;
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (secretKeys.has(key) || /password|secret|token|key/i.test(key)) {
      out[key] = allowStoreSecrets ? maskValue(value) : "****";
    } else {
      out[key] = sanitize(value);
    }
  }
  return out;
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw ? JSON.parse(raw) : {};
}

async function initDb() {
  if (!pool) {
    dbError = "DATABASE_URL ausente";
    return;
  }

  try {
    const schema = readFileSync(resolve(root, "docs/postgres-schema.sql"), "utf-8");
    await pool.query(schema);
    dbReady = true;
    dbError = "";
    console.log("Postgres schema ready");
  } catch (error) {
    dbReady = false;
    dbError = error instanceof Error ? error.message : String(error);
    console.error("Postgres init failed:", dbError);
  }
}

async function listJobs(response) {
  if (!pool || !dbReady) {
    json(response, 503, { ok: false, error: dbError || "Postgres indisponivel" });
    return;
  }

  const result = await pool.query(
    `SELECT id, source_app, target_app, old_url, new_url, status, current_step,
            dry_run, allow_existing_target, created_at, updated_at, started_at, finished_at,
            error_message, report
       FROM clone_jobs
      ORDER BY created_at DESC
      LIMIT 50`
  );
  json(response, 200, { ok: true, jobs: result.rows });
}

async function createJob(request, response) {
  if (!pool || !dbReady) {
    json(response, 503, { ok: false, error: dbError || "Postgres indisponivel" });
    return;
  }

  const body = await readBody(request);
  const config = sanitize(body.config || {});
  const source = config.source || {};
  const target = config.target || {};
  const execution = config.execution || {};

  const sourceApp = source.app || body.sourceApp || "";
  const targetApp = target.app || body.targetApp || "";
  const oldUrl = source.url || body.oldUrl || "";
  const newUrl = target.url || body.newUrl || "";

  if (!sourceApp || !targetApp || !oldUrl || !newUrl) {
    json(response, 400, {
      ok: false,
      error: "source.app, target.app, source.url e target.url sao obrigatorios",
    });
    return;
  }

  const id = randomUUID();
  await pool.query(
    `INSERT INTO clone_jobs (
       id, source_app, target_app, old_url, new_url, status, current_step,
       dry_run, allow_existing_target, config_snapshot, source_summary, target_summary
     )
     VALUES ($1, $2, $3, $4, $5, 'draft', 'created', $6, $7, $8, $9, $10)`,
    [
      id,
      sourceApp,
      targetApp,
      oldUrl,
      newUrl,
      execution.dryRun !== false,
      Boolean(execution.allowExistingTarget),
      config,
      sanitize(source),
      sanitize(target),
    ]
  );

  await pool.query(
    `INSERT INTO clone_job_logs (job_id, level, message, metadata)
     VALUES ($1, 'info', 'Job criado pela UI', $2)`,
    [id, { sourceApp, targetApp }]
  );

  json(response, 201, { ok: true, id });
}

async function health(response) {
  let postgres = { configured: Boolean(pool), ready: dbReady, error: dbError || null };
  if (pool) {
    try {
      await pool.query("SELECT 1");
      postgres = { configured: true, ready: true, error: null };
    } catch (error) {
      postgres = {
        configured: true,
        ready: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  json(response, 200, {
    ok: postgres.ready,
    version: "0.2.0",
    postgres,
    env: {
      port,
      dataDir: process.env.WORDPRESS_DUPLICATOR_DATA_DIR || "/data",
      dryRunDefault: process.env.DRY_RUN_DEFAULT !== "false",
      allowStoreSecrets,
    },
  });
}

function serveStatic(request, response) {
  const url = new URL(request.url || "/", `http://${request.headers.host}`);
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = resolve(join(uiRoot, requestedPath));

  if (!filePath.startsWith(uiRoot) || !existsSync(filePath)) {
    notFound(response);
    return;
  }

  response.writeHead(200, {
    "content-type": contentTypes[extname(filePath)] || "application/octet-stream",
    "cache-control": "no-store",
  });

  createReadStream(filePath).pipe(response);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host}`);

    if (url.pathname === "/api/health" && request.method === "GET") {
      await health(response);
      return;
    }

    if (url.pathname === "/api/jobs" && request.method === "GET") {
      await listJobs(response);
      return;
    }

    if (url.pathname === "/api/jobs" && request.method === "POST") {
      await createJob(request, response);
      return;
    }

    serveStatic(request, response);
  } catch (error) {
    console.error(error);
    json(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

await initDb();

server.listen(port, "0.0.0.0", () => {
  console.log(`WordPress Duplicator running at http://0.0.0.0:${port}/`);
});
