import { describe, expect, it } from 'vitest';
import { formatOutbound } from '../src/channels/whatsapp/transform.js';
import {
  isNotConnected,
  isUnreachable,
  LINKEDIN_ERR_NO_DM,
  LINKEDIN_ERR_NO_CONNECT,
} from '../src/channels/linkedin/api.js';

describe('WhatsApp outbound payload mapping (formatOutbound)', () => {
  it('maps a plain text message', () => {
    expect(formatOutbound({ kind: 'text', text: 'Hello there' })).toEqual({
      type: 'text',
      text: { body: 'Hello there' },
    });
  });

  it('maps a template with language + components verbatim', () => {
    const components = [{ type: 'body', parameters: [{ type: 'text', text: 'Acme' }] }];
    expect(
      formatOutbound({
        kind: 'template',
        templateName: 'hello_there',
        language: 'en_US',
        components,
      }),
    ).toEqual({
      type: 'template',
      template: {
        name: 'hello_there',
        language: { code: 'en_US' },
        components,
      },
    });
  });

  it('maps an interactive button message', () => {
    const out = formatOutbound({
      kind: 'interactive',
      body: 'Pick one',
      buttons: [
        { id: 'yes', title: 'Yes' },
        { id: 'no', title: 'No' },
      ],
    });
    expect(out.type).toBe('interactive');
    expect((out.interactive as { action: { buttons: unknown[] } }).action.buttons).toHaveLength(2);
  });

  it('refuses to send button_reply (inbound-only content)', () => {
    expect(() =>
      formatOutbound({ kind: 'button_reply', buttonId: 'x', buttonText: 'X' }),
    ).toThrow(/cannot be sent outbound/);
  });
});

describe('LinkedIn outcome predicates (chain decisions)', () => {
  it('detects "reachable but not connected" so the caller falls back to an invitation', () => {
    expect(isNotConnected({ resolvedAction: 'message', status: 'skipped', error: LINKEDIN_ERR_NO_DM })).toBe(true);
    expect(isNotConnected({ resolvedAction: 'message', status: 'skipped', error: LINKEDIN_ERR_NO_CONNECT })).toBe(false);
    expect(isNotConnected({ resolvedAction: 'message', status: 'accepted' })).toBe(false);
    expect(isNotConnected({ resolvedAction: 'message', status: 'failed', error: 'boom' })).toBe(false);
  });

  it('detects "no connect entry point" (private / restricted profile)', () => {
    expect(isUnreachable({ resolvedAction: 'invitation', status: 'skipped', error: LINKEDIN_ERR_NO_CONNECT })).toBe(true);
    expect(isUnreachable({ resolvedAction: 'invitation', status: 'skipped', error: LINKEDIN_ERR_NO_DM })).toBe(false);
  });

  it('contract: playwright codes match the exported constants', () => {
    expect(LINKEDIN_ERR_NO_DM).toBe('no_dm_button');
    expect(LINKEDIN_ERR_NO_CONNECT).toBe('no_connect_button');
  });
});
