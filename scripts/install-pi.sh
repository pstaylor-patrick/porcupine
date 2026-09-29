#!/usr/bin/env bash
# Installs the pinned pi version per user under ~/.local. Never touches system paths.
set -euo pipefail

PI_VERSION="0.99.1"
PI_PACKAGE="@earendil-works/pi-coding-agent"
PREFIX="${HOME}/.local"
BIN="${PREFIX}/bin/pi"

mkdir -p "${PREFIX}/bin"

# An older standalone install may own ~/.local/bin/pi as a symlink outside the
# npm prefix. Move it aside so npm can create its own link.
if [ -L "${BIN}" ]; then
  target="$(readlink -f "${BIN}")"
  case "${target}" in
    "${PREFIX}/lib/node_modules/"*) ;;
    *)
      echo "moving existing ${BIN} -> ${target} aside to ${BIN}.pre-${PI_VERSION}"
      mv "${BIN}" "${BIN}.pre-${PI_VERSION}"
      ;;
  esac
fi

npm install --global --prefix "${PREFIX}" "${PI_PACKAGE}@${PI_VERSION}"

actual="$("${BIN}" --version)"
echo "${BIN} --version: ${actual}"
case "${actual}" in
  *"${PI_VERSION}"*) ;;
  *) echo "expected pi ${PI_VERSION}, got ${actual}" >&2; exit 1 ;;
esac
