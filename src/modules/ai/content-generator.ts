import { logger } from '../../utils/logger.js';
import { config } from '../../config/index.js';
import type { AIContentTemplate, Customer } from '@prisma/client';

// ── Generation input (context about the prospect) ────────────────────────

export interface ProspectContext {
  customer: Pick<Customer, 'name' | 'phone' | 'email' | 'source' | 'tags' | 'attributes'>;
  // Seller-side context (your company info, value prop, etc.)
  sellerInfo?: Record<string, string>;
  // Free-form notes about this prospect (research output)
  researchNotes?: string;
  // Previous messages in the conversation (for follow-up context)
  previousMessages?: string[];
}

// ── Generation result ────────────────────────────────────────────────────

export interface GeneratedContent {
  // For WhatsApp/template: the message body text
  body: string;
  // For email: subject line (null for non-email)
  subject: string | null;
  // The provider that produced this (for analytics)
  source: 'llm' | 'template_fallback';
}

// ── Variable substitution ─────────────────────────────────────────────────

/**
 * Replace {{variable}} placeholders in a prompt with values from context.
 * Built-in variables: prospect_name, prospect_company, prospect_phone,
 * prospect_source, seller_* (any key from sellerInfo), research_notes.
 */
export function renderTemplate(template: string, ctx: ProspectContext): string {
  const vars: Record<string, string> = {
    prospect_name: ctx.customer.name ?? 'there',
    prospect_company: (ctx.customer.attributes as Record<string, string>)?.company ?? '',
    prospect_phone: ctx.customer.phone ?? '',
    prospect_source: ctx.customer.source ?? '',
    research_notes: ctx.researchNotes ?? '',
  };

  // Merge seller info with seller_ prefix
  if (ctx.sellerInfo) {
    for (const [k, v] of Object.entries(ctx.sellerInfo)) {
      vars[`seller_${k}`] = v;
    }
  }

  // Merge prospect attributes with prospect_ prefix
  const attrs = ctx.customer.attributes as Record<string, string> | null;
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (!(k in vars)) vars[`prospect_${k}`] = String(v);
    }
  }

  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? '');
}

// ── LLM call (OpenAI-compatible API) ──────────────────────────────────────

interface LLMResponse {
  content: string;
}

async function callLLM(
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
): Promise<LLMResponse> {
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? '';
  const baseUrl =
    process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1';
  const model = process.env.LLM_MODEL ?? 'gpt-4o-mini';

  if (!apiKey) {
    throw new Error('No LLM API key configured');
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: maxTokens,
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`LLM API error ${response.status}: ${errText}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };

  return { content: data.choices[0]?.message?.content ?? '' };
}

// ── Template-based fallback (no API key needed) ───────────────────────────

function templateFallback(
  aiTemplate: AIContentTemplate,
  ctx: ProspectContext,
): GeneratedContent {
  const name = ctx.customer.name ?? 'there';
  const source = ctx.customer.source ?? 'your ad';

  // Channel-aware fallback
  const isEmail = aiTemplate.channel === 'EMAIL';
  const body = renderTemplate(aiTemplate.userPrompt, ctx) ||
    `Hi ${name}, I noticed you showed interest via ${source}. ` +
    `I'd love to learn more about your needs and see if we can help. ` +
    `Are you open to a quick chat this week?`;

  return {
    body,
    subject: isEmail ? `Quick question for you, ${name}` : null,
    source: 'template_fallback',
  };
}

// ── Main generation entry point ────────────────────────────────────────────

/**
 * Generate personalized outreach content using an AI template + prospect context.
 * Uses LLM if configured, falls back to template rendering otherwise.
 */
export async function generateOutreachContent(
  aiTemplate: AIContentTemplate,
  ctx: ProspectContext,
): Promise<GeneratedContent> {
  const systemPrompt = renderTemplate(aiTemplate.systemPrompt, ctx);
  const userPrompt = renderTemplate(aiTemplate.userPrompt, ctx);

  const hasLLM =
    !!(process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY);

  if (hasLLM) {
    try {
      const result = await callLLM(systemPrompt, userPrompt, aiTemplate.maxTokens);
      const content = result.content.trim();

      // Parse subject + body for emails (LLM may return "Subject: ...\n\nBody")
      let subject: string | null = null;
      let body = content;

      if (aiTemplate.channel === 'EMAIL') {
        const subjectMatch = content.match(/^subject:\s*(.+?)$/im);
        if (subjectMatch) {
          subject = subjectMatch[1].trim();
          body = content.slice(subjectMatch.index! + subjectMatch[0].length).trim();
        }
      }

      logger.info(
        { templateId: aiTemplate.id, source: 'llm', channel: aiTemplate.channel },
        'AI outreach content generated',
      );

      return { body, subject, source: 'llm' };
    } catch (err) {
      logger.warn({ err, templateId: aiTemplate.id }, 'LLM call failed, using fallback');
    }
  }

  return templateFallback(aiTemplate, ctx);
}

// ── Seed default templates (used by sequence steps) ───────────────────────

export const DEFAULT_SYSTEM_PROMPT = `You are a skilled B2B sales development representative writing personalized outreach.
Rules:
- Keep it concise and conversational (under 80 words for WhatsApp, under 150 for email)
- Reference one specific detail about the prospect
- End with a soft, low-pressure question
- Never sound like a mass template
- Write in {{language}}`;

export const DEFAULT_WHATSAPP_PROMPT = `Write a casual WhatsApp follow-up message to {{prospect_name}}.
Context: They came from {{prospect_source}}. {{research_notes}}
Tone: Friendly, like a colleague texting. No emojis unless natural.
Start with "Hi {{prospect_name}}" and ask one question to qualify interest.`;

export const DEFAULT_EMAIL_PROMPT = `Write a cold email to {{prospect_name}} at {{prospect_company}}.
They engaged via {{prospect_source}}. {{research_notes}}
Your company: {{seller_name}} — {{seller_value_prop}}.
Format: "Subject: ..." on first line, blank line, then body. Under 120 words.`;
