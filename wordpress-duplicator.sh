#!/usr/bin/env bash
set -Eeuo pipefail

VERSION="0.1.0"
STATE_DIR="${STATE_DIR:-.wordpress-duplicator-state}"
REPORT_FILE="${REPORT_FILE:-wordpress-duplicator-report.txt}"
LOG_FILE="${LOG_FILE:-wordpress-duplicator.log}"

SOURCE_APP="${SOURCE_APP:-}"
TARGET_APP="${TARGET_APP:-}"
OLD_URL="${OLD_URL:-}"
NEW_URL="${NEW_URL:-}"
CAPROVER_URL="${CAPROVER_URL:-}"
CAPROVER_PASSWORD="${CAPROVER_PASSWORD:-}"
MYSQL_ROOT_USER="${MYSQL_ROOT_USER:-root}"
MYSQL_ROOT_PASSWORD="${MYSQL_ROOT_PASSWORD:-}"
TARGET_DB_NAME="${TARGET_DB_NAME:-}"
TARGET_DB_USER="${TARGET_DB_USER:-}"
TARGET_DB_PASSWORD="${TARGET_DB_PASSWORD:-}"
WP_PATH="${WP_PATH:-/var/www/html}"
DRY_RUN="${DRY_RUN:-false}"
ALLOW_EXISTING_TARGET="${ALLOW_EXISTING_TARGET:-false}"
SKIP_CAPROVER_CREATE="${SKIP_CAPROVER_CREATE:-false}"
SKIP_IMAGE_DEPLOY="${SKIP_IMAGE_DEPLOY:-false}"

SOURCE_SERVICE=""
TARGET_SERVICE=""
SOURCE_CONTAINER=""
TARGET_CONTAINER=""
SOURCE_DB_NAME=""
SOURCE_DB_USER=""
SOURCE_DB_PASSWORD=""
SOURCE_DB_HOST=""
SOURCE_TABLE_PREFIX="wp_"
SOURCE_IMAGE=""
TARGET_DB_HOST=""
WORK_DIR=""

mkdir -p "$STATE_DIR"
: > "$LOG_FILE"

