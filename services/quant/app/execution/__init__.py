"""Step 2.1 — broker abstraction & execution adapters (QN-030…034).

- `adapter`     — QN-030 typed BrokerAdapter protocol + error taxonomy
- `models`      — order/fill/position/history runtime models (mirror @fx/types broker.ts)
- `symbols`     — QN-033 per-broker symbol mapping (seeded by the instrument registry)
- `sizing`      — QN-034 cross-currency pip/lot/margin module
- `oanda_adapter` — QN-032 OANDA v20 execution adapter (SOLE venue, ADR-005;
  the optional MT5 adapter QN-031 was dropped 2026-07-06)
- `credentials` — BE-131 envelope decrypt (v1 AES-256-GCM) + DB loader
"""

from app.execution.adapter import BrokerAdapter, BrokerError, OrderRejectedError
from app.execution.models import (
    BrokerPosition,
    BrokerTradeRecord,
    OrderRequest,
    OrderResult,
    OrderSide,
    OrderStatus,
)

__all__ = [
    "BrokerAdapter",
    "BrokerError",
    "BrokerPosition",
    "BrokerTradeRecord",
    "OrderRejectedError",
    "OrderRequest",
    "OrderResult",
    "OrderSide",
    "OrderStatus",
]
