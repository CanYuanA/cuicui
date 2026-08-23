# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY . .
RUN npm run check
RUN npm run build
RUN test -f dist/standalone/server.js \
 && test -f dist/standalone/node_modules/react/package.json

FROM node:24-bookworm-slim AS runtime
WORKDIR /app

LABEL org.opencontainers.image.title="cuicui"

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=build --chown=node:node /app/dist/standalone ./

USER node
EXPOSE 3000

CMD ["node", "server.js"]
