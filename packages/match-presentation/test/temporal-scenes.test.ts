import { describe, expect, it } from 'vitest';
import { DEFAULT_MATCH_CONFIG, DEFAULT_OVERLAY_SETTINGS, DEFAULT_SPONSOR_ADS, createEmptyLineups } from '@kpl/shared';
import type { Project } from '@kpl/editor-core';
import { removeRange } from '@kpl/editor-core';
import { buildEditorOverlaySvg, isSideChangeAction, recentScene } from '../src/index.js';

const first='1497558c-106e-4307-9c6b-a40b599374d7';
const second='206334a1-e104-4477-894e-c7047951b775';
const id='a83ad4c4-5e27-4cbb-8aad-820e35ba6dbf';
function project():Project{return {version:1,id,title:'Prueba',date:'2026-09-23',season:'T1',matchday:1,court:'Pista',event:{id,title:'Prueba',homeTeamId:'a',awayTeamId:'b',lineups:createEmptyLineups(),servingSide:'home',courtName:'Pista',status:'live',config:DEFAULT_MATCH_CONFIG,overlaySettings:DEFAULT_OVERLAY_SETTINGS,sponsorAds:DEFAULT_SPONSOR_ADS},teams:[{id:'a',name:'A',shortName:'A',logoUrl:'/logos/kpl.png',primaryColor:'#ffffff',secondaryColor:'#000000'},{id:'b',name:'B',shortName:'B',logoUrl:'/logos/kpl.png',primaryColor:'#ffffff',secondaryColor:'#000000'}],catalogSyncedAt:null,clips:[first,second].map((clipId,i)=>({id:clipId,path:`/tmp/${i}.mp4`,relativePath:null,name:`${i}.mp4`,duration:10,width:1920,height:1080,fpsNum:30,fpsDen:1,hasAudio:true,hdr:false,size:1000,kept:[{start:0,end:10}]})),actions:[{id:'cd4c76b1-f7cb-45d2-a5b7-d3128188ce57',clipId:first,at:9,kind:'card',payload:{side:'home',cardId:'comodin',cardName:'Comodín'},duration:5}],revision:0,outputReferenceClipId:null};}

describe('escenas con tiempo de vídeo',()=>{
  it('solo muestra cambio de lado cuando el punto termina un juego impar',()=>{
    const p=project();
    const point={id:crypto.randomUUID(),clipId:first,at:9.2,kind:'point' as const,payload:{side:'home'}};
    p.actions.push(point);
    expect(isSideChangeAction(p,point)).toBe(false);
    expect(recentScene(p,first,9.5)?.kind).toBe('card');
    p.actions=[{id:crypto.randomUUID(),clipId:first,at:0,kind:'status',payload:{status:'live'}},
      ...[1,2,3,4].map(at=>({id:crypto.randomUUID(),clipId:first,at,kind:'point' as const,payload:{side:'home'}}))];
    const last=p.actions.at(-1)!;
    expect(isSideChangeAction(p,last)).toBe(true);
    expect(recentScene(p,first,4.5)?.id).toBe(last.id);
  });
  it('mantiene una escena entre clips durante cinco segundos visibles aunque haya cortes',()=>{
    const p=project();
    expect(buildEditorOverlaySvg(p,second,1,1920,1080)).toContain('CARTA');
    expect(buildEditorOverlaySvg(p,second,4.1,1920,1080)).not.toContain('CARTA');
    const cut=removeRange(p,first,{start:9.2,end:10});
    expect(buildEditorOverlaySvg(cut,second,1,1920,1080)).toContain('CARTA');
    expect(buildEditorOverlaySvg(cut,second,4.7,1920,1080)).toContain('CARTA');
    expect(buildEditorOverlaySvg(cut,second,4.9,1920,1080)).not.toContain('CARTA');
    expect(buildEditorOverlaySvg(cut,second,1,1920,1080)).toBe(buildEditorOverlaySvg(cut,second,1,1920,1080));
  });
});
