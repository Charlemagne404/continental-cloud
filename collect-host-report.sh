#!/usr/bin/env bash
# Read-only Continental Cloud host inventory.
# Run from the repository as root:
#   sudo bash collect-host-report.sh /home/charlie/continental-cloud/host-report.txt
#
# This script does not mount, format, repair, modify, install, restart, or stop
# anything. It intentionally does not print environment variables, .env files,
# Docker environment values, process command-line arguments, or private keys.

set -u
umask 077

if [[ ${EUID:-99999} -ne 0 ]]; then
  echo "Run this script with sudo: sudo bash $0 [output-file]" >&2
  exit 1
fi

ORIGINAL_USER="${SUDO_USER:-}"
if [[ -z "$ORIGINAL_USER" || "$ORIGINAL_USER" == "root" ]]; then
  ORIGINAL_USER="root"
fi

REPORT_OWNER_HOME=""
if [[ "$ORIGINAL_USER" != "root" ]]; then
  REPORT_OWNER_HOME="$(getent passwd "$ORIGINAL_USER" | awk -F: 'NR == 1 { print $6 }')"
fi
[[ -n "$REPORT_OWNER_HOME" ]] || REPORT_OWNER_HOME="/root"

DEFAULT_OUTPUT="$REPORT_OWNER_HOME/continental-cloud-host-report.txt"
OUTPUT_PATH="${1:-$DEFAULT_OUTPUT}"
OUTPUT_DIR="$(dirname -- "$OUTPUT_PATH")"

if [[ -e "$OUTPUT_PATH" ]]; then
  echo "Refusing to overwrite existing file: $OUTPUT_PATH" >&2
  exit 1
fi

mkdir -p -- "$OUTPUT_DIR"
exec 3>&1
exec >"$OUTPUT_PATH" 2>&1

run() {
  printf '\n$'
  printf ' %q' "$@"
  printf '\n'
  "$@"
  local status=$?
  if [[ $status -ne 0 ]]; then
    printf '[exit status %s]\n' "$status"
  fi
  return 0
}

run_shell() {
  local description="$1"
  local command_text="$2"
  printf '\n$ %s\n' "$description"
  bash -c "$command_text"
  local status=$?
  if [[ $status -ne 0 ]]; then
    printf '[exit status %s]\n' "$status"
  fi
  return 0
}

section() {
  printf '\n\n===== %s =====\n' "$1"
}

section "Report metadata"
run date --iso-8601=seconds
run hostname
run id
printf 'Original invoking user: %s\n' "$ORIGINAL_USER"
printf 'Report path: %s\n' "$OUTPUT_PATH"
printf 'Read-only collection: yes\n'

section "Operating system and runtime"
run uname -a
run_shell "OS release" "sed -n '1,120p' /etc/os-release"
run hostnamectl --static
run timedatectl status
run systemd-detect-virt
run nproc
run lscpu
run free -h
run uptime
run node --version
run npm --version
run_shell "Node installations" "type -a node 2>/dev/null || true; find /home /opt /usr/local -maxdepth 3 -type f -name node -executable -printf '%p %m %u:%g\\n' 2>/dev/null | sed -n '1,120p'"

section "Block devices and filesystem capacity"
run lsblk -e7 -o NAME,MODEL,SERIAL,SIZE,FSTYPE,LABEL,UUID,TYPE,MOUNTPOINTS,RO,STATE
run blkid
run findmnt -rn -o TARGET,SOURCE,FSTYPE,OPTIONS
run df -hT
run df -ih
run udisksctl status
run_shell "Mount directories and Continental markers" "ls -lad /mnt /mnt/* /media /media/* /run/media /run/media/* 2>/dev/null || true; find /mnt /media /run/media -maxdepth 4 -type d -name .continental -print 2>/dev/null | sed -n '1,120p'"
run_shell "Filesystem metadata without mounting" 'while read -r device filesystem; do case "$filesystem" in ext2|ext3|ext4) echo; echo "--- $device ($filesystem) ---"; dumpe2fs -h "$device" 2>&1 | sed -n "1,100p" ;; ntfs|ntfs3) echo; echo "--- $device ($filesystem) ---"; ntfsinfo -m "$device" 2>&1 | sed -n "1,140p" ;; esac; done < <(lsblk -rnpo NAME,FSTYPE)'
run_shell "Partition tables" 'for device in /dev/sd? /dev/nvme?n?; do [[ -b "$device" ]] || continue; echo; echo "--- $device ---"; fdisk -l "$device" 2>&1 | sed -n "1,160p"; done'

