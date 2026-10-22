# syntax=docker/dockerfile:1

# ---- 1. Rust -> WASM -------------------------------------------------------
FROM rust:1-bookworm AS wasm
RUN rustup target add wasm32-unknown-unknown \
 && cargo install wasm-bindgen-cli --version 0.2.100 --locked
WORKDIR /src
COPY Cargo.toml Cargo.lock* ./
COPY crates ./crates
# run the math tests in the build so a broken core never ships
RUN cargo test -p meshmap-core --release
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

# ---- 3. Static server (non-root, listens on 8080) ----------------------------
FROM nginxinc/nginx-unprivileged:stable-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web /web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
