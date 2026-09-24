import type { CSSProperties } from 'react';
import { BarChart3, CreditCard, Megaphone, Menu, Pencil, Plus, RotateCcw } from 'lucide-react';
import type { MatchState, Side, Team } from '@kpl/shared';

export type MatchControlPanel = 'cards' | 'data' | 'ads' | 'edit' | 'menu';

export function MatchScoreControls({ state, teams, pending = false, onAddPoint, onUndo, onOpenPanel }: {
  state: MatchState | null;
  teams: Team[];
  pending?: boolean;
  onAddPoint: (side: Side) => void;
  onUndo: () => void;
  onOpenPanel: (panel: MatchControlPanel) => void;
}) {
  const home = teams.find(team => team.id === state?.homeTeamId);
  const away = teams.find(team => team.id === state?.awayTeamId);
  return <>
    <div className="point-controls">
      {(['home', 'away'] as const).map(side => {
        const team = side === 'home' ? home : away;
        return <button key={side} type="button" className={`point-button ${side}`}
          style={{ '--point-team-color': team?.primaryColor ?? '#c9a227', '--point-team-secondary': team?.secondaryColor ?? '#0d1016' } as CSSProperties}
          onClick={() => onAddPoint(side)} disabled={!state || pending || state.status === 'finished'}>
          <Plus size={28} /><strong>{team?.shortName ?? (side === 'home' ? 'Local' : 'Visitante')}</strong>
        </button>;
      })}
    </div>
    <nav className="control-action-bar" aria-label="Acciones del marcador">
      <button type="button" className="danger" onClick={onUndo} disabled={!state || pending}><RotateCcw size={18} /><span>Deshacer</span></button>
      <button type="button" onClick={() => onOpenPanel('cards')} disabled={!state}><CreditCard size={18} /><span>Carta especial</span></button>
      <button type="button" onClick={() => onOpenPanel('data')} disabled={!state}><BarChart3 size={18} /><span>OBS datos</span></button>
      <button type="button" onClick={() => onOpenPanel('ads')} disabled={!state}><Megaphone size={18} /><span>Anuncios</span></button>
      <button type="button" onClick={() => onOpenPanel('edit')} disabled={!state}><Pencil size={18} /><span>Editar marcador</span></button>
      <button type="button" onClick={() => onOpenPanel('menu')} disabled={!state}><Menu size={18} /><span>Menu</span></button>
    </nav>
  </>;
}
