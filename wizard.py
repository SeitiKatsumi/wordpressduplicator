#!/usr/bin/env python3
"""
WordPress Duplicator Wizard

Interactive clone flow for WordPress apps hosted on CapRover.

Run this from an admin workstation that has:
- ssh
- caprover CLI authenticated by password flags, or CAPROVER_URL/CAPROVER_PASSWORD

The remote source/target hosts need Docker access for the SSH user.
"""

from __future__ import annotations

import getpass
import json
import os
import re
import secrets
import shlex
import subprocess
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Optional


STATE_DIR = Path(".wordpress-duplicator-state")
REPORT_FILE = Path("wordpress-duplicator-report.json")
LOG_FILE = Path("wordpress-duplicator-wizard.log")
WP_PATH_DEFAULT = "/var/www/html"
CAPTAIN_OVERLAY_NETWORK = "captain-overlay-network"


APP_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9-]{1,62}$")
URL_RE = re.compile(r"^https?://[^\s/]+(?:/.*)?$")


@dataclass
class SshTarget:
    label: str
    host: str
    user: str
    port: int = 22
    key_path: str = ""

    def base_cmd(self) -> list[str]:
        cmd = ["ssh", "-p", str(self.port), "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new"]
        if self.key_path:
            cmd.extend(["-i", self.key_path])
        cmd.append(f"{self.user}@{self.host}")
        return cmd


@dataclass
class CapRoverTarget:
    url: str
    password: str


@dataclass
class CloneConfig:
    source_ssh: SshTarget
    target_ssh: SshTarget
    source_caprover: CapRoverTarget
    target_caprover: CapRoverTarget
    source_app: str
    target_app: str
    old_url: str
    new_url: str
    wp_path: str = WP_PATH_DEFAULT
    source_mysql_root_user: str = "root"
    source_mysql_root_password: str = ""
    target_mysql_app: str = ""
    target_mysql_root_user: str = "root"
    target_mysql_root_password: str = ""
    target_db_name: str = ""
    target_db_user: str = ""
    target_db_password: str = ""
    allow_existing_target: bool = False
    dry_run: bool = False


@dataclass
class SourceDiscovery:
    source_service: str = ""
    source_container: str = ""
    source_image: str = ""
    db_name: str = ""
    db_user: str = ""
    db_password: str = ""
    db_host: str = ""
    table_prefix: str = "wp_"
    mysql_app: str = ""
    mysql_container: str = ""


@dataclass
class TargetDiscovery:
    target_service: str = ""
    target_container: str = ""
    mysql_container: str = ""
    target_db_host: str = ""


@dataclass
class WizardState:
    config: Optional[CloneConfig] = None
    source: SourceDiscovery = field(default_factory=SourceDiscovery)
    target: TargetDiscovery = field(default_factory=TargetDiscovery)
    checkpoints: dict[str, str] = field(default_factory=dict)


def log(message: str) -> None:
    safe = redact(message)
    line = f"[{time.strftime('%Y-%m-%dT%H:%M:%S%z')}] {safe}"
    print(line)
    with LOG_FILE.open("a", encoding="utf-8") as fh:
        fh.write(line + "\n")


SECRETS: list[str] = []


def remember_secret(value: str) -> None:
    if value and value not in SECRETS:
        SECRETS.append(value)


def redact(text: str) -> str:
    for secret in SECRETS:
        if secret:
            text = text.replace(secret, "****")
    return text


def prompt(label: str, default: str = "", secret: bool = False, required: bool = True) -> str:
    suffix = f" [{default}]" if default else ""
    while True:
        if secret:
            value = getpass.getpass(f"{label}{suffix}: ").strip()
        else:
            value = input(f"{label}{suffix}: ").strip()
        if not value:
            value = default
        if value or not required:
            if secret:
                remember_secret(value)
            return value
        print("Valor obrigatorio.")


def prompt_bool(label: str, default: bool = False) -> bool:
    hint = "S/n" if default else "s/N"
    value = input(f"{label} [{hint}]: ").strip().lower()
    if not value:
        return default
    return value in {"s", "sim", "y", "yes", "1", "true"}


