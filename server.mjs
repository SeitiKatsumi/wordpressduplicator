import http from "node:http";
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join, posix, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import pg from "pg";

const { Pool } = pg;

const root = resolve(".");
const uiRoot = resolve("./ui");
const port = Number(process.env.PORT || 3000);
const databaseUrl = process.env.DATABASE_URL || "";
const allowStoreSecrets = process.env.ALLOW_STORE_SECRETS === "true";
const dataDir = process.env.WORDPRESS_DUPLICATOR_DATA_DIR || "/data";
const jobTimeoutSeconds = Number(process.env.JOB_TIMEOUT_SECONDS || 7200);
const fileManagerMaxUploadMb = Number(process.env.FILE_MANAGER_MAX_UPLOAD_MB || 512);
const fileManagerMaxUploadBytes =
  (Number.isFinite(fileManagerMaxUploadMb) && fileManagerMaxUploadMb > 0 ? fileManagerMaxUploadMb : 512) *
  1024 *
  1024;
const runningJobs = new Map();
const uploadSessions = new Map();
const caproverAppPattern = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,62}$/;

const uploadSessionJanitor = setInterval(() => {
  const now = Date.now();
  for (const [id, session] of uploadSessions.entries()) {
    if (session.expiresAt < now) uploadSessions.delete(id);
  }
}, 60_000);
uploadSessionJanitor.unref?.();

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

function shQuote(value) {
  return `'${String(value ?? "").replaceAll("'", "'\"'\"'")}'`;
}

function normalizePrivateKey(value) {
  return String(value || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim() + "\n";
}

function safeRelativePath(value = ".") {
  const text = String(value || ".").trim().replaceAll("\\", "/");
  if (!text || text === ".") return ".";
  if (text.startsWith("/") || text.includes("\0")) {
    throw new Error("Caminho invalido: use caminho relativo dentro do WordPress.");
  }
  const parts = text.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === ".." || /[\x00-\x1f]/.test(part))) {
    throw new Error("Caminho invalido: navegacao fora do WordPress bloqueada.");
  }
  return parts.join("/");
}

function safeFileName(value) {
  const name = String(value || "").trim();
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    /[\x00-\x1f]/.test(name)
  ) {
    throw new Error("Nome de arquivo invalido.");
  }
  return name.slice(0, 180);
}

function safeAppName(value, label = "app") {
  const name = String(value || "").trim();
  if (!caproverAppPattern.test(name)) {
    throw new Error(`${label} invalida. Use apenas letras, numeros e hifen.`);
  }
  return name;
}

function safeWpPath(value) {
  const path = String(value || "/var/www/html").trim().replace(/\/+$/g, "") || "/var/www/html";
  if (!path.startsWith("/") || path.includes("\0") || path.split("/").includes("..")) {
    throw new Error("WP path invalido.");
  }
  return path;
}

function joinWpPath(wpPath, relativePath = ".") {
  const base = safeWpPath(wpPath);
  const rel = safeRelativePath(relativePath);
  return rel === "." ? base : `${base}/${rel}`;
}

function parentRelativePath(relativePath = ".") {
  const rel = safeRelativePath(relativePath);
  if (rel === ".") return ".";
  const parent = posix.dirname(rel);
  return parent === "." ? "." : parent;
}

function isProtectedWrite(relativePath = ".", fileName = "") {
  const full = safeRelativePath(relativePath) === "." ? safeFileName(fileName) : `${safeRelativePath(relativePath)}/${safeFileName(fileName)}`;
  const lower = full.toLowerCase();
  return lower === "wp-config.php" || lower.endsWith("/wp-config.php") || lower === ".env" || lower.endsWith("/.env");
}

function serviceName(app) {
  return `srv-captain--${app}`;
}

function buildFileContext(body = {}) {
  const config = body.config || {};
  const ssh = config.ssh || {};
  const host = String(ssh.host || "").trim();
  const user = String(ssh.user || "root").trim();
  const portValue = Number(ssh.port || 22);
  const keyPath = String(ssh.keyPath || "").trim();
  const privateKey = String(ssh.privateKey || "");
  if (!host) throw new Error("SSH host obrigatorio.");
  if (!user) throw new Error("SSH usuario obrigatorio.");
  if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535) {
    throw new Error("Porta SSH invalida.");
  }
  if (keyPath && keyPath !== "****" && !keyPath.startsWith("/") && !keyPath.startsWith("~")) {
    throw new Error("Caminho da chave SSH precisa ser absoluto dentro do container.");
  }
  if (!keyPath && !privateKey.includes("PRIVATE KEY")) {
    throw new Error("Informe caminho de chave SSH ou cole a chave privada completa.");
  }
  return {
    app: safeAppName(config.app, "App WordPress"),
    wpPath: safeWpPath(config.wpPath),
    ssh: {
      host,
      user,
      port: portValue,
      keyPath: keyPath === "****" ? "" : keyPath,
      privateKey,
    },
  };
}

