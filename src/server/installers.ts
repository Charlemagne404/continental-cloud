import { deflateRawSync } from 'node:zlib';

export type SyncInstallerPlatform = 'windows' | 'macos' | 'linux';

export function isSyncInstallerPlatform(value: unknown): value is SyncInstallerPlatform {
  return value === 'windows' || value === 'macos' || value === 'linux';
}

export function renderSyncInstaller(platform: SyncInstallerPlatform, serverOrigin: string, code: string): { filename: string; contentType: string; body: string | Buffer } {
  const origin = normalizeOrigin(serverOrigin);
  if (platform === 'windows') return { filename: 'Continental Cloud Sync.cmd', contentType: 'text/plain; charset=utf-8', body: windowsInstaller(origin, code) };
  if (platform === 'macos') return { filename: 'Continental Cloud Sync.zip', contentType: 'application/zip', body: zipExecutableScript('Continental Cloud Sync.command', macInstaller(origin, code)) };
  return { filename: 'continental-cloud-sync.sh', contentType: 'text/plain; charset=utf-8', body: unixInstaller(origin, code) };
}

function windowsInstaller(origin: string, code: string): string {
  return `@echo off\r\nsetlocal EnableExtensions\r\n\r\nset "SERVER_URL=${cmd(origin)}"\r\nset "PAIRING_CODE=${cmd(code)}"\r\nif "%LOCALAPPDATA%"=="" set "LOCALAPPDATA=%USERPROFILE%\\AppData\\Local"\r\nset "INSTALL_DIR=%LOCALAPPDATA%\\Continental Cloud Sync"\r\nif not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"\r\nif /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" (set "ARTIFACT=cloud-sync-win-arm64.exe") else (set "ARTIFACT=cloud-sync-win-x64.exe")\r\nset "DOWNLOAD_URL=%SERVER_URL%/downloads/%ARTIFACT%"\r\n\r\necho Downloading Continental Cloud Sync...\r\ncurl.exe --fail --location --silent --show-error --output "%INSTALL_DIR%\\cloud-sync.exe" "%DOWNLOAD_URL%"\r\nif errorlevel 1 (\r\n  echo curl was unavailable or the download failed. Trying PowerShell...\r\n  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri '%DOWNLOAD_URL%' -OutFile '%INSTALL_DIR%\\cloud-sync.exe'"\r\n)\r\nif errorlevel 1 goto :failed\r\n\r\nset "LOCAL_FOLDER=%USERPROFILE%\\Continental Cloud"\r\necho.\r\nset /p "CUSTOM_FOLDER=Local folder [press Enter for %LOCAL_FOLDER%]: "\r\nif not "%CUSTOM_FOLDER%"=="" set "LOCAL_FOLDER=%CUSTOM_FOLDER%"\r\n\r\n"%INSTALL_DIR%\\cloud-sync.exe" pair --server "%SERVER_URL%" --code "%PAIRING_CODE%" --local "%LOCAL_FOLDER%" --name "%COMPUTERNAME%"\r\nif errorlevel 1 goto :failed\r\n"%INSTALL_DIR%\\cloud-sync.exe" install\r\nif errorlevel 1 goto :failed\r\n\r\necho.\r\necho Continental Cloud Sync is installed and will start automatically when you sign in.\r\necho Your files are in "%LOCAL_FOLDER%".\r\npause\r\nexit /b 0\r\n\r\n:failed\r\necho.\r\necho Setup could not finish. The one-time pairing code may still be unused; download a fresh installer from Continental Cloud and try again.\r\npause\r\nexit /b 1\r\n`;
}