def require_local_cmd(name: str) -> None:
    if subprocess.run(["where" if os.name == "nt" else "which", name], capture_output=True, text=True).returncode != 0:
        raise RuntimeError(f"Comando local nao encontrado: {name}")


def run_local(args: list[str], *, input_bytes: bytes | None = None, capture: bool = False, check: bool = True) -> subprocess.CompletedProcess:
    log("+ " + redact(" ".join(shlex.quote(a) for a in args)))
    if STATE.config and STATE.config.dry_run:
        return subprocess.CompletedProcess(args, 0, stdout="", stderr="")
    return subprocess.run(args, input=input_bytes, capture_output=capture, check=check, text=False)


def ssh(target: SshTarget, command: str, *, capture: bool = False, check: bool = True, input_bytes: bytes | None = None) -> subprocess.CompletedProcess:
    args = target.base_cmd() + [command]
    return run_local(args, input_bytes=input_bytes, capture=capture, check=check)


def ssh_text(target: SshTarget, command: str) -> str:
    cp = ssh(target, command, capture=True)
    return cp.stdout.decode("utf-8", errors="replace").strip()


def captain_service(app: str) -> str:
    return f"srv-captain--{app}"


def validate_or_die(config: CloneConfig) -> None:
    for label, value in [("source_app", config.source_app), ("target_app", config.target_app)]:
        if not APP_RE.match(value):
            raise RuntimeError(f"{label} invalido: {value}")
    for label, value in [("old_url", config.old_url), ("new_url", config.new_url)]:
        if not URL_RE.match(value):
            raise RuntimeError(f"{label} invalida: {value}")
    if config.old_url == config.new_url:
        raise RuntimeError("A URL antiga e a nova nao podem ser iguais.")


def checkpoint(name: str) -> None:
    STATE.checkpoints[name] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    save_state()


def done(name: str) -> bool:
    return name in STATE.checkpoints


def state_path() -> Path:
    STATE_DIR.mkdir(exist_ok=True)
    return STATE_DIR / "wizard-state.json"


def to_jsonable(obj):
    if hasattr(obj, "__dataclass_fields__"):
        return asdict(obj)
    return obj


def save_state() -> None:
    state_path().write_text(json.dumps(to_jsonable(STATE), indent=2), encoding="utf-8")


def load_state() -> Optional[WizardState]:
    path = state_path()
    if not path.exists():
        return None
    raw = json.loads(path.read_text(encoding="utf-8"))
    cfg = raw.get("config")
    config = None
    if cfg:
        config = CloneConfig(
            source_ssh=SshTarget(**cfg["source_ssh"]),
            target_ssh=SshTarget(**cfg["target_ssh"]),
            source_caprover=CapRoverTarget(**cfg["source_caprover"]),
            target_caprover=CapRoverTarget(**cfg["target_caprover"]),
            source_app=cfg["source_app"],
            target_app=cfg["target_app"],
            old_url=cfg["old_url"],
            new_url=cfg["new_url"],
            wp_path=cfg.get("wp_path", WP_PATH_DEFAULT),
            source_mysql_root_user=cfg.get("source_mysql_root_user", "root"),
            source_mysql_root_password=cfg.get("source_mysql_root_password", ""),
            target_mysql_app=cfg.get("target_mysql_app", ""),
            target_mysql_root_user=cfg.get("target_mysql_root_user", "root"),
            target_mysql_root_password=cfg.get("target_mysql_root_password", ""),
            target_db_name=cfg.get("target_db_name", ""),
            target_db_user=cfg.get("target_db_user", ""),
            target_db_password=cfg.get("target_db_password", ""),
            allow_existing_target=cfg.get("allow_existing_target", False),
            dry_run=cfg.get("dry_run", False),
        )
    return WizardState(
        config=config,
        source=SourceDiscovery(**raw.get("source", {})),
        target=TargetDiscovery(**raw.get("target", {})),
        checkpoints=raw.get("checkpoints", {}),
    )


