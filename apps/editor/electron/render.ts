import { spawn, type ChildProcess } from 'node:child_process';
import { BrowserWindow } from 'electron';
import { createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { access, mkdir, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProductionAssets } from '@kpl/production-assets';
import type { ProductionAssetInput } from '@kpl/production-assets';
import type { Team } from '@kpl/shared';
import { orderedActions, outputDuration, replay, sourceToOutput } from '@kpl/editor-core';
import type { Project } from '@kpl/editor-core';
import { sceneBoundarySeconds, isOverlayAnimated } from '@kpl/match-presentation';
import type { ExportProgress } from '../src/bridge.js';
import { binary, inspect, runProbe } from './media.js';

let processRunning:ChildProcess|null=null;let cancelled=false;let busy=false;
export function cancelExport(){cancelled=true;processRunning?.kill('SIGTERM');}
function command(exe:string,args:string[],onProgress?:(seconds:number)=>void):Promise<void>{return new Promise((resolvePromise,reject)=>{const child=spawn(exe,args,{stdio:['ignore','ignore','pipe'],windowsHide:true,shell:false});processRunning=child;let message='';child.stderr?.on('data',(chunk:Buffer)=>{message=(message+chunk.toString()).slice(-2000);const match=message.match(/out_time_us=(\d+)/g)?.at(-1);if(match)onProgress?.(Number(match.slice(12))/1_000_000);});child.once('error',reject);child.once('close',(code)=>{processRunning=null;if(code===0&&!cancelled)resolvePromise();else reject(new Error(cancelled?'Exportación cancelada':message||`FFmpeg salió con código ${code}`));});});}
export async function exportProject(folder:string,project:Project,output:string,report:(p:ExportProgress)=>void):Promise<void>{
  if(busy)throw new Error('Ya hay una exportación en curso');busy=true;cancelled=false;
  let audioStream:ReturnType<typeof createWriteStream>|null=null;let surface:BrowserWindow|null=null;
  const temp=join(dirname(output),`.kpl-export-${randomUUID()}`);const tempOutput=join(temp,'video.mp4');const audioOutput=join(temp,'audio.pcm');const mixedOutput=join(temp,'audio-mixed.pcm');const finalOutput=join(temp,'resultado.mp4');
  try{
    if(outputDuration(project)<=0)throw new Error('No quedan tramos de vídeo para exportar');
    const errors=replay(project).errors;if(errors.length)throw new Error(`Corrige ${errors.length} acciones inválidas antes de exportar`);
    try{await access(output);throw new Error('El archivo de salida ya existe');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    for(const clip of project.clips){const info=await inspect(clip.path);if(info.hdr)throw new Error(`El clip ${clip.name} es HDR: convierte una copia a SDR antes de exportar`);if(info.size!==clip.size||Math.abs(info.duration-clip.duration)>0.5)throw new Error(`El clip ${clip.name} ha cambiado; vuelve a vincularlo`);if(resolve(clip.path)===resolve(output))throw new Error('El destino no puede ser un clip original');}
    const reference=project.clips.find(c=>c.id===project.outputReferenceClipId)??project.clips[0];if(!reference)throw new Error('Falta el clip de referencia');
    const mixed=project.clips.some(c=>c.width!==reference.width||c.height!==reference.height||c.fpsNum*reference.fpsDen!==reference.fpsNum*c.fpsDen);
    if(mixed&&!project.outputReferenceClipId)throw new Error('Selecciona un clip de referencia para combinar formatos distintos');
    const free=await statfs(dirname(output));if(free.bavail*free.bsize<Math.max(512*1024*1024,outputDuration(project)*(reference.width*reference.height>=3840*2160?12_000_000:4_000_000)))throw new Error('Espacio insuficiente en el destino');
    await mkdir(temp);report({phase:'preparing',fraction:0,message:'Preparando segmentos'});
    surface=new BrowserWindow({width:1920,height:1080,show:false,transparent:true,frame:false,paintWhenInitiallyHidden:true,webPreferences:{offscreen:true,backgroundThrottling:false,nodeIntegration:false,contextIsolation:true,sandbox:true}});
    surface.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    await surface.loadFile(join(import.meta.dirname,'../../dist/render.html'));
    await surface.webContents.debugger.attach('1.3');
    await surface.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:1,mobile:false});
    await surface.webContents.debugger.sendCommand('Emulation.setDefaultBackgroundColorOverride',{color:{r:0,g:0,b:0,a:0}});
    await surface.webContents.executeJavaScript(`window.setRenderProject(${JSON.stringify(project)})`);
    async function capture(clipId:string,at:number):Promise<Uint8Array>{
      if(!surface)throw new Error('Renderizador de gráficos no disponible');
      await surface.webContents.executeJavaScript(`window.renderAt(${JSON.stringify(clipId)},${JSON.stringify(at)})`);
      const screenshot=await surface.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:true,clip:{x:0,y:0,width:1920,height:1080,scale:1}}) as {data:string};
      const png=Buffer.from(screenshot.data,'base64');
      if(!png.length)throw new Error('No se pudo capturar el gráfico del partido');
      return png;
    }
    const fontFiles=[join(folder,'assets','fonts','SpaceGrotesk_700Bold.ttf'),join(folder,'assets','fonts','Manrope_700Bold.ttf')];
    for(const font of fontFiles)await access(font);
    const fps=`${reference.fpsNum}/${reference.fpsDen}`;const segments:string[]=[];audioStream=createWriteStream(audioOutput);audioStream.on('error',()=>undefined);
    const actions=orderedActions(project);let completedSeconds=0;
    for(const clip of project.clips)for(const keep of clip.kept){
      const sceneTimes=actions.flatMap(a=>{const beginning=sourceToOutput(project,a.clipId,a.at);if(beginning===null)return[];return [beginning,beginning+sceneBoundarySeconds(a)-a.at];});
      const outputStart=sourceToOutput(project,clip.id,keep.start);
      const boundaries=[keep.start,keep.end,...(outputStart===null?[]:sceneTimes.map(t=>keep.start+t-outputStart)),...actions.filter(a=>a.clipId===clip.id).map(a=>a.at)].filter(t=>t>=keep.start&&t<=keep.end).sort((a,b)=>a-b).filter((t,i,list)=>i===0||t-list[i-1]!>0.001);
      for(let k=0;k<boundaries.length-1;k++){
        const start=boundaries[k]!,end=boundaries[k+1]!;if(end-start<0.001)continue;
        const n=segments.length;const overlay=join(temp,`${n}.png`),segment=join(temp,`${n}.mp4`);
        const animated=isOverlayAnimated(project,clip.id,start+0.0001);
        if(!animated)await writeFile(overlay,await capture(clip.id,start+0.0001));
        const frameCount=Math.max(1,Math.round((end-start)*reference.fpsNum/reference.fpsDen));
        const audioSamples=Math.round(frameCount*reference.fpsDen/reference.fpsNum*48000);
        const filter=`[0:v]fps=${fps},scale=${reference.width}:${reference.height}:force_original_aspect_ratio=decrease,pad=${reference.width}:${reference.height}:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p[v];[1:v]scale=${reference.width}:${reference.height}:flags=lanczos[ov];[v][ov]overlay=0:0:shortest=1:format=auto,format=yuv420p[out]`;
        const args=['-hide_banner','-loglevel','error','-progress','pipe:2','-ss',String(start),'-i',clip.path,...(animated?['-f','image2pipe','-vcodec','png']:['-loop','1']),'-framerate',fps,'-i',animated?'pipe:0':overlay,'-filter_complex',filter,'-map','[out]','-frames:v',String(frameCount),'-an','-c:v','libx264','-crf','16','-preset','medium','-r',fps,'-movflags','+faststart','-y',segment];
        const progressAt=(seconds:number)=>report({phase:'encoding',fraction:Math.min(0.93,(completedSeconds+seconds)/outputDuration(project)),message:`Codificando ${clip.name}`});
        if(animated)await commandFrames(args,frameCount,i=>capture(clip.id,start+i*reference.fpsDen/reference.fpsNum),progressAt);else await command(binary('ffmpeg'),args,progressAt);
        await appendAudio(audioStream,clip.hasAudio?clip.path:null,start,end-start,audioSamples);
        segments.push(segment);completedSeconds+=end-start;if(cancelled)throw new Error('Exportación cancelada');
        report({phase:'encoding',fraction:Math.min(0.94,completedSeconds/outputDuration(project)),message:`Segmento ${segments.length}`});
      }
    }
    audioStream.end();await once(audioStream,'finish');
    if(!segments.length)throw new Error('No hay segmentos exportables');
    const list=join(temp,'segments.txt');await writeFile(list,segments.map(p=>`file '${p.replaceAll("'","'\\''")}'`).join('\n'));
    await command(binary('ffmpeg'),['-hide_banner','-loglevel','error','-f','concat','-safe','0','-i',list,'-c','copy','-y',tempOutput]);
    await mixCardAudio(audioOutput,mixedOutput,project);
    await command(binary('ffmpeg'),['-hide_banner','-loglevel','error','-i',tempOutput,'-f','s16le','-ar','48000','-ac','2','-i',mixedOutput,'-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a','192k','-movflags','+faststart','-shortest','-y',finalOutput]);
    report({phase:'validating',fraction:0.97,message:'Verificando vídeo'});
    const probe=await runProbe(finalOutput);const videoStream=probe.streams?.find(s=>s.codec_type==='video');
    if(!videoStream||videoStream.width!==reference.width||videoStream.height!==reference.height)throw new Error('La resolución de salida no coincide con la prevista');
    if(!probe.streams?.some(s=>s.codec_type==='audio'))throw new Error('La salida no contiene audio');
    const encodedDuration=Number(probe.format?.duration);
    if(!Number.isFinite(encodedDuration)||Math.abs(encodedDuration-outputDuration(project))>Math.max(0.5,segments.length*reference.fpsDen/reference.fpsNum+0.1))throw new Error('La duración de salida no coincide con el proyecto');
    const home=project.teams.find(t=>t.id===project.event.homeTeamId),away=project.teams.find(t=>t.id===project.event.awayTeamId);
    if(!home||!away)throw new Error('Faltan equipos para la miniatura');
    const localAssets=Object.fromEntries(Object.entries(project.resources??{}).filter(([key,value])=>key.startsWith('/logos/')&&value.startsWith('data:image/')).map(([key,value])=>[key,Buffer.from(value.split(',')[1]??'','base64')]));
    const thumbnail=createProductionAssets({leagueName:'KingsPadelLeague',seasonLabel:project.season,matchdayLabel:'Jornada',matchdayNumber:project.matchday,courtName:project.court,home:thumbnailTeam(home),away:thumbnailTeam(away),scheduledAt:new Date(project.date).toISOString(),timeZone:'Europe/Madrid',locale:'es-ES',publicUrl:'https://live.kingspadelleague.es/',templateRevision:'editor-v1'},{statusLabel:'PARTIDO',localAssets,fontFiles});
    const image=join(temp,'miniatura.png');await writeFile(image,thumbnail.pngBytes);
    const thumbOutput=output.replace(/\.mp4$/i,'.png');try{await access(thumbOutput);throw new Error('La miniatura de salida ya existe');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    await rename(finalOutput,output);try{await rename(image,thumbOutput);}catch(error){await rm(output,{force:true});throw error;}report({phase:'done',fraction:1,message:'Exportación terminada',output});
  }catch(error){report({phase:cancelled?'cancelled':'error',fraction:0,message:error instanceof Error?error.message:String(error)});throw error;
  }finally{audioStream?.destroy();surface?.destroy();processRunning=null;busy=false;await rm(temp,{recursive:true,force:true}).catch(()=>undefined);}
}