function prepareSshKey(ssh) {
  if (ssh.privateKey && ssh.privateKey.includes("PRIVATE KEY")) {
    const keyDir = resolve(dataDir, "file-manager", "keys");
    mkdirSync(keyDir, { recursive: true });
    const keyPath = resolve(keyDir, `${randomUUID()}.key`);
    writeFileSync(keyPath, normalizePrivateKey(ssh.privateKey), { mode: 0o600 });
    try {
      chmodSync(keyPath, 0o600);
    } catch {
      // Some filesystems already honor the requested mode.
    }
    return {
      keyPath,
      cleanup: () => {
        try {
          unlinkSync(keyPath);
        } catch {
          // Temporary SSH keys are best-effort cleaned after each request.
        }
      },
    };
  }
  return { keyPath: ssh.keyPath, cleanup: () => {} };
}

async function runLocal(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  const stdout = [];
  const stderr = [];
  let settled = false;
  const timeout = options.timeoutMs
    ? setTimeout(() => {
        if (!settled) child.kill("SIGTERM");
      }, options.timeoutMs)
    : null;

  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.on("error", (error) => {
    stderr.push(Buffer.from(error.message));
  });

  if (options.inputFile) {
    await new Promise((resolvePromise, rejectPromise) => {
      const input = createReadStream(options.inputFile);
      input.on("error", rejectPromise);
      child.stdin.on("error", rejectPromise);
      child.stdin.on("finish", resolvePromise);
      input.pipe(child.stdin);
    });
  } else if (options.inputBuffer) {
    child.stdin.end(options.inputBuffer);
  } else {
    child.stdin.end();
  }

  const code = await new Promise((resolvePromise) => {
    child.on("close", (exitCode) => resolvePromise(exitCode ?? 1));
  });
  settled = true;
  if (timeout) clearTimeout(timeout);
  const result = {
    code,
    stdout: Buffer.concat(stdout).toString("utf-8"),
    stderr: Buffer.concat(stderr).toString("utf-8"),
  };
  if (options.check !== false && code !== 0) {
    const detail = result.stderr || result.stdout || `${command} exited with code ${code}`;
    throw new Error(detail.slice(0, 1200));
  }
  return result;
}

async function sshExec(context, remoteCommand, options = {}) {
  const args = [
    "-p",
    String(context.ssh.port),
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-i",
    context.keyPath,
    `${context.ssh.user}@${context.ssh.host}`,
    remoteCommand,
  ];
  return runLocal("ssh", args, { timeoutMs: options.timeoutMs || 120_000, inputFile: options.inputFile, check: options.check });
}

function containerIdSnippet(app) {
  return `cid=$(docker ps --filter label=com.docker.swarm.service.name=${shQuote(serviceName(app))} --format '{{.ID}}' | head -n 1); test -n "$cid" || { echo 'Container WordPress nao encontrado' >&2; exit 40; }`;
}

function parseListing(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const [kind, rawName, rawSize, rawMtime, mode, owner, group] = line.split("\t");
      const name = String(rawName || "").replace(/^\.\//, "");
      return {
        name,
        type: kind === "directory" ? "directory" : kind === "symbolic link" ? "symlink" : "file",
        size: Number(rawSize || 0),
        mtime: Number(rawMtime || 0),
        mode: mode || "",
        owner: owner || "",
        group: group || "",
      };
    })
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" });
    });
}