def collect_ssh(label: str, defaults: Optional[SshTarget] = None) -> SshTarget:
    print(f"\nSSH {label}")
    host = prompt("Host/IP", defaults.host if defaults else "")
    user = prompt("Usuario", defaults.user if defaults else "root")
    port = int(prompt("Porta", str(defaults.port if defaults else 22)))
    key_path = prompt("Caminho da chave SSH (vazio para agente/senha)", defaults.key_path if defaults else "", required=False)
    return SshTarget(label=label, host=host, user=user, port=port, key_path=key_path)


def collect_caprover(label: str, defaults: Optional[CapRoverTarget] = None) -> CapRoverTarget:
    print(f"\nCapRover {label}")
    url = prompt("URL do CapRover, ex: https://captain.example.com", defaults.url if defaults else "")
    password = prompt("Senha do CapRover", defaults.password if defaults else "", secret=True)
    return CapRoverTarget(url=url, password=password)


def collect_config() -> CloneConfig:
    print("WordPress Duplicator Wizard\n")
    print("Etapa 1: origem, onde esta o WordPress que sera usado para ser clonado.")
    source_ssh = collect_ssh("origem")
    source_caprover = collect_caprover("origem")
    source_app = prompt("Nome da app WordPress origem no CapRover")
    old_url = prompt("URL atual do WordPress origem, ex: https://site-antigo.com")

    print("\nEtapa 2: destino, onde a nova app e o novo banco serao criados.")
    same_server = prompt_bool("O destino e o mesmo servidor SSH da origem?", True)
    target_ssh = source_ssh if same_server else collect_ssh("destino")
    same_caprover = prompt_bool("O destino usa a mesma instancia CapRover da origem?", same_server)
    target_caprover = source_caprover if same_caprover else collect_caprover("destino")
    target_app = prompt("Nome da nova app no CapRover")
    new_url = prompt("Nova URL que sera gravada no WordPress, ex: https://site-novo.com")
    wp_path = prompt("Caminho do WordPress dentro do container", WP_PATH_DEFAULT)

    print("\nEtapa 3: banco MySQL.")
    source_root_user = prompt("Usuario root/admin MySQL da origem", "root")
    source_root_password = prompt("Senha root/admin MySQL da origem", secret=True)
    target_mysql_app = prompt("App MySQL no CapRover destino (vazio = detectar pela origem)", "", required=False)
    target_root_user = prompt("Usuario root/admin MySQL destino", source_root_user)
    target_root_password = prompt("Senha root/admin MySQL destino", source_root_password, secret=True)
    target_db_name = prompt("Nome do novo banco (vazio = gerar)", "", required=False)
    target_db_user = prompt("Usuario do novo banco (vazio = gerar)", "", required=False)
    target_db_password = prompt("Senha do novo banco (vazio = gerar)", "", secret=True, required=False)

    allow_existing = prompt_bool("Permitir reutilizar app/banco destino se ja existirem?", False)
    dry_run = prompt_bool("Executar apenas dry-run?", False)

    cfg = CloneConfig(
        source_ssh=source_ssh,
        target_ssh=target_ssh,
        source_caprover=source_caprover,
        target_caprover=target_caprover,
        source_app=source_app,
        target_app=target_app,
        old_url=old_url.rstrip("/"),
        new_url=new_url.rstrip("/"),
        wp_path=wp_path,
        source_mysql_root_user=source_root_user,
        source_mysql_root_password=source_root_password,
        target_mysql_app=target_mysql_app,
        target_mysql_root_user=target_root_user,
        target_mysql_root_password=target_root_password,
        target_db_name=target_db_name,
        target_db_user=target_db_user,
        target_db_password=target_db_password,
        allow_existing_target=allow_existing,
        dry_run=dry_run,
    )
    validate_or_die(cfg)
    return cfg


def remote_preflight(target: SshTarget) -> None:
    ssh(target, "command -v docker >/dev/null && docker info >/dev/null")