function macInstaller(origin: string, code: string): string {
  return `#!/bin/zsh\nset -e\n\nSERVER_URL=${shell(origin)}\nPAIRING_CODE=${shell(code)}\nINSTALL_DIR="$HOME/Library/Application Support/Continental Cloud Sync"\nmkdir -p "$INSTALL_DIR"\n\ncase "$(uname -m)" in\n  arm64) ARTIFACT="cloud-sync-macos-arm64" ;;\n  x86_64) ARTIFACT="cloud-sync-macos-x64" ;;\n  *) echo "This Mac architecture is not supported yet."; exit 1 ;;\nesac\n\necho "Downloading Continental Cloud Sync…"\ncurl -fL --retry 3 "$SERVER_URL/downloads/\${ARTIFACT}" -o "$INSTALL_DIR/cloud-sync"\nchmod 700 "$INSTALL_DIR/cloud-sync"\n\nDEFAULT_LOCAL="$HOME/Continental Cloud"\nprintf "Local folder [press Enter for %s]: " "$DEFAULT_LOCAL"\nread -r CUSTOM_LOCAL || true\nLOCAL_FOLDER="\${CUSTOM_LOCAL:-$DEFAULT_LOCAL}"\nDEVICE_NAME="$(scutil --get ComputerName 2>/dev/null || hostname)"\n\n"$INSTALL_DIR/cloud-sync" pair --server "$SERVER_URL" --code "$PAIRING_CODE" --local "$LOCAL_FOLDER" --name "$DEVICE_NAME"\n"$INSTALL_DIR/cloud-sync" install\n\necho\necho "Continental Cloud Sync is installed and will start automatically when you sign in."\necho "Your files are in $LOCAL_FOLDER."\nread -r _ || true\n`;
}

function unixInstaller(origin: string, code: string): string {
  const artifactPrefix = 'linux';
  return `#!/usr/bin/env bash\nset -euo pipefail\n\nSERVER_URL=${shell(origin)}\nPAIRING_CODE=${shell(code)}\nINSTALL_DIR="$HOME/.local/share/continental-cloud-sync"\nmkdir -p "$INSTALL_DIR"\n\ncase "$(uname -m)" in\n  aarch64|arm64) ARTIFACT="cloud-sync-${artifactPrefix}-arm64" ;;\n  x86_64|amd64) ARTIFACT="cloud-sync-${artifactPrefix}-x64" ;;\n  *) echo "This Linux architecture is not supported yet."; exit 1 ;;\nesac\n\necho "Downloading Continental Cloud Sync…"\ncurl -fL --retry 3 "$SERVER_URL/downloads/\${ARTIFACT}" -o "$INSTALL_DIR/cloud-sync"\nchmod 700 "$INSTALL_DIR/cloud-sync"\n\nDEFAULT_LOCAL="$HOME/Continental Cloud"\nprintf "Local folder [press Enter for %s]: " "$DEFAULT_LOCAL"\nread -r CUSTOM_LOCAL || true\nLOCAL_FOLDER="\${CUSTOM_LOCAL:-$DEFAULT_LOCAL}"\n"$INSTALL_DIR/cloud-sync" pair --server "$SERVER_URL" --code "$PAIRING_CODE" --local "$LOCAL_FOLDER" --name "$(hostname)"\n"$INSTALL_DIR/cloud-sync" install\n\necho\necho "Continental Cloud Sync is installed and running for this user."\nread -r _ || true\n`;
}

function normalizeOrigin(value: string): string {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Installer server URL must use http or https.');
  return parsed.toString().replace(/\/$/, '');
}
function shell(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function cmd(value: string): string { return value.replaceAll('"', '""'); }

function zipExecutableScript(name: string, content: string): Buffer {
  const filename = Buffer.from(name); const source = Buffer.from(content); const compressed = deflateRawSync(source); const checksum = crc32(source);
  const local = Buffer.alloc(30 + filename.length); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(8, 8); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(source.length, 22); local.writeUInt16LE(filename.length, 26); filename.copy(local, 30);
  const central = Buffer.alloc(46 + filename.length); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8); central.writeUInt16LE(8, 10); central.writeUInt32LE(checksum, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(source.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE((0o100755 * 65536) >>> 0, 38); filename.copy(central, 46);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(local.length + compressed.length, 16);
  return Buffer.concat([local, compressed, central, end]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => { let value = index; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; return value >>> 0; });
function crc32(value: Buffer): number { let checksum = 0xffffffff; for (const byte of value) checksum = CRC_TABLE[(checksum ^ byte) & 0xff] ^ (checksum >>> 8); return (checksum ^ 0xffffffff) >>> 0; }
