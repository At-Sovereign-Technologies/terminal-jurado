# syntax=docker/dockerfile:1

FROM node:20-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

FROM deps AS ui-build
WORKDIR /app

COPY . .

ARG VITE_SIDECAR_URL=http://localhost:8089
ENV VITE_SIDECAR_URL=${VITE_SIDECAR_URL}

RUN npm run build

FROM nginx:1.27-alpine AS ui
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=ui-build /app/dist /usr/share/nginx/html
EXPOSE 80

FROM deps AS sidecar
WORKDIR /app

COPY . .

ENV NODE_ENV=production
EXPOSE 8089 8090 8087

CMD ["npm", "run", "sidecar"]