def discover_source() -> None:
    cfg = STATE.config
    assert cfg
    src = STATE.source
    src.source_service = captain_service(cfg.source_app)
    src.source_container = ssh_text(
        cfg.source_ssh,
        f"docker ps --filter {shlex.quote('label=com.docker.swarm.service.name=' + src.source_service)} --format '{{{{.ID}}}}' | head -n 1",
    )
    if not src.source_container:
        raise RuntimeError(f"Container da origem nao encontrado: {src.source_service}")

    q_wp = shlex.quote(cfg.wp_path)
    ssh(cfg.source_ssh, f"docker exec {src.source_container} sh -lc {shlex.quote(f'test -f {q_wp}/wp-config.php && test -d {q_wp}/wp-content')}")
    src.source_image = ssh_text(cfg.source_ssh, f"docker service inspect {src.source_service} --format '{{{{.Spec.TaskTemplate.ContainerSpec.Image}}}}'")
    src.db_name = wp_config_value(cfg.source_ssh, src.source_container, cfg.wp_path, "DB_NAME")
    src.db_user = wp_config_value(cfg.source_ssh, src.source_container, cfg.wp_path, "DB_USER")
    src.db_password = wp_config_value(cfg.source_ssh, src.source_container, cfg.wp_path, "DB_PASSWORD")
    remember_secret(src.db_password)
    src.db_host = wp_config_value(cfg.source_ssh, src.source_container, cfg.wp_path, "DB_HOST")
    src.table_prefix = wp_table_prefix(cfg.source_ssh, src.source_container, cfg.wp_path)
    src.mysql_app = mysql_app_from_host(src.db_host)
    src.mysql_container = mysql_container(cfg.source_ssh, src.mysql_app)
    if not src.mysql_container:
        raise RuntimeError(f"Container MySQL origem nao encontrado para DB_HOST={src.db_host}")
    log(f"Origem OK: app={cfg.source_app}, image={src.source_image}, db={src.db_name}, db_host={src.db_host}")


def wp_config_value(target: SshTarget, container: str, wp_path: str, key: str) -> str:
    php = (
        "$file=" + repr(f"{wp_path}/wp-config.php") + ";"
        "$c=file_get_contents($file);"
        "if(preg_match('/define\\s*\\(\\s*[\"\\']" + key + "[\"\\']\\s*,\\s*[\"\\']([^\"\\']*)[\"\\']\\s*\\)/',$c,$m)){echo $m[1]; exit;}"
        "$c=preg_replace('/require_once\\s*\\(?\\s*ABSPATH\\s*\\.\\s*[\"\\']wp-settings\\.php[\"\\']\\s*\\)?\\s*;?/','return;',$c);"
        "$c=preg_replace('/^\\s*<\\?php/','',$c);"
        "if(!defined('ABSPATH')) define('ABSPATH'," + repr(f"{wp_path}/") + ");"
        "try{eval($c);}catch(Throwable $e){}"
        "if(defined(" + repr(key) + ")){echo constant(" + repr(key) + "); exit;}"
        "$map=['DB_NAME'=>'WORDPRESS_DB_NAME','DB_USER'=>'WORDPRESS_DB_USER','DB_PASSWORD'=>'WORDPRESS_DB_PASSWORD','DB_HOST'=>'WORDPRESS_DB_HOST'];"
        "if(isset($map[" + repr(key) + "])) echo getenv($map[" + repr(key) + "]) ?: '';"
    )
    return ssh_text(target, f"docker exec {container} php -r {shlex.quote(php)}")


def wp_table_prefix(target: SshTarget, container: str, wp_path: str) -> str:
    php = (
        "$c=file_get_contents(" + repr(f"{wp_path}/wp-config.php") + ");"
        "if(preg_match('/\\$table_prefix\\s*=\\s*[\"\\']([^\"\\']+)[\"\\']\\s*;/',$c,$m)) echo $m[1]; else echo 'wp_';"
    )
    return ssh_text(target, f"docker exec {container} php -r {shlex.quote(php)}")


def mysql_app_from_host(db_host: str) -> str:
    host = db_host.split(":")[0]
    if host.startswith("srv-captain--"):
        return host.replace("srv-captain--", "", 1)
    return host


def mysql_container(target: SshTarget, mysql_app: str) -> str:
    service = captain_service(mysql_app)
    return ssh_text(
        target,
        f"docker ps --filter {shlex.quote('label=com.docker.swarm.service.name=' + service)} --format '{{{{.ID}}}}' | head -n 1",
    )


