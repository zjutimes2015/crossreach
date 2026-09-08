import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

interface Account {
  id: string;
  channel: string;
  name: string;
  status: string;
  lastUsedAt: string | null;
  createdAt: string;
}

const CHANNEL_TEMPLATES: Record<string, string> = {
  EMAIL: JSON.stringify(
    { smtpHost: 'smtp.gmail.com', smtpPort: 587, smtpSecure: false, smtpUser: 'you@gmail.com', smtpPass: 'app-password', fromAddress: 'you@gmail.com' },
    null,
    2,
  ),
  LINKEDIN: JSON.stringify({ sessionCookie: 'AQED...', profileUrl: 'https://linkedin.com/in/you' }, null, 2),
  WHATSAPP: JSON.stringify({ phoneNumberId: '112233445566778899', accessToken: 'EAA...', verifyToken: '' }, null, 2),
};

export function ConnectPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [quota, setQuota] = useState<{ plan?: string; rows?: Array<{ channel: string; label: string; used: number; limit: number }> }>({});
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [testId, setTestId] = useState('');

  const [channel, setChannel] = useState('EMAIL');
  const [name, setName] = useState('');
  const [configText, setConfigText] = useState(CHANNEL_TEMPLATES.EMAIL);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ accounts: Account[]; quota: { plan: string; rows: Array<{ channel: string; label: string; used: number; limit: number }> } }>('/connect/accounts');
      setAccounts(r?.accounts ?? []);
      setQuota(r?.quota ?? {});
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Failed to load accounts' });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const switchChannel = (ch: string) => {
    setChannel(ch);
    setConfigText(CHANNEL_TEMPLATES[ch] ?? '{}');
  };

  const createAccount = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const config = JSON.parse(configText) as Record<string, unknown>;
      await api.post('/connect/accounts', { channel, name: name || `${channel} account`, config });
      setMsg({ kind: 'ok', text: `${channel} account connected.` });
      setConfigText(CHANNEL_TEMPLATES[channel] ?? '{}');
      setName('');
      load();
    } catch (err) {
      const e = err as { message?: string };
      setMsg({ kind: 'err', text: e.message ?? 'Failed to connect account' });
    } finally {
      setBusy(false);
    }
  };

  const testAccount = async (id: string) => {
    setTestId(id);
    setMsg(null);
    try {
      const r = await api.post<any>(`/connect/accounts/${id}/test`);
      const test = r?.test ?? r;
      const ok = test?.ok ?? test?.connected ?? test?.success;
      setMsg(
        ok
          ? { kind: 'ok', text: `Connection verified · ${test?.detail ?? ''}` }
          : { kind: 'err', text: `Verification failed · ${test?.error ?? test?.detail ?? 'unknown'}` },
      );
      load();
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Test failed' });
    } finally {
      setTestId('');
    }
  };

  const removeAccount = async (id: string, accountName: string) => {
    if (!window.confirm(`Disconnect "${accountName}"? Channel quota slot will be freed.`)) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.del(`/connect/accounts/${id}`);
      setMsg({ kind: 'ok', text: 'Account disconnected.' });
      load();
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Delete failed' });
    } finally {
      setBusy(false);
    }
  };

  const statusPill = (s: string) =>
    s === 'ACTIVE' ? 'teal' : s === 'RECONNECT_REQUIRED' ? 'amber' : 'gray';

  return (
    <>
      <header className="page-head">
        <div className="kicker">Connect · sending accounts</div>
        <h1>One login per channel. Linked once, dispatched forever.</h1>
        <p>Email inboxes, LinkedIn sessions and WhatsApp Business numbers — validated live, secrets masked on every read.</p>
      </header>

      {msg && <div className={`alert ${msg.kind}`}>{msg.text}</div>}

      <div className="grid cols-2">
        <div className="card">
          <h3>Connect a channel</h3>
          <div className="row" style={{ marginBottom: 12 }}>
            {['EMAIL', 'LINKEDIN', 'WHATSAPP'].map((ch) => (
              <button key={ch} className={`btn sm ${channel === ch ? 'primary' : ''}`} onClick={() => switchChannel(ch)}>
                {ch.charAt(0) + ch.slice(1).toLowerCase()}
              </button>
            ))}
          </div>
          <div className="field">
            <label>Account name</label>
            <input className="input" placeholder="e.g. Sales Gmail" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label>Config (JSON)</label>
            <textarea className="input" spellCheck={false} value={configText} onChange={(e) => setConfigText(e.target.value)} />
          </div>
          <button className="btn primary" disabled={busy} onClick={createAccount}>
            Link account →
          </button>
          <p style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6, marginTop: 12 }}>
            Credentials are encrypted at rest and masked when read back. The connection is verified with a live test (SMTP / Graph API / cookie).
          </p>
        </div>

        <div className="card">
          <h3>Quota <span className="hint">{String(quota?.plan ?? '')}</span></h3>
          {(quota?.rows ?? []).map((c) => (
            <div key={c.channel} className="row spread" style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontSize: 13, color: 'var(--text-soft)' }}>{c.label}</span>
              <span className="mono" style={{ color: Number(c.used ?? 0) >= Number(c.limit ?? 0) ? 'var(--amber)' : 'var(--lime)' }}>
                {String(c.used ?? 0)} / {c.limit === 99 ? '∞' : String(c.limit ?? 0)}
              </span>
            </div>
          ))}
          {(quota?.rows ?? []).length === 0 && (
            <p style={{ color: 'var(--muted)', fontSize: 13 }}>Channel quotas appear here once an account is linked. Limits follow your plan.</p>
          )}
          <div className="alert info" style={{ marginTop: 14 }}>
            Each channel allows one account per plan tier. Deleting an account frees its slot immediately.
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3>Connected accounts <span className="hint">{accounts.length}</span></h3>
        {accounts.length === 0 ? (
          <p style={{ color: 'var(--muted)' }}>No sending accounts connected yet. Link your first channel on the left.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Channel</th><th>Name</th><th>Status</th><th>Last used</th><th></th><th></th></tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td><span className="mono pill gray">{a.channel.charAt(0) + a.channel.slice(1).toLowerCase()}</span></td>
                  <td style={{ fontWeight: 600, color: 'var(--text)' }}>{a.name}</td>
                  <td><span className={`pill ${statusPill(a.status)}`}>{a.status.replace(/_/g, ' ')}</span></td>
                  <td className="mono" style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                    {a.lastUsedAt ? new Date(a.lastUsedAt).toLocaleString() : 'never'}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn sm" disabled={testId === a.id} onClick={() => testAccount(a.id)}>
                      {testId === a.id ? <span className="spin" /> : 'Test'}
                    </button>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn sm danger" onClick={() => removeAccount(a.id, a.name)}>Disconnect</button>
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
