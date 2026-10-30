#!/usr/bin/env bash
# Check the actual .deb contents without installation, systemd, or user data.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEB="${1:?usage: check-deb.sh path/to/package.deb}"
command -v dpkg-deb >/dev/null || { echo 'dpkg-deb is required' >&2; exit 1; }
CHECK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/violoop-mem-ov-deb.XXXXXX")"
trap 'rm -rf "$CHECK_DIR"' EXIT
# Maintainer scripts are deliberately not executed.
dpkg-deb --extract "$DEB" "$CHECK_DIR/root"
python3 "$SCRIPT_DIR/test-package.py" --app-root "$CHECK_DIR/root/opt/violoop-mem-ov" --python "$(command -v python3)"
