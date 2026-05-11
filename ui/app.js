const screens = [...document.querySelectorAll(".screen")];
const stepButtons = [...document.querySelectorAll(".step")];
const prevButton = document.querySelector("#prevStep");
const nextButton = document.querySelector("#nextStep");
const exportButton = document.querySelector("#exportConfig");
const dryRunButton = document.querySelector("#toggleDryRun");
const simulateButton = document.querySelector("#simulateRun");
const executeButton = document.querySelector("#executeRun");
const form = document.querySelector("#wizardForm");
const consoleOutput = document.querySelector("#consoleOutput");
const dbStatus = document.querySelector("#dbStatus");
const jobHistory = document.querySelector("#jobHistory");
const progressValue = document.querySelector("#progressValue");
const missionList = document.querySelector("#missionList");
const telemetryMode = document.querySelector("#telemetryMode");
const telemetryRisk = document.querySelector("#telemetryRisk");
const telemetryState = document.querySelector("#telemetryState");
const transferPhase = document.querySelector("#transferPhase");
const transferBar = document.querySelector("#transferBar");
const transferDetail = document.querySelector("#transferDetail");
const canvas = document.querySelector("#radarCanvas");
const ctx = canvas.getContext("2d");

let currentStep = 0;
let progress = 0;
let sweep = 0;
let activeJobPoll = null;

const transferStages = [
  ["preflight", 8, "Validando SSH e Docker"],
  ["descobrir app wordpress origem", 16, "Lendo WordPress de origem"],
  ["criar app caprover destino", 25, "Criando app WordPress destino"],
  ["deploying wordpress", 32, "Fazendo deploy da imagem WordPress"],
  ["copiar arquivos", 45, "Transferindo arquivos WordPress"],
  ["transferencia arquivos", 52, "Copiando volume WordPress"],
  ["criar app mysql destino", 62, "Criando app MySQL destino"],
  ["pulling this image: mysql", 70, "Baixando imagem MySQL"],
  ["duplicar banco", 78, "Transferindo dump MySQL"],
  ["transferencia banco", 80, "Dump/restore MySQL em andamento"],
  ["dump e restore mysql", 82, "Restaurando banco no destino"],
  ["atualizar wp-config", 88, "Apontando WordPress para o banco novo"],
  ["search-replace", 94, "Regravando URLs serializadas"],
  ["permiss", 98, "Ajustando permissoes"],
  ["validacao ok", 100, "Clone validado"],
  ["execucao concluida", 100, "Clone concluido"],
];

const scanMessages = {
  ssh: "SSH conectado",
  caprover: "CapRover autenticado",
  wordpress: "wp-config.php localizado",
  mysql: "Banco de origem detectado",
  volumes: "Volume WordPress mapeado",
};

function setStep(index) {
  currentStep = Math.max(0, Math.min(index, screens.length - 1));
  screens.forEach((screen, i) => screen.classList.toggle("is-active", i === currentStep));
  stepButtons.forEach((button, i) => button.classList.toggle("is-active", i === currentStep));
  prevButton.disabled = currentStep === 0;
  nextButton.textContent = currentStep === screens.length - 1 ? "Revisar" : "Avançar";
  telemetryState.textContent = currentStep === screens.length - 1 ? "ARMADO" : "PRONTO";
}

function formData() {
  const data = Object.fromEntries(new FormData(form).entries());
  data.sameSsh = form.elements.sameSsh.checked;
  data.sameCaprover = form.elements.sameCaprover.checked;
  data.dryRun = form.elements.dryRun.checked;
  data.allowExistingTarget = form.elements.allowExistingTarget.checked;
  if (!data.targetMysqlApp && data.targetApp) data.targetMysqlApp = `${data.targetApp}-db`;
  if (!data.targetMysqlImage) data.targetMysqlImage = "mysql:8.0";
  if (!data.targetDbName) data.targetDbName = "wordpress";
  if (!data.targetDbUser) data.targetDbUser = "wordpressuser";

  if (data.sameSsh) {
    data.targetSshHost = data.sourceSshHost;
    data.targetSshUser = data.sourceSshUser;
    data.targetSshPort = data.sourceSshPort;
  }

  if (data.sameCaprover) {
    data.targetCaproverUrl = data.sourceCaproverUrl;
  }

  return data;
}

