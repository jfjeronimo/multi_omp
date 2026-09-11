# multi-omp runs on Bun (pure TypeScript, no compile step).
FROM oven/bun:1.2

WORKDIR /app

# devDependencies only (typescript + @types/bun); no production deps exist.
COPY package.json tsconfig.json ./
RUN bun install

COPY src ./src

# Non-root user; data dir lives outside the image.
ENV HOME=/home/multiomp \
    MULTI_OMP_HOME=/data \
    MULTI_OMP_HOST=0.0.0.0 \
    MULTI_OMP_PORT=30140
RUN mkdir -p /data && chown -R 1000:1000 /data /app
USER 1000

# Gateway/dashboard on 30140; per-node listeners on 30200-30299.
EXPOSE 30140 30200-30299

ENTRYPOINT ["bun", "run", "src/index.ts"]
