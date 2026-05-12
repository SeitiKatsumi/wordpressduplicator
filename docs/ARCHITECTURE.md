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
- gerenciar arquivos do volume WordPress via backend seguro.

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
- criar app MySQL destino separada;
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

### Gerenciador de arquivos

Local: `server.mjs` + aba `Arquivos` em `ui/`

Responsabilidades:

- resolver a app WordPress pelo service `srv-captain--nome-da-app`;
- confinar operacoes ao `WP path` informado, normalmente `/var/www/html`;
- listar arquivos e pastas;
- criar diretorios;
- receber uploads com progresso visual;
- copiar uploads para o container com `docker cp`;
- compactar e descompactar `.zip` usando area temporaria no host;
- bloquear caminhos perigosos, `../`, paths absolutos e escrita em `wp-config.php`/`.env`.

## Fluxo futuro da UI com backend

```text
UI -> Backend Node -> Postgres
              |
              +-> wizard.py / jobs operacionais
              +-> gerenciador de arquivos por SSH + docker cp
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
target_mysql_app_created
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
