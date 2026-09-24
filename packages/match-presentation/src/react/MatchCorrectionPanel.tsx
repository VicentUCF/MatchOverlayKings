import { ListRestart, ShieldAlert } from 'lucide-react';

export type ManualScoreValues = { homeGames: number; awayGames: number; homePoints: number; awayPoints: number };

export function MatchCorrectionPanel({ values, onChange, onApply, onReset, disabled = false }: {
  values: ManualScoreValues;
  onChange: (key: keyof ManualScoreValues, value: number) => void;
  onApply: () => void;
  onReset?: () => void;
  disabled?: boolean;
}) {
  return <section className="operator-panel danger-zone">
    <h2>Correccion</h2>
    <div className="manual-grid">
      <NumberField label="Juegos L" value={values.homeGames} onChange={value=>onChange('homeGames',value)} />
      <NumberField label="Juegos V" value={values.awayGames} onChange={value=>onChange('awayGames',value)} />
      <NumberField label="Puntos L" value={values.homePoints} onChange={value=>onChange('homePoints',value)} />
      <NumberField label="Puntos V" value={values.awayPoints} onChange={value=>onChange('awayPoints',value)} />
    </div>
    <button type="button" onClick={onApply} disabled={disabled}><ShieldAlert size={18} /> Aplicar</button>
    {onReset && <button type="button" onClick={onReset} disabled={disabled}><ListRestart size={18} /> Reset</button>}
  </section>;
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return <label><span>{label}</span><input type="number" min="0" step="1" value={value} onChange={event=>onChange(Math.max(0,Number(event.target.value)||0))}/></label>;
}
