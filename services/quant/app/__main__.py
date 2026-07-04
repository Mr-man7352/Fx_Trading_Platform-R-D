"""`python -m app` — run uvicorn honouring QUANT_PORT (QN-001)."""

import uvicorn

from app.config import get_settings


def main() -> None:
    settings = get_settings()
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=settings.quant_port,
        log_config=None,  # fx_common JSON logging owns handlers
    )


if __name__ == "__main__":
    main()
