# Frontend image: build the Vite app, serve it with nginx, and reverse-proxy the API and
# both WebSocket endpoints to the backend (the app talks same-origin). The backend target
# is set at runtime via the BACKEND_URL env var (default: http://backend:3001).

# --- build stage ---
FROM node:20 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Generic build — no feature flags baked in; the UI fetches them at runtime from /api/config.
RUN npm run build

# --- runtime stage ---
FROM nginx:alpine
# nginx config is rendered from a template at start so BACKEND_URL can be injected.
COPY nginx/default.conf.template /etc/nginx/templates-src/default.conf.template
COPY nginx/entrypoint.sh /docker-entrypoint.d/40-render-backend.sh
RUN chmod +x /docker-entrypoint.d/40-render-backend.sh
COPY --from=build /app/dist /usr/share/nginx/html

ENV BACKEND_URL=http://backend:3001
EXPOSE 80
# Base nginx:alpine entrypoint runs everything in /docker-entrypoint.d then starts nginx.
