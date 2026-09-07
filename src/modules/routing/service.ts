import { prisma } from '../../db/prisma.js';
import { logger } from '../../utils/logger.js';
import type {
  RoutingRule,
  User,
  ChannelType,
  Conversation,
} from '@prisma/client';

// ── Routing Context (what we know when deciding an assignment) ────────────

export interface RoutingContext {
  tenantId: string;
  conversationId: string;
  channelId: string;
  channelType: ChannelType;
  customerId: string;
  customerTags: string[];
  customerSource: string | null;
  customerLanguage: string | null;
  firstMessageText: string | null;
}

// ── Match a routing rule against context ──────────────────────────────────

function ruleMatches(rule: RoutingRule, ctx: RoutingContext): boolean {
  switch (rule.matchType) {
    case 'CATCH_ALL':
      return true;

    case 'CHANNEL_TYPE':
      return ctx.channelType === rule.matchValue;

    case 'CUSTOMER_TAG':
      return ctx.customerTags.includes(rule.matchValue);

    case 'SOURCE':
      return ctx.customerSource === rule.matchValue;

    case 'LANGUAGE':
      return ctx.customerLanguage === rule.matchValue;

    case 'KEYWORD':
      if (!ctx.firstMessageText) return false;
      return ctx.firstMessageText
        .toLowerCase()
        .includes(rule.matchValue.toLowerCase());

    default:
      return false;
  }
}

// ── Assignment strategies ─────────────────────────────────────────────────

/**
 * Round-robin: cycle through online agents in the tenant (or a skill group).
 * Uses rrCursor on User to track position.
 */
async function assignRoundRobin(
  tenantId: string,
  candidateAgentIds: string[],
): Promise<string | null> {
  if (candidateAgentIds.length === 0) return null;

  // Pick the agent with the lowest rrCursor (next in line)
  const agents = await prisma.user.findMany({
    where: { id: { in: candidateAgentIds }, tenantId, isOnline: true },
    orderBy: { rrCursor: 'asc' },
    take: 1,
  });

  if (agents.length === 0) {
    // Fallback: include offline agents
    const offline = await prisma.user.findMany({
      where: { id: { in: candidateAgentIds }, tenantId },
      orderBy: { rrCursor: 'asc' },
      take: 1,
    });
    if (offline.length === 0) return null;
    return offline[0].id;
  }

  const chosen = agents[0];
  // Increment cursor for next round-robin cycle
  await prisma.user.update({
    where: { id: chosen.id },
    data: { rrCursor: { increment: 1 } },
  });

  return chosen.id;
}

/**
 * Least-load: assign to the agent with the fewest OPEN conversations.
 */
async function assignLeastLoad(
  tenantId: string,
  candidateAgentIds: string[],
): Promise<string | null> {
  if (candidateAgentIds.length === 0) return null;

  // Count open conversations per candidate agent
  const agents = await prisma.user.findMany({
    where: { id: { in: candidateAgentIds }, tenantId, isOnline: true },
    select: {
      id: true,
      _count: {
        select: {
          assignedConversations: {
            where: { status: { in: ['OPEN', 'PENDING'] } },
          },
        },
      },
    },
  });

  if (agents.length === 0) {
    // Fallback to offline agents
    const offline = await prisma.user.findMany({
      where: { id: { in: candidateAgentIds }, tenantId },
      select: { id: true },
      take: 1,
    });
    return offline[0]?.id ?? null;
  }

  // Sort by load ascending, pick the least loaded
  agents.sort(
    (a, b) =>
      a._count.assignedConversations - b._count.assignedConversations,
  );

  return agents[0].id;
}

/**
 * Dedicated: always assign to a specific agent (targetAgentId on rule).
 */
async function assignDedicated(rule: RoutingRule): Promise<string | null> {
  if (!rule.targetAgentId) return null;
  const agent = await prisma.user.findUnique({
    where: { id: rule.targetAgentId },
  });
  return agent ? agent.id : null;
}

/**
 * Skill-based: find agents whose skills match the skill group's required skills.
 */
async function assignSkillBased(
  tenantId: string,
  skillGroupId: string | null,
): Promise<string | null> {
  if (!skillGroupId) return null;

  const group = await prisma.skillGroup.findUnique({
    where: { id: skillGroupId },
    include: { members: true },
  });

  if (!group || group.members.length === 0) return null;

  // Online members first, then use least-load among them
  const onlineMembers = group.members.filter((m) => m.isOnline);
  const candidateIds = (onlineMembers.length > 0 ? onlineMembers : group.members).map(
    (m) => m.id,
  );

  return assignLeastLoad(tenantId, candidateIds);
}

// ── Main routing entry point ──────────────────────────────────────────────

