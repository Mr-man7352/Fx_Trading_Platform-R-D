import datetime

from google.protobuf import timestamp_pb2 as _timestamp_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class Timeframe(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    TIMEFRAME_UNSPECIFIED: _ClassVar[Timeframe]
    TIMEFRAME_M1: _ClassVar[Timeframe]
    TIMEFRAME_M5: _ClassVar[Timeframe]
    TIMEFRAME_M15: _ClassVar[Timeframe]
    TIMEFRAME_M30: _ClassVar[Timeframe]
    TIMEFRAME_H1: _ClassVar[Timeframe]
    TIMEFRAME_H4: _ClassVar[Timeframe]
    TIMEFRAME_D1: _ClassVar[Timeframe]

class TradeSide(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    TRADE_SIDE_UNSPECIFIED: _ClassVar[TradeSide]
    TRADE_SIDE_LONG: _ClassVar[TradeSide]
    TRADE_SIDE_SHORT: _ClassVar[TradeSide]

class ExecutionStatus(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    EXECUTION_STATUS_UNSPECIFIED: _ClassVar[ExecutionStatus]
    EXECUTION_STATUS_FILLED: _ClassVar[ExecutionStatus]
    EXECUTION_STATUS_PARTIAL: _ClassVar[ExecutionStatus]
    EXECUTION_STATUS_REJECTED: _ClassVar[ExecutionStatus]
TIMEFRAME_UNSPECIFIED: Timeframe
TIMEFRAME_M1: Timeframe
TIMEFRAME_M5: Timeframe
TIMEFRAME_M15: Timeframe
TIMEFRAME_M30: Timeframe
TIMEFRAME_H1: Timeframe
TIMEFRAME_H4: Timeframe
TIMEFRAME_D1: Timeframe
TRADE_SIDE_UNSPECIFIED: TradeSide
TRADE_SIDE_LONG: TradeSide
TRADE_SIDE_SHORT: TradeSide
EXECUTION_STATUS_UNSPECIFIED: ExecutionStatus
EXECUTION_STATUS_FILLED: ExecutionStatus
EXECUTION_STATUS_PARTIAL: ExecutionStatus
EXECUTION_STATUS_REJECTED: ExecutionStatus

class RunPipelineRequest(_message.Message):
    __slots__ = ("instrument", "timeframe", "bar_ts")
    INSTRUMENT_FIELD_NUMBER: _ClassVar[int]
    TIMEFRAME_FIELD_NUMBER: _ClassVar[int]
    BAR_TS_FIELD_NUMBER: _ClassVar[int]
    instrument: str
    timeframe: Timeframe
    bar_ts: _timestamp_pb2.Timestamp
    def __init__(self, instrument: _Optional[str] = ..., timeframe: _Optional[_Union[Timeframe, str]] = ..., bar_ts: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ...) -> None: ...

class Candidate(_message.Message):
    __slots__ = ("instrument", "side", "probability", "regime", "model_version", "entry_price", "stop_loss_price", "take_profit_price")
    INSTRUMENT_FIELD_NUMBER: _ClassVar[int]
    SIDE_FIELD_NUMBER: _ClassVar[int]
    PROBABILITY_FIELD_NUMBER: _ClassVar[int]
    REGIME_FIELD_NUMBER: _ClassVar[int]
    MODEL_VERSION_FIELD_NUMBER: _ClassVar[int]
    ENTRY_PRICE_FIELD_NUMBER: _ClassVar[int]
    STOP_LOSS_PRICE_FIELD_NUMBER: _ClassVar[int]
    TAKE_PROFIT_PRICE_FIELD_NUMBER: _ClassVar[int]
    instrument: str
    side: TradeSide
    probability: float
    regime: str
    model_version: str
    entry_price: float
    stop_loss_price: float
    take_profit_price: float
    def __init__(self, instrument: _Optional[str] = ..., side: _Optional[_Union[TradeSide, str]] = ..., probability: _Optional[float] = ..., regime: _Optional[str] = ..., model_version: _Optional[str] = ..., entry_price: _Optional[float] = ..., stop_loss_price: _Optional[float] = ..., take_profit_price: _Optional[float] = ...) -> None: ...

class RunPipelineResponse(_message.Message):
    __slots__ = ("features", "has_candidate", "candidate", "session_label", "liquidity_regime", "trend_regime", "regime_entropy", "debate_rounds", "feature_set_version", "challenger_probability")
    class FeaturesEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: float
        def __init__(self, key: _Optional[str] = ..., value: _Optional[float] = ...) -> None: ...
    FEATURES_FIELD_NUMBER: _ClassVar[int]
    HAS_CANDIDATE_FIELD_NUMBER: _ClassVar[int]
    CANDIDATE_FIELD_NUMBER: _ClassVar[int]
    SESSION_LABEL_FIELD_NUMBER: _ClassVar[int]
    LIQUIDITY_REGIME_FIELD_NUMBER: _ClassVar[int]
    TREND_REGIME_FIELD_NUMBER: _ClassVar[int]
    REGIME_ENTROPY_FIELD_NUMBER: _ClassVar[int]
    DEBATE_ROUNDS_FIELD_NUMBER: _ClassVar[int]
    FEATURE_SET_VERSION_FIELD_NUMBER: _ClassVar[int]
    CHALLENGER_PROBABILITY_FIELD_NUMBER: _ClassVar[int]
    features: _containers.ScalarMap[str, float]
    has_candidate: bool
    candidate: Candidate
    session_label: str
    liquidity_regime: str
    trend_regime: str
    regime_entropy: float
    debate_rounds: int
    feature_set_version: int
    challenger_probability: float
    def __init__(self, features: _Optional[_Mapping[str, float]] = ..., has_candidate: _Optional[bool] = ..., candidate: _Optional[_Union[Candidate, _Mapping]] = ..., session_label: _Optional[str] = ..., liquidity_regime: _Optional[str] = ..., trend_regime: _Optional[str] = ..., regime_entropy: _Optional[float] = ..., debate_rounds: _Optional[int] = ..., feature_set_version: _Optional[int] = ..., challenger_probability: _Optional[float] = ...) -> None: ...

class SizePositionRequest(_message.Message):
    __slots__ = ("instrument", "side", "probability", "account_equity", "entry_price", "stop_loss_price")
    INSTRUMENT_FIELD_NUMBER: _ClassVar[int]
    SIDE_FIELD_NUMBER: _ClassVar[int]
    PROBABILITY_FIELD_NUMBER: _ClassVar[int]
    ACCOUNT_EQUITY_FIELD_NUMBER: _ClassVar[int]
    ENTRY_PRICE_FIELD_NUMBER: _ClassVar[int]
    STOP_LOSS_PRICE_FIELD_NUMBER: _ClassVar[int]
    instrument: str
    side: TradeSide
    probability: float
    account_equity: float
    entry_price: float
    stop_loss_price: float
    def __init__(self, instrument: _Optional[str] = ..., side: _Optional[_Union[TradeSide, str]] = ..., probability: _Optional[float] = ..., account_equity: _Optional[float] = ..., entry_price: _Optional[float] = ..., stop_loss_price: _Optional[float] = ...) -> None: ...

class SizePositionResponse(_message.Message):
    __slots__ = ("units", "calibrated_probability", "target_volatility", "sizing_model_version", "risk_amount", "caps_applied", "prob_scale")
    UNITS_FIELD_NUMBER: _ClassVar[int]
    CALIBRATED_PROBABILITY_FIELD_NUMBER: _ClassVar[int]
    TARGET_VOLATILITY_FIELD_NUMBER: _ClassVar[int]
    SIZING_MODEL_VERSION_FIELD_NUMBER: _ClassVar[int]
    RISK_AMOUNT_FIELD_NUMBER: _ClassVar[int]
    CAPS_APPLIED_FIELD_NUMBER: _ClassVar[int]
    PROB_SCALE_FIELD_NUMBER: _ClassVar[int]
    units: float
    calibrated_probability: float
    target_volatility: float
    sizing_model_version: str
    risk_amount: float
    caps_applied: _containers.RepeatedScalarFieldContainer[str]
    prob_scale: float
    def __init__(self, units: _Optional[float] = ..., calibrated_probability: _Optional[float] = ..., target_volatility: _Optional[float] = ..., sizing_model_version: _Optional[str] = ..., risk_amount: _Optional[float] = ..., caps_applied: _Optional[_Iterable[str]] = ..., prob_scale: _Optional[float] = ...) -> None: ...

class PredictRequest(_message.Message):
    __slots__ = ("instrument", "timeframe", "bar_ts", "features")
    class FeaturesEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: float
        def __init__(self, key: _Optional[str] = ..., value: _Optional[float] = ...) -> None: ...
    INSTRUMENT_FIELD_NUMBER: _ClassVar[int]
    TIMEFRAME_FIELD_NUMBER: _ClassVar[int]
    BAR_TS_FIELD_NUMBER: _ClassVar[int]
    FEATURES_FIELD_NUMBER: _ClassVar[int]
    instrument: str
    timeframe: Timeframe
    bar_ts: _timestamp_pb2.Timestamp
    features: _containers.ScalarMap[str, float]
    def __init__(self, instrument: _Optional[str] = ..., timeframe: _Optional[_Union[Timeframe, str]] = ..., bar_ts: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., features: _Optional[_Mapping[str, float]] = ...) -> None: ...

class PredictResponse(_message.Message):
    __slots__ = ("probability", "calibration_method", "model_version", "trained_at")
    PROBABILITY_FIELD_NUMBER: _ClassVar[int]
    CALIBRATION_METHOD_FIELD_NUMBER: _ClassVar[int]
    MODEL_VERSION_FIELD_NUMBER: _ClassVar[int]
    TRAINED_AT_FIELD_NUMBER: _ClassVar[int]
    probability: float
    calibration_method: str
    model_version: str
    trained_at: _timestamp_pb2.Timestamp
    def __init__(self, probability: _Optional[float] = ..., calibration_method: _Optional[str] = ..., model_version: _Optional[str] = ..., trained_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ...) -> None: ...

class PlaceOrderRequest(_message.Message):
    __slots__ = ("client_order_id", "instrument", "side", "units", "stop_loss_price", "take_profit_price")
    CLIENT_ORDER_ID_FIELD_NUMBER: _ClassVar[int]
    INSTRUMENT_FIELD_NUMBER: _ClassVar[int]
    SIDE_FIELD_NUMBER: _ClassVar[int]
    UNITS_FIELD_NUMBER: _ClassVar[int]
    STOP_LOSS_PRICE_FIELD_NUMBER: _ClassVar[int]
    TAKE_PROFIT_PRICE_FIELD_NUMBER: _ClassVar[int]
    client_order_id: str
    instrument: str
    side: TradeSide
    units: float
    stop_loss_price: float
    take_profit_price: float
    def __init__(self, client_order_id: _Optional[str] = ..., instrument: _Optional[str] = ..., side: _Optional[_Union[TradeSide, str]] = ..., units: _Optional[float] = ..., stop_loss_price: _Optional[float] = ..., take_profit_price: _Optional[float] = ...) -> None: ...

class PlaceOrderResponse(_message.Message):
    __slots__ = ("status", "broker", "broker_order_id", "broker_trade_id", "requested_units", "filled_units", "remainder_units", "fill_price", "reason_code")
    STATUS_FIELD_NUMBER: _ClassVar[int]
    BROKER_FIELD_NUMBER: _ClassVar[int]
    BROKER_ORDER_ID_FIELD_NUMBER: _ClassVar[int]
    BROKER_TRADE_ID_FIELD_NUMBER: _ClassVar[int]
    REQUESTED_UNITS_FIELD_NUMBER: _ClassVar[int]
    FILLED_UNITS_FIELD_NUMBER: _ClassVar[int]
    REMAINDER_UNITS_FIELD_NUMBER: _ClassVar[int]
    FILL_PRICE_FIELD_NUMBER: _ClassVar[int]
    REASON_CODE_FIELD_NUMBER: _ClassVar[int]
    status: ExecutionStatus
    broker: str
    broker_order_id: str
    broker_trade_id: str
    requested_units: float
    filled_units: float
    remainder_units: float
    fill_price: float
    reason_code: str
    def __init__(self, status: _Optional[_Union[ExecutionStatus, str]] = ..., broker: _Optional[str] = ..., broker_order_id: _Optional[str] = ..., broker_trade_id: _Optional[str] = ..., requested_units: _Optional[float] = ..., filled_units: _Optional[float] = ..., remainder_units: _Optional[float] = ..., fill_price: _Optional[float] = ..., reason_code: _Optional[str] = ...) -> None: ...

class CloseTradeRequest(_message.Message):
    __slots__ = ("broker_trade_id", "units")
    BROKER_TRADE_ID_FIELD_NUMBER: _ClassVar[int]
    UNITS_FIELD_NUMBER: _ClassVar[int]
    broker_trade_id: str
    units: float
    def __init__(self, broker_trade_id: _Optional[str] = ..., units: _Optional[float] = ...) -> None: ...

class CloseTradeResponse(_message.Message):
    __slots__ = ("status", "broker_order_id", "filled_units", "fill_price", "reason_code")
    STATUS_FIELD_NUMBER: _ClassVar[int]
    BROKER_ORDER_ID_FIELD_NUMBER: _ClassVar[int]
    FILLED_UNITS_FIELD_NUMBER: _ClassVar[int]
    FILL_PRICE_FIELD_NUMBER: _ClassVar[int]
    REASON_CODE_FIELD_NUMBER: _ClassVar[int]
    status: ExecutionStatus
    broker_order_id: str
    filled_units: float
    fill_price: float
    reason_code: str
    def __init__(self, status: _Optional[_Union[ExecutionStatus, str]] = ..., broker_order_id: _Optional[str] = ..., filled_units: _Optional[float] = ..., fill_price: _Optional[float] = ..., reason_code: _Optional[str] = ...) -> None: ...

class ModifyTradeRequest(_message.Message):
    __slots__ = ("broker_trade_id", "stop_loss_price", "take_profit_price")
    BROKER_TRADE_ID_FIELD_NUMBER: _ClassVar[int]
    STOP_LOSS_PRICE_FIELD_NUMBER: _ClassVar[int]
    TAKE_PROFIT_PRICE_FIELD_NUMBER: _ClassVar[int]
    broker_trade_id: str
    stop_loss_price: float
    take_profit_price: float
    def __init__(self, broker_trade_id: _Optional[str] = ..., stop_loss_price: _Optional[float] = ..., take_profit_price: _Optional[float] = ...) -> None: ...

class ModifyTradeResponse(_message.Message):
    __slots__ = ("status", "reason_code")
    STATUS_FIELD_NUMBER: _ClassVar[int]
    REASON_CODE_FIELD_NUMBER: _ClassVar[int]
    status: ExecutionStatus
    reason_code: str
    def __init__(self, status: _Optional[_Union[ExecutionStatus, str]] = ..., reason_code: _Optional[str] = ...) -> None: ...

class ListOpenPositionsRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class BrokerPositionMsg(_message.Message):
    __slots__ = ("instrument", "side", "units", "avg_price", "unrealized_pl", "broker_trade_ids")
    INSTRUMENT_FIELD_NUMBER: _ClassVar[int]
    SIDE_FIELD_NUMBER: _ClassVar[int]
    UNITS_FIELD_NUMBER: _ClassVar[int]
    AVG_PRICE_FIELD_NUMBER: _ClassVar[int]
    UNREALIZED_PL_FIELD_NUMBER: _ClassVar[int]
    BROKER_TRADE_IDS_FIELD_NUMBER: _ClassVar[int]
    instrument: str
    side: TradeSide
    units: float
    avg_price: float
    unrealized_pl: float
    broker_trade_ids: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, instrument: _Optional[str] = ..., side: _Optional[_Union[TradeSide, str]] = ..., units: _Optional[float] = ..., avg_price: _Optional[float] = ..., unrealized_pl: _Optional[float] = ..., broker_trade_ids: _Optional[_Iterable[str]] = ...) -> None: ...

class ListOpenPositionsResponse(_message.Message):
    __slots__ = ("positions",)
    POSITIONS_FIELD_NUMBER: _ClassVar[int]
    positions: _containers.RepeatedCompositeFieldContainer[BrokerPositionMsg]
    def __init__(self, positions: _Optional[_Iterable[_Union[BrokerPositionMsg, _Mapping]]] = ...) -> None: ...

class GetTransactionsRequest(_message.Message):
    __slots__ = ("since_txn_id",)
    SINCE_TXN_ID_FIELD_NUMBER: _ClassVar[int]
    since_txn_id: str
    def __init__(self, since_txn_id: _Optional[str] = ...) -> None: ...

class TradeReduceMsg(_message.Message):
    __slots__ = ("trade_id", "units", "price", "realized_pl", "financing")
    TRADE_ID_FIELD_NUMBER: _ClassVar[int]
    UNITS_FIELD_NUMBER: _ClassVar[int]
    PRICE_FIELD_NUMBER: _ClassVar[int]
    REALIZED_PL_FIELD_NUMBER: _ClassVar[int]
    FINANCING_FIELD_NUMBER: _ClassVar[int]
    trade_id: str
    units: float
    price: float
    realized_pl: float
    financing: float
    def __init__(self, trade_id: _Optional[str] = ..., units: _Optional[float] = ..., price: _Optional[float] = ..., realized_pl: _Optional[float] = ..., financing: _Optional[float] = ...) -> None: ...

class BrokerTransactionMsg(_message.Message):
    __slots__ = ("id", "type", "instrument", "trade_id", "units", "price", "pl", "financing", "commission", "client_order_id", "time", "reason", "trade_opened_id", "trades_closed", "trade_reduced")
    ID_FIELD_NUMBER: _ClassVar[int]
    TYPE_FIELD_NUMBER: _ClassVar[int]
    INSTRUMENT_FIELD_NUMBER: _ClassVar[int]
    TRADE_ID_FIELD_NUMBER: _ClassVar[int]
    UNITS_FIELD_NUMBER: _ClassVar[int]
    PRICE_FIELD_NUMBER: _ClassVar[int]
    PL_FIELD_NUMBER: _ClassVar[int]
    FINANCING_FIELD_NUMBER: _ClassVar[int]
    COMMISSION_FIELD_NUMBER: _ClassVar[int]
    CLIENT_ORDER_ID_FIELD_NUMBER: _ClassVar[int]
    TIME_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    TRADE_OPENED_ID_FIELD_NUMBER: _ClassVar[int]
    TRADES_CLOSED_FIELD_NUMBER: _ClassVar[int]
    TRADE_REDUCED_FIELD_NUMBER: _ClassVar[int]
    id: str
    type: str
    instrument: str
    trade_id: str
    units: float
    price: float
    pl: float
    financing: float
    commission: float
    client_order_id: str
    time: _timestamp_pb2.Timestamp
    reason: str
    trade_opened_id: str
    trades_closed: _containers.RepeatedCompositeFieldContainer[TradeReduceMsg]
    trade_reduced: TradeReduceMsg
    def __init__(self, id: _Optional[str] = ..., type: _Optional[str] = ..., instrument: _Optional[str] = ..., trade_id: _Optional[str] = ..., units: _Optional[float] = ..., price: _Optional[float] = ..., pl: _Optional[float] = ..., financing: _Optional[float] = ..., commission: _Optional[float] = ..., client_order_id: _Optional[str] = ..., time: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., reason: _Optional[str] = ..., trade_opened_id: _Optional[str] = ..., trades_closed: _Optional[_Iterable[_Union[TradeReduceMsg, _Mapping]]] = ..., trade_reduced: _Optional[_Union[TradeReduceMsg, _Mapping]] = ...) -> None: ...

class GetTransactionsResponse(_message.Message):
    __slots__ = ("transactions", "last_txn_id")
    TRANSACTIONS_FIELD_NUMBER: _ClassVar[int]
    LAST_TXN_ID_FIELD_NUMBER: _ClassVar[int]
    transactions: _containers.RepeatedCompositeFieldContainer[BrokerTransactionMsg]
    last_txn_id: str
    def __init__(self, transactions: _Optional[_Iterable[_Union[BrokerTransactionMsg, _Mapping]]] = ..., last_txn_id: _Optional[str] = ...) -> None: ...