section "Disk health indicators"
if command -v smartctl >/dev/null 2>&1; then
  while read -r device kind; do
    [[ "$kind" == "disk" ]] || continue
    printf '\n--- SMART %s ---\n' "$device"
    smartctl -H -i "$device" 2>&1 | sed -n '1,140p'
  done < <(lsblk -dnpo NAME,TYPE)
else
  echo "smartctl is not installed."
fi
if command -v nvme >/dev/null 2>&1; then
  while read -r device kind; do
    [[ "$kind" == "disk" && "$device" == /dev/nvme* ]] || continue
    printf '\n--- NVMe SMART %s ---\n' "$device"
    nvme smart-log "$device" 2>&1 | sed -n '1,140p'
  done < <(lsblk -dnpo NAME,TYPE)
fi
run sensors

section "Storage paths and permissions"
run stat -c '%n %F %a %U:%G %s bytes' /mnt /mnt/hdd-ubuntu /home/charlie/continental-cloud 2>&1
run_shell "Relevant path permissions" 'for path in /mnt/continental-cloud /mnt/hdd-ubuntu /home/charlie/continental-cloud/storage /home/charlie/continental-cloud/.env /home/charlie/continental-cloud/.env.example; do if [[ -e "$path" || -L "$path" ]]; then stat -c "%n %F %a %U:%G %s bytes" "$path"; else echo "$path: absent"; fi; done'
run_shell "Repository and nearby disk usage" "du -xsh /home/charlie/continental-cloud /home/charlie /var/lib/docker /var/www 2>/dev/null | sort -h | tail -40"
run_shell "Possible encrypted block devices" "lsblk -o NAME,TYPE,FSTYPE,MOUNTPOINTS | grep -Ei 'crypt| luks|dm-' || true; ls /dev/mapper 2>/dev/null || true"

section "Network addresses, listeners, and firewall"
run ip -br addr
run ip route
run ss -lntup
run ufw status verbose
run_shell "nftables ruleset, first 500 lines" "nft list ruleset 2>&1 | sed -n '1,500p'"
run_shell "iptables rules, first 300 lines" "iptables -S 2>&1 | sed -n '1,300p'"
run_shell "IPv4 forwarding settings" "sysctl net.ipv4.ip_forward net.ipv6.conf.all.forwarding net.ipv4.conf.all.rp_filter 2>&1"

section "Tailscale"
run tailscale version
run tailscale ip -4
run tailscale status
run tailscale serve status
run tailscale funnel status
run tailscale netcheck

section "System services and scheduled work"
run systemctl --failed --no-legend
run systemctl list-units --type=service --state=running --no-legend
run systemctl list-timers --all --no-legend
run_shell "Selected service state" 'for unit in caddy tailscaled docker netdata; do echo; echo "--- $unit ---"; systemctl is-enabled "$unit" 2>&1 || true; systemctl is-active "$unit" 2>&1 || true; systemctl show "$unit" -p User -p Restart -p NoNewPrivileges -p ProtectSystem -p ReadWritePaths 2>&1 || true; done'
run loginctl show-user "$ORIGINAL_USER" -p Linger -p State -p Sessions
if [[ "$ORIGINAL_USER" != "root" ]]; then
  run runuser -u "$ORIGINAL_USER" -- systemctl --user list-unit-files --state=enabled --no-legend
  run runuser -u "$ORIGINAL_USER" -- systemctl --user list-timers --all --no-legend
fi

