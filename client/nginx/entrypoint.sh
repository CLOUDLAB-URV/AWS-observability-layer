#!/bin/sh
# Render the nginx site config, substituting ${BACKEND_URL} only (leave nginx's own
# $variables intact). Runs via /docker-entrypoint.d before nginx starts.
set -e
envsubst '${BACKEND_URL}' \
    < /etc/nginx/templates-src/default.conf.template \
    > /etc/nginx/conf.d/default.conf
echo "[entrypoint] proxying /api and /ws* to ${BACKEND_URL}"