function maskedConfig() {
  const data = formData();
  const maskKeys = [
    "sourceCaproverPassword",
    "sourceMysqlPassword",
    "targetMysqlPassword",
    "targetDbPassword",
  ];
  for (const key of maskKeys) {
    if (data[key]) data[key] = "****";
  }
  return {
    source: {
      ssh: {
        host: data.sourceSshHost,
        user: data.sourceSshUser || "root",
        port: Number(data.sourceSshPort || 22),
        keyPath: data.sourceSshKey || "",
        privateKey: data.sourceSshPrivateKey || "",
      },
      caprover: {
        url: data.sourceCaproverUrl,
        password: data.sourceCaproverPassword,
      },
      app: data.sourceApp,
      url: data.oldUrl,
    },
    target: {
      sameSsh: data.sameSsh,
      sameCaprover: data.sameCaprover,
      ssh: {
        host: data.targetSshHost,
        user: data.targetSshUser || "root",
        port: Number(data.targetSshPort || 22),
        keyPath: data.targetSshKey || "",
        privateKey: data.targetSshPrivateKey || "",
      },
      caprover: {
        url: data.targetCaproverUrl,
      },
      app: data.targetApp,
      url: data.newUrl,
      wpPath: data.wpPath,
    },
    database: {
      sourceRootUser: data.sourceMysqlUser,
      sourceRootPassword: data.sourceMysqlPassword,
      targetMysqlApp: data.targetMysqlApp,
      targetMysqlImage: data.targetMysqlImage,
      targetRootUser: data.targetMysqlUser,
      targetRootPassword: data.targetMysqlPassword,
      targetDbName: data.targetDbName,
      targetDbUser: data.targetDbUser,
      targetDbPassword: data.targetDbPassword,
    },
    execution: {
      dryRun: data.dryRun,
      allowExistingTarget: data.allowExistingTarget,
    },
  };
}

function safeReuseConfig(config) {
  const copy = structuredClone(config || {});
  const clear = (obj, path) => {
    let cur = obj;
    for (const key of path.slice(0, -1)) {
      if (!cur || typeof cur !== "object") return;
      cur = cur[key];
    }
    if (cur && typeof cur === "object") cur[path.at(-1)] = "";
  };
  [
    ["source", "caprover", "password"],
    ["target", "caprover", "password"],
    ["source", "ssh", "keyPath"],
    ["source", "ssh", "privateKey"],
    ["target", "ssh", "keyPath"],
    ["target", "ssh", "privateKey"],
    ["database", "sourceRootPassword"],
    ["database", "targetRootPassword"],
    ["database", "targetDbPassword"],
  ].forEach((path) => clear(copy, path));
  return copy;
}