async function fileList(request, response) {
  const body = await readBody(request);
  const context = buildFileContext(body);
  const relPath = safeRelativePath(body.path || ".");
  const { keyPath, cleanup } = prepareSshKey(context.ssh);
  context.keyPath = keyPath;
  const containerDir = joinWpPath(context.wpPath, relPath);
  try {
    const command = [
      "set -euo pipefail",
      containerIdSnippet(context.app),
      `docker exec "$cid" sh -lc ${shQuote(`test -d ${shQuote(containerDir)} && cd ${shQuote(containerDir)} && find . -mindepth 1 -maxdepth 1 -exec stat -c '%F\t%n\t%s\t%Y\t%a\t%U\t%G' {} \\;`)}`,
    ].join("; ");
    const result = await sshExec(context, command);
    json(response, 200, {
      ok: true,
      app: context.app,
      path: relPath,
      wpPath: context.wpPath,
      parent: parentRelativePath(relPath),
      files: parseListing(result.stdout),
    });
  } finally {
    cleanup();
  }
}

async function fileMkdir(request, response) {
  const body = await readBody(request);
  const context = buildFileContext(body);
  const relPath = safeRelativePath(body.path || ".");
  const dirName = safeFileName(body.name || "");
  const { keyPath, cleanup } = prepareSshKey(context.ssh);
  context.keyPath = keyPath;
  const containerDir = joinWpPath(context.wpPath, relPath === "." ? dirName : `${relPath}/${dirName}`);
  try {
    const command = [
      "set -euo pipefail",
      containerIdSnippet(context.app),
      `docker exec "$cid" sh -lc ${shQuote(`mkdir -p ${shQuote(containerDir)} && (chown www-data:www-data ${shQuote(containerDir)} 2>/dev/null || true)`)}`,
    ].join("; ");
    await sshExec(context, command);
    json(response, 200, { ok: true, path: relPath, name: dirName });
  } finally {
    cleanup();
  }
}

async function filePreview(request, response) {
  const body = await readBody(request);
  const context = buildFileContext(body);
  const relPath = safeRelativePath(body.path || ".");
  const { keyPath, cleanup } = prepareSshKey(context.ssh);
  context.keyPath = keyPath;
  const containerFile = joinWpPath(context.wpPath, relPath);
  try {
    const script = [
      "set -euo pipefail",
      containerIdSnippet(context.app),
      `docker exec "$cid" sh -lc ${shQuote(`test -f ${shQuote(containerFile)}; bytes=$(wc -c < ${shQuote(containerFile)}); test "$bytes" -le 262144 || { echo 'Arquivo muito grande para preview' >&2; exit 47; }; sed -n '1,240p' ${shQuote(containerFile)}`)}`,
    ].join("; ");
    const result = await sshExec(context, script);
    json(response, 200, { ok: true, path: relPath, content: result.stdout });
  } finally {
    cleanup();
  }
}

async function createUploadSession(request, response) {
  const body = await readBody(request);
  const context = buildFileContext(body);
  const relPath = safeRelativePath(body.path || ".");
  const fileName = safeFileName(body.fileName || "");
  if (isProtectedWrite(relPath, fileName) && body.allowProtected !== true) {
    json(response, 400, { ok: false, error: "Upload de wp-config.php/.env bloqueado por seguranca." });
    return;
  }
  const id = randomUUID();
  const expiresAt = Date.now() + 10 * 60 * 1000;
  uploadSessions.set(id, {
    context,
    path: relPath,
    fileName,
    overwrite: body.overwrite === true,
    expiresAt,
  });
  json(response, 201, { ok: true, id, maxBytes: fileManagerMaxUploadBytes, expiresAt });
}

async function streamUploadToFile(request, targetPath) {
  const contentLength = Number(request.headers["content-length"] || 0);
  if (contentLength && contentLength > fileManagerMaxUploadBytes) {
    throw new Error(`Arquivo acima do limite configurado (${Math.round(fileManagerMaxUploadBytes / 1024 / 1024)} MB).`);
  }
  await new Promise((resolvePromise, rejectPromise) => {
    let received = 0;
    const output = createWriteStream(targetPath, { mode: 0o600 });
    request.on("data", (chunk) => {
      received += chunk.length;
      if (received > fileManagerMaxUploadBytes) {
        output.destroy();
        request.destroy(new Error("Arquivo acima do limite configurado."));
      }
    });
    request.on("error", rejectPromise);
    output.on("error", rejectPromise);
    output.on("finish", resolvePromise);
    request.pipe(output);
  });
  return contentLength;
}

