import { useCallback, useEffect, useState } from 'react';
import { Eye, Lock, LogOut, Mail, MonitorPlay, RefreshCw, SlidersHorizontal } from 'lucide-react';
import type { MatchState } from '@kpl/shared';
import { type EventSummary, fetchEventSummaries } from '../lib/kpl-data.js';
import { supabase } from '../lib/supabase.js';

export function AdminPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authenticated, setAuthenticated] = useState(false);
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const nextEvents = await fetchEventSummaries({ liveOnly: false });
      setEvents(nextEvents);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Error desconocido.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;

    void supabase.auth.getSession().then(({ data }) => {
      if (!mounted) {
        return;
      }

      setAuthenticated(Boolean(data.session));
    });

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setAuthenticated(Boolean(session));
    });

    return () => {
      mounted = false;
      data.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (authenticated) {
      void claimClubAndLoad();
    }
  }, [authenticated]);

  async function claimClubAndLoad() {
    const { error: claimError } = await supabase.rpc('claim_default_club');

    if (claimError) {
      setError(claimError.message);
      return;
    }

    await loadEvents();
  }

  async function signIn() {
    setLoading(true);
    setError(null);

    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });

    if (signInError) {
      setError(signInError.message);
      setLoading(false);
      return;
    }

    setLoading(false);
  }

  async function signOut() {
    await supabase.auth.signOut();
    setAuthenticated(false);
    setEvents([]);
  }

  if (!authenticated) {
    return (
      <main className="home-page">
        <section className="admin-login">
          <div className="brand">
            <img src="/logos/kpl-wordmark.png" alt="" />
            <span>
              <strong>KPL Admin</strong>
              <small>Acceso de control</small>
            </span>
          </div>
          <label>
            <span>Email</span>
            <div className="input-icon">
              <Mail size={16} />
              <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoFocus />
            </div>
          </label>
          <label>
            <span>Password</span>
            <div className="input-icon">
              <Lock size={16} />
              <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" />
            </div>
          </label>
          {error ? <div className="empty-panel">{error}</div> : null}
          <button type="button" className="primary-action" onClick={signIn} disabled={loading}>
            Entrar
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="home-page">
      <header className="home-topbar">
        <div className="brand">
          <img src="/logos/kpl-wordmark.png" alt="" />
          <span>
            <strong>KPL Admin</strong>
            <small>Panel de pistas</small>
          </span>
        </div>

        <button type="button" className="refresh-button" onClick={() => void loadEvents()} disabled={loading}>
          <RefreshCw size={18} />
          Actualizar
        </button>
        <button type="button" className="refresh-button" onClick={() => void signOut()}>
          <LogOut size={18} />
          Salir
        </button>
      </header>

      <section className="match-picker" aria-labelledby="admin-title">
        <div className="section-heading">
          <h1 id="admin-title">Todas las pistas</h1>
          <span>{events.length} pistas</span>
        </div>

        {error ? <div className="empty-panel">{error}</div> : null}
        {loading ? <div className="loading-panel">Cargando pistas</div> : null}

        {!loading && events.length > 0 ? (
          <div className="match-list">
            {events.map((event) => (
              <article className="match-row" key={event.id}>
                <div className="match-info">
                  <span className={`match-status ${event.status}`}>{statusLabel(event.status)}</span>
                  <h2>{event.courtName}</h2>
                  <p>{event.title}</p>
                  <small>
                    Ruta {event.id} - Version {event.version}
                  </small>
                </div>

                <div className="match-actions">
                  <a className="match-action primary" href={`/control/${event.id}`}>
                    <SlidersHorizontal size={18} />
                    Mandos
                  </a>
                  <a className="match-action" href={`/overlay/${event.id}/scoreboard`}>
                    <MonitorPlay size={18} />
                    OBS
                  </a>
                  <a className="match-action" href={`/live/${event.id}`}>
                    <Eye size={18} />
                    Publico
                  </a>
                </div>
              </article>
            ))}
          </div>
        ) : null}
      </section>
    </main>
  );
}

function statusLabel(status: MatchState['status']): string {
  return {
    pre_match: 'Pre',
    live: 'Live',
    finished: 'Final',
  }[status];
}
