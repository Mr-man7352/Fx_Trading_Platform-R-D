"""QuantService servicer (QN-004 — definitions only in Step 1.5).

Every RPC aborts with UNIMPLEMENTED until its Phase-2 story lands:
Predict → QN-042, SizePosition → QN-043, RunPipeline → QN-046.
The Node caller's circuit breaker (BE-068) treats these as failures → HOLD.
"""

from __future__ import annotations

from typing import NoReturn

import grpc

from app.proto_gen import quant_pb2, quant_pb2_grpc


async def _unimplemented(context: grpc.aio.ServicerContext, story: str) -> NoReturn:
    await context.abort(
        grpc.StatusCode.UNIMPLEMENTED,
        f"Defined in Step 1.5 (QN-004); implementation lands in Phase 2 ({story})",
    )
    raise AssertionError("unreachable")  # abort always raises


class QuantServicer(quant_pb2_grpc.QuantServiceServicer):
    """Stub servicer — shape is final, behaviour arrives in Phase 2."""

    async def RunPipeline(
        self,
        request: quant_pb2.RunPipelineRequest,
        context: grpc.aio.ServicerContext,
    ) -> quant_pb2.RunPipelineResponse:
        await _unimplemented(context, "QN-046")

    async def SizePosition(
        self,
        request: quant_pb2.SizePositionRequest,
        context: grpc.aio.ServicerContext,
    ) -> quant_pb2.SizePositionResponse:
        await _unimplemented(context, "QN-043")

    async def Predict(
        self,
        request: quant_pb2.PredictRequest,
        context: grpc.aio.ServicerContext,
    ) -> quant_pb2.PredictResponse:
        await _unimplemented(context, "QN-042")