def caprover_api(cap: CapRoverTarget, path: str, data: str, method: str = "POST") -> None:
    require_local_cmd("caprover")
    run_local([
        "caprover",
        "api",
        "--caproverUrl",
        cap.url,
        "--caproverPassword",
        cap.password,
        "--path",
        path,
        "--method",
        method,
        "--data",
        data,
    ])


def caprover_deploy_image(cap: CapRoverTarget, app: str, image: str) -> None:
    require_local_cmd("caprover")
    run_local([
        "caprover",
        "deploy",
        "--caproverUrl",
        cap.url,
        "--caproverPassword",
        cap.password,
        "--caproverApp",
        app,
        "--imageName",
        image,
    ])


def create_target_app() -> None:
    cfg = STATE.config
    assert cfg
    target_service = captain_service(cfg.target_app)
    existing = ssh_text(cfg.target_ssh, f"docker service ls --format '{{{{.Name}}}}' | grep -x {shlex.quote(target_service)} || true")
    if existing and not cfg.allow_existing_target:
        raise RuntimeError("A app destino ja existe. Reexecute permitindo reutilizacao se for intencional.")
    if not existing:
        payload = json.dumps({"appName": cfg.target_app, "hasPersistentData": True})
        caprover_api(cfg.target_caprover, "/user/apps/appDefinitions/register", payload)
    else:
        log(f"App destino ja existe e sera reutilizada: {cfg.target_app}")
    STATE.target.target_service = target_service


def deploy_target_image() -> None:
    cfg = STATE.config
    assert cfg
    caprover_deploy_image(cfg.target_caprover, cfg.target_app, STATE.source.source_image)
    STATE.target.target_container = wait_container(cfg.target_ssh, STATE.target.target_service)


