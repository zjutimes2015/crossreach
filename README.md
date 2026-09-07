# CrossReach

> **AI Outbound Agent for Cross-Border Sales** — find buyers, warm them up across WhatsApp + LinkedIn + Email, and book meetings. Built for Chinese exporters reaching global buyers.

CrossReach is a multi-tenant SaaS backend that turns WhatsApp Business into an automated sales engine. Instead of a help-desk tool, it's an **AI agent** that orchestrates cross-channel outreach sequences, generates personalized content per prospect, and stops the moment a prospect replies — so your team only steps in when a deal is ready to close.

Inspired by [revor.ai](https://revor.ai/), repositioned **WhatsApp-first** for the cross-border trade use case.

---

## Table of contents

- [Why CrossReach](#why-crossreach)
- [How it works](#how-it-works)
- [Features](#features)
- [Tech stack](#tech-stack)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [npm scripts](#npm-scripts)
- [Data model](#data-model)
- [API reference](#api-reference)
- [Usage examples](#usage-examples)
- [Architecture](#architecture)
- [Deployment](#deployment)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## Why CrossReach

| Pain | How CrossReach solves it |
|------|--------------------------|
| WhatsApp is blocked in mainland China | Backend deploys overseas (HK/SG); operators use the web dashboard via VPN, customers are overseas and use WhatsApp normally |
| Mass-template outreach gets ignored | AI generates a personalized message per prospect, referencing their company + intent signals |
| Single-channel sequences feel robotic | One prospect flows through **email → LinkedIn → WhatsApp** in a single orchestrated thread |
| Sales reps waste time on cold leads | `stopIfReplied` halts all sequences the moment a prospect replies on any channel |
| Lead form → WhatsApp latency kills conversions | Facebook/TikTok/Google lead forms auto-enroll into a WhatsApp sequence — zero manual steps |
| SaaS priced per seat punishes AI productivity | Credit-based pricing: you pay for enrichment + outreach that actually happens, not headcount |

## How it works

```
Ad lead / ICP match
       │
       ▼
  enroll in cross-channel sequence
       │
       ▼
  ┌─────────────────────────────────────────────┐
  │  Day 1  →  email warm-up        (AI-generated) │
  │  Day 2  →  LinkedIn: like posts               │
  │  Day 3  →  LinkedIn: connect + note           │
  │  Day 5  →  WhatsApp follow-up    (AI-generated) │
  │  Day 7  →  meeting booked                       │
  └─────────────────────────────────────────────┘
       │
       ▼
  prospect replies on ANY channel
       │
       ▼
  all active sequences auto-stop
       │
       ▼
  unified conversation thread → routed to a sales rep
```

## Features

- **Cross-channel sequences** — each step targets a different channel; one prospect, three channels, one conversation
- **7 step action types** — `SEND_TEMPLATE`, `SEND_AI_OUTREACH`, `SEND_EMAIL`, `LINKEDIN_LIKE`, `LINKEDIN_CONNECT`, `LINKEDIN_MESSAGE`, `WAIT`
- **AI content generation** — learns your company + value prop, writes personalized outreach per prospect (LLM with template fallback)
- **Cross-channel stop-if-replied** — any inbound reply on any channel stops all active sequences for that prospect
- **Multi-tenant SaaS** — API-key-based tenant isolation, per-tenant channels/customers/conversations
- **WhatsApp Business Cloud API** — webhook HMAC-SHA256 signature verification, template messages, 24h customer-service window
- **Ad lead auto-enrollment** — Facebook / TikTok / Google lead forms → WhatsApp sequence
- **Unified customer profile (CDP)** — cross-channel identity merge, sales-stage flow (NEW → CONTACTED → QUALIFIED → WON)
- **Smart routing** — round-robin / least-load / dedicated / skill-based assignment
- **Commercial landing page** — served at `/`, ready for deployment

## Tech stack

| Layer | Choice | Why |
|-------|--------|-----|
| Runtime | Node.js 24, TypeScript (strict, ESM) | Modern, fast, type-safe |
| Web framework | Fastify 4 | 2× faster than Express, schema-first |
| Database | PostgreSQL 16 + Prisma 5 | Relational + type-safe ORM |
| WhatsApp | Meta Cloud API | No on-prem client, hosted by Meta |
| AI | OpenAI-compatible chat completions | Pluggable — works with OpenAI, Azure, Anthropic-proxy, local LLMs |
| Logging | Pino | Structured JSON logs, low overhead |
| Validation | Zod | Runtime + compile-time safety |

## Quick start

### Prerequisites

- **Node.js** ≥ 20 (tested on 24)
- **PostgreSQL** ≥ 14 (tested on 16)
- A Meta WhatsApp Business account (for production; demo mode works without it)

### Install & run

```bash
# 1. Clone & install
git clone <your-repo-url> crossreach && cd crossreach
npm install

# 2. Start PostgreSQL (pick one)
docker compose up -d                          # via docker-compose.yml
#   OR
#   set DATABASE_URL in .env to your existing Postgres

# 3. Create the database schema
npm run db:push

# 4. Seed demo data (tenant + WhatsApp channel + admin user + API key)
npm run db:seed

# 5. Start the dev server
npm run dev
```

The server starts on `http://localhost:3000`.

| URL | What |
|-----|------|
| http://localhost:3000/ | Commercial landing page |
| http://localhost:3000/health | Health check |
| http://localhost:3000/api/* | REST API (requires `x-api-key` header) |

## Configuration

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Purpose |
|----------|----------|---------|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `WHATSAPP_PHONE_NUMBER_ID` | prod | Meta WhatsApp Business phone number ID |
| `WHATSAPP_ACCESS_TOKEN` | prod | Meta Graph API access token |
| `WHATSAPP_VERIFY_TOKEN` | prod | Webhook verification token (any string you set) |
| `META_APP_SECRET` | prod | Meta app secret for webhook HMAC verification |
| `OPENAI_API_KEY` | optional | Enables LLM content generation; falls back to template if unset |
| `LLM_BASE_URL` | optional | Custom LLM endpoint (defaults to OpenAI) |
| `LLM_MODEL` | optional | Model name (defaults to `gpt-4o-mini`) |

## npm scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with hot reload (tsx watch) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled server (`node dist/app.js`) |
| `npm run db:generate` | Regenerate Prisma Client |
| `npm run db:push` | Push schema to database (no migration history) |
| `npm run db:migrate` | Create + apply a migration |
| `npm run db:studio` | Open Prisma Studio (visual DB browser) |
| `npm run db:seed` | Seed demo data |
| `npm test` | Run tests (Vitest) |
| `npm run test:watch` | Run tests in watch mode |

## Data model

15 Prisma models + 16 enums. Core entities:

```
Tenant ──< Channel          (WhatsApp, Email, LinkedIn, …)
       ──< User             (sales reps, admins)
       ──< Customer         (unified CDP profile)
       │      └─< Conversation ──< Message
       ──< SkillGroup       (routing target)
       ──< RoutingRule      (assignment rules)
       ──< LeadSource       (FB/TikTok/Google lead forms)
       ──< Campaign ──< CampaignRecipient   (batch broadcast)
       ──< Sequence ──< SequenceStep        (cross-channel steps)
       │      └─< SequenceEnrollment        (per-customer state)
       ──< AIContentTemplate                (LLM prompt + variables)
```

Key enums: `ChannelType`, `CustomerStage` (NEW→CONTACTED→QUALIFIED→WON), `StepActionType` (7 action types), `EnrollmentStatus` (ACTIVE/COMPLETED/STOPPED), `AssignStrategy` (4 routing algorithms).

See [prisma/schema.prisma](prisma/schema.prisma) for the full schema.

## API reference

All `/api/*` routes require the `x-api-key: <your-tenant-api-key>` header.

### Webhooks (no auth — verified by signature/token)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/webhooks/whatsapp` | Meta webhook subscription verification |
| `POST` | `/webhooks/whatsapp` | Receive inbound WhatsApp messages |
| `POST` | `/webhooks/leads` | Receive ad-lead webhook (FB/TikTok/Google) |

### AI

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/ai/templates` | List AI content templates |
| `POST` | `/api/ai/templates` | Create an AI content template |
| `DELETE` | `/api/ai/templates/:id` | Delete a template |
| `POST` | `/api/ai/generate` | Generate personalized outreach for a customer |
| `POST` | `/api/ai/preview` | Preview rendered prompt (no LLM call) |
| `GET` | `/api/ai/defaults` | Get default prompt templates (for UI seeding) |

### Growth (sequences & campaigns)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sequences` | List sequences (with steps + active enrollment count) |
| `POST` | `/api/sequences` | Create a cross-channel sequence |
| `GET` | `/api/sequences/:id` | Get sequence detail (steps + enrollments) |
| `POST` | `/api/sequences/:id/enroll` | Enroll a customer in a sequence |
| `GET/POST` | `/api/campaigns` | List / create broadcast campaigns |
| `POST` | `/api/campaigns/:id/start` | Start a campaign |

### Customers & conversations

| Method | Path | Description |
|--------|------|-------------|
| `GET/POST` | `/api/customers` | List / create customers |
| `PATCH` | `/api/customers/:id/stage` | Update customer stage |
| `GET` | `/api/conversations` | List conversations |
| `POST` | `/api/conversations/:id/messages` | Send a message (text/template/interactive) |
| `POST` | `/api/conversations/:id/assign` | Assign an agent |
| `GET` | `/api/routing/rules` | List routing rules |

## Usage examples

### 1. Create an AI content template

```bash
curl -X POST http://localhost:3000/api/ai/templates \
  -H "x-api-key: demo-api-key-001" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "WhatsApp follow-up",
    "channel": "WHATSAPP",
    "systemPrompt": "You are a skilled B2B sales rep writing casual WhatsApp messages.",
    "userPrompt": "Write to {{prospect_name}}. They came from {{prospect_source}}. {{research_notes}}",
    "maxTokens": 150
  }'
```

### 2. Generate personalized outreach

```bash
curl -X POST http://localhost:3000/api/ai/generate \
  -H "x-api-key: demo-api-key-001" \
  -H "Content-Type: application/json" \
  -d '{
    "templateId": "<template-id>",
    "customerId": "<customer-id>",
    "researchNotes": "Recently raised Series A, expanding to Southeast Asia",
    "sellerInfo": { "name": "Acme", "value_prop": "cross-border logistics" }
  }'
# → { "content": { "body": "Hi Sarah, saw your Series A — congrats! ...", "subject": null, "source": "llm" } }
```

### 3. Create a cross-channel sequence

```bash
curl -X POST http://localhost:3000/api/sequences \
  -H "x-api-key: demo-api-key-001" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Cross-border outbound — 3 channels",
    "steps": [
      {"stepNumber": 1, "actionType": "SEND_AI_OUTREACH", "aiTemplateId": "<email-template-id>", "channelId": "<email-channel-id>", "delayMinutes": 0, "stopIfReplied": false},
      {"stepNumber": 2, "actionType": "LINKEDIN_LIKE", "delayMinutes": 1440},
      {"stepNumber": 3, "actionType": "LINKEDIN_CONNECT", "delayMinutes": 1440},
      {"stepNumber": 4, "actionType": "SEND_AI_OUTREACH", "aiTemplateId": "<wa-template-id>", "channelId": "<wa-channel-id>", "delayMinutes": 2880}
    ]
  }'
```

### 4. Enroll a customer → the agent handles the rest

```bash
curl -X POST http://localhost:3000/api/sequences/<sequence-id>/enroll \
  -H "x-api-key: demo-api-key-001" \
  -H "Content-Type: application/json" \
  -d '{"customerId": "<customer-id>"}'
```

The sequence scheduler runs every 60 seconds, executes due steps, and auto-stops when the prospect replies on any channel.

## Architecture

```
public/                          Commercial landing page (HTML/CSS)
prisma/
  schema.prisma                  Multi-tenant data model (15 models, 16 enums)
  seed.ts                         Demo data (tenant + channel + admin + API key)
src/
  api/
    routes/                      REST endpoints
      webhooks.ts                  WhatsApp + lead-form webhooks
      ai.ts                        AI template CRUD + content generation
      growth.ts                    Sequences + campaigns
      customers.ts  conversations.ts  routing.ts  leads.ts
    middleware/tenant.ts         API-key → tenant resolution
    server.ts                    Fastify bootstrap + static file serving
  channels/
    whatsapp/                    WhatsApp Cloud API adapter (webhook + send + transform)
    types.ts                     Unified MessageContent abstraction (8 message kinds)
  modules/
    ai/content-generator.ts      LLM call + variable substitution + template fallback
    growth/
      sequences.ts               Cross-channel sequence engine (7 action types)
      broadcast.ts               Batch campaign dispatch
      lead-import.ts             Ad-lead → customer + enrollment
    customers/service.ts        CDP — unified profile, stage flow, identity merge
    conversations/service.ts    Session management + assignment
    messages/
      pipeline.ts                Inbound: webhook → channel → customer → conversation
      service.ts                 Outbound: send + persist
    routing/service.ts          Smart agent routing (4 strategies)
  config/index.ts               Env-driven config (Zod-validated)
  db/prisma.ts                  Prisma client singleton
  utils/logger.ts               Pino structured logger
  app.ts                        Server entry + sequence scheduler (60s cron)
```

## Deployment

### Production (WhatsApp requires overseas hosting)

WhatsApp is blocked in mainland China. Deploy the backend on overseas infrastructure:

| Concern | Recommendation |
|---------|----------------|
| Region | AWS Hong Kong / Singapore / GCP Tokyo |
| Runtime | Node 24 + PostgreSQL 16 (managed RDS or self-hosted) |
| Process manager | PM2 or containerized (Dockerfile) |
| Webhook URL | `https://<your-domain>/webhooks/whatsapp` — register in Meta App Dashboard |
| China operator access | Web dashboard via corporate VPN; customers are overseas and use WhatsApp normally |
| Data residency | Customer data stays overseas — this avoids China's data-export review |

### Minimal Dockerfile

```dockerfile
FROM node:24-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN npx prisma generate
EXPOSE 3000
CMD ["node", "dist/app.js"]
```

Build with `npm run build` before `docker build`.

## Roadmap

### Done

- [x] Multi-tenant Prisma schema (15 models, 16 enums)
- [x] WhatsApp Business Cloud API adapter (webhook + send)
- [x] Cross-channel sequence engine (7 action types)
- [x] AI content generation (LLM + template fallback)
- [x] Cross-channel stop-if-replied
- [x] Unified CDP + sales-stage flow
- [x] Smart routing (4 strategies)
- [x] Ad-lead auto-enrollment
- [x] Commercial landing page

### Next

- [ ] LinkedIn automation layer (Playwright-based `LINKEDIN_LIKE`/`CONNECT`/`MESSAGE` execution)
- [ ] Email send service (currently stubbed — needs SMTP or SendGrid integration)
- [ ] ICP target discovery (live-signal-based prospect finding, à la revor.ai)
- [ ] Company enrichment (domain → decision-maker contacts)
- [ ] React dashboard (conversation inbox + sequence builder)
- [ ] Webhook delivery for CRM sync (HubSpot / Salesforce / custom)
- [ ] Internal IM integrations (WeCom / Feishu / DingTalk) for in-team notifications
- [ ] Credit-based billing + usage metering
- [ ] OAuth for multi-tenant onboarding

## Contributing

1. Fork the repo and create a feature branch: `git checkout -b feat/<name>`
2. Run `npm install` and `npm run db:push` to set up your dev DB
3. Make your change — keep TypeScript strict mode passing (`npx tsc --noEmit`)
4. Add or update tests where relevant (`npm test`)
5. Open a PR describing what changed and why

### Commit style

Conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.

## License

Proprietary. All rights reserved. See [LICENSE](LICENSE) for details (or contact the maintainer for licensing options).
