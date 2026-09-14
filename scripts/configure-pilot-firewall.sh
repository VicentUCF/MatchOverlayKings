#!/usr/bin/env bash

set -euo pipefail

readonly DEFAULT_LAN_CIDR="192.168.68.0/22"
readonly LAN_CIDR="${1:-$DEFAULT_LAN_CIDR}"

if [[ ! "$LAN_CIDR" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/([0-9]|[12][0-9]|3[0-2])$ ]]; then
  echo "CIDR IPv4 no valido: $LAN_CIDR" >&2
  echo "Uso: $0 [CIDR_LAN]" >&2
  exit 64
fi

if (( EUID != 0 )); then
  exec sudo -- "$0" "$LAN_CIDR"
fi

if ! command -v ufw >/dev/null 2>&1; then
  echo "UFW no esta instalado. Instala ufw o configura reglas equivalentes en el firewall del equipo." >&2
  exit 69
fi

echo "Autorizando el piloto KPL solo desde $LAN_CIDR..."
ufw allow from "$LAN_CIDR" to any port 4310 proto tcp comment "KPL piloto web"
ufw allow from "$LAN_CIDR" to any port 8889 proto tcp comment "KPL piloto WHIP-WHEP"
ufw allow from "$LAN_CIDR" to any port 8189 proto udp comment "KPL piloto WebRTC ICE"

echo
if ufw status | grep -q '^Status: inactive'; then
  echo "Las reglas se han guardado, pero UFW esta inactivo. No se ha activado automaticamente."
  echo "Revisa primero el acceso SSH y, si procede, ejecuta: sudo ufw enable"
else
  echo "Reglas activas:"
  ufw status
fi