function fillFormFromConfig(config) {
  const source = config.source || {};
  const target = config.target || {};
  const database = config.database || {};
  const execution = config.execution || {};

  const set = (name, value = "") => {
    if (form.elements[name]) form.elements[name].value = value || "";
  };
  const setChecked = (name, value) => {
    if (form.elements[name]) form.elements[name].checked = Boolean(value);
  };

  set("sourceSshHost", source.ssh?.host);
  set("sourceSshUser", source.ssh?.user || "root");
  set("sourceSshPort", source.ssh?.port || 22);
  set("sourceSshKey", source.ssh?.keyPath === "****" ? "" : source.ssh?.keyPath);
  set("sourceSshPrivateKey", "");
  set("sourceCaproverUrl", source.caprover?.url);
  set("sourceCaproverPassword", "");
  set("sourceApp", source.app);
  set("oldUrl", source.url);

  setChecked("sameSsh", target.sameSsh !== false);
  setChecked("sameCaprover", target.sameCaprover !== false);
  set("targetSshHost", target.ssh?.host);
  set("targetSshUser", target.ssh?.user || "root");
  set("targetSshPort", target.ssh?.port || 22);
  set("targetSshKey", target.ssh?.keyPath === "****" ? "" : target.ssh?.keyPath);
  set("targetSshPrivateKey", "");
  set("targetCaproverUrl", target.caprover?.url);
  set("targetCaproverPassword", "");
  set("targetApp", target.app);
  set("newUrl", target.url);
  set("wpPath", target.wpPath || "/var/www/html");

  set("sourceMysqlUser", database.sourceRootUser || "root");
  set("sourceMysqlPassword", "");
  set("targetMysqlApp", database.targetMysqlApp);
  set("targetMysqlImage", database.targetMysqlImage || "mysql:8.0");
  set("targetMysqlUser", database.targetRootUser || "root");
  set("targetMysqlPassword", "");
  set("targetDbName", database.targetDbName);
  set("targetDbUser", database.targetDbUser);
  set("targetDbPassword", "");

  setChecked("dryRun", execution.dryRun !== false);
  setChecked("allowExistingTarget", execution.allowExistingTarget);

  refreshPreview();
  setStep(0);
  appendLog("configuração reaproveitada; recoloque senhas e chaves");
}

function rawConfig() {
  const data = formData();
  const sourceKeyPath = data.sourceSshKey === "****" ? "" : data.sourceSshKey || "";
  const targetKeyPath = data.targetSshKey === "****" ? "" : data.targetSshKey || "";
  return {
    source: {
      ssh: {
        host: data.sourceSshHost,
        user: data.sourceSshUser || "root",
        port: Number(data.sourceSshPort || 22),
        keyPath: sourceKeyPath,
        privateKey: data.sourceSshPrivateKey || "",
      },
      caprover: {
        url: data.sourceCaproverUrl,
        password: data.sourceCaproverPassword,
      },
      app: data.sourceApp,
      url: data.oldUrl,
    },
    target: {
      sameSsh: data.sameSsh,
      sameCaprover: data.sameCaprover,
      ssh: {
        host: data.targetSshHost,
        user: data.targetSshUser || "root",
        port: Number(data.targetSshPort || 22),
        keyPath: targetKeyPath,
        privateKey: data.targetSshPrivateKey || "",
      },
      caprover: {
        url: data.targetCaproverUrl,
        password: data.sameCaprover ? data.sourceCaproverPassword : data.targetCaproverPassword,
      },
      app: data.targetApp,
      url: data.newUrl,
      wpPath: data.wpPath,
    },
    database: {
      sourceRootUser: data.sourceMysqlUser,
      sourceRootPassword: data.sourceMysqlPassword,
      targetMysqlApp: data.targetMysqlApp,
      targetMysqlImage: data.targetMysqlImage,
      targetRootUser: data.targetMysqlUser,
      targetRootPassword: data.targetMysqlPassword,
      targetDbName: data.targetDbName,
      targetDbUser: data.targetDbUser,
      targetDbPassword: data.targetDbPassword,
    },
    execution: {
      dryRun: data.dryRun,
      allowExistingTarget: data.allowExistingTarget,
    },
  };
}

function appendLog(line) {
  const now = new Date().toISOString().slice(11, 19);
  consoleOutput.textContent += `\n[${now}] ${line}`;
  consoleOutput.scrollTop = consoleOutput.scrollHeight;
  updateTransferFromText(line);
}

function setTransfer(percent, phase, detail = "") {
  const safePercent = Math.max(0, Math.min(100, percent));
  transferBar.style.width = `${safePercent}%`;
  transferPhase.textContent = phase;
  transferDetail.textContent = detail || `${safePercent}% concluido`;
  progress = Math.max(progress, safePercent);
  progressValue.textContent = `${String(progress).padStart(2, "0")}%`;
}

