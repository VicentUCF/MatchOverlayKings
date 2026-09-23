import { z } from 'zod';
import { addPoint, applyManualPatch, createInitialMatchState, setMatchStatus, triggerOverlayDataScene, triggerSponsorFullscreen, updateMatchMeta, updateOverlaySettings, updateSponsorTicker, useMatchCard, parseTeams, parseEventDefinition } from '@kpl/shared';
import type { EventDefinition, MatchState, Team } from '@kpl/shared';

const range = z.object({ start: z.number().finite().nonnegative(), end: z.number().finite().positive() }).refine(x => x.end > x.start);
export const ClipSchema = z.object({ id:z.string().uuid(), path:z.string().min(1), relativePath:z.string().nullable(), name:z.string(), duration:z.number().positive(), width:z.number().int().positive(), height:z.number().int().positive(), fpsNum:z.number().int().positive(), fpsDen:z.number().int().positive(), hasAudio:z.boolean(), hdr:z.boolean(), proxyPath:z.string().nullable().optional(), size:z.number().nonnegative(), kept:z.array(range) }).superRefine((clip,ctx)=>{let end=0;for(const keep of clip.kept){if(keep.start<end||keep.end>clip.duration+0.001)ctx.addIssue({code:'custom',message:'Los cortes se solapan o exceden el clip'});end=keep.end;}});
export const ActionSchema = z.object({ id:z.string().uuid(), clipId:z.string().uuid(), at:z.number().finite().nonnegative(), kind:z.enum(['point','status','manual','meta','overlay','card','data','sponsor','ticker']), payload:z.record(z.string(),z.unknown()), duration:z.number().nonnegative().optional() });
export const ProjectSchema = z.object({ version:z.literal(1), id:z.string().uuid(), title:z.string().min(1), date:z.iso.date(), season:z.string(), matchday:z.number().int().positive(), court:z.string(), event:z.custom<Omit<EventDefinition,'state'>>(value=>{try{parseEventDefinition({...value as object,state:null});return true;}catch{return false;}}), teams:z.custom<Team[]>(value=>{try{parseTeams(value);return true;}catch{return false;}}), catalogSyncedAt:z.string().nullable(), leagueSnapshot:z.unknown().nullable().optional(), resources:z.record(z.string(),z.string()).optional(), clips:z.array(ClipSchema), actions:z.array(ActionSchema), revision:z.number().int().nonnegative(), outputReferenceClipId:z.string().uuid().nullable() });
export type Project = z.infer<typeof ProjectSchema>;
export type Clip = z.infer<typeof ClipSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type Range = z.infer<typeof range>;

export function orderedActions(project:Project):Action[] {
  const order = new Map(project.clips.map((c,i)=>[c.id,i]));
  return project.actions.slice().sort((a,b)=>(order.get(a.clipId)??Infinity)-(order.get(b.clipId)??Infinity)||a.at-b.at||project.actions.indexOf(a)-project.actions.indexOf(b));
}

export function replay(project:Project, through?:{clipId:string;at:number}):{state:MatchState; errors:{id:string;message:string}[]} {
  let state = createInitialMatchState(project.event, () => project.date ? new Date(project.date).toISOString() : new Date(0).toISOString());
  const errors:{id:string;message:string}[]=[];
  const maxIndex=through?project.clips.findIndex(c=>c.id===through.clipId):Infinity;
  for(const action of orderedActions(project)) {
    const index=project.clips.findIndex(c=>c.id===action.clipId);
    if(index<0){errors.push({id:action.id,message:'Clip ausente'});continue;}
    if(action.at>project.clips[index]!.duration){errors.push({id:action.id,message:'Acción fuera del clip'});continue;}
    if(through && (index>maxIndex || (index===maxIndex&&action.at>through.at))) break;
    try { state=applyAction(state,action, project); } catch(error) { errors.push({id:action.id,message:error instanceof Error?error.message:String(error)}); }
  }
  return {state,errors};
}

function applyAction(state:MatchState,a:Action, project:Project):MatchState {
  const clock = () => new Date(Date.parse(project.date || "1970-01-01") + Math.round(a.at * 1000)).toISOString();
  const p=a.payload;
  switch(a.kind){
    case 'point': return addPoint(state,p.side==='away'?'away':'home',a.id,clock);
    case 'status': return setMatchStatus(state,p.status==='finished'?'finished':p.status==='pre_match'?'pre_match':'live',a.id,clock);
    case 'meta': return updateMatchMeta(state,p as Parameters<typeof updateMatchMeta>[1],a.id,clock);
    case 'manual': return applyManualPatch(state,p as Parameters<typeof applyManualPatch>[1],a.id,clock);
    case 'overlay': return updateOverlaySettings(state,p as Parameters<typeof updateOverlaySettings>[1],a.id,clock);
    case 'card': return useMatchCard(state,p.side==='away'?'away':'home',p.cardId as Parameters<typeof useMatchCard>[2],String(p.cardName??p.cardId),a.id,clock);
    case 'data': return triggerOverlayDataScene(state,p.kind as Parameters<typeof triggerOverlayDataScene>[1],p.target as Parameters<typeof triggerOverlayDataScene>[2],a.id,clock);
    case 'sponsor': return triggerSponsorFullscreen(state,p.sponsorIds as string[]|null,Number(p.durationSeconds??8),a.id,clock);
    case 'ticker': return updateSponsorTicker(state,p as Parameters<typeof updateSponsorTicker>[1],a.id,clock);
  }
}

export function sourceAt(project:Project, outputSeconds:number):{clip:Clip;at:number}|null {
  let cursor=0;
  for(const clip of project.clips)for(const keep of clip.kept){const length=keep.end-keep.start;if(outputSeconds<cursor+length)return{clip,at:keep.start+Math.max(0,outputSeconds-cursor)};cursor+=length;}
  return null;
}
export function outputDuration(project:Project):number{return project.clips.reduce((n,c)=>n+c.kept.reduce((m,r)=>m+r.end-r.start,0),0);}
export function sourceToOutput(project:Project,clipId:string,at:number):number|null{
  let cursor=0;for(const clip of project.clips)for(const keep of clip.kept){if(clip.id===clipId&&at>=keep.start&&at<keep.end)return cursor+at-keep.start;cursor+=keep.end-keep.start;}return null;
}
export function removeRange(project:Project,clipId:string,cut:Range):Project {
  return {...project,revision:project.revision+1,clips:project.clips.map(c=>c.id!==clipId?c:{...c,kept:c.kept.flatMap(r=>cut.end<=r.start||cut.start>=r.end?[r]:[{start:r.start,end:Math.min(cut.start,r.end)},{start:Math.max(cut.end,r.start),end:r.end}].filter(x=>x.end>x.start))})};
}
