import { prisma } from '../../db/prisma.js';
import { logger } from '../../utils/logger.js';
import { sendWhatsAppMessage } from '../../channels/whatsapp/api.js';
import { generateOutreachContent } from '../ai/content-generator.js';
import { isSuppressed } from '../compliance/suppression.js';
import type { WhatsAppChannelConfig } from '../../channels/types.js';
import type {
  Sequence,
  SequenceStep,
  SequenceEnrollment,
  StepActionType,
} from '@prisma/client';

// ── Step definition (for createSequence) ──────────────────────────────────

export interface SequenceStepInput {
  stepNumber: number;
  delayMinutes: number;
  channelId?: string; // overrides sequence.channelId
  actionType?: StepActionType;
  templateName?: string;
  language?: string;
  components?: unknown[];
  emailSubject?: string;
  emailBody?: string;
  linkedinTarget?: string;
  aiTemplateId?: string;
  stopIfReplied?: boolean;
}

// ── Create a sequence with cross-channel steps ────────────────────────────

export async function createSequence(params: {
  tenantId: string;
  name: string;
  description?: string;
  channelId?: string;
  steps: SequenceStepInput[];
}): Promise<Sequence> {
  const sequence = await prisma.sequence.create({
    data: {
      tenantId: params.tenantId,
      name: params.name,
      description: params.description,
      channelId: params.channelId,
      isActive: true,
      steps: {
        create: params.steps.map((s) => ({
          stepNumber: s.stepNumber,
          delayMinutes: s.delayMinutes,
          channelId: s.channelId,
          actionType: s.actionType ?? 'SEND_TEMPLATE',
          templateName: s.templateName,
          language: s.language ?? 'en_US',
          components: (s.components ?? []) as object,
          emailSubject: s.emailSubject,
          emailBody: s.emailBody,
          linkedinTarget: s.linkedinTarget,
          aiTemplateId: s.aiTemplateId,
          stopIfReplied: s.stopIfReplied ?? true,
        })),
      },
    },
    include: { steps: { orderBy: { stepNumber: 'asc' } } },
  });

  logger.info({ sequenceId: sequence.id, stepCount: params.steps.length }, 'Sequence created');
  return sequence;
}

// ── Enroll a customer in a sequence ───────────────────────────────────────

export async function enrollInSequence(
  tenantId: string,
  sequenceId: string,
  customerId: string,
): Promise<SequenceEnrollment | null> {
  const sequence = await prisma.sequence.findFirst({
    where: { id: sequenceId, tenantId, isActive: true },
    include: { steps: { orderBy: { stepNumber: 'asc' } } },
  });

  if (!sequence || sequence.steps.length === 0) {
    logger.warn({ sequenceId, customerId }, 'Cannot enroll: sequence missing or no steps');
    return null;
  }

  // Avoid duplicate active enrollment
  const existing = await prisma.sequenceEnrollment.findFirst({
    where: { sequenceId, customerId, status: 'ACTIVE' },
  });
  if (existing) {
    logger.info({ sequenceId, customerId }, 'Already enrolled, skipping');
    return existing;
  }

  const firstStep = sequence.steps[0];
  const nextStepAt = new Date(Date.now() + firstStep.delayMinutes * 60_000);

  const enrollment = await prisma.sequenceEnrollment.create({
    data: {
      tenantId,
      sequenceId,
      customerId,
      currentStepId: firstStep.id,
      status: 'ACTIVE',
      nextStepAt,
    },
  });

  logger.info(
    { enrollmentId: enrollment.id, sequenceId, customerId, nextStepAt },
    'Customer enrolled in sequence',
  );

  return enrollment;
}

// ── Stop all active enrollments for a customer (cross-channel) ────────────

export async function stopEnrollment(
  tenantId: string,
  customerId: string,
): Promise<number> {
  const result = await prisma.sequenceEnrollment.updateMany({
    where: { tenantId, customerId, status: 'ACTIVE' },
    data: { status: 'STOPPED' },
  });

  if (result.count > 0) {
    logger.info({ customerId, stopped: result.count }, 'Sequence enrollments stopped (customer replied)');
  }
  return result.count;
}

// ── Execute a single step's action ─────────────────────────────────────────

