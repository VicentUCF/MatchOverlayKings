#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${KPL_LOCAL_PRODUCTION_ENV:-$repo_dir/.env.pilot.docker}"
web_env_file="$repo_dir/apps/web/.env"
action="${1:-check}"

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

compose=(docker compose --project-directory "$repo_dir")
for source in "${env_files[@]}"; do
  compose+=(--env-file "$source")
done

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
