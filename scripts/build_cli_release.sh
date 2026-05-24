#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEFAULT_LINK_PATH="/Users/kongweixian/bin/eidolon-cli"

usage() {
  cat <<'EOF'
Build the Eidolon CLI binary and link it to a user-facing command.

Usage:
  ./scripts/build_cli_release.sh [options]

Options:
  --link-path PATH     Override the symlink/install path (default: /Users/kongweixian/bin/eidolon-cli).
  --no-link            Only build the binary and skip the install/link step.
  --verify             Run the linked binary with --help after linking.
  --help               Show this help text.
EOF
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

require_cmd bun

link_path="${DEFAULT_LINK_PATH}"
skip_link=0
verify_link=0

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --link-path)
      [[ "$#" -ge 2 ]] || die "--link-path requires a value"
      link_path="$2"
      shift 2
      ;;
    --no-link)
      skip_link=1
      shift
      ;;
    --verify)
      verify_link=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "Unknown argument: $1"
      ;;
  esac
done

cd "${REPO_ROOT}"

printf 'Building Eidolon CLI binary via bun...\n'
bun run build:terminal:cli

if [[ "${skip_link}" -eq 1 ]]; then
  printf 'Build complete. Skipped install/link step.\n'
  exit 0
fi

printf 'Linking binary to %s\n' "${link_path}"
bun run scripts/install-dist-cli.ts --target-path "${link_path}"

if [[ "${verify_link}" -eq 1 ]]; then
  printf 'Verifying launcher via %s --help\n' "${link_path}"
  "${link_path}" --help >/dev/null
  printf 'Launcher self-check passed\n'
fi
