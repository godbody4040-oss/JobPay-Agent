# JobPay Agent — runs on Render's free web service (or anywhere Docker runs).
FROM oven/bun:1-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY public ./public
# Render injects PORT; default 3000 locally.
ENV PORT=3000
EXPOSE 3000
USER bun
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1
CMD ["bun", "run", "src/index.ts"]
