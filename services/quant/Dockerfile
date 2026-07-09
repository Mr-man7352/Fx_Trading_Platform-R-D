# QN-005 — Quant service image: FastAPI :5001 + gRPC :50051, TA-Lib C lib baked in.
# Build from REPO ROOT (same convention as all Dockerfiles here):
#   docker build -f services/quant/Dockerfile .
# The Python TA-Lib wheel (Phase 2, QN-04x) links against the C lib staged here.

ARG PYTHON_VERSION=3.13
ARG TALIB_VERSION=0.6.4
ARG UV_VERSION=0.11.19

# --- Stage 1: build the TA-Lib C library -------------------------------------
FROM python:${PYTHON_VERSION}-slim AS talib-build
ARG TALIB_VERSION
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential wget ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN wget -q "https://github.com/ta-lib/ta-lib/releases/download/v${TALIB_VERSION}/ta-lib-${TALIB_VERSION}-src.tar.gz" \
 && tar -xzf "ta-lib-${TALIB_VERSION}-src.tar.gz" \
 && cd "ta-lib-${TALIB_VERSION}" \
 && ./configure --prefix=/usr/local \
 && make -j"$(nproc)" \
 && make install

# --- Stage 2: install Python deps with uv ------------------------------------
FROM python:${PYTHON_VERSION}-slim AS deps
ARG UV_VERSION
RUN pip install --no-cache-dir "uv==${UV_VERSION}"
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
# Lockfile + workspace member first for layer caching; app code changes
# shouldn't re-resolve dependencies.
COPY services/quant/pyproject.toml services/quant/uv.lock ./
COPY services/quant/libs ./libs
RUN uv sync --frozen --no-dev --no-install-project
COPY services/quant/app ./app
RUN uv sync --frozen --no-dev

# --- Stage 3: runtime ---------------------------------------------------------
FROM python:${PYTHON_VERSION}-slim
ARG GIT_COMMIT=dev
ENV PYTHONUNBUFFERED=1 \
    GIT_COMMIT=${GIT_COMMIT} \
    PATH="/app/.venv/bin:${PATH}"
# libgomp1 = OpenMP runtime required by LightGBM's native lib (libgomp.so.1).
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=talib-build /usr/local/lib/libta-lib* /usr/local/lib/
COPY --from=talib-build /usr/local/include/ta-lib /usr/local/include/ta-lib
RUN ldconfig
WORKDIR /app
# fx-common is installed editable from /app/libs — copy to the same path.
COPY --from=deps /app/.venv ./.venv
COPY services/quant/libs ./libs
COPY services/quant/app ./app

EXPOSE 5001 50051
# Same healthcheck contract as the Step 1.2 stub (port moved 5000 → 5001).
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5001/healthz')" || exit 1

CMD ["python", "-m", "app"]
