import { ArrowLeft, Wifi, WifiOff } from 'lucide-react';
import { CardAnnouncementScene } from '../components/CardAnnouncementScene.js';
import { Scoreboard } from '../components/Scoreboard.js';
import { useCardAnnouncementQueue } from '../hooks/useCardAnnouncementQueue.js';
import { useMatchSocket } from '../hooks/useMatchSocket.js';

export function LivePage({ eventId }: { eventId: string }) {
  const match = useMatchSocket(eventId, 'viewer', '');
  const { activeAnnouncement, completeAnnouncement } = useCardAnnouncementQueue(
    match.state?.cards?.announcement ?? null,
    match.state?.status === 'live',
  );

  return (
    <main className="watch-page">
      <header className="watch-topbar">
        <a className="match-action" href="/">
          <ArrowLeft size={18} />
          Directos
        </a>
        <div className={`connection-pill ${match.connectionState}`}>
          {match.connectionState === 'connected' ? <Wifi size={16} /> : <WifiOff size={16} />}
          <span>{match.connectionState === 'connected' ? 'En directo' : 'Conectando'}</span>
        </div>
      </header>

      <section className="watch-score">
        {match.state?.status === 'live' ? (
          <Scoreboard state={match.state} teams={match.teams} mode="control" />
        ) : null}
        {match.state && match.state.status !== 'live' ? (
          <div className="empty-panel">Este partido no esta en directo.</div>
        ) : null}
        {!match.state && match.connectionState === 'connecting' ? <div className="loading-panel">Cargando marcador</div> : null}
        {!match.state && match.connectionState !== 'connecting' ? (
          <div className="empty-panel">Este partido no esta en directo.</div>
        ) : null}
      </section>

      {activeAnnouncement ? (
        <CardAnnouncementScene
          announcement={activeAnnouncement}
          teams={match.teams}
          onDone={completeAnnouncement}
        />
      ) : null}
    </main>
  );
}
