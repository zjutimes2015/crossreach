import type { ChannelAdapter } from '../types.js';
import type { WhatsAppChannelConfig } from '../types.js';
import { parseWebhook } from './transform.js';
import { sendWhatsAppMessage } from './api.js';

/**
 * WhatsApp Business Cloud API adapter.
 * Implements the unified ChannelAdapter interface.
 */
export const whatsappAdapter: ChannelAdapter = {
  type: 'WHATSAPP',

  parseWebhook(payload: unknown) {
    return parseWebhook(payload);
  },

  async send(message, channelConfig) {
    const config = channelConfig as unknown as WhatsAppChannelConfig;
    return sendWhatsAppMessage(config, message);
  },
};
