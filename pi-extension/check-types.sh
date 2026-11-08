#!/usr/bin/env bash
# Type-check pi-cost.ts against Pi's real declarations.
#
# Two things this machine-locks away, because both were hard-coded before and broke
# everywhere except the one box they were written on:
#
#   1. Where Pi lives. The package with the extension API types is not a dependency of
#      this repo — it is Pi's own install. The script reads the version Pi marks current
#      (~/.pi/agent/install/current-version, overridable with PI_AGENT_DIR) and points
#      the paths mapping at that release, so a Pi upgrade follows on its own.
#   2. Where tsc comes from. TypeScript is not installed here either; the script finds
#      tsc on PATH, in a local or parent node_modules, or in the Pi install's own
#      node_modules.
#
# Usage: ./check-types.sh
#        PI_AGENT_DIR=/path/to/.pi/agent ./check-types.sh

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
agent_dir="${PI_AGENT_DIR:-${HOME}/.pi/agent}"

# 1. Resolve the Pi package that carries the extension API types.
version_file="${agent_dir}/install/current-version"
if [[ ! -f "${version_file}" ]]; then
  echo "check-types: no Pi install found at ${agent_dir} (set PI_AGENT_DIR to point at one)" >&2
  exit 1
fi
version="$(tr -d '[:space:]' < "${version_file}")"
types_entry="${agent_dir}/install/releases/${version}/node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts"
if [[ ! -f "${types_entry}" ]]; then
  echo "check-types: Pi ${version} is current but declares no types at ${types_entry}" >&2
  exit 1
fi

# 2. Find tsc: PATH, then the usual node_modules walks, then the Pi install's own.
if command -v tsc > /dev/null 2>&1; then
  tsc="$(command -v tsc)"
elif [[ -x "${here}/node_modules/.bin/tsc" ]]; then
  tsc="${here}/node_modules/.bin/tsc"
elif [[ -x "${here}/../node_modules/.bin/tsc" ]]; then
  tsc="${here}/../node_modules/.bin/tsc"
elif [[ -x "${HOME}/node_modules/.bin/tsc" ]]; then
  tsc="${HOME}/node_modules/.bin/tsc"
elif [[ -x "${agent_dir}/install/releases/${version}/node_modules/.bin/tsc" ]]; then
  tsc="${agent_dir}/install/releases/${version}/node_modules/.bin/tsc"
else
  echo "check-types: tsc not found on PATH or in any node_modules this script knows" >&2
  echo "check-types: install a TypeScript 5.5+ and run again" >&2
  exit 1
fi

# 3. Extend the dialect with the one fact this machine owns: where the types live.
#    The temp file sits next to the real tsconfig, so its include paths resolve the
#    same way, and it is removed whichever way the compiler exits.
temp_config="${here}/tsconfig.check-types.json"
cleanup() { rm -f "${temp_config}"; }
trap cleanup EXIT

node -e '
  const [file, dialect, entry] = process.argv.slice(1);
  const config = JSON.parse(require("fs").readFileSync(dialect, "utf8"));
  delete config.$comment;
  config.compilerOptions.paths = { "@earendil-works/pi-coding-agent": [entry] };
  require("fs").writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
' "${temp_config}" "${here}/tsconfig.json" "${types_entry}"

echo "check-types: ${tsc}"
echo "check-types: Pi types  ${types_entry}"
"${tsc}" --project "${temp_config}"
echo "check-types: no errors"