async function uploadFile(request, response, sessionId) {
  const session = uploadSessions.get(sessionId);
  if (!session || session.expiresAt < Date.now()) {
    uploadSessions.delete(sessionId);
    json(response, 404, { ok: false, error: "Sessao de upload expirada. Inicie o upload novamente." });
    return;
  }
  uploadSessions.delete(sessionId);
  const uploadDir = resolve(dataDir, "file-manager", "uploads");
  mkdirSync(uploadDir, { recursive: true });
  const localPath = resolve(uploadDir, `${sessionId}-${session.fileName}`);
  const { context } = session;
  const { keyPath, cleanup } = prepareSshKey(context.ssh);
  context.keyPath = keyPath;
  const remoteTemp = `/tmp/wpclone-upload-${sessionId}-${session.fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  const containerDir = joinWpPath(context.wpPath, session.path);
  const containerDest = joinWpPath(context.wpPath, session.path === "." ? session.fileName : `${session.path}/${session.fileName}`);
  try {
    await streamUploadToFile(request, localPath);
    await sshExec(context, `cat > ${shQuote(remoteTemp)}`, { inputFile: localPath, timeoutMs: 30 * 60 * 1000 });
    const overwriteGuard = session.overwrite
      ? "true"
      : `docker exec "$cid" sh -lc ${shQuote(`test ! -e ${shQuote(containerDest)}`)} || { echo 'Arquivo destino ja existe; marque sobrescrever para substituir' >&2; exit 49; }`;
    const command = [
      "set -euo pipefail",
      containerIdSnippet(context.app),
      `docker exec "$cid" sh -lc ${shQuote(`mkdir -p ${shQuote(containerDir)}`)}`,
      overwriteGuard,
      `docker cp ${shQuote(remoteTemp)} "$cid":${shQuote(containerDest)}`,
      `rm -f ${shQuote(remoteTemp)}`,
      `docker exec "$cid" sh -lc ${shQuote(`chown www-data:www-data ${shQuote(containerDest)} 2>/dev/null || true`)}`,
    ].join("; ");
    await sshExec(context, command, { timeoutMs: 30 * 60 * 1000 });
    json(response, 200, { ok: true, path: session.path, fileName: session.fileName });
  } finally {
    cleanup();
    try {
      unlinkSync(localPath);
    } catch {
      // Best-effort cleanup.
    }
  }
}

function pythonZipCode(src, out) {
  return [
    "import os, zipfile",
    `src=${JSON.stringify(src)}`,
    `out=${JSON.stringify(out)}`,
    "base=os.path.basename(src.rstrip('/')) or 'arquivo'",
    "zf=zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED)",
    "try:",
    "    if os.path.isdir(src):",
    "        for root, dirs, files in os.walk(src):",
    "            dirs[:] = [d for d in dirs if d not in {'.git','node_modules'}]",
    "            for name in files:",
    "                path=os.path.join(root,name)",
    "                zf.write(path, os.path.join(base, os.path.relpath(path,src)))",
    "    else:",
    "        zf.write(src, os.path.basename(src))",
    "finally:",
    "    zf.close()",
  ].join("\n");
}

function pythonUnzipCode(zipPath, destDir, containerDest, overwrite) {
  return [
    "import os, shlex, subprocess, sys, zipfile",
    `zip_path=${JSON.stringify(zipPath)}`,
    `dest=${JSON.stringify(destDir)}`,
    "cid=os.environ['CID']",
    `container_dest=${JSON.stringify(containerDest)}`,
    `overwrite=${overwrite ? "True" : "False"}`,
    "with zipfile.ZipFile(zip_path) as z:",
    "    for member in z.infolist():",
    "        name=member.filename.replace('\\\\','/')",
    "        parts=[p for p in name.split('/') if p]",
    "        if name.startswith('/') or '..' in parts:",
    "            print('ZIP bloqueado: contem caminho inseguro', file=sys.stderr)",
    "            sys.exit(64)",
    "    z.extractall(dest)",
    "if not overwrite:",
    "    for name in os.listdir(dest):",
    "        target=os.path.join(container_dest, name)",
    "        cmd='test ! -e ' + shlex.quote(target)",
    "        result=subprocess.run(['docker','exec',cid,'sh','-lc',cmd])",
    "        if result.returncode != 0:",
    "            print('Destino ja contem: ' + target, file=sys.stderr)",
    "            sys.exit(58)",
  ].join("\n");
}

async function zipFile(request, response) {
  const body = await readBody(request);
  const context = buildFileContext(body);
  const relPath = safeRelativePath(body.path || ".");
  const archiveName = safeFileName(body.archiveName || `${basename(relPath === "." ? "wordpress-public" : relPath)}.zip`);
  const archiveRel = safeRelativePath(`${parentRelativePath(relPath)}/${archiveName}`);
  if (isProtectedWrite(parentRelativePath(relPath), archiveName)) {
    json(response, 400, { ok: false, error: "Nome de ZIP reservado bloqueado." });
    return;
  }
  const { keyPath, cleanup } = prepareSshKey(context.ssh);
  context.keyPath = keyPath;
  const id = randomUUID();
  const work = `/tmp/wpclone-zip-${id}`;
  const containerSource = joinWpPath(context.wpPath, relPath);
  const containerArchive = joinWpPath(context.wpPath, archiveRel);
  try {
    const code = pythonZipCode(`${work}/source`, `${work}/archive.zip`);
    const command = [
      "set -euo pipefail",
      containerIdSnippet(context.app),
      `rm -rf ${shQuote(work)} && mkdir -p ${shQuote(work)}`,
      `docker cp "$cid":${shQuote(containerSource)} ${shQuote(`${work}/source`)}`,
      `python3 -c ${shQuote(code)}`,
      `docker cp ${shQuote(`${work}/archive.zip`)} "$cid":${shQuote(containerArchive)}`,
      `rm -rf ${shQuote(work)}`,
    ].join("; ");
    await sshExec(context, command, { timeoutMs: 30 * 60 * 1000 });
    json(response, 200, { ok: true, archive: archiveRel });
  } finally {
    cleanup();
  }
}

async function unzipFile(request, response) {
  const body = await readBody(request);
  const context = buildFileContext(body);
  const relPath = safeRelativePath(body.path || ".");
  const destinationPath = safeRelativePath(body.destinationPath || parentRelativePath(relPath));
  if (!relPath.toLowerCase().endsWith(".zip")) {
    json(response, 400, { ok: false, error: "Selecione um arquivo .zip para descompactar." });
    return;
  }
  const { keyPath, cleanup } = prepareSshKey(context.ssh);
  context.keyPath = keyPath;
  const id = randomUUID();
  const work = `/tmp/wpclone-unzip-${id}`;
  const containerZip = joinWpPath(context.wpPath, relPath);
  const containerDest = joinWpPath(context.wpPath, destinationPath);
  try {
    const command = [
      "set -euo pipefail",
      containerIdSnippet(context.app),
      `rm -rf ${shQuote(work)} && mkdir -p ${shQuote(`${work}/extracted`)}`,
      `docker cp "$cid":${shQuote(containerZip)} ${shQuote(`${work}/archive.zip`)}`,
      `CID="$cid" python3 -c ${shQuote(pythonUnzipCode(`${work}/archive.zip`, `${work}/extracted`, containerDest, body.overwrite === true))}`,
      `docker exec "$cid" sh -lc ${shQuote(`mkdir -p ${shQuote(containerDest)}`)}`,
      `docker cp ${shQuote(`${work}/extracted/.`)} "$cid":${shQuote(`${containerDest}/`)}`,
      `docker exec "$cid" sh -lc ${shQuote(`chown -R www-data:www-data ${shQuote(containerDest)} 2>/dev/null || true`)}`,
      `rm -rf ${shQuote(work)}`,
    ].join("; ");
    await sshExec(context, command, { timeoutMs: 30 * 60 * 1000 });
    json(response, 200, { ok: true, extractedTo: destinationPath });
  } finally {
    cleanup();
  }
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
            error_message, report, config_snapshot
       FROM clone_jobs
      ORDER BY created_at DESC
      LIMIT 50`
  );
  json(response, 200, { ok: true, jobs: result.rows });
}

