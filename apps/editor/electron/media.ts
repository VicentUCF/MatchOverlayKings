import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { MediaInfo } from '../src/bridge.js';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';

export function binary(name:'ffmpeg'|'ffprobe'):string{
  if(process.env.KPL_EDITOR_FFMPEG_DIR)return `${process.env.KPL_EDITOR_FFMPEG_DIR}/${name}${process.platform==='win32'?'.exe':''}`;
  if(process.env.NODE_ENV==='development')return name==='ffmpeg'?ffmpegInstaller.path:ffprobeInstaller.path;
  return `${process.resourcesPath}/bin/${name}${process.platform==='win32'?'.exe':''}`;
}
interface ProbeStream { codec_type:string; duration?:string; width?:number; height?:number; avg_frame_rate?:string; r_frame_rate?:string; color_transfer?:string }
interface ProbeData { streams:ProbeStream[]; format?:{ duration?:string } }
export function runProbe(path:string):Promise<ProbeData>{return new Promise((resolve,reject)=>execFile(binary('ffprobe'),['-v','error','-show_format','-show_streams','-of','json',path],{maxBuffer:1024*1024,timeout:30000,windowsHide:true},(error,stdout)=>{if(error)reject(error);else try{resolve(JSON.parse(stdout) as ProbeData);}catch(e){reject(e);}}));}
export async function inspect(path:string):Promise<MediaInfo>{
  const [probe,file]=await Promise.all([runProbe(path),stat(path)]);
  const video=probe.streams?.find((stream:ProbeStream)=>stream.codec_type==='video');
  if(!video)throw new Error(`No hay vídeo: ${basename(path)}`);
  const duration=Number(video.duration??probe.format?.duration);
  const rate=String(video.avg_frame_rate??video.r_frame_rate??'30/1').split('/').map(Number);
  if(!Number.isFinite(duration)||duration<=0)throw new Error(`Duración desconocida: ${basename(path)}`);
  const hdr=['smpte2084','arib-std-b67'].includes(video.color_transfer??'');
  return {path,name:basename(path),duration,width:Number(video.width),height:Number(video.height),fpsNum:rate[0]||30,fpsDen:rate[1]||1,hasAudio:Boolean(probe.streams?.some((stream:ProbeStream)=>stream.codec_type==='audio')),hdr,size:file.size};
}
