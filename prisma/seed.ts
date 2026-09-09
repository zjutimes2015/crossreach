import { prisma } from '../src/db/prisma.js';
import { logger } from '../src/utils/logger.js';
import { hashPassword } from '../src/modules/auth/passwords.js';

/**
 * Seed a demo tenant + WhatsApp channel + admin user so the API is testable
 * immediately after `docker compose up && npm run db:push && npm run db:seed`.
 */
async function main() {
  // 1. Demo tenant
  const tenant = await prisma.tenant.upsert({
    where: { apiKey: 'demo-api-key-001' },
    update: {},
    create: {
      name: 'Demo Export Co.',
      plan: 'GROWTH',
      status: 'TRIAL',
      apiKey: 'demo-api-key-001',
    },
  });

  logger.info({ tenantId: tenant.id }, 'Seeded tenant');

  // 2. WhatsApp channel (config pulled from env or placeholder values)
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || 'demo-phone-number-id';
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN || 'demo-access-token';
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || 'demo-verify-token';

  await prisma.channel.upsert({
    where: { tenantId_type: { tenantId: tenant.id, type: 'WHATSAPP' } },
    update: {},
    create: {
      tenantId: tenant.id,
      type: 'WHATSAPP',
      name: 'WhatsApp Business',
      config: {
        phoneNumberId,
        accessToken,
        verifyToken,
        apiVersion: 'v18.0',
      },
    },
  });

  logger.info('Seeded WhatsApp channel');

  // 3. Admin user (bcrypt-hashed password so email+password login works)
  const adminPassword = process.env.DEMO_ADMIN_PASSWORD || 'changeme';
  await prisma.user.upsert({
    where: { email: 'admin@demo.com' },
    update: {},
    create: {
      tenantId: tenant.id,
      email: 'admin@demo.com',
      name: 'Demo Admin',
      role: 'ADMIN',
      authProvider: 'PASSWORD',
      password: await hashPassword(adminPassword),
    },
  });

  logger.info('Seeded admin user');
  logger.info('──────────────────────────────────');
  logger.info('Demo API Key:  demo-api-key-001');
  logger.info('Admin email:   admin@demo.com');
  logger.info(`Admin password: ${adminPassword}`);
  logger.info('──────────────────────────────────');
}

main()
  .catch((err) => {
    logger.error({ err }, 'Seed failed');
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
