FROM node:20-alpine AS base
WORKDIR /app
COPY package.json pnpm-lock.yaml* tsconfig.json ./
RUN corepack enable
RUN pnpm install --frozen-lockfile || pnpm install
COPY src ./src
RUN pnpm build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=base /app/package.json .
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/server.js"]
