# Backend image: Node + Express, serves the API and both WebSocket endpoints.
# Generic image — no secrets baked in. Runtime config/secrets come from the deploy
# (env / env_file); the Agent (MCP) mode needs no AWS/GCP creds.
FROM node:20-slim

WORKDIR /app

# Install deps first (better layer caching). Only package manifests change here.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source (.dockerignore keeps secrets/state/node_modules out).
COPY . .

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

CMD ["node", "index.js"]
