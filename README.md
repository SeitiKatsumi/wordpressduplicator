# WordPress Duplicator

Wizard para duplicar uma instalacao WordPress hospedada no CapRover.

Fluxo recomendado para producao: crie antes uma app WordPress limpa e uma app
MySQL limpa no CapRover destino. O WP Clone usa essas apps como destino, copia
os arquivos da origem, recria apenas o banco destino, atualiza `wp-config.php`,
troca a URL e valida o resultado. A origem nao e alterada.

O modulo executa:

- confirmacao ou criacao da app WordPress destino;
- confirmacao ou criacao da app MySQL destino, separada da origem;
- copia completa dos arquivos do WordPress;
- novo banco MySQL baseado no banco da origem dentro da app MySQL destino;
- novo usuario/senha do banco;
- `wp-config.php` apontando para o banco novo;
- troca da URL antiga pela nova com suporte a dados serializados via WP-CLI;
- correcao de permissoes;
- validacao final;
- relatorio auditavel.
- gerenciador de arquivos para o volume publico do WordPress, com upload, listagem,
  preview de textos, compactacao ZIP e descompactacao segura.

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

## Gerenciador de arquivos

A aba `Arquivos` permite gerenciar a pasta publica do WordPress, normalmente
`/var/www/html`, usando as mesmas credenciais SSH do wizard.

Recursos:

- listar arquivos e pastas do volume da app WordPress escolhida;
- navegar entre pastas;
- criar novas pastas;
- fazer upload com barra de progresso;
- bloquear upload direto de `wp-config.php` e `.env` por seguranca;
- evitar sobrescrita acidental, a menos que `Sobrescrever` esteja marcado;
- visualizar arquivos de texto pequenos;
- compactar arquivo/pasta em `.zip`;
- descompactar `.zip` com bloqueio de path traversal (`../` ou caminho absoluto).

O upload e preparado em `/data/file-manager/uploads` e depois enviado ao host por
SSH, entrando no container WordPress via `docker cp`. Para ajustar o limite de
upload, configure:

```env
FILE_MANAGER_MAX_UPLOAD_MB=512
```

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
7. nome da app WordPress destino ja criada.
8. nova URL que sera gravada no banco.
9. credenciais admin/root do MySQL.
10. nome da app MySQL destino ja criada.
11. nome do banco/usuario destino; em destino existente, esse banco sera substituido.

## Fluxo executado

1. Testa SSH e Docker na origem/destino.
2. Localiza container WordPress da origem.
3. Le `wp-config.php` da origem.
4. Descobre banco, usuario, senha, host e prefixo de tabelas.
5. Localiza container MySQL da origem.
6. Confirma a app WordPress destino.
7. Confirma a app MySQL destino.
8. Configura volume/env do destino quando necessario.
9. Aguarda containers destino ficarem prontos.
10. Copia arquivos do WordPress por `tar` via SSH.
11. Recria o banco informado apenas no MySQL destino.
12. Faz `mysqldump` da origem e restore no banco destino.
13. Atualiza `wp-config.php` da copia para `srv-captain--app-db:3306`.
14. Executa `wp search-replace` da URL antiga para a nova.
15. Atualiza `home` e `siteurl`.
16. Corrige permissoes.
17. Reinicia a service destino.
18. Valida arquivos essenciais e tabelas.
19. Gera `wordpress-duplicator-report.json`.

## Segurança

- O site original nao e alterado.
- A copia de arquivos e feita somente leitura na origem.
- O banco original e lido via `mysqldump`; nao recebe writes.
- Senhas sao mascaradas nos logs.
- O estado fica salvo em `.wordpress-duplicator-state/wizard-state.json`.
- Se uma etapa falhar, corrija o problema e rode o wizard novamente para retomar.
- Por padrao, a UI usa destino existente e sobrescreve somente as apps destino informadas.

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
