import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

interface PlanOption { id: string; label: string; monthlyPriceCents: number; monthlyCredits: number; emailInboxes: number; socialChannels: number; }

export function BillingPage() {
  const [balance, setBalance] = useState<Record<string, unknown> | null>(null);
  const [txns, setTxns] = useState<Array<Record<string, unknown>>>([]);
  const [stripe, setStripe] = useState<Record<string, unknown> | null>(null);
  const [plans, setPlans] = useState<PlanOption[]>([]);
  const [planInfo, setPlanInfo] = useState<Record<string, unknown> | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const [topUpAmount, setTopUpAmount] = useState(1000);
  const [planChoice, setPlanChoice] = useState('GROWTH');

  const baseUrl = `${window.location.origin}${window.location.pathname}`;

  const load = useCallback(async () => {
    try {
      const [bal, tx, st, plan] = await Promise.all([
        api.get<any>('/billing/balance'),
        api.get<any>('/billing/transactions?limit=12'),
        api.get<any>('/billing/stripe/status'),
        api.get<any>('/billing/plan'),
      ]);
      setBalance(bal?.balance ?? null);
      setTxns(tx?.transactions ?? []);
      setStripe(st?.stripe ?? null);
      setPlans((st?.plans ?? []) as PlanOption[]);
      setPlanInfo(plan?.plan ?? null);
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Failed to load billing' });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleTopUp = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.post<any>('/billing/top-up', {
        amount: Math.max(1, Math.round(topUpAmount)),
        description: `Dashboard manual top-up`,
      });
      setMsg({ kind: 'ok', text: `Topped up ${r.charged?.toLocaleString?.() ?? topUpAmount} credits. New balance: ${r.balanceAfter?.toLocaleString() ?? ''}` });
      load();
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Top-up failed' });
    } finally {
      setBusy(false);
    }
  };

  const openStripeTopUp = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.post<any>('/billing/stripe/checkout', {
        creditAmount: Math.max(100, Math.round(topUpAmount)),
        successUrl: `${baseUrl}?paid=1`,
        cancelUrl: `${baseUrl}?paid=0`,
      });
      if (r.url) window.open(r.url, '_blank');
      else setMsg({ kind: 'err', text: 'No checkout URL returned' });
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Checkout failed' });
    } finally {
      setBusy(false);
    }
  };

  const subscribeToPlan = async (planId: string) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.post<any>('/billing/stripe/checkout', {
        planId,
        successUrl: `${baseUrl}?plan=1`,
        cancelUrl: `${baseUrl}?plan=0`,
      });
      if (r.url) window.open(r.url, '_blank');
      else setMsg({ kind: 'err', text: 'No checkout URL returned' });
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Checkout failed' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="page-head">
        <div className="kicker">Billing · Credits & plan</div>
        <h1>Usage-based pricing, fully visible.</h1>
        <p>Every discovery and outreach action maps to a credit. Grant resets monthly; purchases never expire.</p>
      </header>

      {msg && <div className={`alert ${msg.kind}`}>{msg.text}</div>}

      <div className="grid cols-3" style={{ marginBottom: 16 }}>
        <div className="card hero-balance">
          <h3>Available credits</h3>
          <div className="amount">{((balance as any)?.available ?? 0).toLocaleString()}<small>cr</small></div>
          <div className="meter-labels" style={{ marginTop: 6 }}>
            <span>grant {(balance as any)?.monthlyGrant ?? 0}</span>
            <span>purchased {(balance as any)?.purchased ?? 0}</span>
          </div>
        </div>
        <div className="card">
          <h3>Plan <span className="hint">{((planInfo as any)?.label ?? '').toUpperCase()}</span></h3>
          <div className="stat" style={{ marginBottom: 10 }}>
            <span className="s-label">Monthly credits</span>
            <span className="s-value">{(planInfo as any)?.monthlyCredits?.toLocaleString?.() ?? '—'}</span>
          </div>
          <div className="row" style={{ gap: 18 }}>
            <div className="stat">
              <span className="s-label">List sizes</span>
              <span className="s-value" style={{ fontSize: 15 }}>{((planInfo as any)?.allowedListSizes ?? []).join(' / ') || '—'}</span>
            </div>
            <div className="stat">
              <span className="s-label">Effective /lead</span>
              <span className="s-value" style={{ fontSize: 15 }}>{(planInfo as any)?.effectiveCostPerLead ?? '—'}</span>
            </div>
          </div>
        </div>
        <div className="card">
          <h3>Subscription <span className="hint">Stripe</span></h3>
          <div className="row" style={{ gap: 18 }}>
            <div className="stat">
              <span className="s-label">Status</span>
              <span className="s-value" style={{ fontSize: 16, color: (stripe as any)?.status === 'cancelled' ? 'var(--rose)' : 'var(--teal)' }}>
                {(stripe as any)?.status ?? 'not subscribed'}
              </span>
            </div>
            <div className="stat">
              <span className="s-label">Last plan</span>
              <span className="s-value" style={{ fontSize: 16 }}>{(stripe as any)?.lastPlanId ?? '—'}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3>Buy credits <span className="hint">$5 / 10,000</span></h3>
          <div className="row" style={{ marginBottom: 12 }}>
            <div className="grow field" style={{ marginBottom: 0 }}>
              <label>Credit amount</label>
              <input className="input" type="number" min={100} step={100} value={topUpAmount} onChange={(e) => setTopUpAmount(Number(e.target.value))} />
            </div>
            <div style={{ paddingTop: 16 }}>
              <button className="btn primary" disabled={busy || !topUpAmount} onClick={openStripeTopUp}>
                Checkout via Stripe →
              </button>
            </div>
          </div>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6 }}>
            Credits are delivered instantly after payment via webhook reconciliation. Purchased credits never expire and are spent only after your monthly grant is exhausted.
          </p>
          <div style={{ marginTop: 14, borderTop: '1px dashed var(--border)', paddingTop: 14 }}>
            <div className="row spread">
              <span className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>Testing? Instant demo top-up (no charge):</span>
              <button className="btn sm" disabled={busy} onClick={handleTopUp}>Manual top-up +{topUpAmount.toLocaleString()}</button>
            </div>
          </div>
        </div>

        <div className="card">
          <h3>Change plan <span className="hint">billed monthly</span></h3>
          <div className="field">
            <label>Plan</label>
            <select className="select" value={planChoice} onChange={(e) => setPlanChoice(e.target.value)}>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} — ${(p.monthlyPriceCents / 100).toFixed(0)}/mo · {p.monthlyCredits.toLocaleString()} cr
                </option>
              ))}
            </select>
          </div>
          <button className="btn" disabled={busy || plans.length === 0} onClick={() => subscribeToPlan(planChoice)}>
            Subscribe to {plans.find((p) => p.id === planChoice)?.label ?? planChoice} →
          </button>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6, marginTop: 12 }}>
            Subscription checkout also activates instant credit top-up capability and unlocks higher list sizes + channel quotas.
          </p>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3>Credit ledger <span className="hint">latest {txns.length}</span></h3>
        {txns.length === 0 ? (
          <p style={{ color: 'var(--muted)' }}>No transactions recorded.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Type</th><th>Description</th><th>Amount</th><th>Balance after</th><th>Date</th></tr>
            </thead>
            <tbody>
              {txns.map((t) => {
                const a = Number(t.amount);
                return (
                  <tr key={String(t.id)}>
                    <td><span className={`pill ${t.type === 'CONSUME' ? 'amber' : t.type === 'REFUND' ? 'lime' : t.type === 'TOP_UP' ? 'teal' : 'gray'}`}>{String(t.type)}</span></td>
                    <td style={{ maxWidth: 320 }}>{String(t.description ?? '')}</td>
                    <td className="mono" style={{ color: a < 0 ? 'var(--amber)' : 'var(--teal)' }}>{a > 0 ? '+' : ''}{a.toLocaleString()}</td>
                    <td className="mono">{Number(t.balanceAfter).toLocaleString()}</td>
                    <td className="mono" style={{ color: 'var(--muted)', fontSize: 11.5 }}>{new Date(String(t.createdAt)).toLocaleString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
