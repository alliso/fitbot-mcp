# ---- build ----
FROM node:22-alpine AS build
WORKDIR /app

# Instala dependencias (incl. dev) sin ejecutar el script "prepare" (compilamos a mano).
COPY package*.json ./
RUN npm ci --ignore-scripts

# Compila TypeScript -> dist/
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Solo dependencias de producción, sin scripts.
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Código compilado.
COPY --from=build /app/dist ./dist

# Modo HTTP por defecto, escuchando en todas las interfaces del contenedor.
ENV MCP_TRANSPORT=http \
    HOST=0.0.0.0 \
    PORT=8000
EXPOSE 8000

# Ejecuta como usuario no root (su HOME /home/node es escribible para el fingerprint).
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "dist/index.js", "--http"]
