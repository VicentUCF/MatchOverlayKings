import type { PilotMobileCameraSession, PilotPreflightCheckId, PilotSource } from '@kpl/production-contracts';
import type { PilotYouTubeHealth } from './pilot-youtube.js';
import type { PilotHostMeasurement } from './pilot-preflight-system.js';
import type { PilotMediaProbeResult } from './pilot-preflight-media.js';
import type { PreflightOutcome, PreflightMediaOutcome } from './pilot-preflight.js';
import type { PilotUploadMeasurement } from './pilot-upload-check.js';

export async function checkPilotMetadata(id: PilotPreflightCheckId, context: {
  readonly source: PilotSource;
  readonly mode: 'youtube' | 'simulation';
  readonly mobile: PilotMobileCameraSession | null;
  readonly assertMatch: () => Promise<void>;
  readonly host: () => Promise<PilotHostMeasurement>;
  readonly destination: () => Promise<PilotYouTubeHealth>;
  readonly transport: () => Promise<{ milliseconds: number; encrypted: boolean }>;
  readonly upload?: () => Promise<PilotUploadMeasurement | null>;
  readonly uploadDemand?: { readonly kbps: number; readonly courts: number };
  readonly mediaMtx: () => Promise<boolean>;
}): Promise<PreflightOutcome> {
  switch (id) {
    case 'configuration':
    case 'authorization':
      await context.assertMatch();
      return { status: 'pass', message: id === 'configuration' ? 'El marcador confirma la pista y los equipos preparados.' : 'Tu cuenta puede operar este partido.' };
    case 'profile': {
      if (context.source.kind !== 'mobile') return { status: context.source.kind === 'synthetic' ? 'warning' : 'pass',
        message: context.source.kind === 'synthetic' ? 'Se utiliza una señal de prueba, no una cámara del partido.' : 'Captura y programa configurados a 1080p30.' };
      const { desired, applied, state } = context.mobile ?? {};
      if (!desired || !applied || !['ready', 'degraded'].includes(state ?? '') || applied.revision !== desired.revision
        || applied.profile !== desired.profile || applied.audioEnabled !== desired.audioEnabled
        || (desired.cameraId !== null && applied.cameraId !== desired.cameraId)) {
        return { status: 'blocked', message: 'El móvil todavía no ha aplicado el perfil solicitado. Conéctalo y espera su confirmación.' };
      }
      const minHeight = desired.profile.startsWith('1080') ? 1080 : 720;
      const fps = desired.profile.endsWith('60') ? 60 : 30;
      const exact = applied.height >= minHeight && applied.width >= minHeight * 16 / 9 && applied.framesPerSecond >= fps * 0.95;
      return { status: exact ? 'pass' : 'warning', message: `El móvil confirma ${applied.width} × ${applied.height} a ${Math.round(applied.framesPerSecond)} fps.${exact ? '' : ' La captura queda por debajo del perfil solicitado; revisa sus ajustes.'}` };
    }
    case 'mediamtx':
      if (context.source.kind !== 'mobile') return { status: 'not_applicable', message: 'Esta fuente no utiliza el servicio de cámaras móviles.' };
      return await context.mediaMtx() ? { status: 'pass', message: 'El servicio de cámaras responde ahora.' }
        : { status: 'blocked', message: 'El servicio de cámaras no responde. Recupera la cámara y repite la comprobación.' };
    case 'storage': {
      const free = (await context.host()).availableStorageBytes;
      return { status: free < 128 * 1024 ** 2 ? 'blocked' : free < 2 * 1024 ** 3 ? 'warning' : 'pass',
        message: `${(free / 1024 ** 3).toFixed(1)} GB libres. Con menos de 128 MB se omite la grabación de prueba. Este aviso no impide emitir.` };
    }
    case 'memory': {
      const free = (await context.host()).availableMemoryBytes;
      return { status: free < 256 * 1024 ** 2 ? 'blocked' : free < 1024 ** 3 ? 'warning' : 'pass',
        message: `${Math.round(free / 1024 ** 2)} MB disponibles para el runtime. Se requieren 256 MB de margen; con menos de 1 GB, cierra otras aplicaciones.` };
    }
    case 'cpu': {
      const host = await context.host();
      return { status: host.cpuBusyRatio === null || host.cpuBusyRatio >= 0.85 ? 'warning' : 'pass',
        message: host.cpuBusyRatio === null ? 'No se pudo medir la carga actual. La prueba del programa comprobará la capacidad del codificador.'
          : `Carga actual: ${Math.round(host.cpuBusyRatio * 100)} % de ${host.cores.toFixed(1)} núcleos disponibles. La prueba del programa comprueba el codificador con esta carga.` };
    }
    case 'destination': {
      if (context.mode === 'simulation') return { status: 'not_applicable', message: 'Simulación local: no se enviará vídeo a una plataforma.' };
      const health = await context.destination();
      const usable = ['created', 'ready', 'testing', 'liveStarting', 'testStarting', 'live'].includes(health.broadcastStatus ?? '')
        && health.streamStatus !== null;
      return { status: usable ? 'pass' : 'blocked', message: usable ? 'YouTube confirma el acceso al broadcast y a su entrada de vídeo.'
        : 'YouTube no confirma un destino utilizable. Revisa la cuenta y si la emisión ya se cerró.' };
    }
    case 'network': {
      if (context.mode === 'simulation') return { status: 'not_applicable', message: 'La simulación no utiliza una conexión de subida.' };
      const transport = await context.transport();
      const upload = await context.upload?.().catch(() => null);
      if (upload && context.uploadDemand) {
        const demand = context.uploadDemand;
        const required = demand.kbps * 1.3;
        const enough = upload.kbps >= required;
        return { status: enough ? 'pass' : 'blocked', checkedAt: upload.checkedAt,
          message: `Entrada accesible (${transport.milliseconds} ms). Subida estimada a Cloudflare: ${(upload.kbps / 1_000).toFixed(1)} Mbps; se requieren ${(required / 1_000).toFixed(1)} Mbps para ${demand.courts} pista(s), con audio y 30 % de margen. ${enough ? 'La ruta a YouTube puede rendir distinto; valida el directo privado.' : 'Reduce las pistas simultáneas o mejora la red y repite Red.'}` };
      }
      if (context.upload) return { status: 'warning', message: `La entrada responde en ${transport.milliseconds} ms. No hay una medición de subida vigente. La prueba se omite durante directos o si el servicio no responde. Comprueba Red con las salidas detenidas antes de comenzar la jornada.` };
      return { status: 'warning', message: `La entrada responde en ${transport.milliseconds} ms${transport.encrypted ? ' mediante TLS' : ''}. Esta conexión no mide la capacidad de subida; valida el ancho de banda en el equipo de emisión.` };
    }
    default: return { status: 'blocked', message: 'Esta comprobación necesita una muestra del programa.' };
  }
}

