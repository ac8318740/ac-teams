#!/bin/sh
set -eu

HOME=$(mktemp -d)
export HOME
unset PI_CODING_AGENT_DIR
trap 'rm -rf -- "$HOME"' EXIT

if [ "$#" -eq 0 ]; then set -- test/*.test.ts; fi
node --experimental-strip-types --test "$@"
