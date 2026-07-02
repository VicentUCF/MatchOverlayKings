import { useCallback, useEffect, useState } from 'react';
import { Eye, Lock, MonitorPlay, RefreshCw, SlidersHorizontal } from 'lucide-react';
import type { MatchState } from '@kpl/shared';

interface EventSummary {
  id: string;
  title: string;
  courtName: string;
  homeTeamId: string;
  awayTeamId: string;
  status: MatchState['status'];
  version: number;
  updatedAt: string;
}

export function AdminPage() {
  const [pin, setPin] = useState(() => localStorage.getItem('kpl-control-pin') ?? '');
  const [unlocked, setUnlocked] = useState(() => localStorage.getItem('kpl-control-pin') !== null);
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(
        '/api/admin/events',
        pin ? { headers: { 'x-control-pin': pin } } : undefined,
      );

      if (!response.ok) {
        throw new Error('No se pudieron cargar las pistas.');
      }

      const payload = (await response.json()) as { events: EventSummary[] };
      setEvents(payload.events);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Error desconocido.');
    } finally {
      setLoading(false);
    }
  }, [pin]);

  useEffect(() => {
    if (unlocked) {
      void loadEvents();
    }
  }, [loadEvents, unlocked]);

  function unlockAdmin() {
    localStorage.setItem('kpl-control-pin', pin);
    setUnlocked(true);
  }

  if (!unlocked) {
    return (
      <main className="home-page">
        <section className="admin-login">
          <div className="brand">
            <img src="/logos/kpl.png" alt="" />
            <span>
              <strong>KPL Admin</strong>
              <small>Acceso de control</small>
            </span>
          </div>
          <label>
            <span>PIN</span>
            <div className="input-icon">
              <Lock size={16} />
              <input value={pin} onChange={(event) => setPin(event.target.value)} type="password" autoFocus />
            </div>
          </label>
          <button type="button" className="primary-action" onClick={unlockAdmin}>
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
          <img src="/logos/kpl.png" alt="" />
          <span>
            <strong>KPL Admin</strong>
            <small>Panel de pistas</small>
          </span>
        </div>

        <button type="button" className="refresh-button" onClick={() => void loadEvents()} disabled={loading}>
          <RefreshCw size={18} />
          Actualizar
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
