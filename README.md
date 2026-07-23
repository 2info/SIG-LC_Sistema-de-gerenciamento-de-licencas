# SIG-LC — Sistema Integrado de Gestão de Licença Capacitação (MVP)

Backoffice para automatizar a concessão de **Licença Capacitação**, conforme o **Decreto nº 9.991/2019** e a **Instrução Normativa nº 21/2021**.



---

# Pré-requisitos

Antes de iniciar, certifique-se de possuir instalado:

- **Node.js 18+**
- **Docker** (para executar um PostgreSQL local)
  - ou um **PostgreSQL 15+** já disponível.

---

# Instalação

## 1. Subir o banco de dados

Execute:

```bash
docker-compose up -d
```

Este comando iniciará um container PostgreSQL disponível em:

```
localhost:5432
```

Utilizando as credenciais definidas no arquivo:

```
docker-compose.yml
```

---

## 2. Configurar as variáveis de ambiente

Copie o arquivo de exemplo:

```bash
cp .env.example .env
```

Em seguida, ajuste a variável:

```env
DATABASE_URL=
```

caso seja necessário.

---

## 3. Instalar as dependências

```bash
npm install
```

---

## 4. Criar o banco de dados

Existem duas opções.

### Opção A — Prisma Migrate (Recomendado)

Gera automaticamente o histórico de migrações.

```bash
npm run prisma:migrate
npm run prisma:generate
```

---

### Opção B — Aplicar o DDL manualmente

Caso prefira não utilizar o Prisma Migrate:

```bash
psql "$DATABASE_URL" -f db/schema.sql
npm run prisma:generate
```

---

## 5. Executar o backend

```bash
npm run dev
```

A API será iniciada em:

```
http://localhost:3333
```

Verifique se está funcionando:

```bash
curl http://localhost:3333/health
```

---

## 6. Executar os testes

Para validar o Motor de Regras:

```bash
npm test
```

---

## 7. Executar o Job de Notificações

Sem aguardar o cron:

```bash
npm run job:notificacao
```

### Produção

Na inicialização do processo **worker**, execute:

```ts
iniciarAgendamento()
```

Exportado em:

```
src/jobs/notificacaoJob.ts
```

Também é possível utilizar:

- Cron do Sistema Operacional;
- Kubernetes CronJob;
- outro scheduler de sua infraestrutura,

apontando para:

```bash
npm run job:notificacao
```

---

# Frontend

Os componentes presentes em:

```
frontend/components/
```

foram desenvolvidos para utilização em um projeto **React + Tailwind CSS**.

Arquivos disponíveis:

- DashboardOcupacao.tsx
- GanttServidores.tsx
- FormularioValidacao.tsx

## Criando um projeto React

```bash
npm create vite@latest sig-lc-frontend -- --template react-ts

cd sig-lc-frontend

npm install -D tailwindcss postcss autoprefixer

npx tailwindcss init -p
```

Configure o arquivo:

```js
tailwind.config.js
```

Incluindo:

```js
content: ["./src/**/*.{ts,tsx}"]
```

Depois copie para:

```
src/
```

as pastas:

```
frontend/components
frontend/mocks
```

---

## Modo Demonstração

O componente:

```
FormularioValidacao.tsx
```

possui:

```ts
MODO_DEMO = true
```

Assim ele funciona sem backend.

Quando integrar com a API real, altere para:

```ts
MODO_DEMO = false
```

A integração utiliza o endpoint:

```
POST /solicitar-licenca
```

---

# Endpoints da API

| Método | Endpoint | Descrição |
|---------|----------|-----------|
| **POST** | `/solicitar-licenca` | Valida e cria uma solicitação de Licença Capacitação |
| **GET** | `/ocupacao-diaria` | Retorna a ocupação diária por lotação e mês (heatmap) |
| **GET** | `/health` | Endpoint para verificação de disponibilidade da API |

---

# Tecnologias Utilizadas

- Node.js 18+
- TypeScript
- Express
- Prisma ORM
- PostgreSQL
- Docker
- React
- Tailwind CSS
- Vite

---

# Estrutura do Projeto

```text
SIG-LC/
│
├── docs/
│   └── ARQUITETURA.md
│
├── db/
│   └── schema.sql
│
├── frontend/
│   ├── components/
│   └── mocks/
│
├── src/
│   ├── jobs/
│   ├── controllers/
│   ├── services/
│   ├── routes/
│   └── ...
│
├── docker-compose.yml
├── package.json
├── .env.example
└── README.md
```

---

# Health Check

Após iniciar o sistema:

```bash
curl http://localhost:3333/health
```

Resposta esperada:

```json
{
  "status": "ok"
}
```

---

# Licença

Projeto desenvolvido para automatizar a gestão de **Licença Capacitação** conforme:

- Decreto nº 9.991/2019
- Instrução Normativa nº 21/2021
