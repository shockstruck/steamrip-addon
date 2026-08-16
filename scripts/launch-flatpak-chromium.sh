#!/bin/sh
set -eu

app_id="org.chromium.Chromium"

if flatpak info --system "$app_id" >/dev/null 2>&1; then
  scope="--system"
elif flatpak info --user "$app_id" >/dev/null 2>&1; then
  scope="--user"
else
  printf '%s\n' "Chromium is not installed from Flathub." >&2
  exit 1
fi

exec flatpak run "$scope" --filesystem=/tmp --command=chromium "$app_id" "$@"
