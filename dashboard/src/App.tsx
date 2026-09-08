// ── CrossReach Mission Control ───────────────────────────────────────────────
// Login gate (tenant API key) + sidebar shell + tabbed pages.

import { useCallback, useEffect, useState } from 'react';
import { api, getApiKey, setApiKey, clearApiKey, ApiError } from './api';
import { OverviewPage } from './pages/Overview';
import { BillingPage } from './pages/Billing';
import { ConnectPage } from './pages/Connect';
import { CrmPage } from './pages/Crm';

type Tab = 'overview' | 'billing' | 'connect' | 'crm';

const TABS: Array<{ id: Tab; label: string; ico: string }> = [
  { id: 'overview', label: 'Overview', ico: '▦' },
  { id: 'billing', label: 'Billing', ico: '$' },
  { id: 'connect', label: 'Connect', ico: '⇄' },
  { id: 'crm', label: 'CRM Sync', ico: '↯' },
];

export default function App() {
  const [authed, setAuthed] = useState(() => getApiKey().length > 0);
  const [tab, setTab] = useState<Tab>('overview');
  const [keyInput, setKeyInput] = useState('');
  const [gateErr, setGateErr] = useState('');
  const [checking, setChecking] = useState(false);

  const handleLogin = async () => {
    setChecking(true);
    setGateErr('');
    setApiKey(keyInput.trim());
    try {
      await api.get('/billing/plan'); // validates the key
      setAuthed(true);
    } catch (err) {
      clearApiKey();
      setGateErr(err instanceof ApiError ? err.message : 'Unable to reach the CrossReach API');
    } finally {
      setChecking(false);
    }
  };

  const logout = () => {
    clearApiKey();
    setAuthed(false);
    setKeyInput('');
  };

  if (!authed) {
    return (
      <div className="gate">
        <div className="gate-card">
          <div className="brand"><span className="brand-mark">⬢</span> CrossReach</div>
          <h2>Mission control</h2>
          <p className="sub">Enter your tenant API key to manage discovery, connect accounts, credits and CRM sync.</p>
          {gateErr && <div className="alert err">{gateErr}</div>}
          <div className="field">
            <label>API key</label>
            <input
              className="input"
              type="password"
              placeholder="x-api-key"
              value={keyInput}
              autoFocus
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
            />
          </div>
          <button className="btn primary" style={{ width: '100%' }} disabled={checking || !keyInput.trim()} onClick={handleLogin}>
            {checking ? <span className="spin" /> : null} Enter console
          </button>
          <div className="demo">
            Demo key: <code>demo-api-key-001</code>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">⬢</span> CrossReach</div>
        <nav className="nav">
          {TABS.map((t) => (
            <button key={t.id} className={`nav-item ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
              <span className="ico">{t.ico}</span> {t.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="api-chip">KEY · {getApiKey().slice(0, 14)}…</div>
          <button className="logout-btn" onClick={logout}>Sign out</button>
        </div>
      </aside>
      <main className="main">
        {tab === 'overview' && <OverviewPage onGo={setTab} />}
        {tab === 'billing' && <BillingPage />}
        {tab === 'connect' && <ConnectPage />}
        {tab === 'crm' && <CrmPage />}
      </main>
    </div>
  );
}
