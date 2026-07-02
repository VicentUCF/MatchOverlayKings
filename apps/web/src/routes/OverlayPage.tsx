import { Scoreboard } from '../components/Scoreboard.js';
import { useMatchSocket } from '../hooks/useMatchSocket.js';

export function OverlayPage({ eventId }: { eventId: string }) {
  const match = useMatchSocket(eventId, 'overlay', '');

  return (
    <main className="overlay-page">
      {match.state ? (
        <Scoreboard state={match.state} teams={match.teams} mode="overlay" />
      ) : (
        <div className="overlay-loading">KPL</div>
      )}
    </main>
  );
}