async function appendAudio(out:ReturnType<typeof createWriteStream>,source:string|null,start:number,duration:number,samples:number){
  const expected=samples*4;let written=0;
  if(source){
    const child=spawn(binary('ffmpeg'),['-hide_banner','-loglevel','error','-ss',String(start),'-i',source,'-t',String(duration+0.05),'-vn','-ar','48000','-ac','2','-f','s16le','pipe:1'],{stdio:['ignore','pipe','pipe'],windowsHide:true});
    processRunning=child;let error='';child.stderr?.on('data',b=>{error=(error+b.toString()).slice(-1000);});
    for await(const chunk of child.stdout!){const bytes=Math.min(chunk.length,expected-written);if(bytes>0){if(!out.write(chunk.subarray(0,bytes)))await once(out,'drain');written+=bytes;}}
    const [code]=await once(child,'close');processRunning=null;if(code!==0)throw new Error(error||'No se pudo decodificar el audio');
  }
  while(written<expected){const bytes=Math.min(expected-written,65536);if(!out.write(Buffer.alloc(bytes)))await once(out,'drain');written+=bytes;}
}
async function mixCardAudio(input:string,output:string,project:Project){
  const cards=orderedActions(project).filter(a=>a.kind==='card' && project.event.overlaySettings?.soundEnabled).map(a=>sourceToOutput(project,a.clipId,a.at)).filter((n):n is number=>n!==null).map(n=>Math.round(n*48000));
  if(cards.length===0){const source=createReadStream(input),dest=createWriteStream(output);source.pipe(dest);await once(dest,'finish');return;}
  const sound=join(import.meta.dirname,'../../dist/sounds/card-reveal.mp3');
  let effect:Buffer=Buffer.alloc(0);
  try{effect=await decodeEffect(sound);}catch{ /* missing optional sound */ }
  const source=createReadStream(input,{highWaterMark:65536}),dest=createWriteStream(output);let frame=0;
  for await(const chunk of source){const bytes=Buffer.from(chunk);for(const start of cards){const from=Math.max(0,start-frame),until=Math.min(bytes.length/4,start+effect.length/4-frame);for(let i=from;i<until;i++)for(let channel=0;channel<2;channel++){const at=i*4+channel*2,eff=(frame+i-start)*4+channel*2;const sample=bytes.readInt16LE(at)+Math.round(effect.readInt16LE(eff)*(project.event.overlaySettings?.soundVolume??0.55));bytes.writeInt16LE(Math.max(-32768,Math.min(32767,sample)),at);}}if(!dest.write(bytes))await once(dest,'drain');frame+=bytes.length/4;}dest.end();await once(dest,'finish');
}
async function decodeEffect(path:string):Promise<Buffer>{return new Promise((resolve,reject)=>{const child=spawn(binary('ffmpeg'),['-hide_banner','-loglevel','error','-i',path,'-f','s16le','-ar','48000','-ac','2','pipe:1'],{stdio:['ignore','pipe','pipe']});const chunks:Buffer[]=[];child.stdout?.on('data',b=>chunks.push(b));child.once('error',reject);child.once('close',code=>{if(code===0)resolve(Buffer.concat(chunks));else reject(new Error('Efecto de audio no disponible'));});});}

