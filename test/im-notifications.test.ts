// Internal IM notifications — payload builders + DingTalk signature.
import { describe, expect, it } from 'vitest';
import {
  buildWecomPayload,
  buildFeishuPayload,
  buildDingtalkPayload,
  dingtalkSign,
} from '../src/modules/notifications/im.js';

describe('WeCom payload', () => {
  it('builds a plain text message', () => {
    expect(buildWecomPayload({ text: 'hello' })).toEqual({
      msgtype: 'text',
      text: { content: 'hello' },
    });
  });

  it('prepends the title to text', () => {
    expect(buildWecomPayload({ title: 'Alert', text: 'boom' })).toEqual({
      msgtype: 'text',
      text: { content: 'Alert\nboom' },
    });
  });

  it('builds a markdown message with a bold title', () => {
    const p = buildWecomPayload({ title: 'Ops', text: 'x', markdown: '**down**' });
    expect(p.msgtype).toBe('markdown');
    expect((p.markdown as { content: string }).content).toBe('**Ops**\n**down**');
  });
});

describe('Feishu payload', () => {
  it('builds a plain text message', () => {
    expect(buildFeishuPayload({ text: 'hi' })).toEqual({
      msg_type: 'text',
      content: { text: 'hi' },
    });
  });

  it('builds an interactive markdown card with header', () => {
    const p = buildFeishuPayload({ title: 'T', text: 'x', markdown: '**strong**' });
    expect(p.msg_type).toBe('interactive');
    expect((p.card as { header?: { title?: { content?: string } } }).header?.title?.content).toBe('T');
    expect((p.card as { elements: Array<{ tag: string; content: string }> }).elements[0]).toEqual({
      tag: 'markdown',
      content: '**strong**',
    });
  });
});

describe('DingTalk payload', () => {
  it('builds a plain text message', () => {
    expect(buildDingtalkPayload({ text: 'hi' })).toEqual({
      msgtype: 'text',
      text: { content: 'hi' },
    });
  });

  it('builds a markdown message with heading', () => {
    const p = buildDingtalkPayload({ title: 'Ops', text: 'x', markdown: 'body' });
    expect(p.msgtype).toBe('markdown');
    expect((p.markdown as { title: string; text: string }).text).toBe('### Ops\nbody');
  });
});

describe('DingTalk signature', () => {
  it('produces the documented HmacSHA256 base64 signature', () => {
    // Reference: secret='SECabc', ts=1700000000000 -> base64(hmac_sha256("1700000000000\nSECabc", ''))
    const crypto = require('node:crypto') as typeof import('node:crypto');
    const expected = crypto
      .createHmac('sha256', '1700000000000\nSECabc')
      .update('')
      .digest('base64');
    expect(dingtalkSign('SECabc', 1700000000000)).toBe(encodeURIComponent(expected));
  });

  it('differs across timestamps (replay protection)', () => {
    const a = dingtalkSign('secret', 1000);
    const b = dingtalkSign('secret', 2000);
    expect(a).not.toBe(b);
  });
});