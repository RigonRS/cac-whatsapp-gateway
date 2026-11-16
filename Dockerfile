FROM node:20-bookworm-slim

# Ferramentas para compilar o better-sqlite3, caso não haja binário pronto,
# e o Python + pdfplumber do extrator de documentos (extrator/extrair_documentos.py)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip make g++ git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --no-cache-dir --break-system-packages pdfplumber==0.11.10

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .
RUN mkdir -p data

EXPOSE 3000
CMD ["node", "server.js"]
