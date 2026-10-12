#!/bin/sh
# Builds the private llm-client (the engine's model transport) into
# apps/agent/vendor/ so the image builds without any secret — locally or on
# Railway, which cannot mount build secrets.
#
# vendor/ must never be committed (this repo is public; llm-client is not).
# It is excluded via .git/info/exclude, which `railway up` does not read, so
# the wheel is uploaded with the build context but stays out of git.
#
# Needs: gh (authenticated with access to surus-lat/llm-client) and uv.
set -eu
LLM_CLIENT_REF="${LLM_CLIENT_REF:-d00cdbbbb63d831687942a279af9760207a51695}"
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

gh repo clone surus-lat/llm-client "$work/llm-client" -- -q
git -C "$work/llm-client" checkout -q "$LLM_CLIENT_REF"
rm -rf "$here/vendor" && mkdir -p "$here/vendor"
uv build --wheel --out-dir "$here/vendor" "$work/llm-client" >/dev/null
git -C "$here" check-ignore -q vendor/ || { echo "vendor/ is not git-ignored — refusing" >&2; exit 1; }
ls "$here/vendor"