/**
 * Evaluate routing rules against context and assign the conversation.
 * Returns the assigned agent ID, or null if no agent could be assigned.
 */
export async function routeConversation(
  ctx: RoutingContext,
): Promise<string | null> {
  // Load active rules ordered by priority (ascending = highest priority first)
  const rules = await prisma.routingRule.findMany({
    where: { tenantId: ctx.tenantId, isActive: true },
    orderBy: { priority: 'asc' },
  });

  // If no rules exist, fall back to least-load across all tenant agents
  if (rules.length === 0) {
    const allAgents = await prisma.user.findMany({
      where: { tenantId: ctx.tenantId, role: { in: ['AGENT', 'MANAGER'] } },
      select: { id: true },
    });
    const agentId = await assignLeastLoad(
      ctx.tenantId,
      allAgents.map((a) => a.id),
    );
    if (agentId) {
      await prisma.conversation.update({
        where: { id: ctx.conversationId },
        data: { assigneeId: agentId },
      });
      logger.info(
        { conversationId: ctx.conversationId, agentId, strategy: 'LEAST_LOAD_DEFAULT' },
        'Conversation auto-assigned (no rules, default least-load)',
      );
    }
    return agentId;
  }

  // Evaluate rules in priority order; first match wins
  for (const rule of rules) {
    if (!ruleMatches(rule, ctx)) continue;

    let agentId: string | null = null;

    switch (rule.strategy) {
      case 'DEDICATED':
        agentId = await assignDedicated(rule);
        break;

      case 'ROUND_ROBIN': {
        // Candidates: all online agents in tenant (or skill group members if specified)
        let candidateIds: string[] = [];
        if (rule.targetSkillGroupId) {
          const group = await prisma.skillGroup.findUnique({
            where: { id: rule.targetSkillGroupId },
            include: { members: { select: { id: true } } },
          });
          candidateIds = group?.members.map((m) => m.id) ?? [];
        } else {
          const agents = await prisma.user.findMany({
            where: { tenantId: ctx.tenantId, role: { in: ['AGENT', 'MANAGER'] } },
            select: { id: true },
          });
          candidateIds = agents.map((a) => a.id);
        }
        agentId = await assignRoundRobin(ctx.tenantId, candidateIds);
        break;
      }

      case 'LEAST_LOAD': {
        let candidateIds: string[] = [];
        if (rule.targetSkillGroupId) {
          const group = await prisma.skillGroup.findUnique({
            where: { id: rule.targetSkillGroupId },
            include: { members: { select: { id: true } } },
          });
          candidateIds = group?.members.map((m) => m.id) ?? [];
        } else {
          const agents = await prisma.user.findMany({
            where: { tenantId: ctx.tenantId, role: { in: ['AGENT', 'MANAGER'] } },
            select: { id: true },
          });
          candidateIds = agents.map((a) => a.id);
        }
        agentId = await assignLeastLoad(ctx.tenantId, candidateIds);
        break;
      }

      case 'SKILL_BASED':
        agentId = await assignSkillBased(ctx.tenantId, rule.targetSkillGroupId);
        break;
    }

    if (agentId) {
      await prisma.conversation.update({
        where: { id: ctx.conversationId },
        data: { assigneeId: agentId },
      });
      logger.info(
        {
          conversationId: ctx.conversationId,
          agentId,
          rule: rule.name,
          strategy: rule.strategy,
        },
        'Conversation auto-assigned via routing rule',
      );
      return agentId;
    }
  }

  logger.warn({ conversationId: ctx.conversationId }, 'No routing rule matched or no agent available');
  return null;
}

// ── Rule CRUD ─────────────────────────────────────────────────────────────

export async function createRoutingRule(params: {
  tenantId: string;
  name: string;
  priority: number;
  matchType: RoutingRule['matchType'];
  matchValue: string;
  strategy: RoutingRule['strategy'];
  targetAgentId?: string;
  targetSkillGroupId?: string;
}) {
  return prisma.routingRule.create({
    data: {
      tenantId: params.tenantId,
      name: params.name,
      priority: params.priority,
      matchType: params.matchType,
      matchValue: params.matchValue,
      strategy: params.strategy,
      targetAgentId: params.targetAgentId,
      targetSkillGroupId: params.targetSkillGroupId,
    },
  });
}

export async function getRoutingRules(tenantId: string) {
  return prisma.routingRule.findMany({
    where: { tenantId },
    orderBy: { priority: 'asc' },
    include: { targetAgent: { select: { id: true, name: true } } },
  });
}

export async function deleteRoutingRule(tenantId: string, ruleId: string) {
  return prisma.routingRule.delete({
    where: { id: ruleId, tenantId },
  });
}
