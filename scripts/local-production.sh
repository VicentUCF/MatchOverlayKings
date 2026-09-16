#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${KPL_LOCAL_PRODUCTION_ENV:-$repo_dir/.env.pilot.docker}"
web_env_file="$repo_dir/apps/web/.env"
action="${1:-check}"

# Ejecuta el contenedor sin privilegios con el propietario real del bind mount.
export KPL_PILOT_UID="${KPL_PILOT_UID:-$(id -u)}"
export KPL_PILOT_GID="${KPL_PILOT_GID:-$(id -g)}"

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

[[ -f "$env_file" ]] || fail "falta $env_file; créalo desde .env.pilot.docker.example"

env_files=()
if [[ -f "$web_env_file" ]]; then
  env_files+=("$web_env_file")
fi
env_files+=("$env_file")

read_env_value() {
  local key="$1"
  local candidate=''
  local source
  for source in "${env_files[@]}"; do
    candidate="$(sed -n "s/^${key}=//p" "$source" | tail -n 1)"
    if [[ -n "$candidate" ]]; then
      REPLY="$candidate"
    fi
  done
}

required=(
  VITE_SUPABASE_URL
  VITE_SUPABASE_PUBLISHABLE_KEY
  KPL_PILOT_LAN_HOST
  KPL_PILOT_LAN_CIDR
  KPL_PILOT_CAMERA_PAGE_ORIGIN
)

for key in "${required[@]}"; do
  REPLY=''
  read_env_value "$key"
  value="$REPLY"
  [[ -n "$value" ]] || fail "falta ${key} en $env_file"
  case "$value" in
    replace-*|https://tu-proyecto.*) fail "${key} todavía contiene el valor de ejemplo" ;;
  esac
done

REPLY=''
read_env_value VITE_SUPABASE_URL
[[ "$REPLY" == https://* ]] || fail 'VITE_SUPABASE_URL debe ser una URL HTTPS accesible por los navegadores'

REPLY=''
read_env_value KPL_PILOT_CAMERA_PAGE_ORIGIN
[[ "$REPLY" == https://* ]] || fail 'KPL_PILOT_CAMERA_PAGE_ORIGIN debe usar HTTPS'

REPLY=''
read_env_value KPL_PILOT_LAN_HOST
case "$REPLY" in
  localhost|127.*|::1) fail 'KPL_PILOT_LAN_HOST debe ser la IP o el hostname LAN del PC' ;;
esac

compose=(docker compose --project-directory "$repo_dir" -f "$repo_dir/docker-compose.yml")
for source in "${env_files[@]}"; do
  compose+=(--env-file "$source")
done

# GPU access is optional. Keep the base Compose usable on hosts without devices
# or NVIDIA Container Toolkit. FFmpeg performs the actual encoding test inside
# the container; a device advertised by Docker alone is not enough.
gpu_override=''
trap 'if [[ -n "$gpu_override" ]]; then rm -f "$gpu_override"; fi' EXIT
if [[ "$action" == up || "$action" == check ]]; then
  REPLY=''
  read_env_value KPL_PILOT_GPU
  gpu_mode="${KPL_PILOT_GPU:-${REPLY:-auto}}"
  gpu_preference="$gpu_mode"
  case "$gpu_mode" in auto|nvidia|vaapi|off) ;; *) fail 'KPL_PILOT_GPU debe ser auto, nvidia, vaapi u off' ;; esac
  if [[ "$gpu_mode" == auto ]]; then
    gpu_mode=off
    nvidia_available=false
    if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
      nvidia_available=true
    elif [[ -x /usr/lib/wsl/lib/nvidia-smi ]] && /usr/lib/wsl/lib/nvidia-smi -L >/dev/null 2>&1; then
      nvidia_available=true
    fi
    if [[ "$nvidia_available" == true ]]; then
      docker_gpu_info="$(docker info --format '{{json .Runtimes}} {{.OperatingSystem}}' 2>/dev/null || true)"
      if [[ "$docker_gpu_info" == *nvidia* || "$docker_gpu_info" == *'Docker Desktop'* ]]; then
        gpu_mode=nvidia
      else
        printf 'NVIDIA detectada sin runtime Docker compatible; se comprobarán otras GPU o CPU.\n'
      fi
    fi
    if [[ "$gpu_mode" == off ]]; then
      for device in /dev/dri/renderD*; do
        if [[ -c "$device" ]]; then gpu_mode=vaapi; break; fi
      done
    fi
  fi
  if [[ "$gpu_mode" == nvidia ]]; then
    gpu_override="$(mktemp)"
    cat > "$gpu_override" <<'YAML'
services:
  kpl-pilot:
    environment:
      NVIDIA_DRIVER_CAPABILITIES: compute,video,utility
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
YAML
  fi
  # In automatic mode also expose integrated/secondary GPUs, so the runtime can
  # use VAAPI if NVIDIA is present but cannot encode the requested stream.
  if [[ "$gpu_mode" == vaapi || "$gpu_preference" == auto ]]; then
    render_devices=()
    device_groups=()
    for device in /dev/dri/renderD*; do
      [[ -c "$device" ]] || continue
      [[ "$device" =~ ^/dev/dri/renderD[0-9]+$ ]] || continue
      render_devices+=("$device")
      device_groups+=("$(stat -c '%g' "$device")")
    done
    if [[ "$gpu_mode" == vaapi && ${#render_devices[@]} -eq 0 ]]; then
      fail 'No hay dispositivos /dev/dri/renderD* para VAAPI'
    fi
    if [[ ${#render_devices[@]} -gt 0 ]]; then
      if [[ -z "$gpu_override" ]]; then
        gpu_override="$(mktemp)"
        printf 'services:\n  kpl-pilot:\n' > "$gpu_override"
      fi
      printf '    devices:\n' >> "$gpu_override"
      for device in "${render_devices[@]}"; do
        printf '      - "%s:%s"\n' "$device" "$device" >> "$gpu_override"
      done
      printf '    group_add:\n' >> "$gpu_override"
      printf '%s\n' "${device_groups[@]}" | sort -u | while read -r device_group; do
        printf '      - "%s"\n' "$device_group" >> "$gpu_override"
      done
      if [[ "$gpu_mode" == nvidia ]]; then gpu_mode=nvidia+vaapi; fi
    fi
  fi
  if [[ -n "$gpu_override" ]]; then compose+=(-f "$gpu_override"); fi
  printf 'Acceso GPU de Docker: %s. El runtime verificará la codificación antes de usarla.\n' "$gpu_mode"
fi

case "$action" in
  check)
    "${compose[@]}" config --quiet
    printf 'Configuración local de producción válida.\n'
    ;;
  up)
    "${compose[@]}" up -d --build --remove-orphans --wait --wait-timeout 180
    printf 'KPL está disponible en http://localhost:4310/admin\n'
    ;;
  down)
    "${compose[@]}" down
    ;;
  logs)
    "${compose[@]}" logs --follow --tail 200 kpl-pilot
    ;;
  *)
    fail "acción no válida: $action (usa check, up, down o logs)"
    ;;
esac
