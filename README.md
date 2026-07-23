# SIG-LC_Sistema-de-gerenciamento-de-licencas
SIG-LC — Sistema Integrado de Gestão de Licença Capacitação (MVP)

Backoffice para automatizar a concessão de Licença Capacitação conforme Decreto 9.991/2019 e IN 21/2021. Veja docs/ARQUITETURA.md para detalhes de design.

Pré-requisitos
Node.js 18+
Docker (para o PostgreSQL local) — ou um Postgres 15+ já disponível
1. Subir o banco de dados
bash
docker-compose up -d

Isso levanta um PostgreSQL em localhost:5432 com as credenciais definidas em docker-compose.yml.

2. Configurar variáveis de ambiente
bash
cp .env.example .env
# ajuste DATABASE_URL se necessário
3. Instalar dependências
bash
npm install
4. Aplicar o schema no banco

Opção A — via Prisma Migrate (recomendado, gera histórico de migrações):

bash
npm run prisma:migrate
npm run prisma:generate

Opção B — aplicar o DDL puro (se preferir não usar Prisma Migrate):

bash
psql "$DATABASE_URL" -f db/schema.sql
npm run prisma:generate
5. Rodar o backend
bash
npm run dev

A API sobe em http://localhost:3333. Teste com:

bash
curl http://localhost:3333/health
6. Rodar os testes do Motor de Regras
bash
npm test
7. Rodar o job de notificação manualmente (sem esperar o cron)
bash
npm run job:notificacao

Em produção, chame iniciarAgendamento() (exportado de src/jobs/notificacaoJob.ts) na inicialização do processo worker, ou agende via cron do SO / scheduler do orquestrador (ex: Kubernetes CronJob) apontando para npm run job:notificacao.

8. Frontend

Os componentes em frontend/components/ (DashboardOcupacao.tsx, GanttServidores.tsx, FormularioValidacao.tsx) foram escritos para rodar dentro de um projeto React + Tailwind já existente (ex: criado com Vite):

bash
npm create vite@latest sig-lc-frontend -- --template react-ts
cd sig-lc-frontend
npm install -D tailwindcss postcss autoprefixer
npx tailwindcss init -p
# configure tailwind.config.js (content: ["./src/**/*.{ts,tsx}"])
# copie a pasta frontend/components e frontend/mocks para src/

FormularioValidacao.tsx está com MODO_DEMO = true para funcionar sem backend; mude para false ao integrar com a API real (POST /solicitar-licenca).

Endpoints disponíveis
Método	Rota	Descrição
POST	/solicitar-licenca	Valida e cria uma solicitação de licença
GET	/ocupacao-diaria	Retorna ocupação diária por lotação/mês (heatmap)
GET	/health	Health check
