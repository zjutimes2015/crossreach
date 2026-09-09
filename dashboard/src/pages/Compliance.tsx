// ── Compliance (外呼合规证据链) ─────────────────────────────────────────────
// Suppression registry (who opted out / complained / hard-bounced and when)
// + the evidence timeline for any recipient across email / WhatsApp / LinkedIn
// (sends, deliveries, opens, bounces, blocks) with CSV export for audits.

import { useCallback, useEffect, useState } from 'react';
import { complianceApi, type SuppressionEntry, type EvidenceItem } from '../api';

const CHANNELS = ['EMAIL', 'WHATSAPP', 'LINKEDIN'];
const REASONS = ['UNSUBSCRIBED', 'COMPLAINED', 'BOUNCED_HARD', 'MANUAL'];

const human = (s: string) => s.toLowerCase().replace(/_/g, ' ');

function kindClass(kind: string): string {
  const k = kind.toUpperCase();
  if (k.startsWith('SUPPRESSION')) return 'rose';
  if (k === 'SENT' || k.endsWith('_SUCCEEDED') || k === 'DELIVERED') return 'lime';
  if (k === 'OPENED' || k === 'CLICKED') return 'teal';
  if (k.includes('BOUNCE') || k.endsWith('_SKIPPED') || k.includes('FAILED')) return 'amber';
  if (k === 'COMPLAINED' || k === 'UNSUBSCRIBED') return 'rose';
  return 'gray';
}

