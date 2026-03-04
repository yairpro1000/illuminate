#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dist_dir="${root_dir}/dist"

rm -rf "${dist_dir}"
mkdir -p "${dist_dir}"

shopt -s nullglob

# Copy top-level html + optional Pages config files
cp -f "${root_dir}"/*.html "${dist_dir}/"
for f in _redirects _headers _routes.json CNAME; do
  if [[ -f "${root_dir}/${f}" ]]; then
    cp -f "${root_dir}/${f}" "${dist_dir}/"
  fi
done

# Copy site asset folders (if present)
for d in css js img; do
  if [[ -d "${root_dir}/${d}" ]]; then
    cp -R "${root_dir}/${d}" "${dist_dir}/"
  fi
done

# Copy simple admin landing (static)
if [[ -d "${root_dir}/admin" ]]; then
  cp -R "${root_dir}/admin" "${dist_dir}/"
fi

echo "Built ${dist_dir}"
