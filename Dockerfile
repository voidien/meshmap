# syntax=docker/dockerfile:1

# ---- 1. Rust -> WASM (link engine for the browser) ----------------------------
FROM rust:1-bookworm AS wasm
RUN rustup target add wasm32-unknown-unknown \
 && cargo install wasm-bindgen-cli --version 0.2.100 --locked
WORKDIR /src
COPY Cargo.toml Cargo.lock* ./
COPY crates ./crates
# run the math tests (including ITM vs the NTIA reference) in the build so a broken core never ships
RUN cargo test -p meshmap-core -p meshmap-itm -p meshmap-coverage --release
RUN cargo build --release --target wasm32-unknown-unknown -p meshmap-wasm \
 && wasm-bindgen --target web --out-dir /out target/wasm32-unknown-unknown/release/meshmap_wasm.wasm

# ---- 2. Web build ------------------------------------------------------------
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
COPY --from=wasm /out ./src/wasm/pkg
RUN npm test && npm run build

# ---- 3. Server -----------------------------------------------------------------
FROM rust:1-bookworm AS server
WORKDIR /src
COPY Cargo.toml Cargo.lock* ./
COPY crates ./crates
RUN cargo test -p meshmap-server --release \
 && cargo build --release -p meshmap-server

# ---- 4. Runtime: one small process serving the app and the API -----------------------------
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends libssl3 ca-certificates util-linux \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home-dir /app --shell /usr/sbin/nologin meshmap
WORKDIR /app
COPY --from=server /src/target/release/meshmap-server /app/meshmap-server
COPY --from=web /web/dist /app/web
COPY deploy/entrypoint.sh /app/entrypoint.sh
# the documentation shown under Help in the app
COPY README.md /app/doc/README.md
COPY docs/ARCHITECTURE.md docs/validation.md /app/doc/docs/
COPY tools/etl/README.md /app/doc/tools/etl/README.md
ENV MESHMAP_DATA_DIR=/app/data MESHMAP_STATIC_DIR=/app/web MESHMAP_DOCS_DIR=/app/doc PORT=8080 RUST_LOG=info
VOLUME /app/data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["/app/meshmap-server", "healthcheck"]
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["/app/meshmap-server"]
