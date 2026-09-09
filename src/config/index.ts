import dotenv from 'dotenv';

dotenv.config();

import { z } from 'zod';

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().url(),

  // Redis
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  // Server
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.string().default('info'),

  // WhatsApp Business Cloud API
  WHATSAPP_PHONE_NUMBER_ID: z.string().default(''),
  WHATSAPP_ACCESS_TOKEN: z.string().default(''),
  WHATSAPP_VERIFY_TOKEN: z.string().default(''),
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().default(''),
  WHATSAPP_API_VERSION: z.string().default('v18.0'),

  // Meta App
  META_APP_SECRET: z.string().default(''),

  // WhatsApp Graph API base URL — override for E2E (local fake Graph server)
  // or an API relay/proxy in front of the Meta Graph endpoint.
  WHATSAPP_GRAPH_BASE_URL: z.string().url().default('https://graph.facebook.com'),

  // Public origin for email tracking links/pixels (open/click/unsubscribe).
  // Set to the externally reachable base URL of this deployment.
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),

  // Auth — self-serve signup/login (email + password, JWT sessions).
  // AUTH_JWT_SECRET MUST be a long random value in production; the dev default
  // is refused when NODE_ENV=production.
  AUTH_JWT_SECRET: z.string().default('crossreach-dev-only-secret-change-me'),
  // Session lifetime in days before the dashboard JWT expires.
  AUTH_SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),

  // LLM provider — OpenRouter as relay (中转站). When OPENROUTER_API_KEY is set
  // it takes priority over the OpenAI-compatible vars below.
  OPENROUTER_API_KEY: z.string().default(''),
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  OPENROUTER_MODEL: z.string().default(''),

  // Legacy direct providers (kept as fallback when no OpenRouter key)
  OPENAI_API_KEY: z.string().default(''),
  ANTHROPIC_API_KEY: z.string().default(''),
  LLM_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  LLM_MODEL: z.string().default('gpt-4o-mini'),

  // Internal IM team alerts — group-bot webhook URLs for WeCom / Feishu /
  // DingTalk. Configure at least one to receive operational notifications.
  WECOM_WEBHOOK_URL: z.union([z.literal(''), z.string().url()]).default(''),
  FEISHU_WEBHOOK_URL: z.union([z.literal(''), z.string().url()]).default(''),
  DINGTALK_WEBHOOK_URL: z.union([z.literal(''), z.string().url()]).default(''),
  // DingTalk "加签" secret, required if the DingTalk robot uses signature auth.
  DINGTALK_SECRET: z.string().default(''),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = {
  ...parsed.data,
  isDev: parsed.data.NODE_ENV === 'development',
  isProd: parsed.data.NODE_ENV === 'production',
} as const;

export type Config = typeof config;
