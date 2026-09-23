import process from 'node:process';
import { mkdir, copyFile, chmod } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpeg from '@ffmpeg-installer/ffmpeg';
import ffprobe from '@ffprobe-installer/ffprobe';
const target=resolve(dirname(fileURLToPath(import.meta.url)),'../vendor');await mkdir(target,{recursive:true});
for(const [name,path] of [['ffmpeg',ffmpeg.path],['ffprobe',ffprobe.path]]){const dest=resolve(target,`${name}${process.platform==='win32'?'.exe':''}`);await copyFile(path,dest);if(process.platform!=='win32')await chmod(dest,0o755);}
