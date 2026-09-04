FROM node:22-alpine AS build
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build

FROM nginx:1.27-alpine AS runtime
COPY docker-nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/attend-fe/browser /usr/share/nginx/html

EXPOSE 80
