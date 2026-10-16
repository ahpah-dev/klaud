#!/usr/bin/env bash
# ---------------------------------------------------------------
#  Klaud launcher (macOS / Linux)
# ---------------------------------------------------------------
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js is required but was not found on your PATH."
  echo "  Install it from https://nodejs.org (LTS is fine) and try again."
  echo
  exit 1
fi

cd "$(dirname "$0")"
echo
echo "  Starting Klaud..."
exec node src/server.js --open
