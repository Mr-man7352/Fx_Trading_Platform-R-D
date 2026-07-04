import datetime

from google.protobuf import timestamp_pb2 as _timestamp_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Mapping as _Mapping
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
    __slots__ = ("instrument", "side", "probability", "regime", "model_version")
    INSTRUMENT_FIELD_NUMBER: _ClassVar[int]
    SIDE_FIELD_NUMBER: _ClassVar[int]
    PROBABILITY_FIELD_NUMBER: _ClassVar[int]
    REGIME_FIELD_NUMBER: _ClassVar[int]
    MODEL_VERSION_FIELD_NUMBER: _ClassVar[int]
    instrument: str
    side: TradeSide
    probability: float
    regime: str
    model_version: str
    def __init__(self, instrument: _Optional[str] = ..., side: _Optional[_Union[TradeSide, str]] = ..., probability: _Optional[float] = ..., regime: _Optional[str] = ..., model_version: _Optional[str] = ...) -> None: ...

class RunPipelineResponse(_message.Message):
    __slots__ = ("features", "has_candidate", "candidate")
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
    features: _containers.ScalarMap[str, float]
    has_candidate: bool
    candidate: Candidate
    def __init__(self, features: _Optional[_Mapping[str, float]] = ..., has_candidate: _Optional[bool] = ..., candidate: _Optional[_Union[Candidate, _Mapping]] = ...) -> None: ...

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
    __slots__ = ("units", "calibrated_probability", "target_volatility", "sizing_model_version")
    UNITS_FIELD_NUMBER: _ClassVar[int]
    CALIBRATED_PROBABILITY_FIELD_NUMBER: _ClassVar[int]
    TARGET_VOLATILITY_FIELD_NUMBER: _ClassVar[int]
    SIZING_MODEL_VERSION_FIELD_NUMBER: _ClassVar[int]
    units: float
    calibrated_probability: float
    target_volatility: float
    sizing_model_version: str
    def __init__(self, units: _Optional[float] = ..., calibrated_probability: _Optional[float] = ..., target_volatility: _Optional[float] = ..., sizing_model_version: _Optional[str] = ...) -> None: ...

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
