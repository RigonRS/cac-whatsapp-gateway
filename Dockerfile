FROM node:20-bookworm-slim

# Ferramentas para compilar o better-sqlite3, caso não haja binário pronto
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .
RUN mkdir -p data

EXPOSE 3000
CMD ["node", "server.js"]