async function getJob(response, id) {
  if (!pool || !dbReady) {
    json(response, 503, { ok: false, error: dbError || "Postgres indisponivel" });
    return;
  }

  const job = await pool.query(
    `SELECT id, source_app, target_app, old_url, new_url, status, current_step,
            dry_run, allow_existing_target, created_at, updated_at, started_at,
            finished_at, error_message, report
       FROM clone_jobs
      WHERE id=$1`,
    [id]
  );
  if (!job.rowCount) {
    json(response, 404, { ok: false, error: "job nao encontrado" });
    return;
  }
  const logs = await pool.query(
    `SELECT level, message, metadata, created_at
       FROM clone_job_logs
      WHERE job_id=$1
      ORDER BY created_at ASC, id ASC
      LIMIT 500`,
    [id]
  );
  json(response, 200, { ok: true, job: job.rows[0], logs: logs.rows });
}

async function createJob(request, response) {
  if (!pool || !dbReady) {
    json(response, 503, { ok: false, error: dbError || "Postgres indisponivel" });
    return;
  }

  const body = await readBody(request);
  const rawConfig = body.config || {};
  const config = sanitize(rawConfig);
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

  if (body.run === true) {
    const validationError = validateRunConfig(rawConfig);
    if (validationError) {
      await pool.query(
        `UPDATE clone_jobs
            SET status='failed', current_step='validation_failed',
                started_at=COALESCE(started_at, now()), finished_at=now(), updated_at=now(),
                error_message=$2
          WHERE id=$1`,
        [id, validationError]
      );
      await pool.query(
        `INSERT INTO clone_job_logs (job_id, level, message, metadata)
         VALUES ($1, 'error', $2, '{}')`,
        [id, validationError]
      );
      json(response, 400, { ok: false, id, error: validationError });
      return;
    }
    if (execution.dryRun !== false) {
      await pool.query(
        `UPDATE clone_jobs
            SET status='succeeded', current_step='dry_run_recorded',
                started_at=COALESCE(started_at, now()), finished_at=now(), updated_at=now(),
                report=$2
          WHERE id=$1`,
        [id, { mode: "dry-run", message: "Job registrado sem executar comandos remotos." }]
      );
      await pool.query(
        `INSERT INTO clone_job_logs (job_id, level, message, metadata)
         VALUES ($1, 'info', 'Dry-run registrado; nenhum comando remoto foi executado', '{}')`,
        [id]
      );
    } else {
      await startJob(id, rawConfig);
    }
  }

  json(response, 201, { ok: true, id, running: body.run === true });
}