function updateTransferFromText(text) {
  const raw = String(text || "");
  const normalized = raw.toLowerCase();
  if (!normalized) return;
  if (normalized.includes("failed") || normalized.includes("falhou") || normalized.includes("execucao falhou")) {
    transferPhase.textContent = "Falhou";
    transferDetail.textContent = raw.slice(0, 180);
    return;
  }
  for (const [needle, percent, detail] of transferStages) {
    if (normalized.includes(needle)) {
      setTransfer(percent, percent >= 100 ? "Completo" : "Em curso", detail);
      return;
    }
  }
  const sizeMatch = raw.match(/([0-9]+(?:[.,][0-9]+)?\s*(?:b|kb|mb|gb|tb))/i);
  if (sizeMatch && /arquivo|dump|transfer|volume|tar/i.test(raw)) {
    transferDetail.textContent = `Volume observado: ${sizeMatch[1]}`;
  }
}

function refreshPreview() {
  const data = formData();
  if (form.elements.targetMysqlApp && !form.elements.targetMysqlApp.value && data.targetApp) {
    form.elements.targetMysqlApp.value = data.targetMysqlApp;
  }
  if (form.elements.targetMysqlImage && !form.elements.targetMysqlImage.value) {
    form.elements.targetMysqlImage.value = data.targetMysqlImage;
  }
  if (form.elements.targetDbName && !form.elements.targetDbName.value) {
    form.elements.targetDbName.value = data.targetDbName;
  }
  if (form.elements.targetDbUser && !form.elements.targetDbUser.value) {
    form.elements.targetDbUser.value = data.targetDbUser;
  }
  document.querySelector("#imagePreview").textContent = data.sourceApp
    ? `clone:${data.sourceApp}`
    : "wordpress:detect";
  document.querySelector("#dbHostPreview").textContent = data.targetMysqlApp
    ? `srv-captain--${data.targetMysqlApp}`
    : "srv-captain--nova-app-db";
  document.querySelector("#volumePreview").textContent = data.wpPath || "/var/www/html";
  telemetryMode.textContent = data.dryRun ? "DRY" : "LIVE";
  telemetryRisk.textContent = data.allowExistingTarget ? "MÉDIO" : "BAIXO";
}