export function CompliancePage() {
  const [suppressions, setSuppressions] = useState<SuppressionEntry[]>([]);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [suppContact, setSuppContact] = useState('');
  const [items, setItems] = useState<EvidenceItem[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // suppression add form
  const [addChannel, setAddChannel] = useState('EMAIL');
  const [addContact, setAddContact] = useState('');
  const [addReason, setAddReason] = useState('MANUAL');
  const [addNote, setAddNote] = useState('');

  // evidence filter
  const [evChannel, setEvChannel] = useState('');
  const [evContact, setEvContact] = useState('');
  const [evFrom, setEvFrom] = useState(() => {
    const d = new Date(Date.now() - 30 * 86_400_000);
    return d.toISOString().slice(0, 10);
  });
  const [evTo, setEvTo] = useState('');

  const loadSuppressions = useCallback(async () => {
    try {
      const list = await complianceApi.suppressions({
        contact: suppContact.trim() || undefined,
        includeInactive,
      });
      setSuppressions(list);
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Failed to load suppressions' });
    }
  }, [suppContact, includeInactive]);

  const loadEvidence = useCallback(async () => {
    try {
      const res = await complianceApi.evidence({
        channel: evChannel || undefined,
        contact: evContact.trim() || undefined,
        from: evFrom ? `${evFrom}T00:00:00.000Z` : undefined,
        to: evTo ? `${evTo}T23:59:59.999Z` : undefined,
        limit: 200,
      });
      setItems(res.items);
      setTruncated(res.truncated);
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Failed to load evidence' });
    }
  }, [evChannel, evContact, evFrom, evTo]);

  useEffect(() => {
    void loadSuppressions();
  }, [loadSuppressions]);

  useEffect(() => {
    void loadEvidence();
  }, [loadEvidence]);

  const addSuppression = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await complianceApi.addSuppression({
        channel: addChannel,
        contact: addContact.trim(),
        reason: addReason,
        note: addNote.trim() || undefined,
      });
      setAddContact('');
      setAddNote('');
      setMsg({ kind: 'ok', text: `Suppressed ${addChannel.toLowerCase()} contact. It will never be contacted again until removed.` });
      await loadSuppressions();
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Failed to add suppression' });
    } finally {
      setBusy(false);
    }
  };

  const removeSuppression = async (entry: SuppressionEntry) => {
    setBusy(true);
    setMsg(null);
    try {
      await complianceApi.removeSuppression(entry.id);
      setMsg({ kind: 'ok', text: `Un-suppressed ${entry.contact} — the audit row stays in the ledger.` });
      await loadSuppressions();
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Failed to remove suppression' });
    } finally {
      setBusy(false);
    }
  };

  const exportCsv = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await complianceApi.exportEvidence({
        channel: evChannel || undefined,
        contact: evContact.trim() || undefined,
        from: evFrom ? `${evFrom}T00:00:00.000Z` : undefined,
        to: evTo ? `${evTo}T23:59:59.999Z` : undefined,
      });
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Export failed' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="page-head">
        <div className="kicker">Compliance · 外呼合规证据链</div>
        <h1>Every contact decision, provable.</h1>
        <p>
          Opt-outs, complaints and hard bounces land in the tenant suppression registry and hard-block every
          outbound channel. Search a recipient below to replay the full evidence timeline, then export it for audit.
        </p>
      </header>

      {msg && <div className={`alert ${msg.kind}`}>{msg.text}</div>}

      <div className="grid cols-2" style={{ marginBottom: 16, alignItems: 'start' }}>
        {/* ── Suppression registry ── */}
        <div className="card">
          <h3>
            Suppression registry
            <span className="hint">never contact again</span>
          </h3>

          <div className="row" style={{ marginBottom: 14 }}>
            <div className="grow field" style={{ marginBottom: 0 }}>
              <label>Search contact</label>
              <input
                className="input"
                placeholder="someone@co.com · +1 555… · linkedin.com/in/…"
                value={suppContact}
                onChange={(e) => setSuppContact(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && loadSuppressions()}
              />
            </div>
            <div style={{ paddingTop: 17 }}>
              <button className="btn sm" onClick={() => loadSuppressions()}>Search</button>
            </div>
            <label className="check" style={{ paddingTop: 21 }}>
              <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
              <span>show removed</span>
            </label>
          </div>

          {suppressions.length === 0 ? (
            <p style={{ color: 'var(--muted)' }}>No suppressed contacts{includeInactive ? ' (including removed)' : ''}.</p>
          ) : (
            <div className="table-scroll">
              <table>
                <tbody>
                  {suppressions.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <span className={`pill ${s.active ? 'rose' : 'gray'}`}>{s.reason}</span>
                      </td>
                      <td style={{ maxWidth: 180 }}>
                        <div className="mono" style={{ fontSize: 11.5, color: 'var(--text)', wordBreak: 'break-all' }}>{s.contact}</div>
                        <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>
                          {human(s.channel)} · {new Date(s.createdAt).toLocaleString()}
                          {s.removedAt ? ` · removed ${new Date(s.removedAt).toLocaleDateString()}` : ''}
                        </div>
                        {s.note && <div style={{ fontSize: 11, color: 'var(--text-soft)' }}>{s.note}</div>}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {s.active ? (
                          <button className="btn sm" disabled={busy} onClick={() => removeSuppression(s)}>Un-suppress</button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div style={{ marginTop: 16, borderTop: '1px dashed var(--border)', paddingTop: 14 }}>
            <div className="grid" style={{ gridTemplateColumns: '1fr 2fr', gap: 10 }}>
              <div className="field" style={{ marginBottom: 0 }}>
                <label>Channel</label>
                <select className="select" value={addChannel} onChange={(e) => setAddChannel(e.target.value)}>
                  {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label>Contact</label>
                <input className="input" placeholder="email / phone / profile URL" value={addContact}
                  onChange={(e) => setAddContact(e.target.value)} />
              </div>
            </div>
            <div className="grid" style={{ gridTemplateColumns: '1fr', gap: 10, marginTop: 10 }}>
              <div className="field" style={{ marginBottom: 0 }}>
                <label>Reason</label>
                <select className="select" value={addReason} onChange={(e) => setAddReason(e.target.value)}>
                  {REASONS.map((r) => <option key={r} value={r}>{human(r)}</option>)}
                </select>
              </div>
            </div>
            <div className="field" style={{ marginBottom: 0, marginTop: 10 }}>
              <label>Note (evidence context)</label>
              <input className="input" placeholder="e.g. customer asked to stop during a call on 2026-09-09"
                value={addNote} onChange={(e) => setAddNote(e.target.value)} />
            </div>
            <button className="btn primary" style={{ width: '100%', marginTop: 12 }}
              disabled={busy || !addContact.trim()} onClick={addSuppression}>
              Add suppression
            </button>
          </div>
        </div>

        {/* ── How the chain works ── */}
        <div className="card">
          <h3>How the evidence chain works</h3>
          <ol className="steps" style={{ marginTop: 2 }}>
            <li><span>1</span><div>
              <b>Auto-capture.</b> Every unsubscribe click, spam complaint and hard bounce is written to the
              suppression registry with reason + timestamp + provenance token.
            </div></li>
            <li><span>2</span><div>
              <b>Hard gate.</b> Email sends, outreach dispatches (email / WhatsApp / LinkedIn), WhatsApp campaigns
              and sequences all check the registry first and block suppressed recipients — the block is kept as a
              job/recipient record and the credit is refunded.
            </div></li>
            <li><span>3</span><div>
              <b>Timeline.</b> The evidence tab replays a recipient's full history: suppression event, each send
              attempt and outcome, opens/clicks/bounces — and exports it as CSV for an auditor.
            </div></li>
            <li><span>4</span><div>
              <b>Appeal.</b> Un-suppressing (申诉解除) only stops the gate; the original row remains in the ledger.
            </div></li>
          </ol>
        </div>
      </div>

      {/* ── Evidence timeline ── */}
      <div className="card" style={{ marginTop: 4 }}>
        <h3>
          Evidence timeline
          <span className="hint">per recipient / period</span>
        </h3>

        <div className="grid" style={{ gridTemplateColumns: '1fr 1.6fr 1fr 1fr auto auto', gap: 10, marginBottom: 16 }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Channel</label>
            <select className="select" value={evChannel} onChange={(e) => setEvChannel(e.target.value)}>
              <option value="">ALL</option>
              {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Recipient</label>
            <input className="input" placeholder="email / phone / profile URL"
              value={evContact} onChange={(e) => setEvContact(e.target.value)} />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>From</label>
            <input className="input" type="date" value={evFrom} onChange={(e) => setEvFrom(e.target.value)} />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>To</label>
            <input className="input" type="date" value={evTo} onChange={(e) => setEvTo(e.target.value)} />
          </div>
          <div style={{ paddingTop: 16 }}>
            <button className="btn" onClick={() => loadEvidence()}>Refresh</button>
          </div>
          <div style={{ paddingTop: 16 }}>
            <button className="btn primary" disabled={busy} onClick={exportCsv}>Export CSV ↓</button>
          </div>
        </div>

        {items.length === 0 ? (
          <p style={{ color: 'var(--muted)' }}>No evidence rows for this filter — narrow the recipient or widen the dates.</p>
        ) : (
          <>
            {truncated && (
              <div className="alert info" style={{ marginBottom: 10 }}>Results truncated — narrow the date range or recipient.</div>
            )}
            <div className="table-scroll">
              <table>
                <thead>
                  <tr><th>Time</th><th>Event</th><th>Channel</th><th>Contact</th><th>Detail</th></tr>
                </thead>
                <tbody>
                  {items.map((it, i) => (
                    <tr key={`${it.ts}-${i}`}>
                      <td className="mono" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>
                        {new Date(it.ts).toLocaleString()}
                      </td>
                      <td>
                        <span className={`pill ${kindClass(it.kind)}`}>{it.kind}</span>
                        {it.status && it.status !== it.kind ? (
                          <div className="mono" style={{ fontSize: 10, color: 'var(--muted)', marginTop: 3 }}>{human(String(it.status))}</div>
                        ) : null}
                      </td>
                      <td className="mono" style={{ fontSize: 11 }}>{it.channel}</td>
                      <td className="mono" style={{ fontSize: 11, maxWidth: 220, wordBreak: 'break-all' }}>{it.contact}</td>
                      <td style={{ fontSize: 12, maxWidth: 380, wordBreak: 'break-word' }}>{it.detail || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </>
  );
}