function validateRunConfig(config) {
  const sourceSsh = config?.source?.ssh || {};
  const target = config?.target || {};
  const targetSsh = target.ssh || {};
  const database = config?.database || {};
  const sourceKeyPath = sourceSsh.keyPath === "****" ? "" : sourceSsh.keyPath || "";
  const sourcePrivateKey = sourceSsh.privateKey || "";
  const targetKeyPath = targetSsh.keyPath === "****" ? "" : targetSsh.keyPath || "";
  const targetPrivateKey = targetSsh.privateKey || "";

  if (sourceKeyPath && !sourceKeyPath.startsWith("/") && !sourceKeyPath.startsWith("~")) {
    return "Caminho da chave SSH origem invalido. Use um caminho dentro do container, como /data/ssh-keys/id_rsa, ou cole a chave no campo de chave privada.";
  }
  if (targetKeyPath && !targetKeyPath.startsWith("/") && !targetKeyPath.startsWith("~")) {
    return "Caminho da chave SSH destino invalido. Use um caminho dentro do container, como /data/ssh-keys/id_rsa, ou cole a chave no campo de chave privada.";
  }
  if (sourcePrivateKey && !sourcePrivateKey.includes("PRIVATE KEY")) {
    return "Chave privada SSH origem invalida ou incompleta.";
  }
  if (!target.sameSsh && targetPrivateKey && !targetPrivateKey.includes("PRIVATE KEY")) {
    return "Chave privada SSH destino invalida ou incompleta.";
  }
  if (!sourceKeyPath && !sourcePrivateKey) {
    return "Informe uma chave privada SSH origem completa ou um caminho de chave existente dentro do container.";
  }
  if (!caproverAppPattern.test(target.app || "")) {
    return "Nome da nova app CapRover invalido. Use apenas letras, numeros e hifen, como wp-invest-caixa.";
  }
  if (!caproverAppPattern.test(database.targetMysqlApp || "")) {
    return "Nome da nova app MySQL invalido. Use apenas letras, numeros e hifen, como wp-invest-caixa-db.";
  }
  return "";
}

async function startExistingJob(request, response, id) {
  if (!pool || !dbReady) {
    json(response, 503, { ok: false, error: dbError || "Postgres indisponivel" });
    return;
  }
  const body = await readBody(request);
  if (!body.config) {
    json(response, 400, { ok: false, error: "config completa com segredos e obrigatoria para executar" });
    return;
  }
  await startJob(id, body.config);
  json(response, 202, { ok: true, id, running: true });
}