export function checkPilotMedia(result: PilotMediaProbeResult, audioExpected: boolean, fps: 30 | 60 = 30): PreflightMediaOutcome['checks'] {
  const issues = result.signal.issues;
  const cameraWarning = issues.find(({ code }) => ['black_video', 'frozen_video'].includes(code));
  const speed = result.signal.measuredSpeed;
  const bitrate = result.sizeBytes * 8 / 1_000 / Math.max(1, result.durationSeconds);
  return {
    camera: !result.cameraReceived || result.cameraInterrupted
      ? { status: 'blocked', message: 'No se recibieron diez segundos continuos de cámara. Revisa la fuente y repite la prueba.' }
      : { status: cameraWarning ? 'warning' : 'pass', message: cameraWarning?.message ?? 'La fuente ha entregado vídeo y audio sincronizados durante la prueba.' },
    overlay: !result.overlayReceived || result.overlayInterrupted
      ? { status: 'blocked', message: 'El marcador no se mantuvo confirmado durante la prueba. Comprueba su conexión y repite.' }
      : { status: 'pass', message: 'El marcador del partido está compuesto dentro de la imagen del programa.' },
    audio: !result.completed ? { status: 'blocked', message: 'No se pudo verificar la pista de audio del programa final.' }
      : !audioExpected ? { status: 'warning', message: 'El programa incluye audio de silencio: esta fuente no tiene un micrófono activo. Comprueba que es lo previsto.' }
        : issues.some(({ code }) => code === 'silent_audio')
          ? { status: 'warning', message: 'El micrófono permaneció en silencio. Reproduce la vista previa y comprueba que se oye el partido.' }
          : { status: 'pass', message: 'El programa contiene audio decodificable. Reproduce la vista previa para comprobar lo que se oye.' },
    encoder: !result.completed || speed === null || speed < 0.95
      ? { status: 'blocked', message: !result.completed ? 'El codificador no completó un programa reproducible. Revisa CPU/GPU y vuelve a comprobar.'
        : `La salida no acredita la velocidad mínima de 0,95×${speed === null ? '' : ` (medida: ${speed.toFixed(2)}×)`}. Reduce la carga o el perfil y repite.` }
      : { status: 'pass', message: `Programa H.264 y AAC reproducible; velocidad reciente ${speed.toFixed(2)}×.` },
    bitrate: result.completed ? { status: bitrate < (fps === 60 ? 2_700 : 1_800) ? 'warning' : 'pass',
      message: `El archivo del programa mide ${Math.round(bitrate)} kbps de media, incluido audio. Reserva al menos un 30 % de margen de subida.` }
      : { status: 'blocked', message: 'Falta un programa completo para medir el bitrate.' },
  };
}
