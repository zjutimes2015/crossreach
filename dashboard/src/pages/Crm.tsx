import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { CrmIntegration } from '../api';

const CRM_META: Record<string, { color: string; label: string; hint: string; webhook: string }> = {
  HUBSPOT: {
    color: 'orange',
    label: 'HubSpot',
    hint: 'Deals / contacts → webhook when object changes',
    webhook: '/webhooks/hubspot',
  },
  SALESFORCE: {
    color: 'teal',
    label: 'Salesforce',
    hint: 'Opportunities / leads / cases (change events)',
    webhook: '/webhooks/salesforce',
  },
  NOTION: {
    color: 'amber',
    label: 'Notion',
    hint: 'Database page created / updated → sync',
    webhook: '/webhooks/notion',
  },
};

const SAMPLE_PAYLOADS: Record<string, string> = {
  HUBSPOT: JSON.stringify(
    { objectType: 'deal', objectId: '987654321', properties: { dealname: 'Acme renewal', amount: '24000', dealstage: 'contractsent' } },
    null,
    2,
  ),
  SALESFORCE: JSON.stringify(
    { EventType: 'afterChange', sfobject: 'Opportunity', Id: '0064x00000AbCdE', fields: { Amount: 24000, StageName: 'Negotiation' } },
    null,
    2,
  ),
  NOTION: JSON.stringify({ type: 'page_update', page: { id: '2f3a9c0e-8d7b-4a5e-9c21-deadbeef0001', properties: { 'Company': { title: [{ plain_text: 'Acme' }] } } } }, null, 2),
};

const noteFor = (crm: string): string =>
  crm === 'NOTION'
    ? 'Register the page id (UUID) of the database row you want to mirror into CrossReach.'
    : 'Register the object id that appears in the webhook payload so inbound events resolve to this tenant.';