mask() {
  local value="$1"
  if [[ -z "$value" ]]; then
    printf ''
  elif ((${#value} <= 4)); then
    printf '****'
  else
    printf '%s****%s' "${value:0:2}" "${value: -2}"
  fi
}

redact() {
  local text="$*"
  for secret in "$CAPROVER_PASSWORD" "$MYSQL_ROOT_PASSWORD" "$SOURCE_DB_PASSWORD" "$TARGET_DB_PASSWORD"; do
    if [[ -n "${secret:-}" ]]; then
      text="${text//$secret/****}"
    fi
  done
  printf '%s' "$text"
}

log() {
  local line
  line="$(redact "$*")"
  printf '[%s] %s\n' "$(date -Is)" "$line" | tee -a "$LOG_FILE"
}

fail() {
  log "ERROR: $*"
  exit 1
}

run() {
  log "+ $*"
  if [[ "$DRY_RUN" == "true" ]]; then
    return 0
  fi
  "$@"
}

run_capture() {
  log "+ $*"
  if [[ "$DRY_RUN" == "true" ]]; then
    printf ''
    return 0
  fi
  "$@"
}

checkpoint() {
  local name="$1"
  date -Is > "$STATE_DIR/$name.done"
}

is_done() {
  [[ -f "$STATE_DIR/$1.done" ]]
}

require_var() {
  local name="$1"
  local value="${!name:-}"
  [[ -n "$value" ]] || fail "Variavel obrigatoria ausente: $name"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Comando obrigatorio nao encontrado: $1"
}

validate_name() {
  local label="$1"
  local value="$2"
  [[ "$value" =~ ^[a-zA-Z0-9][a-zA-Z0-9-]{1,62}$ ]] || fail "$label invalido: $value"
}

validate_url() {
  local label="$1"
  local value="$2"
  [[ "$value" =~ ^https?://[^[:space:]/]+(/.*)?$ ]] || fail "$label invalida: $value"
}

service_name() {
  printf 'srv-captain--%s' "$1"
}

container_for_service() {
  local service="$1"
  docker ps \
    --filter "label=com.docker.swarm.service.name=$service" \
    --format '{{.ID}}' \
    | head -n 1
}

wait_for_container() {
  local service="$1"
  local timeout="${2:-120}"
  local elapsed=0
  local container=""

  while (( elapsed < timeout )); do
    container="$(container_for_service "$service")"
    if [[ -n "$container" ]]; then
      printf '%s' "$container"
      return 0
    fi
    sleep 3
    elapsed=$((elapsed + 3))
  done

  return 1
}

wp_config_value() {
  local container="$1"
  local key="$2"
  docker exec "$container" sh -lc "php -r '\$c=file_get_contents(\"$WP_PATH/wp-config.php\"); if (preg_match(\"/define\\\\s*\\\\(\\\\s*[\\\"'\\\"']$key[\\\"'\\\"']\\\\s*,\\\\s*[\\\"'\\\"']([^\\\"'\\\"']*)[\\\"'\\\"']\\\\s*\\\\)/\", \$c, \$m)) echo \$m[1];'"
}

wp_table_prefix() {
  local container="$1"
  docker exec "$container" sh -lc "php -r '\$c=file_get_contents(\"$WP_PATH/wp-config.php\"); if (preg_match(\"/\\\\\$table_prefix\\\\s*=\\\\s*[\\\"'\\\"']([^\\\"'\\\"']+)[\\\"'\\\"']\\\\s*;/\", \$c, \$m)) echo \$m[1]; else echo \"wp_\";'"
}

sql_escape() {
  printf '%s' "$1" | sed "s/'/''/g"
}

mysql_exec() {
  local sql="$1"
  docker exec -i "$SOURCE_DB_HOST_CONTAINER" mysql \
    -u"$MYSQL_ROOT_USER" \
    -p"$MYSQL_ROOT_PASSWORD" \
    -e "$sql"
}

mysql_database_exists() {
  local db="$1"
  docker exec -i "$SOURCE_DB_HOST_CONTAINER" mysql \
    -u"$MYSQL_ROOT_USER" \
    -p"$MYSQL_ROOT_PASSWORD" \
    -NBe "SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME='$(sql_escape "$db")';" \
    | grep -qx "$db"
}

discover_mysql_container() {
  local host="$1"
  local app_name="${host#srv-captain--}"
  app_name="${app_name%%:*}"
  local service
  service="$(service_name "$app_name")"
  container_for_service "$service"
}

caprover_create_app() {
  if [[ "$SKIP_CAPROVER_CREATE" == "true" ]]; then
    log "Criacao da app no CapRover ignorada por SKIP_CAPROVER_CREATE=true"
    return 0
  fi

  require_var CAPROVER_URL
  require_var CAPROVER_PASSWORD
  require_cmd caprover

  local existing
  existing="$(docker service ls --format '{{.Name}}' | grep -x "$(service_name "$TARGET_APP")" || true)"
  if [[ -n "$existing" && "$ALLOW_EXISTING_TARGET" != "true" ]]; then
    fail "A app destino ja existe. Use ALLOW_EXISTING_TARGET=true se quiser reutiliza-la."
  fi

  if [[ -z "$existing" ]]; then
    run caprover api \
      --caproverUrl "$CAPROVER_URL" \
      --caproverPassword "$CAPROVER_PASSWORD" \
      --path "/user/apps/appDefinitions/register" \
      --method "POST" \
      --data "{\"appName\":\"$TARGET_APP\",\"hasPersistentData\":true}"
  else
    log "App destino ja existe e sera reutilizada: $TARGET_APP"
  fi
}

deploy_same_image() {
  if [[ "$SKIP_IMAGE_DEPLOY" == "true" ]]; then
    log "Deploy da imagem ignorado por SKIP_IMAGE_DEPLOY=true"
    return 0
  fi

  require_var CAPROVER_URL
  require_var CAPROVER_PASSWORD
  require_cmd caprover

  SOURCE_IMAGE="$(docker service inspect "$SOURCE_SERVICE" --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}')"
  [[ -n "$SOURCE_IMAGE" ]] || fail "Nao foi possivel descobrir a imagem da app origem"

  run caprover deploy \
    --caproverUrl "$CAPROVER_URL" \
    --caproverPassword "$CAPROVER_PASSWORD" \
    --caproverApp "$TARGET_APP" \
    --imageName "$SOURCE_IMAGE"
}

copy_wordpress_files() {
  WORK_DIR="$(mktemp -d "/tmp/wp-duplicator-$TARGET_APP.XXXXXX")"
  log "Diretorio temporario: $WORK_DIR"

  run docker exec "$SOURCE_CONTAINER" sh -lc "test -f '$WP_PATH/wp-config.php' && test -d '$WP_PATH/wp-content'"
  run docker exec "$TARGET_CONTAINER" sh -lc "mkdir -p '$WP_PATH'"

  if [[ "$DRY_RUN" == "true" ]]; then
    return 0
  fi

  docker exec "$SOURCE_CONTAINER" tar -C "$WP_PATH" -cf - . \
    | docker exec -i "$TARGET_CONTAINER" tar -C "$WP_PATH" -xf -
}

create_database_clone() {
  SOURCE_DB_NAME="$(wp_config_value "$SOURCE_CONTAINER" "DB_NAME")"
  SOURCE_DB_USER="$(wp_config_value "$SOURCE_CONTAINER" "DB_USER")"
  SOURCE_DB_PASSWORD="$(wp_config_value "$SOURCE_CONTAINER" "DB_PASSWORD")"
  SOURCE_DB_HOST="$(wp_config_value "$SOURCE_CONTAINER" "DB_HOST")"
  SOURCE_TABLE_PREFIX="$(wp_table_prefix "$SOURCE_CONTAINER")"

  [[ -n "$SOURCE_DB_NAME" ]] || fail "DB_NAME nao encontrado no wp-config.php"
  [[ -n "$SOURCE_DB_USER" ]] || fail "DB_USER nao encontrado no wp-config.php"
  [[ -n "$SOURCE_DB_PASSWORD" ]] || fail "DB_PASSWORD nao encontrado no wp-config.php"
  [[ -n "$SOURCE_DB_HOST" ]] || fail "DB_HOST nao encontrado no wp-config.php"

  TARGET_DB_NAME="${TARGET_DB_NAME:-${SOURCE_DB_NAME}_${TARGET_APP//-/_}}"
  TARGET_DB_USER="${TARGET_DB_USER:-${SOURCE_DB_USER}_${TARGET_APP//-/_}}"
  TARGET_DB_PASSWORD="${TARGET_DB_PASSWORD:-$(openssl rand -base64 30 | tr -d '\n' | tr '/+' '_-' | cut -c1-32)}"
  TARGET_DB_HOST="$SOURCE_DB_HOST"

  SOURCE_DB_HOST_CONTAINER="$(discover_mysql_container "$SOURCE_DB_HOST")"
  [[ -n "$SOURCE_DB_HOST_CONTAINER" ]] || fail "Nao foi possivel localizar container MySQL para DB_HOST=$SOURCE_DB_HOST"

  require_var MYSQL_ROOT_PASSWORD

  if mysql_database_exists "$TARGET_DB_NAME" && [[ "$ALLOW_EXISTING_TARGET" != "true" ]]; then
    fail "Banco destino ja existe: $TARGET_DB_NAME. Use ALLOW_EXISTING_TARGET=true para reutilizar."
  fi

  local dump_path="$WORK_DIR/source.sql"

  if [[ "$DRY_RUN" == "true" ]]; then
    log "DRY_RUN: criaria banco $TARGET_DB_NAME e usuario $TARGET_DB_USER"
    return 0
  fi

  docker exec "$SOURCE_DB_HOST_CONTAINER" mysqldump \
    -u"$MYSQL_ROOT_USER" \
    -p"$MYSQL_ROOT_PASSWORD" \
    --single-transaction \
    --routines \
    --triggers \
    --events \
    "$SOURCE_DB_NAME" > "$dump_path"

  [[ -s "$dump_path" ]] || fail "Dump do banco ficou vazio"

  mysql_exec "CREATE DATABASE IF NOT EXISTS \`$TARGET_DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
  mysql_exec "CREATE USER IF NOT EXISTS '$TARGET_DB_USER'@'%' IDENTIFIED BY '$TARGET_DB_PASSWORD';"
  mysql_exec "GRANT ALL PRIVILEGES ON \`$TARGET_DB_NAME\`.* TO '$TARGET_DB_USER'@'%'; FLUSH PRIVILEGES;"

  docker exec -i "$SOURCE_DB_HOST_CONTAINER" mysql \
    -u"$MYSQL_ROOT_USER" \
    -p"$MYSQL_ROOT_PASSWORD" \
    "$TARGET_DB_NAME" < "$dump_path"
}

update_wp_config() {
  local replacements
  replacements="$(cat <<PHP
\$file = '$WP_PATH/wp-config.php';
\$c = file_get_contents(\$file);
\$values = [
  'DB_NAME' => '$TARGET_DB_NAME',
  'DB_USER' => '$TARGET_DB_USER',
  'DB_PASSWORD' => '$TARGET_DB_PASSWORD',
  'DB_HOST' => '$TARGET_DB_HOST',
];
foreach (\$values as \$key => \$value) {
  \$quoted = var_export(\$value, true);
  \$c = preg_replace('/define\s*\(\s*[\\\"\\']'.preg_quote(\$key, '/').'[\\\"\\']\s*,\s*[\\\"\\'][^\\\"\\']*[\\\"\\']\s*\)\s*;/', \"define('\$key', \$quoted);\", \$c, 1);
}
file_put_contents(\$file, \$c);
PHP
)"

  if [[ "$DRY_RUN" == "true" ]]; then
    log "DRY_RUN: atualizaria wp-config.php da app destino"
    return 0
  fi

  docker exec "$TARGET_CONTAINER" sh -lc "php <<'PHP'
$replacements
PHP"
}

run_search_replace() {
  local wp="wp --allow-root --path='$WP_PATH'"

  if ! docker exec "$TARGET_CONTAINER" sh -lc "command -v wp >/dev/null 2>&1"; then
    log "WP-CLI nao existe no container destino; tentando executar com imagem wordpress:cli"
    run docker run --rm \
      --volumes-from "$TARGET_CONTAINER" \
      --network captain-overlay-network \
      wordpress:cli \
      --allow-root \
      --path="$WP_PATH" \
      search-replace "$OLD_URL" "$NEW_URL" \
      --all-tables \
      --precise \
      --recurse-objects \
      --skip-columns=guid
  else
    run docker exec "$TARGET_CONTAINER" sh -lc "$wp search-replace '$OLD_URL' '$NEW_URL' --all-tables --precise --recurse-objects --skip-columns=guid"
  fi

  run docker exec "$TARGET_CONTAINER" sh -lc "$wp option update home '$NEW_URL' || true"
  run docker exec "$TARGET_CONTAINER" sh -lc "$wp option update siteurl '$NEW_URL' || true"
}

fix_permissions() {
  local uid_gid
  uid_gid="$(docker exec "$TARGET_CONTAINER" sh -lc "id -u www-data >/dev/null 2>&1 && printf 'www-data:www-data' || printf '%s:%s' \"\$(id -u)\" \"\$(id -g)\"")"

  run docker exec "$TARGET_CONTAINER" sh -lc "chown -R '$uid_gid' '$WP_PATH/wp-content' || true"
  run docker exec "$TARGET_CONTAINER" sh -lc "find '$WP_PATH' -type d -exec chmod 755 {} \\;"
  run docker exec "$TARGET_CONTAINER" sh -lc "find '$WP_PATH' -type f -exec chmod 644 {} \\;"
}

validate_clone() {
  run docker exec "$TARGET_CONTAINER" sh -lc "test -f '$WP_PATH/wp-config.php'"
  run docker exec "$TARGET_CONTAINER" sh -lc "test -d '$WP_PATH/wp-content/uploads' || mkdir -p '$WP_PATH/wp-content/uploads'"
  run docker exec "$TARGET_CONTAINER" sh -lc "test -d '$WP_PATH/wp-content/plugins'"
  run docker exec "$TARGET_CONTAINER" sh -lc "test -d '$WP_PATH/wp-content/themes'"

  local table_count
  table_count="$(docker exec -i "$SOURCE_DB_HOST_CONTAINER" mysql -u"$MYSQL_ROOT_USER" -p"$MYSQL_ROOT_PASSWORD" -NBe "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='$(sql_escape "$TARGET_DB_NAME")';")"
  [[ "${table_count:-0}" -gt 0 ]] || fail "Banco destino nao possui tabelas"

  log "Validacao OK: banco destino tem $table_count tabelas"
}

restart_target() {
  run docker service update --force "$TARGET_SERVICE"
}

write_report() {
  cat > "$REPORT_FILE" <<EOF
WordPress Duplicator v$VERSION

Origem
- App: $SOURCE_APP
- Service: $SOURCE_SERVICE
- Container: $SOURCE_CONTAINER
- Banco: $SOURCE_DB_NAME
- URL antiga: $OLD_URL

Destino
- App: $TARGET_APP
- Service: $TARGET_SERVICE
- Container: $TARGET_CONTAINER
- Banco: $TARGET_DB_NAME
- Usuario banco: $TARGET_DB_USER
- Senha banco: $(mask "$TARGET_DB_PASSWORD")
- DB_HOST: $TARGET_DB_HOST
- URL nova: $NEW_URL

Status
- App CapRover criada/reutilizada: OK
- Imagem clonada da origem: OK
- Arquivos copiados: OK
- Banco duplicado: OK
- wp-config.php atualizado: OK
- URLs substituidas via WP-CLI: OK
- Permissoes corrigidas: OK
- Validacoes finais: OK

Observacao
- Dominio/DNS/HTTPS no CapRover nao foram configurados por este modulo.
- Credenciais completas nao sao exibidas neste relatorio.
- Log tecnico: $LOG_FILE
EOF

  log "Relatorio gerado em $REPORT_FILE"
}

main() {
  require_var SOURCE_APP
  require_var TARGET_APP
  require_var OLD_URL
  require_var NEW_URL
  validate_name SOURCE_APP "$SOURCE_APP"
  validate_name TARGET_APP "$TARGET_APP"
  validate_url OLD_URL "$OLD_URL"
  validate_url NEW_URL "$NEW_URL"
  require_cmd docker
  require_cmd openssl

  SOURCE_SERVICE="$(service_name "$SOURCE_APP")"
  TARGET_SERVICE="$(service_name "$TARGET_APP")"

  SOURCE_CONTAINER="$(container_for_service "$SOURCE_SERVICE")"
  [[ -n "$SOURCE_CONTAINER" ]] || fail "Container da app origem nao encontrado: $SOURCE_SERVICE"

  if ! is_done "caprover_app_created"; then
    caprover_create_app
    checkpoint "caprover_app_created"
  fi

  if ! is_done "image_deployed"; then
    deploy_same_image
    checkpoint "image_deployed"
  fi

  TARGET_CONTAINER="$(wait_for_container "$TARGET_SERVICE" 180)" || fail "Container da app destino nao subiu: $TARGET_SERVICE"

  if ! is_done "files_copied"; then
    copy_wordpress_files
    checkpoint "files_copied"
  fi

  if ! is_done "database_cloned"; then
    create_database_clone
    checkpoint "database_cloned"
  fi

  if ! is_done "wp_config_updated"; then
    update_wp_config
    checkpoint "wp_config_updated"
  fi

  if ! is_done "urls_replaced"; then
    run_search_replace
    checkpoint "urls_replaced"
  fi

  if ! is_done "permissions_fixed"; then
    fix_permissions
    checkpoint "permissions_fixed"
  fi

  if ! is_done "target_restarted"; then
    restart_target
    checkpoint "target_restarted"
  fi

  validate_clone
  checkpoint "validation_completed"
  write_report
  log "Duplicacao concluida com sucesso."
}

main "$@"
