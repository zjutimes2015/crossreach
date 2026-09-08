import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

type Tab = 'overview' | 'billing' | 'connect' | 'crm';

interface StatCards {
  available?: number;
  granted?: number;
  monthlyGrant?: number;
  purchased?: number;
  consumedThisCycle?: number;
  plan?: string;
  cycleEndsAt?: string | null;
  totalCredits?: number;
  totalEvents?: number;
  channels?: number;
  linkedin?: string;
}

export function OverviewPage({ onGo }: { onGo: (t: Tab) => void }) {
  const [data, setData] = useState<StatCards>({});
  const [error, setError] = useState('');
  const [recentTxns, setRecentTxns] = useState<Array<Record<string, unknown>>>([]);
  const [usage, setUsage] = useState<Array<Record<string, unknown>>>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [bal, plan, usageR, txns, accounts, stripe] = await Promise.all([
        api.get<any>('/billing/balance'),
        api.get<any>('/billing/plan'),
        api.get<any>('/billing/usage'),
        api.get<any>('/billing/transactions?limit=6'),
        api.get<any>('/connect/accounts'),
        api.get<any>('/billing/stripe/status'),
      ]);
      setData({
        available: bal?.balance?.available,
        granted: bal?.balance?.granted,
        purchased: bal?.balance?.purchased,
        consumedThisCycle: bal?.balance?.consumedThisCycle,
        monthlyGrant: bal?.balance?.monthlyGrant,
        plan: plan?.plan?.label ?? plan?.plan?.name,
        cycleEndsAt: bal?.balance?.cycleEndsAt,
        totalCredits: usageR?.usage?.totalCredits,
        totalEvents: usageR?.usage?.totalEvents,
        channels: (accounts?.accounts ?? []).length,
        linkedin: stripe?.stripe?.status ?? null,
      });
      setRecentTxns(txns?.transactions ?? []);
      setUsage(usageR?.usage?.byResource ?? []);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const pct = data.monthlyGrant && data.monthlyGrant > 0 ? Math.min(100, Math.round(((data.consumedThisCycle ?? 0) / data.monthlyGrant) * 100)) : 0;

  return (
    <>
      <header className="page-head">
        <div className="kicker">Mission Control · Overview</div>
        <h1>Good to see you, operator.</h1>
        <p>Credit position, channel health and this cycle's usage at a glance.</p>
      </header>

      {error && <div className="alert err">{error}</div>}
      {loading ? (
        <div className="alert info">Loading <span className="spin" /></div>
      ) : (
        <>
          <div className="grid cols-3" style={{ marginBottom: 16 }}>
            <div className="card hero-balance">
              <h3>Available credits <span className="hint">{data.plan ?? 'plan'}</span></h3>
              <div className="amount">{(data.available ?? 0).toLocaleString()}<small>cr</small></div>
              <div className="meter"><div style={{ width: `${pct}%` }} /></div>
              <div className="meter-labels">
                <span>{pct}% of monthly grant consumed</span>
                <span>purchased {data.purchased?.toLocaleString()}</span>
              </div>
            </div>
            <div className="card">
              <h3>This cycle</h3>
              <div className="grid cols-2">
                <div className="stat">
                  <span className="s-label">Consumed</span>
                  <span className="s-value warn">{(data.consumedThisCycle ?? 0).toLocaleString()}</span>
                </div>
                <div className="stat">
                  <span className="s-label">of grant</span>
                  <span className="s-value">{(data.monthlyGrant ?? 0).toLocaleString()}</span>
                </div>
                <div className="stat" style={{ gridColumn: '1 / -1' }}>
                  <span className="s-label">Cycle ends</span>
                  <span className="s-value" style={{ fontSize: 15 }}>
                    {data.cycleEndsAt ? new Date(data.cycleEndsAt).toLocaleDateString() : '—'}
                  </span>
                </div>
              </div>
            </div>
            <div className="card">
              <h3>Activity</h3>
              <div className="stat" style={{ marginBottom: 12 }}>
                <span className="s-label">Credits metered this cycle</span>
                <span className="s-value ok">{(data.totalCredits ?? 0).toLocaleString()}</span>
              </div>
              <div className="stat" style={{ marginBottom: 12 }}>
                <span className="s-label">Usage events</span>
                <span className="s-value">{(data.totalEvents ?? 0).toLocaleString()}</span>
              </div>
              <div className="stat">
                <span className="s-label">Connected channels</span>
                <span className="s-value">{(data.channels ?? 0).toLocaleString()}</span>
              </div>
            </div>
          </div>

          <div className="grid cols-2">
            <div className="card">
              <h3>
                Usage by resource
                <span className="hint">this cycle</span>
              </h3>
              {usage.length === 0 ? (
                <p style={{ color: 'var(--muted)' }}>No metered usage yet — create a webset or dispatch outreach to start consuming.</p>
              ) : (
                usage.map((u) => (
                  <div key={String(u.resource)} className="row spread" style={{ padding: '9px 0', borderBottom: '1px solid var(--border)' }}>
                    <span className="mono" style={{ textTransform: 'capitalize', fontSize: 12 }}>{String(u.resource).toLowerCase().replace(/_/g, ' ')}</span>
                    <span className="mono" style={{ color: 'var(--lime)' }}>{String(u.credits)} cr · {String(u.events)}×</span>
                  </div>
                ))
              )}
            </div>
            <div className="card">
              <h3>
                Recent credit activity
                <button className="btn sm" onClick={() => onGo('billing')}>Open billing →</button>
              </h3>
              {recentTxns.length === 0 ? (
                <p style={{ color: 'var(--muted)' }}>No transactions recorded yet.</p>
              ) : (
                <table>
                  <tbody>
                    {recentTxns.map((t) => (
                      <tr key={String(t.id)}>
                        <td className="mono" style={{ fontSize: 11.5 }}>
                          <span className={`pill ${t.type === 'CONSUME' ? 'amber' : t.type === 'REFUND' ? 'lime' : 'teal'}`}>{String(t.type)}</span>
                        </td>
                        <td>{String(t.description ?? '')}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>
                          {Number(t.amount) > 0 ? '+' : ''}{String(t.amount)}
                        </td>
                        <td className="mono" style={{ color: 'var(--muted)', fontSize: 11 }}>
                          {new Date(String(t.createdAt)).toLocaleDateString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}
