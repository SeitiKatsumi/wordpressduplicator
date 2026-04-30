# Deploy no CapRover

Este guia prepara o WordPress Duplicator para rodar como app Docker no CapRover.

Estado atual:

- a UI web roda no Docker;
- o backend HTTP conecta no Postgres;
- o schema Postgres para historico/auditoria e aplicado automaticamente no boot;
- a UI registra jobs e carrega historico;
- o backend dispara `wizard_runner.py` para executar clonagens reais;
- execucao real exige desativar dry-run e confirmar digitando `EXECUTAR`.

## 1. Criar app Postgres

No CapRover, crie um app Postgres, por exemplo:

```text
wordpress-duplicator-db
```

Crie banco e usuario dedicados:

```sql
CREATE DATABASE wordpressduplicator;
CREATE USER wordpressduplicator WITH PASSWORD 'troque-esta-senha';
GRANT ALL PRIVILEGES ON DATABASE wordpressduplicator TO wordpressduplicator;
```

O app aplica o schema automaticamente no boot. Se quiser aplicar manualmente:

```bash
psql "$DATABASE_URL" -f docs/postgres-schema.sql
```

Exemplo de `DATABASE_URL` dentro da rede CapRover:

```text
postgresql://wordpressduplicator:troque-esta-senha@srv-captain--wordpress-duplicator-db:5432/wordpressduplicator
```

## 2. Criar app do WordPress Duplicator

No CapRover:

1. Crie uma nova app chamada `wordpress-duplicator`.
2. Ative persistent data.
3. Configure um volume persistente:

```text
/data
```

4. Configure as variaveis de ambiente:

```env
PORT=3000
NODE_ENV=production
WORDPRESS_DUPLICATOR_DATA_DIR=/data
DATABASE_URL=postgresql://wordpressduplicator:troque-esta-senha@srv-captain--wordpress-duplicator-db:5432/wordpressduplicator
APP_SECRET_KEY=gere-com-openssl-rand-base64-32
DRY_RUN_DEFAULT=true
DEFAULT_WP_PATH=/var/www/html
CAPROVER_OVERLAY_NETWORK=captain-overlay-network
ALLOW_DOCKER_SOCKET=false
ALLOW_STORE_SECRETS=false
```

Gere `APP_SECRET_KEY`:

```bash
openssl rand -base64 32
```

## 3. Deploy

Com o repositorio acessivel pelo CapRover, faca deploy usando o `captain-definition`:

```text
captain-definition
Dockerfile
```

Ou pelo CLI:

```bash
caprover deploy
```

## 4. Sobre Docker socket

Evite montar `/var/run/docker.sock` na app web.

Dar acesso ao Docker socket equivale a dar controle administrativo do host. Para producao, prefira:

- executar clones via SSH com usuario restrito;
- pedir credenciais na hora da execucao;
- usar chave SSH dedicada;
- registrar logs e checkpoints no Postgres;
- manter `DRY_RUN_DEFAULT=true` ate validar o fluxo.

Se ainda assim decidir usar Docker socket, faca isso apenas em ambiente controlado e com acesso autenticado ao painel.

## 5. Fluxo operacional recomendado

1. Acesse a UI do WordPress Duplicator.
2. Cadastre origem:
   - CapRover origem;
   - SSH origem;
   - app WordPress origem;
   - URL antiga.
3. Rode diagnostico:
   - SSH;
   - Docker;
   - CapRover;
   - container WordPress;
   - `wp-config.php`;
   - DB host;
   - MySQL;
   - volume/path.
4. Cadastre destino:
   - mesmo servidor ou outro;
   - mesmo CapRover ou outro;
   - nome da nova app;
   - nova URL.
5. Configure banco:
   - app MySQL destino;
   - credenciais root/admin;
   - nome do novo banco ou geracao automatica.
6. Execute primeiro em dry-run.
7. Execute em modo real.
8. Adicione dominio e HTTPS manualmente no CapRover.

## 6. Healthcheck

Depois do deploy, abra:

```text
https://SEU-DOMINIO/api/health
```

Resultado esperado:

```json
{
  "ok": true,
  "postgres": {
    "configured": true,
    "ready": true,
    "error": null
  }
}
```

## 7. Dados persistidos no Postgres

O Postgres deve guardar:

- perfis de conexao;
- perfis de clonagem;
- execucoes;
- etapas/checkpoints;
- logs mascarados;
- relatorios finais.

Credenciais sensiveis devem ser criptografadas com `APP_SECRET_KEY` ou solicitadas em tempo de execucao.

## 8. Checklist de seguranca

- Nao salvar senhas em texto puro.
- Mascarar segredos em logs.
- Usar chave SSH dedicada; senha SSH interativa nao funciona porque o executor usa `BatchMode=yes`.
- Se rodar dentro do CapRover, cole a chave privada SSH na UI ou monte a chave no container e informe o caminho interno.
- Validar primeiro com dry-run.
- Bloquear destino existente por padrao.
- Nunca escrever no banco original.
- Nunca alterar arquivos da app original.
- Usar `wp search-replace` em vez de SQL bruto para URLs.
- Ignorar coluna `guid` no search-replace.
- Registrar cada checkpoint.
- Permitir retomada apos falha.

## 9. Portas

Dentro do CapRover, a app escuta em:

```text
PORT=3000
```

Em `Configuracoes HTTP`, preencha tambem:

```text
Porta HTTP do Conteiner = 3000
```

Localmente, a UI pode rodar em:

```bash
PORT=3101 node ui/server.mjs
```