def wait_container(target: SshTarget, service: str, timeout: int = 180) -> str:
    for _ in range(max(1, timeout // 3)):
        container = ssh_text(
            target,
            f"docker ps --filter {shlex.quote('label=com.docker.swarm.service.name=' + service)} --format '{{{{.ID}}}}' | head -n 1",
        )
        if container:
            return container
        time.sleep(3)
    raise RuntimeError(f"Container nao subiu para service {service}")


def copy_files() -> None:
    cfg = STATE.config
    assert cfg
    ssh(
        cfg.source_ssh,
        f"docker exec {STATE.source.source_container} sh -lc {shlex.quote(f'test -d {cfg.wp_path} && test -f {cfg.wp_path}/wp-config.php')}",
    )
    ssh(
        cfg.target_ssh,
        f"docker exec {STATE.target.target_container} sh -lc {shlex.quote(f'mkdir -p {cfg.wp_path}')}",
    )
    src_cmd = cfg.source_ssh.base_cmd() + [
        f"docker exec {STATE.source.source_container} tar -C {shlex.quote(cfg.wp_path)} -czf - ."
    ]
    dst_cmd = cfg.target_ssh.base_cmd() + [
        f"docker exec -i {STATE.target.target_container} tar -C {shlex.quote(cfg.wp_path)} -xzf -"
    ]
    log("+ copiar arquivos WordPress origem -> destino via tar/ssh")
    if cfg.dry_run:
        return
    p1 = subprocess.Popen(src_cmd, stdout=subprocess.PIPE)
    p2 = subprocess.Popen(dst_cmd, stdin=p1.stdout)
    assert p1.stdout is not None
    p1.stdout.close()
    rc2 = p2.wait()
    rc1 = p1.wait()
    if rc1 != 0 or rc2 != 0:
        raise RuntimeError(f"Falha ao copiar arquivos: source_rc={rc1}, target_rc={rc2}")


def generate_db_names() -> None:
    cfg = STATE.config
    assert cfg
    suffix = re.sub(r"[^a-zA-Z0-9_]", "_", cfg.target_app)
    if not cfg.target_db_name:
        cfg.target_db_name = f"{STATE.source.db_name}_{suffix}"[:60]
    if not cfg.target_db_user:
        cfg.target_db_user = f"{STATE.source.db_user}_{suffix}"[:30]
    if not cfg.target_db_password:
        cfg.target_db_password = secrets.token_urlsafe(24)
    remember_secret(cfg.target_db_password)
    target_mysql_app = cfg.target_mysql_app or STATE.source.mysql_app
    STATE.target.mysql_container = mysql_container(cfg.target_ssh, target_mysql_app)
    if not STATE.target.mysql_container:
        raise RuntimeError(f"Container MySQL destino nao encontrado: {target_mysql_app}")
    STATE.target.target_db_host = f"srv-captain--{target_mysql_app}"


def mysql_exec(target: SshTarget, container: str, user: str, password: str, sql: str) -> None:
    remember_secret(password)
    cmd = f"docker exec -i {container} mysql -u{shlex.quote(user)} -p{shlex.quote(password)} -e {shlex.quote(sql)}"
    ssh(target, cmd)


def clone_database() -> None:
    cfg = STATE.config
    assert cfg
    generate_db_names()
    exists_sql = f"SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME='{sql_escape(cfg.target_db_name)}';"
    existing = ssh_text(
        cfg.target_ssh,
        f"docker exec -i {STATE.target.mysql_container} mysql -u{shlex.quote(cfg.target_mysql_root_user)} -p{shlex.quote(cfg.target_mysql_root_password)} -NBe {shlex.quote(exists_sql)} || true",
    )
    if existing and not cfg.allow_existing_target:
        raise RuntimeError(f"Banco destino ja existe: {cfg.target_db_name}")

    mysql_exec(cfg.target_ssh, STATE.target.mysql_container, cfg.target_mysql_root_user, cfg.target_mysql_root_password, f"CREATE DATABASE IF NOT EXISTS `{cfg.target_db_name}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;")
    mysql_exec(cfg.target_ssh, STATE.target.mysql_container, cfg.target_mysql_root_user, cfg.target_mysql_root_password, f"CREATE USER IF NOT EXISTS '{sql_escape(cfg.target_db_user)}'@'%' IDENTIFIED BY '{sql_escape(cfg.target_db_password)}';")
    mysql_exec(cfg.target_ssh, STATE.target.mysql_container, cfg.target_mysql_root_user, cfg.target_mysql_root_password, f"GRANT ALL PRIVILEGES ON `{cfg.target_db_name}`.* TO '{sql_escape(cfg.target_db_user)}'@'%'; FLUSH PRIVILEGES;")

    src_dump_cmd = cfg.source_ssh.base_cmd() + [
        "docker exec -i "
        + STATE.source.mysql_container
        + f" mysqldump -u{shlex.quote(cfg.source_mysql_root_user)} -p{shlex.quote(cfg.source_mysql_root_password)} --single-transaction --routines --triggers --events {shlex.quote(STATE.source.db_name)}"
    ]
    dst_restore_cmd = cfg.target_ssh.base_cmd() + [
        "docker exec -i "
        + STATE.target.mysql_container
        + f" mysql -u{shlex.quote(cfg.target_mysql_root_user)} -p{shlex.quote(cfg.target_mysql_root_password)} {shlex.quote(cfg.target_db_name)}"
    ]
    log("+ duplicar banco via mysqldump/mysql por SSH")
    if cfg.dry_run:
        return
    p1 = subprocess.Popen(src_dump_cmd, stdout=subprocess.PIPE)
    p2 = subprocess.Popen(dst_restore_cmd, stdin=p1.stdout)
    assert p1.stdout is not None
    p1.stdout.close()
    rc2 = p2.wait()
    rc1 = p1.wait()
    if rc1 != 0 or rc2 != 0:
        raise RuntimeError(f"Falha ao duplicar banco: dump_rc={rc1}, restore_rc={rc2}")


def sql_escape(value: str) -> str:
    return value.replace("'", "''")


def update_target_wp_config() -> None:
    cfg = STATE.config
    assert cfg
    values = {
        "DB_NAME": cfg.target_db_name,
        "DB_USER": cfg.target_db_user,
        "DB_PASSWORD": cfg.target_db_password,
        "DB_HOST": STATE.target.target_db_host,
    }
    php = (
        "$file=" + repr(f"{cfg.wp_path}/wp-config.php") + ";"
        "$c=file_get_contents($file);"
        "$values=" + php_array(values) + ";"
        "foreach($values as $k=>$v){$c=preg_replace('/define\\s*\\(\\s*[\"\\']'.preg_quote($k,'/').'[\"\\']\\s*,\\s*[\"\\'][^\"\\']*[\"\\']\\s*\\)\\s*;/',\"define('\".$k.\"', \".var_export($v,true).\");\",$c,1);}"
        "file_put_contents($file,$c);"
    )
    ssh(cfg.target_ssh, f"docker exec {STATE.target.target_container} php -r {shlex.quote(php)}")


def php_array(values: dict[str, str]) -> str:
    parts = []
    for key, value in values.items():
        parts.append(f"{php_string(key)}=>{php_string(value)}")
    return "array(" + ",".join(parts) + ")"


def php_string(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def run_wp_search_replace() -> None:
    cfg = STATE.config
    assert cfg
    wp_inside = (
        f"cd {shlex.quote(cfg.wp_path)} && "
        f"wp --allow-root search-replace {shlex.quote(cfg.old_url)} {shlex.quote(cfg.new_url)} --all-tables --precise --recurse-objects --skip-columns=guid && "
        f"wp --allow-root option update home {shlex.quote(cfg.new_url)} && "
        f"wp --allow-root option update siteurl {shlex.quote(cfg.new_url)}"
    )
    has_wp = ssh_text(cfg.target_ssh, f"docker exec {STATE.target.target_container} sh -lc 'command -v wp >/dev/null 2>&1 && echo yes || echo no'")
    if has_wp == "yes":
        ssh(cfg.target_ssh, f"docker exec {STATE.target.target_container} sh -lc {shlex.quote(wp_inside)}")
        return

    wp_cli = (
        f"docker run --rm --volumes-from {STATE.target.target_container} --network {CAPTAIN_OVERLAY_NETWORK} "
        f"wordpress:cli --allow-root --path={shlex.quote(cfg.wp_path)} "
        f"search-replace {shlex.quote(cfg.old_url)} {shlex.quote(cfg.new_url)} --all-tables --precise --recurse-objects --skip-columns=guid"
    )
    ssh(cfg.target_ssh, wp_cli)
    ssh(cfg.target_ssh, f"docker run --rm --volumes-from {STATE.target.target_container} --network {CAPTAIN_OVERLAY_NETWORK} wordpress:cli --allow-root --path={shlex.quote(cfg.wp_path)} option update home {shlex.quote(cfg.new_url)}")
    ssh(cfg.target_ssh, f"docker run --rm --volumes-from {STATE.target.target_container} --network {CAPTAIN_OVERLAY_NETWORK} wordpress:cli --allow-root --path={shlex.quote(cfg.wp_path)} option update siteurl {shlex.quote(cfg.new_url)}")


def fix_permissions() -> None:
    cfg = STATE.config
    assert cfg
    script = (
        f"uidgid=$(id -u www-data >/dev/null 2>&1 && echo www-data:www-data || echo $(id -u):$(id -g)); "
        f"chown -R \"$uidgid\" {shlex.quote(cfg.wp_path)}/wp-content || true; "
        f"find {shlex.quote(cfg.wp_path)} -type d -exec chmod 755 {{}} \\; ; "
        f"find {shlex.quote(cfg.wp_path)} -type f -exec chmod 644 {{}} \\;"
    )
    ssh(cfg.target_ssh, f"docker exec {STATE.target.target_container} sh -lc {shlex.quote(script)}")


def validate_target() -> None:
    cfg = STATE.config
    assert cfg
    ssh(cfg.target_ssh, f"docker exec {STATE.target.target_container} sh -lc {shlex.quote(f'test -f {cfg.wp_path}/wp-config.php && test -d {cfg.wp_path}/wp-content/plugins && test -d {cfg.wp_path}/wp-content/themes')}")
    validation_sql = f'SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA="{sql_escape(cfg.target_db_name)}";'
    count = ssh_text(
        cfg.target_ssh,
        f"docker exec -i {STATE.target.mysql_container} mysql -u{shlex.quote(cfg.target_mysql_root_user)} -p{shlex.quote(cfg.target_mysql_root_password)} -NBe {shlex.quote(validation_sql)}",
    )
    if int(count or "0") <= 0:
        raise RuntimeError("Banco destino nao possui tabelas.")
    log(f"Validacao OK: banco destino possui {count} tabelas.")


def restart_target() -> None:
    cfg = STATE.config
    assert cfg
    ssh(cfg.target_ssh, f"docker service update --force {STATE.target.target_service}")


def write_report() -> None:
    cfg = STATE.config
    assert cfg
    report = {
        "source": {
            "ssh": f"{cfg.source_ssh.user}@{cfg.source_ssh.host}:{cfg.source_ssh.port}",
            "caprover": cfg.source_caprover.url,
            "app": cfg.source_app,
            "service": STATE.source.source_service,
            "image": STATE.source.source_image,
            "database": STATE.source.db_name,
            "url": cfg.old_url,
        },
        "target": {
            "ssh": f"{cfg.target_ssh.user}@{cfg.target_ssh.host}:{cfg.target_ssh.port}",
            "caprover": cfg.target_caprover.url,
            "app": cfg.target_app,
            "service": STATE.target.target_service,
            "database": cfg.target_db_name,
            "database_user": cfg.target_db_user,
            "database_password": "****",
            "database_host": STATE.target.target_db_host,
            "url": cfg.new_url,
        },
        "manual_steps": [
            "Apontar DNS do novo dominio para o servidor correto.",
            "Adicionar o dominio manualmente na app destino dentro do CapRover.",
            "Ativar HTTPS manualmente no CapRover quando o DNS estiver propagado.",
        ],
        "checkpoints": STATE.checkpoints,
        "log_file": str(LOG_FILE),
    }
    REPORT_FILE.write_text(json.dumps(report, indent=2), encoding="utf-8")
    log(f"Relatorio gerado: {REPORT_FILE}")


def run_flow() -> None:
    require_local_cmd("ssh")
    cfg = STATE.config
    assert cfg

    if not done("preflight"):
        remote_preflight(cfg.source_ssh)
        remote_preflight(cfg.target_ssh)
        checkpoint("preflight")

    if not done("source_discovered"):
        discover_source()
        checkpoint("source_discovered")

    if not done("target_app_created"):
        create_target_app()
        checkpoint("target_app_created")

    if not done("target_image_deployed"):
        deploy_target_image()
        checkpoint("target_image_deployed")
    elif not STATE.target.target_container:
        STATE.target.target_container = wait_container(cfg.target_ssh, STATE.target.target_service)

    if not done("files_copied"):
        copy_files()
        checkpoint("files_copied")

    if not done("database_cloned"):
        clone_database()
        checkpoint("database_cloned")

    if not done("wp_config_updated"):
        update_target_wp_config()
        checkpoint("wp_config_updated")

    if not done("urls_replaced"):
        run_wp_search_replace()
        checkpoint("urls_replaced")

    if not done("permissions_fixed"):
        fix_permissions()
        checkpoint("permissions_fixed")

    if not done("target_restarted"):
        restart_target()
        checkpoint("target_restarted")

    validate_target()
    checkpoint("validated")
    write_report()


STATE = load_state() or WizardState()


def main() -> int:
    try:
        LOG_FILE.write_text("", encoding="utf-8")
        if STATE.config:
            for value in [
                STATE.config.source_caprover.password,
                STATE.config.target_caprover.password,
                STATE.config.source_mysql_root_password,
                STATE.config.target_mysql_root_password,
                STATE.config.target_db_password,
                STATE.source.db_password,
            ]:
                remember_secret(value)
            reuse = prompt_bool("Existe uma execucao anterior. Retomar?", True)
            if not reuse:
                STATE_DIR.mkdir(exist_ok=True)
                state_path().unlink(missing_ok=True)
                STATE.config = collect_config()
        else:
            STATE.config = collect_config()
        validate_or_die(STATE.config)
        save_state()
        run_flow()
        log("Duplicacao concluida com sucesso.")
        return 0
    except KeyboardInterrupt:
        log("Execucao interrompida pelo usuario.")
        return 130
    except Exception as exc:
        log(f"ERRO: {exc}")
        log("Estado salvo. Corrija o problema e reexecute para retomar.")
        return 1


if __name__ == "__main__":
    sys.exit(main())
