const screens = [...document.querySelectorAll(".screen")];
const stepButtons = [...document.querySelectorAll(".step")];
const prevButton = document.querySelector("#prevStep");
const nextButton = document.querySelector("#nextStep");
const exportButton = document.querySelector("#exportConfig");
const dryRunButton = document.querySelector("#toggleDryRun");
const simulateButton = document.querySelector("#simulateRun");
const form = document.querySelector("#wizardForm");
const consoleOutput = document.querySelector("#consoleOutput");
const progressValue = document.querySelector("#progressValue");
const missionList = document.querySelector("#missionList");
const telemetryMode = document.querySelector("#telemetryMode");
const telemetryRisk = document.querySelector("#telemetryRisk");
const telemetryState = document.querySelector("#telemetryState");
const canvas = document.querySelector("#radarCanvas");
const ctx = canvas.getContext("2d");

let currentStep = 0;
let progress = 0;
let sweep = 0;

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
        user: data.sourceSshUser,
        port: Number(data.sourceSshPort || 22),
        keyPath: data.sourceSshKey || "",
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
        user: data.targetSshUser,
        port: Number(data.targetSshPort || 22),
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
}

function refreshPreview() {
  const data = formData();
  document.querySelector("#imagePreview").textContent = data.sourceApp
    ? `clone:${data.sourceApp}`
    : "wordpress:detect";
  document.querySelector("#dbHostPreview").textContent = data.targetMysqlApp
    ? `srv-captain--${data.targetMysqlApp}`
    : "srv-captain--mysql";
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
  appendLog("sequência de duplicação simulada iniciada");

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

document.querySelectorAll(".scan-row").forEach((button) => {
  button.addEventListener("click", () => simulateScan(button));
});

form.addEventListener("input", refreshPreview);
form.addEventListener("change", refreshPreview);

setStep(0);
refreshPreview();
drawRadar();
