FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM ghcr.io/yourok/torrserver:MatriX.141.1
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies /usr/local/bin/node /usr/local/bin/node
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY assets ./assets
USER 1000
EXPOSE 7000
CMD ["node", "dist/index.js"]
