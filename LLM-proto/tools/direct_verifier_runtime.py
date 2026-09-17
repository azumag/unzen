"""Shared runtime validation for direct multi-segment numerical verifiers."""

from __future__ import annotations

import math
import operator


EMPTY_TOKEN_MESSAGES = {
    "inputTokenIds": "at least one token ID is required",
    "promptTokenIds": "at least one prompt token ID is required",
}


def non_negative_int(raw: object, *, field: str) -> int:
    """Normalize one integer-like runtime value while rejecting bool/negative values."""

    if isinstance(raw, bool):
        raise ValueError(f"{field} must be a non-negative integer")
    try:
        value = operator.index(raw)
    except TypeError as error:
        raise ValueError(f"{field} must be a non-negative integer") from error
    if value < 0:
        raise ValueError(f"{field} must be a non-negative integer")
    return int(value)


def _positive_int(raw: object, *, field: str) -> int:
    value = non_negative_int(raw, field=field)
    if value <= 0:
        raise ValueError(f"{field} must be a positive integer")
    return value


def _finite_non_negative_float(raw: object, *, field: str) -> float:
    if isinstance(raw, bool):
        raise ValueError(f"{field} must be a finite non-negative number")
    try:
        value = float(raw)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{field} must be a finite non-negative number") from error
    if not math.isfinite(value) or value < 0:
        raise ValueError(f"{field} must be a finite non-negative number")
    return value


def _provider_name(raw: object) -> str:
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("provider must be a non-empty ONNX Runtime provider name")
    # Preserve the exact caller-supplied name. Availability/policy is a higher-level concern.
    return raw


def _snapshot_token_ids(raw: object, *, field: str) -> list[int]:
    """Snapshot caller-owned token input once, then validate the detached values."""

    if isinstance(raw, (str, bytes, bytearray)):
        raise ValueError(f"{field} must be an iterable of token IDs")
    try:
        snapshot = list(raw)  # type: ignore[arg-type]
    except TypeError as error:
        raise ValueError(f"{field} must be an iterable of token IDs") from error

    if not snapshot:
        raise ValueError(EMPTY_TOKEN_MESSAGES.get(field, f"at least one {field} is required"))

    return [
        non_negative_int(value, field=f"{field}[{index}]")
        for index, value in enumerate(snapshot)
    ]


def preflight_direct_verifier_parameters(
    token_ids: object,
    *,
    token_field: str,
    provider: object,
    kv_heads: object,
    head_size: object,
    atol: object,
    rtol: object,
) -> tuple[list[int], str, int, int, float, float]:
    """Validate runtime configuration before any artifact I/O or ORT session creation."""

    normalized_tokens = _snapshot_token_ids(token_ids, field=token_field)
    return (
        normalized_tokens,
        _provider_name(provider),
        _positive_int(kv_heads, field="kvHeads"),
        _positive_int(head_size, field="headSize"),
        _finite_non_negative_float(atol, field="atol"),
        _finite_non_negative_float(rtol, field="rtol"),
    )
