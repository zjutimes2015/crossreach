// CRM inbound parsers — normalize HubSpot / Salesforce / Notion payloads into
// a single CrmEvent shape without touching the network or database.
import { describe, expect, it } from 'vitest';
import {
  parseHubSpot,
  parseSalesforce,
  parseNotion,
} from '../src/modules/crm/webhooks.js';

describe('parseHubSpot', () => {
  it('parses a deal update when dealstage is present', () => {
    const r = parseHubSpot({
      objectType: 'deal',
      objectId: '987654321',
      properties: { dealname: 'Acme renewal', amount: '24000', dealstage: 'contractsent' },
    });
    expect(r.event?.kind).toBe('deal.updated');
    expect(r.event?.externalId).toBe('987654321');
    expect((r.event?.object.properties as Record<string, unknown>).dealname).toBe('Acme renewal');
  });

  it('parses a bare deal event without objectType via stage properties', () => {
    const r = parseHubSpot({ objectId: '123', properties: { dealstage: 'appointment' } });
    expect(r.event?.kind).toBe('deal.updated');
  });

  it('parses a contact from the email property when objectType is omitted', () => {
    const r = parseHubSpot({ objectId: '456', properties: { email: 'x@y.com' } });
    expect(r.event?.kind).toBe('contact.created');
  });

  it('rejects payloads with no object id', () => {
    const r = parseHubSpot({ properties: { email: 'x@y.com' } });
    expect(r.event).toBeNull();
    expect(r.error).toContain('objectId');
  });
});

describe('parseSalesforce', () => {
  it('parses a flat Composite-REST event using capital Id', () => {
    const r = parseSalesforce({
      EventType: 'afterChange',
      sfobject: 'Opportunity',
      Id: '0064x00000AbCdE',
      fields: { Amount: 24000, StageName: 'Negotiation' },
    });
    expect(r.event?.kind).toBe('deal.updated');
    expect(r.event?.crm).toBe('SALESFORCE');
    expect(r.event?.externalId).toBe('0064x00000AbCdE');
  });

  it('parses a Change Data Capture envelope (CometD) and strips ChangeEvent suffix', () => {
    const r = parseSalesforce({
      event: { replayId: 42, type: 'changeNotification' },
      payload: {
        ChangeEventHeader: { entityName: 'OpportunityChangeEvent', changeType: 'UPDATE' },
        Id: '0064x00000AbCdE',
        Amount: 30000,
      },
    });
    expect(r.event?.kind).toBe('deal.updated');
    expect(r.event?.externalId).toBe('0064x00000AbCdE');
  });

  it('maps CREATE change type to .created', () => {
    const r = parseSalesforce({
      payload: {
        ChangeEventHeader: { entityName: 'LeadChangeEvent', changeType: 'CREATE' },
        Id: '00Qlead0001',
      },
    });
    expect(r.event?.kind).toBe('lead.created');
  });

  it('rejects unknown object types', () => {
    const r = parseSalesforce({ EventType: 'afterChange', sfobject: 'CustomThing', Id: 'x' });
    expect(r.event).toBeNull();
    expect(r.error).toContain('unrecognized');
  });
});

describe('parseNotion', () => {
  it('parses a page_update event', () => {
    const r = parseNotion({
      type: 'page_update',
      page: { id: '2f3a9c0e-8d7b-4a5e-9c21-deadbeef0001' },
    });
    expect(r.event?.kind).toBe('deal.updated');
    expect(r.event?.crm).toBe('NOTION');
    expect(r.event?.externalId).toBe('2f3a9c0e-8d7b-4a5e-9c21-deadbeef0001');
  });

  it('parses page_create as created', () => {
    const r = parseNotion({ type: 'page_create', page: { id: 'page-1' } });
    expect(r.event?.kind).toBe('deal.created');
  });

  it('skips unrelated event types without erroring', () => {
    const r = parseNotion({ type: 'comment_created', page: { id: 'page-1' } });
    expect(r.event).toBeNull();
    expect(r.error).toBeUndefined();
  });
});
