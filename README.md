# WordPress Duplicator

Wizard para duplicar uma instalacao WordPress hospedada no CapRover, criando automaticamente:

- nova app no CapRover destino;
- copia completa dos arquivos do WordPress;
- novo banco MySQL baseado no banco da origem;
- novo usuario/senha do banco;
- `wp-config.php` apontando para o banco novo;
- troca da URL antiga pela nova com suporte a dados serializados via WP-CLI;
- correcao de permissoes;
- validacao final;
- relatorio auditavel.

O modulo nao aponta DNS, nao adiciona dominio no CapRover e nao ativa HTTPS. Essas etapas ficam manuais, como solicitado.

## Arquivos

- `wizard.py`: fluxo interativo recomendado.
- `wordpress-duplicator.sh`: executor Bash para cenarios simples no mesmo servidor.
- `ui/`: interface futurista do wizard integrada ao backend.
- `server.mjs`: backend HTTP com Postgres, healthcheck, jobs e historico.
- `Dockerfile`: imagem para deploy no CapRover.
- `captain-definition`: definicao de deploy do CapRover.
- `.env.example`: variaveis de ambiente recomendadas.
- `docs/CAPROVER_DEPLOY.md`: guia completo de instalacao no CapRover.
- `docs/postgres-schema.sql`: schema para historico, auditoria e clonagens futuras.
- `docs/ARCHITECTURE.md`: arquitetura e fluxo tecnico.

## Deploy no CapRover

Leia primeiro:

```text
docs/CAPROVER_DEPLOY.md
```

Resumo:

1. Crie um Postgres no CapRover.
2. Aplique `docs/postgres-schema.sql`.
3. Crie a app `wordpress-duplicator`.
4. Ative persistent data em `/data`.
5. Configure as envs de `.env.example`.
6. Configure `Porta HTTP do Conteiner` como `3000`.
7. Faca deploy usando `captain-definition`.

O app Docker serve a UI web, conecta no Postgres para registrar jobs/historico/auditoria e dispara o `wizard_runner.py` em background quando a clonagem real e confirmada na UI. A execucao real exige desativar dry-run e digitar `EXECUTAR`.

## Pre-requisitos locais

Na maquina onde voce roda o wizard:

- Python 3.10+;
- `ssh`;
- CapRover CLI:

```bash
npm install -g caprover
```

O CapRover CLI e usado para registrar a nova app e fazer deploy da mesma imagem da app original.

## Pre-requisitos nos servidores

No servidor de origem e destino:

- Docker funcionando;
- usuario SSH com permissao para executar Docker;
- app WordPress rodando como service CapRover (`srv-captain--nome-da-app`);
- container MySQL acessivel via Docker/CapRover;
- senha root/admin do MySQL.

No container WordPress destino:

- WP-CLI instalado, ou permissao para rodar temporariamente a imagem `wordpress:cli`.

## Como executar

```bash
cd wordpress-duplicator
python3 wizard.py
```

## Interface visual

Abra o arquivo abaixo no navegador:

```text
wordpress-duplicator/ui/index.html
```

A interface coleta os mesmos dados do wizard, registra execucoes no Postgres, mostra historico e exporta um JSON mascarado. Ela nao executa SSH diretamente no navegador; a execucao real roda no backend.

O wizard pergunta:

1. SSH da origem.
2. CapRover da origem.
3. app WordPress origem.
4. URL atual do site.
5. SSH do destino, que pode ser o mesmo.
6. CapRover do destino, que pode ser o mesmo.
7. nome da nova app.
8. nova URL que sera gravada no banco.
9. credenciais admin/root do MySQL.
10. nome do banco/usuario destino, ou deixa gerar automaticamente.

## Fluxo executado

1. Testa SSH e Docker na origem/destino.
2. Localiza container WordPress da origem.
3. Le `wp-config.php` da origem.
4. Descobre banco, usuario, senha, host e prefixo de tabelas.
5. Localiza container MySQL da origem.
6. Cria nova app no CapRover destino.
7. Faz deploy da mesma imagem Docker usada pela origem.
8. Aguarda container destino subir.
9. Copia arquivos do WordPress por `tar` via SSH.
10. Cria banco e usuario no MySQL destino.
11. Faz `mysqldump` da origem e restore no destino.
12. Atualiza `wp-config.php` da copia.
13. Executa `wp search-replace` da URL antiga para a nova.
14. Atualiza `home` e `siteurl`.
15. Corrige permissoes.
16. Reinicia a service destino.
17. Valida arquivos essenciais e tabelas.
18. Gera `wordpress-duplicator-report.json`.

## Segurança

- O site original nao e alterado.
- A copia de arquivos e feita somente leitura na origem.
- O banco original e lido via `mysqldump`; nao recebe writes.
- Senhas sao mascaradas nos logs.
- O estado fica salvo em `.wordpress-duplicator-state/wizard-state.json`.
- Se uma etapa falhar, corrija o problema e rode o wizard novamente para retomar.
- Por padrao, o wizard bloqueia app/banco destino ja existentes.

## Observacoes importantes

- A troca de URL usa WP-CLI com `--precise` e `--recurse-objects`, para preservar dados serializados do WordPress.
- A coluna `guid` e ignorada por seguranca.
- Se origem e destino forem servidores diferentes, os arquivos e o dump trafegam via SSH.
- A nova app fica pronta internamente com a nova URL, mas o dominio precisa ser adicionado manualmente no CapRover depois.

## Relatorio

Ao final, o wizard gera:

```text
wordpress-duplicator-report.json
wordpress-duplicator-wizard.log
```

O relatorio contem:

- app origem;
- app destino;
- imagem clonada;
- banco origem;
- banco destino;
- URL antiga;
- URL nova;
- checkpoints executados;
- proximas etapas manuais.