function exportConfig() {
  const blob = new Blob([JSON.stringify(maskedConfig(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "wordpress-duplicator-config.masked.json";
  link.click();
  URL.revokeObjectURL(url);
  appendLog("configuração mascarada exportada");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

async function loadHealth() {
  try {
    const health = await api("/api/health");
    dbStatus.textContent = health.postgres.ready ? "DB OK" : "DB OFF";
    dbStatus.style.color = health.postgres.ready ? "var(--radar)" : "var(--amber)";
    appendLog(health.postgres.ready ? "Postgres conectado" : "Postgres indisponível");
  } catch (error) {
    dbStatus.textContent = "DB OFF";
    dbStatus.style.color = "var(--amber)";
    appendLog(`Postgres indisponível: ${error.message}`);
  }
}

async function loadJobs() {
  try {
    const payload = await api("/api/jobs");
    if (!payload.jobs.length) {
      jobHistory.innerHTML = "<p>Nenhuma execução registrada.</p>";
      return;
    }
    jobHistory.innerHTML = payload.jobs
      .map(
        (job) => `
          <article class="history__item" data-job-id="${job.id}">
            <small>${job.status}</small>
            <strong>${escapeHtml(job.source_app)} → ${escapeHtml(job.target_app)}</strong>
            <span>${escapeHtml(job.old_url)} → ${escapeHtml(job.new_url)}</span>
            <button class="history__reuse" type="button" data-reuse-id="${job.id}">Reusar</button>
          </article>
        `
      )
      .join("");
    for (const button of jobHistory.querySelectorAll("[data-reuse-id]")) {
      button.addEventListener("click", () => {
        const job = payload.jobs.find((item) => item.id === button.dataset.reuseId);
        if (!job?.config_snapshot) {
          appendLog("histórico sem configuração para reuso");
          return;
        }
        fillFormFromConfig(safeReuseConfig(job.config_snapshot));
      });
    }
  } catch (error) {
    jobHistory.innerHTML = `<p>Histórico indisponível: ${escapeHtml(error.message)}</p>`;
  }
}

async function pollJob(id) {
  window.clearInterval(activeJobPoll);
  activeJobPoll = window.setInterval(async () => {
    try {
      const payload = await api(`/api/jobs/${id}`);
      const job = payload.job;
      const last = payload.logs.slice(-6).map((entry) => `[${entry.level}] ${entry.message}`);
      consoleOutput.textContent = last.join("\n") || consoleOutput.textContent;
      payload.logs.forEach((entry) => updateTransferFromText(entry.message));
      telemetryState.textContent = job.status.toUpperCase();
      if (["succeeded", "failed", "cancelled"].includes(job.status)) {
        window.clearInterval(activeJobPoll);
        await loadJobs();
        appendLog(`job ${job.status}: ${id}`);
        if (job.status === "succeeded") setTransfer(100, "Completo", "Clone concluido com sucesso");
      }
    } catch (error) {
      appendLog(`falha ao acompanhar job: ${error.message}`);
      window.clearInterval(activeJobPoll);
    }
  }, 3500);
}

async function saveJob() {
  try {
    const payload = await api("/api/jobs", {
      method: "POST",
      body: JSON.stringify({ config: maskedConfig() }),
    });
    appendLog(`job registrado no Postgres: ${payload.id}`);
    await loadJobs();
  } catch (error) {
    appendLog(`falha ao registrar job: ${error.message}`);
  }
}

async function executeJob() {
  const config = rawConfig();
  const validationError = validateRealRun(config);
  if (validationError) {
    appendLog(`execução real bloqueada: ${validationError}`);
    return;
  }
  if (config.execution.dryRun) {
    appendLog("execução real bloqueada: desative Dry-run para clonar de verdade");
    return;
  }
  const typed = window.prompt('Digite EXECUTAR para iniciar a clonagem real');
  if (typed !== "EXECUTAR") {
    appendLog("execução real cancelada");
    return;
  }
  try {
    const payload = await api("/api/jobs", {
      method: "POST",
      body: JSON.stringify({ config, run: true }),
    });
    setTransfer(4, "Iniciando", "Job enviado para o runner");
    appendLog(`execução real iniciada: ${payload.id}`);
    await loadJobs();
    await pollJob(payload.id);
  } catch (error) {
    appendLog(`falha ao iniciar execução real: ${error.message}`);
  }
}

function validateRealRun(config) {
  const sourceKeyPath = config.source.ssh.keyPath || "";
  const sourcePrivateKey = config.source.ssh.privateKey || "";
  const targetKeyPath = config.target.ssh.keyPath || "";
  const targetPrivateKey = config.target.ssh.privateKey || "";

  if (sourceKeyPath && sourceKeyPath !== "****" && !sourceKeyPath.startsWith("/") && !sourceKeyPath.startsWith("~")) {
    return "o campo Caminho da chave SSH origem precisa ser um caminho, como /data/ssh-keys/id_rsa. Para colar uma chave, use o campo Chave privada SSH completa.";
  }
  if (targetKeyPath && targetKeyPath !== "****" && !targetKeyPath.startsWith("/") && !targetKeyPath.startsWith("~")) {
    return "o campo Caminho da chave SSH destino precisa ser um caminho, como /data/ssh-keys/id_rsa. Para colar uma chave, use o campo Chave privada SSH destino completa.";
  }
  if (sourcePrivateKey && !sourcePrivateKey.includes("PRIVATE KEY")) {
    return "a chave privada SSH origem parece incompleta. Ela deve conter BEGIN/END PRIVATE KEY.";
  }
  if (!config.target.sameSsh && targetPrivateKey && !targetPrivateKey.includes("PRIVATE KEY")) {
    return "a chave privada SSH destino parece incompleta. Ela deve conter BEGIN/END PRIVATE KEY.";
  }
  if (!sourceKeyPath && !sourcePrivateKey) {
    return "informe uma chave privada SSH origem completa ou um caminho de chave existente dentro do container.";
  }
  return "";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function simulateScan(button) {
  const scan = button.dataset.scan;
  const status = document.querySelector(`[data-status="${scan}"]`);
  button.classList.add("is-ok");
  status.textContent = "OK";
  progress = Math.min(42, progress + 8);
  progressValue.textContent = `${String(progress).padStart(2, "0")}%`;
  appendLog(scanMessages[scan]);
}

function simulateRun() {
  const items = [...missionList.children];
  items.forEach((item) => item.classList.remove("is-done"));
  progress = 44;
  progressValue.textContent = "44%";
  telemetryState.textContent = "EXEC";
  setTransfer(8, "Simulando", "Sequencia de clonagem iniciada");
  appendLog("sequência de duplicação simulada iniciada");
  saveJob();

  items.forEach((item, index) => {
    window.setTimeout(() => {
      item.classList.add("is-done");
      progress = Math.min(100, 44 + Math.round(((index + 1) / items.length) * 56));
      progressValue.textContent = `${String(progress).padStart(2, "0")}%`;
      appendLog(item.textContent.toLowerCase() + " concluído");
      if (index === items.length - 1) telemetryState.textContent = "OK";
    }, 360 * (index + 1));
  });
}

function drawRadar() {
  const size = canvas.width;
  const center = size / 2;
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = "rgba(166,255,77,0.28)";
  ctx.lineWidth = 1;

  for (let r = 42; r <= 142; r += 34) {
    ctx.beginPath();
    ctx.arc(center, center, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  for (let i = 0; i < 8; i += 1) {
    const angle = (Math.PI * 2 * i) / 8;
    ctx.beginPath();
    ctx.moveTo(center, center);
    ctx.lineTo(center + Math.cos(angle) * 148, center + Math.sin(angle) * 148);
    ctx.stroke();
  }

  const gradient = ctx.createRadialGradient(center, center, 8, center, center, 150);
  gradient.addColorStop(0, "rgba(166,255,77,0.38)");
  gradient.addColorStop(1, "rgba(166,255,77,0)");

  ctx.save();
  ctx.translate(center, center);
  ctx.rotate(sweep);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.arc(0, 0, 150, -0.08, 0.42);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.restore();

  const blips = [
    [0.35, 72],
    [1.74, 112],
    [3.9, 94],
  ];
  for (const [angle, distance] of blips) {
    ctx.beginPath();
    ctx.arc(center + Math.cos(angle) * distance, center + Math.sin(angle) * distance, 4, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,181,71,0.92)";
    ctx.fill();
  }

  sweep += 0.016;
  requestAnimationFrame(drawRadar);
}

stepButtons.forEach((button) => {
  button.addEventListener("click", () => setStep(Number(button.dataset.step)));
});

prevButton.addEventListener("click", () => setStep(currentStep - 1));
nextButton.addEventListener("click", () => setStep(currentStep + 1));
exportButton.addEventListener("click", exportConfig);
dryRunButton.addEventListener("click", () => {
  form.elements.dryRun.checked = !form.elements.dryRun.checked;
  refreshPreview();
  appendLog(`modo ${form.elements.dryRun.checked ? "dry-run" : "live"} selecionado`);
});
simulateButton.addEventListener("click", simulateRun);
executeButton.addEventListener("click", executeJob);

document.querySelectorAll(".scan-row").forEach((button) => {
  button.addEventListener("click", () => simulateScan(button));
});

form.addEventListener("input", refreshPreview);
form.addEventListener("change", refreshPreview);

setStep(0);
refreshPreview();
drawRadar();
loadHealth();
loadJobs();
