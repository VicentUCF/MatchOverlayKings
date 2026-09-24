import { useMemo } from 'react';
import { replay, sourceToOutput } from '@kpl/editor-core';
import type { Project } from '@kpl/editor-core';
import type { LeagueSnapshot } from '@kpl/match-data';
import { isSideChangeAction, recentScene, sceneBoundarySeconds } from '../index.js';
import { CardAnnouncementScene } from './CardAnnouncementScene.js';
import { OverlayDataScene } from './OverlayDataScene.js';
import { PrematchOverlayScene } from './PrematchOverlayScene.js';
import { Scoreboard } from './Scoreboard.js';
import { SideChangeScene } from './SideChangeScene.js';
import { SponsorAdScene, hasSponsorTicker } from './SponsorAdScene.js';

export function EditorOverlayFrame({ project, clipId, at }: { project: Project; clipId: string; at: number }) {
  const { state } = replay(project, { clipId, at });
  const teams = useMemo(() => project.teams.map(team => ({
    ...team,
    logoUrl: project.resources?.[team.logoUrl] ?? (team.logoUrl.startsWith('/') ? `.${team.logoUrl}` : team.logoUrl),
  })), [project]);
  const scene = recentScene(project, clipId, at);
  const now = sourceToOutput(project, clipId, at) ?? 0;
  const started = scene ? sourceToOutput(project, scene.clipId, scene.at) ?? now : now;
  const elapsed = Math.max(0, now - started);
  const duration = scene ? sceneBoundarySeconds(scene) - scene.at : 0;
  const opacity = Math.min(1, elapsed / 0.35, (duration - elapsed) / 0.5);
  const resolveAssetUrl = (url:string) => project.resources?.[url] ?? (url.startsWith('/') ? `.${url}` : url);
  const snapshot = useMemo(() => localSnapshot(project.leagueSnapshot, project.resources ?? {}), [project.leagueSnapshot, project.resources]);
  const showScore = state.status === 'live' && state.overlaySettings.visible !== false;
  const isCard = scene?.kind === 'card' && state.cards.announcement;
  const isSideChange = scene?.kind === 'point' && isSideChangeAction(project, scene);
  const isData = scene?.kind === 'data' && state.dataScene;
  const isSponsor = scene?.kind === 'sponsor' && state.sponsorAds.fullscreen;
  const brandLogoUrl = './logos/kpl-wordmark.png';
  return <main className="editor-overlay-frame overlay-page" data-sponsor-ticker={hasSponsorTicker(state.sponsorAds.ticker) && !isSponsor}>
    {showScore && <div className="overlay-score-wrap" data-position={state.overlaySettings.position} data-size={state.overlaySettings.size}>
      <Scoreboard state={state} teams={teams} mode="overlay" brandLogoUrl={brandLogoUrl} liveLabel="Partido" animateChanges={false} />
    </div>}
    {isCard && <CardAnnouncementScene key={scene.id} announcement={state.cards.announcement!} teams={teams} playbackTimeMs={elapsed * 1000} resolveAssetUrl={resolveAssetUrl} onDone={()=>undefined}/>}
    {isSideChange && <div className="editor-time-scene" style={{opacity}}><SideChangeScene key={scene.id} signal={{setNumber:state.sets.length,homeGames:state.sets.at(-1)?.homeGames??0,awayGames:state.sets.at(-1)?.awayGames??0}} state={state} teams={teams} playbackTimeMs={elapsed*1000} brandLogoUrl={brandLogoUrl} onDone={()=>undefined}/></div>}
    {isData && !isCard && <div className="editor-time-scene" style={{opacity}}><OverlayDataScene key={scene.id} scene={state.dataScene!} state={state} teams={teams} snapshotOverride={snapshot} playbackTimeMs={elapsed*1000} brandLogoUrl={brandLogoUrl} onDone={()=>undefined}/></div>}
    {state.status === 'pre_match' && <PrematchOverlayScene state={state} teams={teams} exiting={false} playbackTimeMs={now*1000} brandLogoUrl={brandLogoUrl} onExitComplete={()=>undefined}/>}
    <SponsorAdScene ticker={state.sponsorAds.ticker} fullscreen={isSponsor ? state.sponsorAds.fullscreen : null} playbackTimeMs={now*1000} brandLogoUrl={brandLogoUrl} resolveAssetUrl={resolveAssetUrl} onFullscreenDone={()=>undefined}/>
  </main>;
}

function localSnapshot(value: unknown, resources: Record<string,string>): LeagueSnapshot | null {
  if (!value) return null;
  // The league snapshot is saved with the project. Resolve downloaded images locally for offline rendering.
  const clone = (item: unknown): unknown => {
    if (typeof item === 'string') return resources[item] ?? (item.startsWith('/') ? `.${item}` : item);
    if (Array.isArray(item)) return item.map(clone);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, clone(entry)]));
    return item;
  };
  return clone(value) as LeagueSnapshot;
}