async function executeStep(
  enrollment: SequenceEnrollment & {
    currentStep: (SequenceStep & { aiTemplate: null }) | null;
    sequence: Sequence & {
      channel: { config: unknown } | null;
      steps: SequenceStep[];
    };
  },
  customer: { id: string; externalId: string; name: string | null; phone: string | null; email: string | null; source: string | null; tags: string[]; attributes: unknown },
  now: Date,
): Promise<{ sent: boolean; suppressed?: boolean }> {
  const step = enrollment.currentStep;
  const sequence = enrollment.sequence;

  if (!step) return { sent: false };

  // Resolve channel: step.channelId ?? sequence.channelId
  const channelId = step.channelId ?? sequence.channelId;
  if (!channelId) {
    logger.warn({ stepId: step.id }, 'Step has no channelId and sequence has none');
    return { sent: false };
  }

  const channel = await prisma.channel.findUnique({ where: { id: channelId } });
  if (!channel) {
    logger.warn({ channelId }, 'Channel not found for sequence step');
    return { sent: false };
  }

  // Compliance gate: anyone suppressed (opted out / complained / hard bounce)
  // is never contacted again, even from an active sequence.
  const sendsMessage =
    step.actionType === 'SEND_TEMPLATE' || step.actionType === 'SEND_AI_OUTREACH';
  if (sendsMessage && (channel.type === 'WHATSAPP' || channel.type === 'EMAIL')) {
    const contactRaw =
      channel.type === 'WHATSAPP' ? customer.externalId : (customer.email ?? '');
    if (contactRaw) {
      const suppressed = await isSuppressed(
        enrollment.tenantId,
        channel.type === 'WHATSAPP' ? 'WHATSAPP' : 'EMAIL',
        contactRaw,
      );
      if (suppressed) {
        logger.info(
          { enrollmentId: enrollment.id, customerId: customer.id, reason: suppressed.reason },
          'Sequence step skipped — recipient suppressed',
        );
        return { sent: false, suppressed: true };
      }
    }
  }

  switch (step.actionType) {
    case 'WAIT': {
      // Pure delay — no action, just advance
      return { sent: true };
    }

    case 'SEND_TEMPLATE': {
      if (channel.type !== 'WHATSAPP' || !step.templateName) {
        logger.warn({ stepId: step.id, channelType: channel.type }, 'SEND_TEMPLATE requires WhatsApp + templateName');
        return { sent: false };
      }
      const channelConfig = channel.config as unknown as WhatsAppChannelConfig;
      const result = await sendWhatsAppMessage(channelConfig, {
        to: customer.externalId,
        content: {
          kind: 'template',
          templateName: step.templateName,
          language: step.language,
          components: (step.components as unknown[]) ?? undefined,
        },
      });
      return { sent: result.status === 'sent' };
    }

    case 'SEND_AI_OUTREACH': {
      if (!step.aiTemplate) {
        logger.warn({ stepId: step.id }, 'SEND_AI_OUTREACH requires aiTemplate');
        return { sent: false };
      }

      // Generate personalized content via AI
      const generated = await generateOutreachContent(step.aiTemplate, {
        customer: {
          name: customer.name,
          phone: customer.phone,
          email: customer.email,
          source: customer.source,
          tags: customer.tags,
          attributes: customer.attributes as object | null,
        },
      });

      if (channel.type === 'WHATSAPP') {
        const channelConfig = channel.config as unknown as WhatsAppChannelConfig;
        const result = await sendWhatsAppMessage(channelConfig, {
          to: customer.externalId,
          content: { kind: 'text', text: generated.body },
        });
        return { sent: result.status === 'sent' };
      }

      // Email channel (stub — would use an email service in production)
      if (channel.type === 'EMAIL') {
        logger.info(
          { customerId: customer.id, subject: generated.subject },
          'AI email generated (email send not yet implemented)',
        );
        return { sent: true };
      }

      return { sent: false };
    }

    case 'SEND_EMAIL': {
      // Plain email with static subject + body
      logger.info(
        { customerId: customer.id, subject: step.emailSubject },
        'Email step (send not yet implemented)',
      );
      return { sent: true };
    }

    case 'LINKEDIN_LIKE':
    case 'LINKEDIN_CONNECT':
    case 'LINKEDIN_MESSAGE': {
      // LinkedIn actions require a browser automation layer (e.g. Playwright)
      // Stub for now — log intent so the dashboard can show "pending LinkedIn action"
      logger.info(
        { customerId: customer.id, action: step.actionType, target: step.linkedinTarget },
        'LinkedIn action queued (automation layer not yet implemented)',
      );
      return { sent: true };
    }

    default:
      logger.warn({ actionType: step.actionType }, 'Unknown step action type');
      return { sent: false };
  }
}

