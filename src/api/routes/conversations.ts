import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  getConversations,
  getConversationById,
  assignConversation,
  resolveConversation,
} from '../../modules/conversations/service.js';
import { sendMessage, getMessages } from '../../modules/messages/service.js';
import type { MessageContent } from '../../channels/types.js';

export async function conversationRoutes(server: FastifyInstance) {
  // GET /api/conversations?status=OPEN&assigneeId=xxx&limit=50
  server.get('/conversations', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const query = req.query as {
      status?: string;
      assigneeId?: string;
      limit?: string;
      offset?: string;
    };

    const conversations = await getConversations(tenant.id, {
      status: query.status,
      assigneeId: query.assigneeId,
      limit: query.limit ? parseInt(query.limit) : undefined,
      offset: query.offset ? parseInt(query.offset) : undefined,
    });

    return reply.send({ conversations });
  });

  // GET /api/conversations/:id  (includes full message history)
  server.get('/conversations/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = req.tenant!;
    const { id } = req.params as { id: string };

    const conversation = await getConversationById(tenant.id, id);
    if (!conversation) {
      return reply.status(404).send({ error: 'Conversation not found' });
    }

    return reply.send({ conversation });
  });

  // POST /api/conversations/:id/messages  body: { content: MessageContent }
  server.post(
    '/conversations/:id/messages',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const tenant = req.tenant!;
      const { id } = req.params as { id: string };
      const { content } = req.body as { content: MessageContent };

      if (!content?.kind) {
        return reply.status(400).send({ error: 'content.kind is required' });
      }

      const result = await sendMessage({
        tenantId: tenant.id,
        conversationId: id,
        content,
      });

      if (!result.success) {
        return reply.status(500).send({ error: 'Failed to send message' });
      }

      return reply.status(201).send(result);
    },
  );

  // POST /api/conversations/:id/assign  body: { assigneeId: "xxx" }
  server.post(
    '/conversations/:id/assign',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const tenant = req.tenant!;
      const { id } = req.params as { id: string };
      const { assigneeId } = req.body as { assigneeId: string };

      const conversation = await assignConversation(tenant.id, id, assigneeId);
      return reply.send({ conversation });
    },
  );

  // POST /api/conversations/:id/resolve
  server.post(
    '/conversations/:id/resolve',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const tenant = req.tenant!;
      const { id } = req.params as { id: string };

      const conversation = await resolveConversation(tenant.id, id);
      return reply.send({ conversation });
    },
  );

  // GET /api/conversations/:id/messages?limit=100
  server.get(
    '/conversations/:id/messages',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const tenant = req.tenant!;
      const { id } = req.params as { id: string };
      const query = req.query as { limit?: string; offset?: string };

      const messages = await getMessages(tenant.id, id, {
        limit: query.limit ? parseInt(query.limit) : undefined,
        offset: query.offset ? parseInt(query.offset) : undefined,
      });

      return reply.send({ messages });
    },
  );
}
