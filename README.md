# CrossReach

**AI Outbound Agent for Cross-Border Sales** — the AI sales agent that finds buyers, orchestrates WhatsApp + LinkedIn + Email sequences, and books meetings. Built for Chinese exporters reaching global buyers.

Inspired by [revor.ai](https://revor.ai/) — repositioned WhatsApp-first for the cross-border trade use case.

## What it does

```
Ad lead / ICP match → enroll in cross-channel sequence → AI generates personalized outreach
  → email warm-up (D1) → LinkedIn like (D2) → LinkedIn connect (D3) → WhatsApp close (D5)
  → prospect replies on ANY channel → sequence auto-stops → unified conversation thread
```

## Features

- **Cross-channel sequences** — each step targets a different channel; one prospect, three channels, one conversation
- **AI content generation** — learns your company + value prop, writes personalized outreach per prospect (LLM or template fallback)
- **Cross-channel stop-if-replied** — any inbound reply on any channel stops all active sequences for that prospect
- **Multi-tenant SaaS** — API-key-based tenant isolation, per-tenant channels/customers/conversations
- **WhatsApp Business Cloud API** — webhook signature verification, template messages, 24h customer-service window
- **Ad lead auto-enrollment** — Facebook / TikTok / Google lead forms → WhatsApp sequence
- **Unified customer profile (CDP)** — cross-channel identity merge, sales-stage flow (NEW → WON)
- **Smart routing** — round-robin / least-load / dedicated / skill-based assignment
- **Commercial landing page** — served at `/`, ready for deployment

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Start PostgreSQL (locally or via docker compose)
docker compose up -d
#   OR set DATABASE_URL in .env to your existing Postgres

# 3. Create the database schema
npm run db:push

# 4. Seed demo data (tenant + WhatsApp channel + admin user + API key)
npm run db:seed

# 5. Start the dev server
npm run dev
```

The server starts on `http://localhost:3000`.

- Landing page: http://localhost:3000/
- Health check: http://localhost:3000/health
- API docs: see `src/api/routes/`

## Configuration

Copy `.env.example` to `.env` and fill in:

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL connection string |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta WhatsApp Business phone number ID |
| `WHATSAPP_ACCESS_TOKEN` | Meta Graph API access token |
| `WHATSAPP_VERIFY_TOKEN` | Webhook verification token (any string) |
| `META_APP_SECRET` | Meta app secret for webhook HMAC verification |
| `OPENAI_API_KEY` | (Optional) enables LLM content generation; falls back to template if unset |
| `LLM_MODEL` | (Optional) model name, defaults to `gpt-4o-mini` |

## API overview

All `/api/*` routes require `x-api-key: <your-tenant-api-key>` header.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check (no auth) |
| `GET` | `/` | Commercial landing page |
| `GET` | `/webhooks/whatsapp` | Meta webhook verification |
| `POST` | `/webhooks/whatsapp` | Receive WhatsApp messages |
| `GET/POST` | `/api/ai/templates` | AI content-template CRUD |
| `POST` | `/api/ai/generate` | Generate personalized outreach for a customer |
| `POST` | `/api/ai/preview` | Preview rendered prompt (no LLM call) |
| `GET` | `/api/ai/defaults` | Default prompt templates |
| `GET/POST` | `/api/sequences` | List / create cross-channel sequences |
| `POST` | `/api/sequences/:id/enroll` | Enroll a customer in a sequence |
| `GET/POST` | `/api/customers` | Customer CRUD |
| `GET` | `/api/conversations` | Conversation list |
| `POST` | `/api/conversations/:id/messages` | Send a message |
| `POST` | `/api/conversations/:id/assign` | Assign an agent |

## Create a cross-channel sequence

```bash
curl -X POST http://localhost:3000/api/sequences \
  -H "x-api-key: demo-api-key-001" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Cross-border outbound",
    "steps": [
      {"stepNumber": 1, "actionType": "SEND_AI_OUTREACH", "aiTemplateId": "<template-id>", "delayMinutes": 0, "stopIfReplied": false},
      {"stepNumber": 2, "actionType": "LINKEDIN_LIKE", "delayMinutes": 1440},
      {"stepNumber": 3, "actionType": "LINKEDIN_CONNECT", "delayMinutes": 1440},
      {"stepNumber": 4, "actionType": "SEND_AI_OUTREACH", "aiTemplateId": "<template-id>", "channelId": "<wa-channel-id>", "delayMinutes": 2880}
    ]
  }'
```

## Tech stack

- **Runtime:** Node.js 24, TypeScript (strict, ESM)
- **Web framework:** Fastify 4
- **Database:** PostgreSQL 16 + Prisma 5
- **WhatsApp:** Meta Cloud API (no on-prem client needed)
- **AI:** OpenAI-compatible chat completions API (pluggable)

## Architecture

```
public/                  Commercial landing page (HTML/CSS)
prisma/
  schema.prisma         Multi-tenant data model (7 models, 6 enums)
  seed.ts                Demo data
src/
  api/
    routes/             REST endpoints (whatsapp, leads, customers, conversations, routing, growth, ai)
    middleware/         API-key tenant resolution
    server.ts           Fastify bootstrap + static file serving
  channels/
    whatsapp/           WhatsApp Cloud API adapter (webhook + send)
    types.ts            Unified MessageContent abstraction
  modules/
    ai/                 AI content generation (LLM + template fallback)
    growth/             Cross-channel sequences + broadcast campaigns
    customers/          CDP — unified customer profile
    conversations/      Session management + assignment
    messages/           Inbound pipeline + outbound dispatch
    routing/            Smart agent routing
  config/               Env-driven config
  db/                   Prisma client
  utils/                Logger
  app.ts                Server entry + scheduler
```

## Deployment (production)

WhatsApp is blocked in mainland China. Deploy the backend on overseas infrastructure:

- **Region:** AWS Hong Kong / Singapore / GCP Tokyo
- **Runtime:** Node 24 + PostgreSQL 16 (managed RDS or self-hosted)
- **Process manager:** PM2 or containerized (Dockerfile below)
- **Webhook URL:** `https://<your-domain>/webhooks/whatsapp` — register in Meta App Dashboard
- **China access:** operators use the web dashboard via corporate VPN; customers are overseas and use WhatsApp normally

## License

Proprietary. All rights reserved.