section "Running processes and current local HTTP services"
run ps -eo pid,user,etimes,comm --sort=pid
run_shell "Local HTTP HEAD checks" 'for port in 8787 8788 8789 8790; do echo; echo "--- http://127.0.0.1:$port/ ---"; curl -sS -I --max-time 4 "http://127.0.0.1:$port/" 2>&1 | sed -n "1,20p" || true; done'

section "Caddy configuration summary"
if [[ -f /etc/caddy/Caddyfile ]]; then
  run caddy version
  run caddy validate --config /etc/caddy/Caddyfile
  run_shell "Caddy site labels" "grep -nE '^[^[:space:]#].*\\{|^[[:space:]]*(reverse_proxy|bind|tls|redir|route|handle|file_server|respond)' /etc/caddy/Caddyfile | sed -n '1,300p'"
  run_shell "Caddy routing directives" "grep -nE 'reverse_proxy|bind|tls|redir|route|handle|file_server|respond' /etc/caddy/Caddyfile | sed -n '1,300p'"
else
  echo "/etc/caddy/Caddyfile is absent."
fi

section "Docker summary"
run docker version
run docker info --format 'ServerVersion={{.ServerVersion}}\nDockerRootDir={{.DockerRootDir}}\nNCPU={{.NCPU}}\nMemTotal={{.MemTotal}}\n'
run docker ps --format 'table {{.ID}}\t{{.Image}}\t{{.Ports}}\t{{.Names}}'
if [[ -f /home/charlie/continental-cloud/docker-compose.yml ]]; then
  run_shell "Continental Cloud compose status" "cd /home/charlie/continental-cloud && docker compose ps 2>&1"
fi

section "Continental Cloud repository"
if [[ -d /home/charlie/continental-cloud/.git ]]; then
  run git -C /home/charlie/continental-cloud status --short --branch
  run git -C /home/charlie/continental-cloud log -8 --oneline --decorate
  run git -C /home/charlie/continental-cloud diff --stat
fi
run_shell "Tracked top-level files" "find /home/charlie/continental-cloud -maxdepth 2 -type f -not -path '*/.git/*' -not -path '*/node_modules/*' -printf '%P %m %u:%g %s bytes\\n' | sort | sed -n '1,260p'"
run_shell "Project configuration without secrets" "sed -n '1,220p' /home/charlie/continental-cloud/package.json; echo; sed -n '1,180p' /home/charlie/continental-cloud/docker-compose.yml; echo; sed -n '1,180p' /home/charlie/continental-cloud/Dockerfile"
run_shell "Environment file inventory only" "find /home/charlie/continental-cloud -maxdepth 1 -type f -name '.env*' -printf '%f %m %u:%g %s bytes\\n' | sort"
run_shell "Project dependency/build state" 'if [[ -d /home/charlie/continental-cloud/node_modules ]]; then du -sh /home/charlie/continental-cloud/node_modules; else echo "node_modules absent"; fi; if [[ -d /home/charlie/continental-cloud/dist ]]; then du -sh /home/charlie/continental-cloud/dist; else echo "dist absent"; fi;'

section "Security-sensitive values intentionally omitted"
cat <<'EOF'
The report does not include:
- Environment variables or .env contents
- Docker container environment values
- Process command-line arguments
- Private keys, certificates, tokens, cookies, or Tailscale state files
- Full application logs
- Any mount, format, repair, package-install, service-restart, or write operation
EOF

printf '\n===== End of report =====\n'

chmod 0640 "$OUTPUT_PATH"
if [[ "$ORIGINAL_USER" != "root" ]]; then
  ORIGINAL_GROUP="$(id -gn "$ORIGINAL_USER" 2>/dev/null || true)"
  if [[ -n "$ORIGINAL_GROUP" ]]; then
    chown "$ORIGINAL_USER:$ORIGINAL_GROUP" "$OUTPUT_PATH" 2>/dev/null || true
  fi
fi

printf 'Report written to %s\n' "$OUTPUT_PATH" >&3
exec 3>&-
