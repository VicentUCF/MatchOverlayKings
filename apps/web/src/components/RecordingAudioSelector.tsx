import type { PilotAudioSelection, PilotReadiness } from '@kpl/production-contracts';

export function RecordingAudioSelector({ readiness, sourceId, selections, includeSourceAudio, onSelections,
  onIncludeSourceAudio, disabled = false, unavailable = [] }: {
  readonly readiness: PilotReadiness;
  readonly sourceId: string;
  readonly selections: readonly PilotAudioSelection[];
  readonly includeSourceAudio: boolean;
  readonly onSelections: (value: PilotAudioSelection[]) => void;
  readonly onIncludeSourceAudio: (value: boolean) => void;
  readonly disabled?: boolean;
  readonly unavailable?: readonly string[];
}) {
  const selected = new Map(selections.map((entry) => [entry.id, entry]));
  const isMobile = sourceId === 'mobile:pilot';
  return <fieldset className="recording-audio-selector" disabled={disabled}>
    <legend>Sonido de la grabación</legend>
    <p>Elige uno o varios micrófonos. La grabación tendrá una sola mezcla final.</p>
    {isMobile ? <label><input type="checkbox" checked={includeSourceAudio}
      onChange={(event) => onIncludeSourceAudio(event.currentTarget.checked)} /> Incluir audio del móvil</label> : null}
    {(readiness.audioInputs ?? []).map((device) => {
      const occupied = unavailable.includes(device.id) && !selected.has(device.id);
      const entry = selected.get(device.id);
      return <div key={device.id} className="recording-audio-selector__input">
        <label><input type="checkbox" checked={entry !== undefined} disabled={occupied}
          onChange={(event) => onSelections(event.currentTarget.checked
            ? [...selections, { id: device.id, gain: 1 }]
            : selections.filter(({ id }) => id !== device.id))} /> {device.label}{occupied ? ' · en uso' : ''}</label>
        {entry ? <label>Volumen de {device.label}
          <input type="range" min="0" max="200" step="10" value={Math.round(entry.gain * 100)}
            onChange={(event) => onSelections(selections.map((value) => value.id === device.id
              ? { ...value, gain: Number(event.currentTarget.value) / 100 } : value))} />
          <output>{Math.round(entry.gain * 100)} %</output></label> : null}
      </div>;
    })}
    {!isMobile && (readiness.audioInputs ?? []).length === 0 ? <p role="status">Windows no detecta micrófonos disponibles.</p> : null}
    {!isMobile && selections.length === 0 ? <p role="alert">Selecciona al menos un micrófono para esta grabación.</p> : null}
  </fieldset>;
}