export function CrmPage() {
  const [integrations, setIntegrations] = useState<CrmIntegration[]>([]);
  const [crm, setCrm] = useState('HUBSPOT');
  const [externalId, setExternalId] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [sample, setSample] = useState(CRM_META.HUBSPOT.label);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ ok: boolean; integrations: CrmIntegration[] }>('/crm/integrations');
      setIntegrations(r.integrations ?? []);
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Failed to load integrations' });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const switchCrm = (ch: string) => {
    setCrm(ch);
    setExternalId('');
    setMsg(null);
  };

  const register = async () => {
    const id = externalId.trim();
    if (!id) {
      setMsg({ kind: 'err', text: 'An external object id is required so webhooks can be routed to this tenant.' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await api.post('/crm/integrations', { crm, externalId: id });
      setMsg({ kind: 'ok', text: `${CRM_META[crm].label} object ${id} is now syncing inbound events.` });
      setExternalId('');
      load();
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Registration failed' });
    } finally {
      setBusy(false);
    }
  };

  const deactivate = async (row: CrmIntegration) => {
    if (!window.confirm(`Stop syncing this ${CRM_META[row.crm]?.label ?? row.crm} object (${row.externalId})?`)) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.del(`/crm/integrations/${row.id}`);
      setMsg({ kind: 'ok', text: 'Integration deactivated. Inbound events for it are now ignored.' });
      load();
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Deactivation failed' });
    } finally {
      setBusy(false);
    }
  };

  const colorFor = (key: string) => CRM_META[key]?.color ?? 'gray';

  return (
    <>
      <header className="page-head">
        <div className="kicker">CRM Sync · inbound webhooks</div>
        <h1>Every deal, contact and lead change — mirrored into CrossReach.</h1>
        <p>Point your CRM's webhook at this workspace, register the object id once, and inbound events land in the tenant event log for CDP processing.</p>
      </header>

      {msg && <div className={`alert ${msg.kind}`}>{msg.text}</div>}

      <div className="card">
        <h3>How routing works</h3>
        <ol className="steps">
          <li><span>1</span> In each CRM, create a webhook subscription that POSTs change events to your deployment, path shown below.</li>
          <li><span>2</span> Register the object id below — CrossReach maps <span className="mono">(crm + objectId) → your tenant</span>.</li>
          <li><span>3</span> Events are verified, persisted to the event log and await downstream processing. No unauthenticated tenant guessing.</li>
        </ol>
        <div className="table-scroll" style={{ marginTop: 10 }}>
          <table>
            <thead>
              <tr><th>CRM</th><th>Inbound endpoint</th><th>Signature / auth</th><th>Typical objects</th></tr>
            </thead>
            <tbody>
              <tr><td><span className="pill orange">HubSpot</span></td><td className="mono">POST {CRM_META.HUBSPOT.webhook}</td><td className="mono">x-hubspot-signature (v3)</td><td>deal · contact · ticket · company</td></tr>
              <tr><td><span className="pill teal">Salesforce</span></td><td className="mono">POST {CRM_META.SALESFORCE.webhook}</td><td className="mono">composite auth key header</td><td>opportunity · lead · case · contact</td></tr>
              <tr><td><span className="pill amber">Notion</span></td><td className="mono">POST {CRM_META.NOTION.webhook}</td><td className="mono">shared verification token</td><td>database page (create / update)</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <div className="card">
          <h3>Register a CRM object</h3>
          <div className="row" style={{ marginBottom: 12 }}>
            {['HUBSPOT', 'SALESFORCE', 'NOTION'].map((ch) => (
              <button key={ch} className={`btn sm ${crm === ch ? 'primary' : ''}`} onClick={() => switchCrm(ch)}>
                {CRM_META[ch].label}
              </button>
            ))}
          </div>
          <div className="field">
            <label>{CRM_META[crm].label} external object id</label>
            <input
              className="input mono"
              spellCheck={false}
              placeholder={crm === 'NOTION' ? 'e.g. 2f3a9c0e-8d7b-…' : 'e.g. 987654321'}
              value={externalId}
              onChange={(e) => setExternalId(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && register()}
            />
          </div>
          <p className="hint" style={{ fontSize: 12, lineHeight: 1.6 }}>{noteFor(crm)}</p>
          <button className="btn primary" disabled={busy || !externalId.trim()} onClick={register}>
            {busy ? <span className="spin" /> : null} Start syncing object →
          </button>
        </div>

        <div className="card">
          <h3>Sample inbound payload</h3>
          <div className="row" style={{ marginBottom: 12 }}>
            {['HubSpot', 'Salesforce', 'Notion'].map((s) => (
              <button key={s} className={`btn sm ${sample === s ? 'primary' : ''}`} onClick={() => setSample(s)}>
                {s}
              </button>
            ))}
          </div>
          <pre className="code">{SAMPLE_PAYLOADS[sample.toUpperCase()]}</pre>
          <p className="hint" style={{ fontSize: 12, marginTop: 8 }}>
            Use this to replay a webhook locally (<span className="mono">curl -X POST …</span>) — events only persist when the object id is registered.
          </p>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3>Active integrations <span className="hint">{integrations.filter((i) => i.active).length}</span></h3>
        {integrations.length === 0 ? (
          <p style={{ color: 'var(--muted)' }}>No CRM objects registered yet. Add one above to begin mirroring webhooks.</p>
        ) : (
          <table>
            <thead>
              <tr><th>CRM</th><th>External object id</th><th>Status</th><th>Registered</th><th></th></tr>
            </thead>
            <tbody>
              {integrations.map((i) => (
                <tr key={i.id}>
                  <td><span className={`pill ${colorFor(i.crm)}`}>{CRM_META[i.crm]?.label ?? i.crm}</span></td>
                  <td className="mono">{i.externalId}</td>
                  <td>
                    <span className={`pill ${i.active ? 'teal' : 'gray'}`}>{i.active ? 'ACTIVE' : 'OFF'}</span>
                  </td>
                  <td className="mono" style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                    {new Date(i.createdAt).toLocaleString()}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {i.active && (
                      <button className="btn sm danger" disabled={busy} onClick={() => deactivate(i)}>Stop sync</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