// ── Process all due steps (called by scheduler every 60s) ─────────────────

export async function processDueSteps(): Promise<{
  processed: number;
  sent: number;
  failed: number;
}> {
  const now = new Date();

  const dueEnrollments = await prisma.sequenceEnrollment.findMany({
    where: { status: 'ACTIVE', nextStepAt: { lte: now } },
    include: {
      currentStep: { include: { aiTemplate: true } },
      sequence: {
        include: {
          channel: true,
          steps: { orderBy: { stepNumber: 'asc' } },
        },
      },
    },
    take: 100,
  });

  let sent = 0;
  let failed = 0;

  for (const enrollment of dueEnrollments) {
    const step = enrollment.currentStep;
    const sequence = enrollment.sequence;

    if (!step) {
      await prisma.sequenceEnrollment.update({
        where: { id: enrollment.id },
        data: { status: 'COMPLETED', completedAt: now, currentStepId: null },
      });
      continue;
    }

    // Cross-channel stopIfReplied: ANY inbound message from this customer since enrollment
    if (step.stopIfReplied) {
      const hasReply = await prisma.message.findFirst({
        where: {
          customerId: enrollment.customerId,
          direction: 'INBOUND',
          createdAt: { gte: enrollment.enrolledAt },
        },
        select: { id: true },
      });

      if (hasReply) {
        await prisma.sequenceEnrollment.update({
          where: { id: enrollment.id },
          data: { status: 'STOPPED', currentStepId: null },
        });
        logger.info(
          { enrollmentId: enrollment.id, customerId: enrollment.customerId },
          'Sequence stopped (customer replied on any channel)',
        );
        continue;
      }
    }

    const customer = await prisma.customer.findUnique({
      where: { id: enrollment.customerId },
    });

    if (!customer) {
      await prisma.sequenceEnrollment.update({
        where: { id: enrollment.id },
        data: { status: 'STOPPED', currentStepId: null },
      });
      continue;
    }

    // Execute the step's action
    const result = await executeStep(enrollment as never, customer, now);

    // Recipient suppression is a terminal stop — consent was withdrawn, so the
    // whole enrollment halts instead of advancing to later steps.
    if (result.suppressed) {
      await prisma.sequenceEnrollment.update({
        where: { id: enrollment.id },
        data: { status: 'STOPPED', currentStepId: null, nextStepAt: null },
      });
      logger.info(
        { enrollmentId: enrollment.id, customerId: enrollment.customerId },
        'Sequence stopped — recipient is suppressed',
      );
      continue;
    }

    if (result.sent) {
      sent++;
    } else {
      failed++;
    }

    // Advance to next step or complete
    const steps = sequence.steps;
    const currentIndex = steps.findIndex((s) => s.id === step.id);
    const nextStep = steps[currentIndex + 1];

    if (nextStep) {
      const nextStepAt = new Date(now.getTime() + nextStep.delayMinutes * 60_000);
      await prisma.sequenceEnrollment.update({
        where: { id: enrollment.id },
        data: { currentStepId: nextStep.id, nextStepAt },
      });
    } else {
      await prisma.sequenceEnrollment.update({
        where: { id: enrollment.id },
        data: {
          status: 'COMPLETED',
          completedAt: now,
          currentStepId: null,
          nextStepAt: null,
        },
      });
    }
  }

  if (dueEnrollments.length > 0) {
    logger.info(
      { processed: dueEnrollments.length, sent, failed },
      'Sequence step batch processed',
    );
  }

  return { processed: dueEnrollments.length, sent, failed };
}

// ── Query ─────────────────────────────────────────────────────────────────

export async function getSequences(tenantId: string) {
  return prisma.sequence.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    include: {
      steps: {
        orderBy: { stepNumber: 'asc' },
        include: { channel: { select: { id: true, name: true, type: true } }, aiTemplate: { select: { id: true, name: true } } },
      },
      _count: { select: { enrollments: { where: { status: 'ACTIVE' } } } },
    },
  });
}

export async function getSequenceById(tenantId: string, sequenceId: string) {
  return prisma.sequence.findFirst({
    where: { id: sequenceId, tenantId },
    include: {
      steps: {
        orderBy: { stepNumber: 'asc' },
        include: { channel: true, aiTemplate: true },
      },
      enrollments: {
        take: 50,
        orderBy: { enrolledAt: 'desc' },
        include: { customer: { select: { id: true, name: true, phone: true } } },
      },
    },
  });
}
