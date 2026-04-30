#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import wizard


def value(data: dict, *keys: str, default: str = "") -> str:
    cur = data
    for key in keys:
        if not isinstance(cur, dict):
            return default
        cur = cur.get(key)
    if cur is None:
        return default
    return str(cur)


def boolean(data: dict, *keys: str, default: bool = False) -> bool:
    cur = data
    for key in keys:
        if not isinstance(cur, dict):
            return default
        cur = cur.get(key)
    if cur is None:
        return default
    if isinstance(cur, bool):
        return cur
    return str(cur).lower() in {"1", "true", "yes", "y", "sim", "s"}


def build_config(raw: dict) -> wizard.CloneConfig:
    source = raw.get("source", {})
    target = raw.get("target", {})
    database = raw.get("database", {})
    execution = raw.get("execution", {})

    source_key_path = prepare_ssh_key("source", value(source, "ssh", "privateKey"))
    target_key_path = prepare_ssh_key("target", value(target, "ssh", "privateKey"))

    source_ssh = wizard.SshTarget(
        label="origem",
        host=value(source, "ssh", "host"),
        user=value(source, "ssh", "user", default="root"),
        port=int(value(source, "ssh", "port", default="22")),
        key_path=source_key_path or value(source, "ssh", "keyPath"),
    )

    target_ssh = source_ssh if boolean(target, "sameSsh", default=True) else wizard.SshTarget(
        label="destino",
        host=value(target, "ssh", "host"),
        user=value(target, "ssh", "user", default="root"),
        port=int(value(target, "ssh", "port", default="22")),
        key_path=target_key_path or value(target, "ssh", "keyPath"),
    )

    source_caprover = wizard.CapRoverTarget(
        url=value(source, "caprover", "url"),
        password=value(source, "caprover", "password"),
    )

    target_caprover = source_caprover if boolean(target, "sameCaprover", default=True) else wizard.CapRoverTarget(
        url=value(target, "caprover", "url"),
        password=value(target, "caprover", "password"),
    )

    config = wizard.CloneConfig(
        source_ssh=source_ssh,
        target_ssh=target_ssh,
        source_caprover=source_caprover,
        target_caprover=target_caprover,
        source_app=value(source, "app"),
        target_app=value(target, "app"),
        old_url=value(source, "url").rstrip("/"),
        new_url=value(target, "url").rstrip("/"),
        wp_path=value(target, "wpPath", default="/var/www/html"),
        source_mysql_root_user=value(database, "sourceRootUser", default="root"),
        source_mysql_root_password=value(database, "sourceRootPassword"),
        target_mysql_app=value(database, "targetMysqlApp"),
        target_mysql_root_user=value(database, "targetRootUser", default="root"),
        target_mysql_root_password=value(database, "targetRootPassword"),
        target_db_name=value(database, "targetDbName"),
        target_db_user=value(database, "targetDbUser"),
        target_db_password=value(database, "targetDbPassword"),
        allow_existing_target=boolean(execution, "allowExistingTarget", default=False),
        dry_run=boolean(execution, "dryRun", default=True),
    )
    wizard.validate_or_die(config)
    return config


def prepare_ssh_key(label: str, private_key: str) -> str:
    if not private_key.strip():
        return ""
    base = Path(os.environ.get("WORDPRESS_DUPLICATOR_DATA_DIR", "/data")) / "ssh-keys"
    base.mkdir(parents=True, exist_ok=True)
    path = base / f"{label}-{os.getpid()}.key"
    normalized = private_key.replace("\\n", "\n").strip() + "\n"
    path.write_text(normalized, encoding="utf-8")
    path.chmod(0o600)
    return str(path)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: wizard_runner.py config.json", file=sys.stderr)
        return 2

    raw = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    job_id = raw.get("jobId", "manual")
    config = build_config(raw.get("config", raw))

    state_dir = Path("/data/jobs") / str(job_id)
    state_dir.mkdir(parents=True, exist_ok=True)

    wizard.STATE_DIR = state_dir / ".wordpress-duplicator-state"
    wizard.REPORT_FILE = state_dir / "wordpress-duplicator-report.json"
    wizard.LOG_FILE = state_dir / "wordpress-duplicator-wizard.log"
    wizard.STATE = wizard.WizardState(config=config)

    for secret in [
        config.source_caprover.password,
        config.target_caprover.password,
        config.source_mysql_root_password,
        config.target_mysql_root_password,
        config.target_db_password,
    ]:
        wizard.remember_secret(secret)

    wizard.save_state()
    wizard.run_flow()
    return 0


if __name__ == "__main__":
    sys.exit(main())
