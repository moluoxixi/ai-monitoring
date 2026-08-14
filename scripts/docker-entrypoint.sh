#!/bin/sh
set -eu

node /app/scripts/ensure-openclaw-plugins.mjs
node /app/scripts/patch-openclaw-weixin.mjs --quiet-if-missing
exec "$@"
