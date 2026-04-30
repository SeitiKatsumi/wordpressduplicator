# Arquitetura

## Componentes

### UI

Local: `ui/`

Responsabilidades:

- coletar dados de origem/destino;
- exibir diagnostico;
- iniciar dry-run;
- acompanhar execucao;
- consultar historico;
- exportar relatorio.

### Wizard CLI

Local: `wizard.py`

Responsabilidades:

- conectar via SSH;
- validar Docker remoto;
- descobrir container WordPress;
- ler `wp-config.php`;
- descobrir banco MySQL;
- criar app CapRover destino;
- copiar arquivos;
- duplicar banco;
- atualizar `wp-config.php`;
- executar `wp search-replace`;
- corrigir permissoes;
- gerar relatorio.

### Banco Postgres

Local do schema: `docs/postgres-schema.sql`

Responsabilidades:

- registrar perfis;
- registrar execucoes;
- registrar checkpoints;
- registrar logs mascarados;
- permitir repeticao de clonagens futuras.

## Fluxo futuro da UI com backend

```text
UI -> Backend Node -> Postgres
              |
              +-> wizard.py / jobs operacionais
              +-> SSH origem/destino
              +-> CapRover API/CLI
              +-> MySQL dump/restore
```

O navegador nunca executa SSH diretamente e nunca deve receber segredos descriptografados depois que forem salvos.

## Estados de uma execucao

```text
draft
running
succeeded
failed
cancelled
```

## Checkpoints

```text
preflight
source_discovered
target_app_created
target_image_deployed
files_copied
database_cloned
wp_config_updated
urls_replaced
permissions_fixed
target_restarted
validated
report_written
```

## Reexecucao

Cada checkpoint deve ser idempotente ou validar o estado antes de prosseguir.

Exemplos:

- se a app destino ja existe, bloquear por padrao;
- se o banco destino ja existe, bloquear por padrao;
- se arquivos ja foram copiados, permitir recopia somente com opcao explicita;
- se `wp-config.php` ja aponta para o banco novo, nao reescrever sem necessidade;
- se `urls_replaced` ja rodou, evitar repetir sem confirmacao.

## Segredos

Nunca persistir em texto puro:

- senha CapRover;
- senha SSH;
- chave privada SSH;
- senha root/admin MySQL;
- senha do banco WordPress;
- salts do WordPress.

Preferencia:

1. pedir segredo na hora da execucao;
2. salvar criptografado com `APP_SECRET_KEY`;
3. salvar apenas referencia externa.
