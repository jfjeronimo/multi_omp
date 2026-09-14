# multi-omp runs on Bun (pure TypeScript, no compile step).
#
# The image is a runtime only (Bun + non-root user + data dir). The code — and
# its node_modules — is bind-mounted from the host over /app, so source edits
# never require rebuilding the image (see docker-compose.example.yaml /
# portainer-stack.example.yml).
#
#   host  /opt/multi_omp/app  ->  container  /app   (src/, package.json, node_modules/)
#
# One-time prerequisite on the host: `bun install` inside app/ so the mount
# carries a populated node_modules (gitignored, never in the image).
FROM oven/bun:1.2

# Non-root user; data dir lives outside the image.
ENV HOME=/home/multiomp \
    MULTI_OMP_HOME=/data \
    MULTI_OMP_HOST=0.0.0.0 \
    MULTI_OMP_PORT=30140
RUN mkdir -p /data && chown -R 1000:1000 /data
USER 1000

# Gateway/dashboard on 30140; per-node listeners on 30200-30299.
EXPOSE 30140 30200-30299

# /app is provided by the host mount; entrypoint runs from it.
WORKDIR /app
ENTRYPOINT ["bun", "run", "src/index.ts"]
