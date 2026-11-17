#!/usr/bin/env bash
# Builds the site into docs/: every page, the sitemap, robots.txt, the web manifest and the icons.
# ./build.sh <dir> writes the same files somewhere else, which is how the tests check the build.
# The work is in tools/build.js. Pages are written in src/pages/.
set -euo pipefail
cd "$(dirname "$0")"
exec node tools/build.js "$@"