async function startJob(id, rawConfig) {
  if (runningJobs.has(id)) return;

  const jobDir = resolve(dataDir, "jobs", id);
  mkdirSync(jobDir, { recursive: true });
  const configPath = resolve(jobDir, "config.json");
  writeFileSync(configPath, JSON.stringify({ jobId: id, config: rawConfig }, null, 2), { mode: 0o600 });

  await pool.query(
    `UPDATE clone_jobs
        SET status='running', current_step='runner_started', started_at=COALESCE(started_at, now()), updated_at=now()
      WHERE id=$1`,
    [id]
  );
  await pool.query(
    `INSERT INTO clone_job_logs (job_id, level, message, metadata)
     VALUES ($1, 'info', 'Execucao real iniciada pelo backend', '{}')`,
    [id]
  );

  const child = spawn("python3", [resolve(root, "wizard_runner.py"), configPath], {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  runningJobs.set(id, child);

  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
  }, jobTimeoutSeconds * 1000);

  const logChunk = async (level, chunk) => {
    const lines = chunk
      .toString("utf-8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      await pool.query(
        `INSERT INTO clone_job_logs (job_id, level, message, metadata)
         VALUES ($1, $2, $3, '{}')`,
        [id, level, line.slice(0, 4000)]
      );
    }
  };

  child.stdout.on("data", (chunk) => {
    logChunk("info", chunk).catch((error) => console.error(error));
  });
  child.stderr.on("data", (chunk) => {
    logChunk("error", chunk).catch((error) => console.error(error));
  });
  child.on("exit", async (code, signal) => {
    clearTimeout(timeout);
    runningJobs.delete(id);
    try {
      unlinkSync(configPath);
    } catch {
      // Config contains execution secrets; best-effort cleanup after the runner starts.
    }
    const ok = code === 0;
    const reportPath = resolve(jobDir, "wordpress-duplicator-report.json");
    let report = {};
    if (existsSync(reportPath)) {
      try {
        report = JSON.parse(readFileSync(reportPath, "utf-8"));
      } catch {
        report = {};
      }
    }
    await pool.query(
      `UPDATE clone_jobs
          SET status=$2, current_step=$3, finished_at=now(), updated_at=now(),
              error_message=$4, report=$5
        WHERE id=$1`,
      [
        id,
        ok ? "succeeded" : "failed",
        ok ? "completed" : "failed",
        ok ? null : `runner exited with code=${code} signal=${signal || ""}`,
        report,
      ]
    );
    await pool.query(
      `INSERT INTO clone_job_logs (job_id, level, message, metadata)
       VALUES ($1, $2, $3, $4)`,
      [
        id,
        ok ? "info" : "error",
        ok ? "Execucao concluida" : "Execucao falhou",
        { code, signal },
      ]
    );
  });
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
      dataDir,
      dryRunDefault: process.env.DRY_RUN_DEFAULT !== "false",
      allowStoreSecrets,
      fileManagerMaxUploadMb: Math.round(fileManagerMaxUploadBytes / 1024 / 1024),
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

    const jobMatch = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]+)$/);
    if (jobMatch && request.method === "GET") {
      await getJob(response, jobMatch[1]);
      return;
    }

    const runMatch = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]+)\/run$/);
    if (runMatch && request.method === "POST") {
      await startExistingJob(request, response, runMatch[1]);
      return;
    }

    if (url.pathname === "/api/files/list" && request.method === "POST") {
      await fileList(request, response);
      return;
    }

    if (url.pathname === "/api/files/mkdir" && request.method === "POST") {
      await fileMkdir(request, response);
      return;
    }

    if (url.pathname === "/api/files/preview" && request.method === "POST") {
      await filePreview(request, response);
      return;
    }

    if (url.pathname === "/api/files/upload-session" && request.method === "POST") {
      await createUploadSession(request, response);
      return;
    }

    const uploadMatch = url.pathname.match(/^\/api\/files\/upload\/([0-9a-f-]+)$/);
    if (uploadMatch && request.method === "PUT") {
      await uploadFile(request, response, uploadMatch[1]);
      return;
    }

    if (url.pathname === "/api/files/zip" && request.method === "POST") {
      await zipFile(request, response);
      return;
    }

    if (url.pathname === "/api/files/unzip" && request.method === "POST") {
      await unzipFile(request, response);
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
