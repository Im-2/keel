# Keel backend (bot + API + keeper) as a container, for any host that runs Docker (Hugging Face Spaces, Koyeb, Fly,
# a second Render workspace...). Secrets are NOT baked in: pass them as the host's environment variables.
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate && pnpm install --frozen-lockfile --filter @keel/bot...
ENV NODE_ENV=production PORT=7860 NETWORK=testnet DB_PATH=/tmp/keel.sqlite
EXPOSE 7860
USER node
CMD ["sh", "-c", "cd bot && ./node_modules/.bin/tsx src/index.ts"]
