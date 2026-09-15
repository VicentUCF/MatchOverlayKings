import { useEffect, useState } from 'react';
import { createProductionPilotAdapter } from '../lib/production-pilot-adapter.js';

const adapter = createProductionPilotAdapter();
export function PilotThumbnailPreview({ homeTeam, awayTeam, matchdayNumber }: {
  readonly homeTeam: string; readonly awayTeam: string; readonly matchdayNumber: number;
}) {
  const [result, setResult] = useState<{ key: string; dataUrl?: string; error?: string } | null>(null);
  const key = JSON.stringify([homeTeam, awayTeam, matchdayNumber]);
  const valid = homeTeam !== '' && awayTeam !== '' && homeTeam !== awayTeam
    && Number.isInteger(matchdayNumber) && matchdayNumber >= 1 && matchdayNumber <= 999;
  useEffect(() => {
    if (!valid) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void adapter.thumbnailPreview({
        homeTeam, awayTeam, matchdayNumber, courtSlug: 'pista-1', mode: 'simulation',
        sourceId: 'synthetic', seasonLabel: 'T2', scheduledAt: '2030-01-01T12:00:00.000Z',
        privacyStatus: 'private',
      }, controller.signal).then((response) => {
        if (controller.signal.aborted) return;
        setResult(response.kind === 'success'
          ? { key, dataUrl: response.value.dataUrl } : { key, error: response.message });
      });
    }, 350);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [homeTeam, awayTeam, matchdayNumber, key, valid]);
  const current = result?.key === key ? result : null;
  return <div className="production-pilot-thumbnail">
    {valid && current?.dataUrl ? <>
      <img src={current.dataUrl} alt={`Portada: ${homeTeam} vs ${awayTeam}, jornada ${matchdayNumber}`} />
      <a href={current.dataUrl} download={`kpl-jornada-${matchdayNumber}-${homeTeam}-${awayTeam}.png`}>Descargar portada PNG</a>
    </> : <p role="status">{!valid ? 'Selecciona dos equipos diferentes y una jornada válida.'
      : current?.error ?? 'Generando portada…'}</p>}
  </div>;
}