async function commandFrames(args:string[],frames:number,render:(index:number)=>Promise<Uint8Array>|Uint8Array,onProgress?:(seconds:number)=>void):Promise<void>{
  const child=spawn(binary('ffmpeg'),args,{stdio:['pipe','ignore','pipe'],windowsHide:true,shell:false});processRunning=child;let message='';child.stderr?.on('data',b=>{message=(message+b.toString()).slice(-1800);const match=message.match(/out_time_us=(\d+)/g)?.at(-1);if(match)onProgress?.(Number(match.slice(12))/1_000_000);});child.stdin?.on('error',()=>undefined);
  const completed=new Promise<void>((resolvePromise,reject)=>{child.once('error',reject);child.once('close',code=>{processRunning=null;if(code===0&&!cancelled)resolvePromise();else reject(new Error(cancelled?'Exportación cancelada':message||`FFmpeg salió con código ${code}`));});});
  try{for(let i=0;i<frames;i++){if(cancelled)break;const png=Buffer.from(await render(i));if(!child.stdin!.write(png))await Promise.race([once(child.stdin!,'drain'),completed]);}child.stdin!.end();await completed;}catch(error){child.kill('SIGTERM');await completed.catch(()=>undefined);throw error;}
}

function thumbnailTeam(team:Team):ProductionAssetInput['home']{
  const logo:ProductionAssetInput['home']['logo']=team.logoUrl.startsWith('data:image/')?(()=>{const [head,data]=team.logoUrl.split(',');const type=head?.slice(5).split(';')[0];if(type==='image/png'||type==='image/jpeg'||type==='image/webp')return {kind:'bytes' as const,mediaType:type,bytes:Buffer.from(data??'','base64')};return undefined;})():/^\/logos\/[A-Za-z0-9][A-Za-z0-9_./-]*\.(?:png|jpe?g|webp)$/i.test(team.logoUrl)?{kind:'local-ref' as const,ref:team.logoUrl}:undefined;
  return {name:team.name,shortName:team.shortName,color:team.primaryColor,...(logo?{logo}:{})};
}
