#!/usr/bin/env python3
"""Independently verify diagnostic endpoint payload materialization evidence.

This helper checks an existing ``materialize_endpoint_payload_chunks.py`` report,
its payload directory, and the pinned source external-data file against an explicit
probe stage/tier selection. The verifier owns a pinned copy of the diagnostic
contract and deterministically re-derives the expected source-byte blueprint and
provenance instead of importing producer-side derivation helpers. It then re-hashes
the source, each source byte range, and every payload. The result remains
diagnostic-only and does not approve a browser cache, manifest, loader, or runtime
design for #223.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
from typing import Iterable


REPORT_KIND = "unzen-endpoint-source-payload-materialization-verification"
REPORT_SCHEMA_VERSION = "1.1.0"
BASE_REPORT_SCHEMA_VERSION = "1.0.0"
EXPECTED_MATERIALIZATION_KIND = "unzen-endpoint-source-payload-materialization"
EXPECTED_MATERIALIZATION_SCHEMA_VERSION = "1.1.0"
DEFAULT_COPY_BUFFER_BYTES = 8 * 1024 * 1024
EXPECTED_PROBE_KIND = "unzen-pinned-llama-1b-endpoint-chunk-envelope-probe"
EXPECTED_PROBE_SCHEMA_VERSION = "1.2.0"
EXPECTED_SOURCE_GRAPH_SHA256 = (
    "a3a6f10916f79379d15cfa9270b7be0d09be2b80fe0872bd7030eaf9001baf46"
)
EXPECTED_SOURCE_LOCATION = "model_q4.onnx_data"
EXPECTED_SOURCE_BYTES = 1_692_672_000
EXPECTED_SOURCE_SHA256 = (
    "07cc629ef2cb7fdb18615ce2e4f3774f763e6fc840207d772a8b511eead36647"
)
EXPECTED_ROWS = 128_256
EXPECTED_ROW_BYTES = 8_192
EXPECTED_SOURCE_OFFSET_BYTES = 0
EXPECTED_STAGE_RESIDUAL_BYTES = {
    "embedding-prefix": 500,
    "logits-postfix": 9_554,
}
EXPECTED_TIER_LIMIT_BYTES = {
    "preferred": 268_435_456,
    "normal": 536_870_912,
    "absolute": 1_073_741_824,
}
EXPECTED_STAGE_TIER_PAYLOAD_COUNTS = {
    "embedding-prefix": {"preferred": 4, "normal": 2, "absolute": 1},
    "logits-postfix": {"preferred": 4, "normal": 2, "absolute": 1},
}


def _required_dict(value: object, *, field: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise RuntimeError(f"{field} must be an object")
    return value


def _required_list(value: object, *, field: str) -> list[object]:
    if not isinstance(value, list):
        raise RuntimeError(f"{field} must be an array")
    return value


def _required_int(value: object, *, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise RuntimeError(f"{field} must be an integer")
    return value


def _required_str(value: object, *, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise RuntimeError(f"{field} must be a non-empty string")
    return value


def _normalized_sha256(value: object, *, field: str) -> str:
    digest = _required_str(value, field=field).lower()
    if len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
        raise RuntimeError(f"{field} must be a 64-character SHA-256 hex digest")
    return digest


def _load_json_with_sha256(path: Path) -> tuple[dict[str, object], str]:
    raw = path.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError(f"invalid UTF-8 JSON report: {path}") from error
    if not isinstance(value, dict):
        raise RuntimeError(f"report root must be an object: {path}")
    return value, digest


def _file_stat_signature(stat_result: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        stat_result.st_dev,
        stat_result.st_ino,
        stat_result.st_size,
        stat_result.st_mtime_ns,
        stat_result.st_ctime_ns,
    )


def _require_stable_file_signature(
    observed: tuple[int, int, int, int, int],
    expected: tuple[int, int, int, int, int],
    *,
    path: Path,
) -> None:
    if observed != expected:
        raise RuntimeError(f"file snapshot changed during verification: {path}")


def _sha256_file(
    path: Path,
    *,
    buffer_bytes: int = DEFAULT_COPY_BUFFER_BYTES,
    expected_stat_signature: tuple[int, int, int, int, int] | None = None,
) -> str:
    if buffer_bytes <= 0:
        raise ValueError("buffer_bytes must be positive")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        before_signature = _file_stat_signature(os.fstat(stream.fileno()))
        if expected_stat_signature is not None:
            _require_stable_file_signature(
                before_signature, expected_stat_signature, path=path
            )
        while True:
            block = stream.read(buffer_bytes)
            if not block:
                break
            digest.update(block)
        after_signature = _file_stat_signature(os.fstat(stream.fileno()))
    _require_stable_file_signature(after_signature, before_signature, path=path)
    if expected_stat_signature is not None:
        _require_stable_file_signature(
            after_signature, expected_stat_signature, path=path
        )
    return digest.hexdigest()


def _canonical_json_sha256(value: object) -> str:
    rendered = json.dumps(
        value,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(rendered).hexdigest()


def _expected_pinned_tier_budget(*, stage_kind: str, tier: str) -> dict[str, object]:
    """Independently derive the pinned budget envelope for one stage/tier."""

    stage_tiers = EXPECTED_STAGE_TIER_PAYLOAD_COUNTS.get(stage_kind)
    residual_bytes = EXPECTED_STAGE_RESIDUAL_BYTES.get(stage_kind)
    limit_bytes = EXPECTED_TIER_LIMIT_BYTES.get(tier)
    if (
        stage_tiers is None
        or residual_bytes is None
        or limit_bytes is None
        or tier not in stage_tiers
    ):
        raise RuntimeError(f"unsupported pinned diagnostic stage/tier: {stage_kind}/{tier}")

    payload_capacity_bytes = limit_bytes - residual_bytes
    maximum_rows = payload_capacity_bytes // EXPECTED_ROW_BYTES
    if maximum_rows <= 0:
        raise RuntimeError(
            f"pinned diagnostic tier leaves no room for one row: {stage_kind}/{tier}"
        )
    minimum_payload_count = (EXPECTED_ROWS + maximum_rows - 1) // maximum_rows
    if minimum_payload_count != stage_tiers[tier]:
        raise RuntimeError(
            "verifier-owned pinned payload count is inconsistent with the independently "
            "derived tier budget: "
            f"{stage_kind}/{tier}"
        )
    balanced_maximum_rows = (
        EXPECTED_ROWS + minimum_payload_count - 1
    ) // minimum_payload_count
    balanced_maximum_payload_bytes = balanced_maximum_rows * EXPECTED_ROW_BYTES
    conservative_maximum_artifact_bytes = (
        balanced_maximum_payload_bytes + residual_bytes
    )
    remaining_headroom_bytes = limit_bytes - conservative_maximum_artifact_bytes
    if remaining_headroom_bytes < 0:
        raise RuntimeError(f"pinned diagnostic tier budget is infeasible: {stage_kind}/{tier}")

    return {
        "limitBytes": limit_bytes,
        "maximumWholeRowsPerArtifact": maximum_rows,
        "minimumPayloadCount": minimum_payload_count,
        "balancedMaximumRows": balanced_maximum_rows,
        "balancedMaximumPayloadBytes": balanced_maximum_payload_bytes,
        "conservativeMaximumArtifactBytes": conservative_maximum_artifact_bytes,
        "remainingHeadroomBytes": remaining_headroom_bytes,
        "feasible": True,
    }


def _expected_pinned_source_payload_chunks(
    *, stage_kind: str, tier: str
) -> list[dict[str, object]]:
    """Return the verifier-owned source-byte blueprint for the pinned graph contract."""

    stage_tiers = EXPECTED_STAGE_TIER_PAYLOAD_COUNTS.get(stage_kind)
    if stage_tiers is None or tier not in stage_tiers:
        raise RuntimeError(f"unsupported pinned diagnostic stage/tier: {stage_kind}/{tier}")
    payload_count = stage_tiers[tier]
    smaller_rows, larger_chunk_count = divmod(EXPECTED_ROWS, payload_count)
    row_cursor = 0
    chunks: list[dict[str, object]] = []
    for chunk_index in range(payload_count):
        row_count = smaller_rows + (1 if chunk_index < larger_chunk_count else 0)
        source_offset = EXPECTED_SOURCE_OFFSET_BYTES + row_cursor * EXPECTED_ROW_BYTES
        payload_bytes = row_count * EXPECTED_ROW_BYTES
        chunks.append(
            {
                "chunkIndex": chunk_index,
                "startRow": row_cursor,
                "endRowExclusive": row_cursor + row_count,
                "rowCount": row_count,
                "sourceLocation": EXPECTED_SOURCE_LOCATION,
                "sourceOffsetBytes": source_offset,
                "sourceEndOffsetBytesExclusive": source_offset + payload_bytes,
                "payloadBytes": payload_bytes,
            }
        )
        row_cursor += row_count
    return chunks


def _source_identity_from_probe_report(report: dict[str, object]) -> dict[str, object]:
    """Validate the pinned probe contract using verifier-owned constants."""

    expected_scalars = {
        "kind": EXPECTED_PROBE_KIND,
        "schemaVersion": EXPECTED_PROBE_SCHEMA_VERSION,
        "status": "pass",
        "decisionStatus": "diagnostic-only",
        "sourceGraphSha256": EXPECTED_SOURCE_GRAPH_SHA256,
    }
    for field, expected in expected_scalars.items():
        observed = report.get(field)
        if observed != expected:
            raise RuntimeError(
                f"probe report identity mismatch for {field}: "
                f"expected={expected!r}, observed={observed!r}"
            )

    identity = _required_dict(
        report.get("pinnedSourceExternalDataIdentity"),
        field="pinnedSourceExternalDataIdentity",
    )
    observed_identity = {
        "location": _required_str(
            identity.get("location"), field="pinnedSourceExternalDataIdentity.location"
        ),
        "bytes": _required_int(
            identity.get("bytes"), field="pinnedSourceExternalDataIdentity.bytes"
        ),
        "sha256": _normalized_sha256(
            identity.get("sha256"), field="pinnedSourceExternalDataIdentity.sha256"
        ),
    }
    expected_identity: dict[str, object] = {
        "location": EXPECTED_SOURCE_LOCATION,
        "bytes": EXPECTED_SOURCE_BYTES,
        "sha256": EXPECTED_SOURCE_SHA256,
    }
    if observed_identity != expected_identity:
        raise RuntimeError(
            "probe report pinned external-data identity mismatch: "
            f"expected={expected_identity!r}, observed={observed_identity!r}"
        )
    return observed_identity


def _chunks_from_probe_report(
    report: dict[str, object],
    *,
    stage_kind: str,
    tier: str,
) -> list[dict[str, object]]:
    """Validate a probe selection against the verifier-owned deterministic blueprint."""

    _source_identity_from_probe_report(report)
    envelopes = _required_dict(report.get("endpointChunkEnvelope"), field="endpointChunkEnvelope")
    stage = _required_dict(envelopes.get(stage_kind), field=f"endpointChunkEnvelope.{stage_kind}")
    tiers = _required_dict(stage.get("tiers"), field=f"endpointChunkEnvelope.{stage_kind}.tiers")
    selected = _required_dict(tiers.get(tier), field=f"endpointChunkEnvelope.{stage_kind}.tiers.{tier}")
    expected_budget = _expected_pinned_tier_budget(stage_kind=stage_kind, tier=tier)
    for field, expected in expected_budget.items():
        observed = selected.get(field)
        if observed != expected:
            raise RuntimeError(
                "probe report tier budget does not match the verifier-owned pinned budget: "
                f"{stage_kind}/{tier}.{field}: expected={expected!r}, observed={observed!r}"
            )

    expected_stage_fields = {
        "rows": EXPECTED_ROWS,
        "rowBytes": EXPECTED_ROW_BYTES,
        "largestRangeBytes": EXPECTED_ROWS * EXPECTED_ROW_BYTES,
        "sourceLocation": EXPECTED_SOURCE_LOCATION,
        "sourceOffsetBytes": EXPECTED_SOURCE_OFFSET_BYTES,
        "sourceStageResidualBytes": EXPECTED_STAGE_RESIDUAL_BYTES[stage_kind],
    }
    for field, expected in expected_stage_fields.items():
        observed = stage.get(field)
        if observed != expected:
            raise RuntimeError(
                "probe report stage envelope does not match the verifier-owned pinned budget: "
                f"{stage_kind}.{field}: expected={expected!r}, observed={observed!r}"
            )

    chunks = [
        _required_dict(item, field=f"chunk[{index}]")
        for index, item in enumerate(
            _required_list(
                selected.get("balancedSourcePayloadChunks"),
                field=f"endpointChunkEnvelope.{stage_kind}.tiers.{tier}.balancedSourcePayloadChunks",
            )
        )
    ]
    expected_chunks = _expected_pinned_source_payload_chunks(stage_kind=stage_kind, tier=tier)
    if chunks != expected_chunks:
        raise RuntimeError(
            "probe report balancedSourcePayloadChunks does not match the verifier-owned pinned blueprint: "
            f"{stage_kind}/{tier}"
        )
    return chunks


def _materialization_provenance_from_probe_report(
    report: dict[str, object],
    *,
    stage_kind: str,
    tier: str,
    chunks: Iterable[dict[str, object]],
) -> dict[str, object]:
    """Reconstruct producer provenance from verifier-owned pinned expectations."""

    normalized_chunks = list(chunks)
    selected_chunks = _chunks_from_probe_report(
        report,
        stage_kind=stage_kind,
        tier=tier,
    )
    if normalized_chunks != selected_chunks:
        raise RuntimeError(
            "verification chunks do not match the selected pinned probe blueprint: "
            f"{stage_kind}/{tier}"
        )
    source_identity = _source_identity_from_probe_report(report)
    return {
        "probeKind": EXPECTED_PROBE_KIND,
        "probeSchemaVersion": EXPECTED_PROBE_SCHEMA_VERSION,
        "sourceGraphSha256": EXPECTED_SOURCE_GRAPH_SHA256,
        "stageKind": stage_kind,
        "tier": tier,
        "blueprintSha256": _canonical_json_sha256(selected_chunks),
        "sourceExternalDataIdentity": source_identity,
    }


def _validate_source_payload_chunks(
    chunks: Iterable[dict[str, object]],
) -> tuple[list[dict[str, object]], str, int, int]:
    """Validate row/source contiguity without producer-side validation helpers."""

    normalized = list(chunks)
    if not normalized:
        raise RuntimeError("chunk blueprint must not be empty")

    expected_row = 0
    expected_source_offset: int | None = None
    expected_row_bytes: int | None = None
    source_location: str | None = None
    coverage_start: int | None = None

    for expected_index, chunk in enumerate(normalized):
        chunk_index = _required_int(chunk.get("chunkIndex"), field=f"chunk[{expected_index}].chunkIndex")
        start_row = _required_int(chunk.get("startRow"), field=f"chunk[{expected_index}].startRow")
        end_row = _required_int(
            chunk.get("endRowExclusive"), field=f"chunk[{expected_index}].endRowExclusive"
        )
        row_count = _required_int(chunk.get("rowCount"), field=f"chunk[{expected_index}].rowCount")
        location = _required_str(
            chunk.get("sourceLocation"), field=f"chunk[{expected_index}].sourceLocation"
        )
        source_offset = _required_int(
            chunk.get("sourceOffsetBytes"), field=f"chunk[{expected_index}].sourceOffsetBytes"
        )
        source_end = _required_int(
            chunk.get("sourceEndOffsetBytesExclusive"),
            field=f"chunk[{expected_index}].sourceEndOffsetBytesExclusive",
        )
        payload_bytes = _required_int(
            chunk.get("payloadBytes"), field=f"chunk[{expected_index}].payloadBytes"
        )

        location_path = PurePosixPath(location.replace("\\", "/"))
        if location_path.is_absolute() or ".." in location_path.parts:
            raise RuntimeError(f"unsafe source location in chunk blueprint: {location}")
        if chunk_index != expected_index:
            raise RuntimeError(
                f"chunkIndex must be contiguous from zero: expected={expected_index}, observed={chunk_index}"
            )
        if start_row != expected_row:
            raise RuntimeError(
                f"row coverage must be contiguous: expected startRow={expected_row}, observed={start_row}"
            )
        if end_row <= start_row or row_count != end_row - start_row:
            raise RuntimeError(f"invalid row coverage in chunk[{expected_index}]")
        if source_offset < 0 or source_end <= source_offset:
            raise RuntimeError(f"invalid source byte range in chunk[{expected_index}]")
        if payload_bytes != source_end - source_offset:
            raise RuntimeError(f"payloadBytes does not match source byte range in chunk[{expected_index}]")
        if payload_bytes % row_count != 0:
            raise RuntimeError(f"payloadBytes is not divisible by rowCount in chunk[{expected_index}]")
        row_bytes = payload_bytes // row_count
        if row_bytes <= 0:
            raise RuntimeError(f"row byte width must be positive in chunk[{expected_index}]")
        if expected_row_bytes is None:
            expected_row_bytes = row_bytes
        elif row_bytes != expected_row_bytes:
            raise RuntimeError(
                "row byte width must remain constant across chunks: "
                f"expected={expected_row_bytes}, observed={row_bytes}"
            )

        if source_location is None:
            source_location = location
            coverage_start = source_offset
            expected_source_offset = source_offset
        elif location != source_location:
            raise RuntimeError("all chunks must reference the same sourceLocation")

        assert expected_source_offset is not None
        if source_offset != expected_source_offset:
            raise RuntimeError(
                "source byte coverage must be contiguous: "
                f"expected offset={expected_source_offset}, observed={source_offset}"
            )

        expected_row = end_row
        expected_source_offset = source_end

    assert source_location is not None
    assert coverage_start is not None
    assert expected_source_offset is not None
    return normalized, source_location, coverage_start, expected_source_offset


def _expected_payload_names(payload_count: int) -> list[str]:
    return [f"payload-{index:04d}.bin" for index in range(payload_count)]


def _sha256_file_range(
    path: Path,
    *,
    source_offset: int,
    payload_bytes: int,
    buffer_bytes: int,
    expected_stat_signature: tuple[int, int, int, int, int] | None = None,
) -> str:
    if source_offset < 0 or payload_bytes <= 0:
        raise ValueError("source range must be non-negative and non-empty")
    if buffer_bytes <= 0:
        raise ValueError("buffer_bytes must be positive")
    digest = hashlib.sha256()
    remaining = payload_bytes
    with path.open("rb") as stream:
        before_signature = _file_stat_signature(os.fstat(stream.fileno()))
        if expected_stat_signature is not None:
            _require_stable_file_signature(
                before_signature, expected_stat_signature, path=path
            )
        stream.seek(source_offset)
        while remaining:
            block = stream.read(min(buffer_bytes, remaining))
            if not block:
                raise RuntimeError(
                    f"source data ended early while verifying range at offset {source_offset}: "
                    f"{remaining} bytes missing"
                )
            digest.update(block)
            remaining -= len(block)
        after_signature = _file_stat_signature(os.fstat(stream.fileno()))
    _require_stable_file_signature(after_signature, before_signature, path=path)
    if expected_stat_signature is not None:
        _require_stable_file_signature(
            after_signature, expected_stat_signature, path=path
        )
    return digest.hexdigest()


def verify_materialization_payloads(
    source_path: Path,
    materialization: dict[str, object],
    payload_dir: Path,
    *,
    expected_chunks: Iterable[dict[str, object]],
    expected_provenance: dict[str, object],
    expected_source_identity: dict[str, object],
    buffer_bytes: int = DEFAULT_COPY_BUFFER_BYTES,
) -> dict[str, object]:
    """Verify one producer report and payload set against source-backed expectations."""

    chunks = list(expected_chunks)
    if not chunks:
        raise RuntimeError("expected chunk blueprint must not be empty")
    _validate_source_payload_chunks(chunks)

    expected_scalars = {
        "schemaVersion": EXPECTED_MATERIALIZATION_SCHEMA_VERSION,
        "kind": EXPECTED_MATERIALIZATION_KIND,
        "status": "pass",
        "decisionStatus": "diagnostic-only",
    }
    for field, expected in expected_scalars.items():
        observed = materialization.get(field)
        if observed != expected:
            raise RuntimeError(
                f"materialization report identity mismatch for {field}: "
                f"expected={expected!r}, observed={observed!r}"
            )

    observed_provenance = _required_dict(
        materialization.get("provenance"), field="materialization.provenance"
    )
    if observed_provenance != expected_provenance:
        raise RuntimeError("materialization provenance does not match the explicit pinned probe selection")

    source_identity = {
        "location": _required_str(
            expected_source_identity.get("location"), field="source identity location"
        ),
        "bytes": _required_int(expected_source_identity.get("bytes"), field="source identity bytes"),
        "sha256": _normalized_sha256(
            expected_source_identity.get("sha256"), field="source identity sha256"
        ),
    }
    expected_basename = PurePosixPath(
        str(source_identity["location"]).replace("\\", "/")
    ).name
    if not source_path.is_file():
        raise FileNotFoundError(f"source external-data file not found: {source_path}")
    if source_path.name != expected_basename:
        raise RuntimeError(
            "source external-data basename does not match pinned external-data location"
        )
    source_stat_signature = _file_stat_signature(source_path.stat())
    actual_source_bytes = source_stat_signature[2]
    if actual_source_bytes != source_identity["bytes"]:
        raise RuntimeError("source external-data byte size does not match pinned identity")
    actual_source_sha256 = _sha256_file(
        source_path,
        buffer_bytes=buffer_bytes,
        expected_stat_signature=source_stat_signature,
    )
    if actual_source_sha256 != source_identity["sha256"]:
        raise RuntimeError("source external-data SHA-256 does not match pinned identity")

    source = _required_dict(materialization.get("source"), field="materialization.source")
    observed_source_bytes = _required_int(source.get("bytes"), field="materialization.source.bytes")
    observed_source_sha256 = _normalized_sha256(
        source.get("sha256"), field="materialization.source.sha256"
    )
    observed_blueprint_location = _required_str(
        source.get("blueprintLocation"), field="materialization.source.blueprintLocation"
    )
    reported_source_path = _required_str(source.get("path"), field="materialization.source.path")
    reported_source_basename = PurePosixPath(reported_source_path.replace("\\", "/")).name
    if reported_source_basename != expected_basename:
        raise RuntimeError(
            "materialization source path basename does not match the pinned external-data location"
        )
    if observed_source_bytes != source_identity["bytes"]:
        raise RuntimeError("materialization source byte size does not match pinned external-data identity")
    if observed_source_sha256 != source_identity["sha256"]:
        raise RuntimeError("materialization source SHA-256 does not match pinned external-data identity")
    if observed_blueprint_location != source_identity["location"]:
        raise RuntimeError("materialization blueprintLocation does not match pinned external-data identity")

    coverage_start = _required_int(
        chunks[0].get("sourceOffsetBytes"), field="chunk[0].sourceOffsetBytes"
    )
    coverage_end = _required_int(
        chunks[-1].get("sourceEndOffsetBytesExclusive"),
        field=f"chunk[{len(chunks) - 1}].sourceEndOffsetBytesExclusive",
    )
    if _required_int(
        source.get("coverageStartBytes"), field="materialization.source.coverageStartBytes"
    ) != coverage_start:
        raise RuntimeError("materialization source coverage start does not match pinned blueprint")
    if _required_int(
        source.get("coverageEndBytesExclusive"),
        field="materialization.source.coverageEndBytesExclusive",
    ) != coverage_end:
        raise RuntimeError("materialization source coverage end does not match pinned blueprint")

    payloads = [
        _required_dict(item, field=f"materialization.payloads[{index}]")
        for index, item in enumerate(
            _required_list(materialization.get("payloads"), field="materialization.payloads")
        )
    ]
    if _required_int(
        materialization.get("payloadCount"), field="materialization.payloadCount"
    ) != len(chunks):
        raise RuntimeError("materialization payloadCount does not match pinned blueprint")
    if len(payloads) != len(chunks):
        raise RuntimeError("materialization payload array length does not match pinned blueprint")

    expected_total_payload_bytes = sum(
        _required_int(chunk.get("payloadBytes"), field=f"chunk[{index}].payloadBytes")
        for index, chunk in enumerate(chunks)
    )
    if _required_int(
        materialization.get("totalPayloadBytes"), field="materialization.totalPayloadBytes"
    ) != expected_total_payload_bytes:
        raise RuntimeError("materialization totalPayloadBytes does not match pinned blueprint")

    if not payload_dir.is_dir():
        raise FileNotFoundError(f"payload directory not found: {payload_dir}")
    expected_names = _expected_payload_names(len(chunks))
    actual_payload_names = {path.name for path in payload_dir.glob("payload-*.bin")}
    if actual_payload_names != set(expected_names):
        raise RuntimeError(
            "payload directory contents do not match the materialization report: "
            f"expected={sorted(expected_names)!r}, observed={sorted(actual_payload_names)!r}"
        )

    verified_payloads: list[dict[str, object]] = []
    verified_payload_signatures: dict[str, tuple[int, int, int, int, int]] = {}
    verified_total_bytes = 0
    for index, (chunk, payload, expected_name) in enumerate(
        zip(chunks, payloads, expected_names, strict=True)
    ):
        expected_fields = {
            "chunkIndex": _required_int(chunk.get("chunkIndex"), field=f"chunk[{index}].chunkIndex"),
            "outputFile": expected_name,
            "bytes": _required_int(chunk.get("payloadBytes"), field=f"chunk[{index}].payloadBytes"),
            "startRow": _required_int(chunk.get("startRow"), field=f"chunk[{index}].startRow"),
            "endRowExclusive": _required_int(
                chunk.get("endRowExclusive"), field=f"chunk[{index}].endRowExclusive"
            ),
            "sourceOffsetBytes": _required_int(
                chunk.get("sourceOffsetBytes"), field=f"chunk[{index}].sourceOffsetBytes"
            ),
            "sourceEndOffsetBytesExclusive": _required_int(
                chunk.get("sourceEndOffsetBytesExclusive"),
                field=f"chunk[{index}].sourceEndOffsetBytesExclusive",
            ),
        }
        for field, expected in expected_fields.items():
            observed = payload.get(field)
            if observed != expected:
                raise RuntimeError(
                    f"materialization payload[{index}].{field} does not match pinned blueprint: "
                    f"expected={expected!r}, observed={observed!r}"
                )

        reported_sha256 = _normalized_sha256(
            payload.get("sha256"), field=f"materialization.payloads[{index}].sha256"
        )
        payload_path = payload_dir / expected_name
        if payload_path.is_symlink():
            raise RuntimeError(f"refusing to verify symlink payload: {payload_path}")
        if not payload_path.is_file():
            raise FileNotFoundError(f"materialized payload not found: {payload_path}")
        payload_stat_signature = _file_stat_signature(payload_path.stat())
        actual_bytes = payload_stat_signature[2]
        if actual_bytes != expected_fields["bytes"]:
            raise RuntimeError(
                f"materialized payload size mismatch for {expected_name}: "
                f"expected={expected_fields['bytes']}, observed={actual_bytes}"
            )
        actual_payload_sha256 = _sha256_file(
            payload_path,
            buffer_bytes=buffer_bytes,
            expected_stat_signature=payload_stat_signature,
        )
        source_range_sha256 = _sha256_file_range(
            source_path,
            source_offset=int(expected_fields["sourceOffsetBytes"]),
            payload_bytes=int(expected_fields["bytes"]),
            buffer_bytes=buffer_bytes,
            expected_stat_signature=source_stat_signature,
        )
        if actual_payload_sha256 != source_range_sha256:
            raise RuntimeError(
                f"materialized payload does not match pinned source range for {expected_name}: "
                f"sourceRangeSha256={source_range_sha256}, payloadSha256={actual_payload_sha256}"
            )
        if reported_sha256 != source_range_sha256:
            raise RuntimeError(
                f"materialization report SHA-256 does not match pinned source range for {expected_name}: "
                f"sourceRangeSha256={source_range_sha256}, reportedSha256={reported_sha256}"
            )
        verified_total_bytes += actual_bytes
        verified_payload_signatures[expected_name] = payload_stat_signature
        verified_payloads.append(
            {
                "chunkIndex": expected_fields["chunkIndex"],
                "outputFile": expected_name,
                "bytes": actual_bytes,
                "sha256": actual_payload_sha256,
                "sourceRangeSha256": source_range_sha256,
            }
        )

    if verified_total_bytes != expected_total_payload_bytes:
        raise RuntimeError("verified payload byte total does not match pinned blueprint")

    for expected_name, payload_stat_signature in verified_payload_signatures.items():
        payload_path = payload_dir / expected_name
        if payload_path.is_symlink():
            raise RuntimeError(f"refusing to verify symlink payload: {payload_path}")
        _require_stable_file_signature(
            _file_stat_signature(payload_path.stat()),
            payload_stat_signature,
            path=payload_path,
        )
    _require_stable_file_signature(
        _file_stat_signature(source_path.stat()),
        source_stat_signature,
        path=source_path,
    )

    report: dict[str, object] = {
        "schemaVersion": BASE_REPORT_SCHEMA_VERSION,
        "kind": REPORT_KIND,
        "status": "pass",
        "decisionStatus": "diagnostic-only",
        "provenance": expected_provenance,
        "source": {
            "path": str(source_path),
            "bytes": actual_source_bytes,
            "sha256": actual_source_sha256,
        },
        "payloadCount": len(verified_payloads),
        "totalPayloadBytes": verified_total_bytes,
        "payloads": verified_payloads,
        "conclusion": (
            "the diagnostic payload files independently match the verifier-owned pinned source "
            "byte ranges, probe selection, and producer materialization report; this verification "
            "does not define or approve a browser artifact, cache, manifest, loader, or runtime contract"
        ),
    }
    return report


def verify_pinned_probe_materialization(
    source_path: Path,
    probe_report: dict[str, object],
    materialization: dict[str, object],
    payload_dir: Path,
    *,
    stage_kind: str,
    tier: str,
    buffer_bytes: int = DEFAULT_COPY_BUFFER_BYTES,
) -> dict[str, object]:
    """Derive pinned expectations locally, then verify source-backed producer evidence."""

    chunks = _chunks_from_probe_report(
        probe_report,
        stage_kind=stage_kind,
        tier=tier,
    )
    expected_provenance = _materialization_provenance_from_probe_report(
        probe_report,
        stage_kind=stage_kind,
        tier=tier,
        chunks=chunks,
    )
    expected_source_identity = _source_identity_from_probe_report(probe_report)
    expected_budget = _expected_pinned_tier_budget(stage_kind=stage_kind, tier=tier)
    report = verify_materialization_payloads(
        source_path,
        materialization,
        payload_dir,
        expected_chunks=chunks,
        expected_provenance=expected_provenance,
        expected_source_identity=expected_source_identity,
        buffer_bytes=buffer_bytes,
    )
    verified_payloads = _required_list(report.get("payloads"), field="verification.payloads")
    actual_max_payload_bytes = max(
        _required_int(
            _required_dict(item, field="verification.payload").get("bytes"),
            field="verification.payload.bytes",
        )
        for item in verified_payloads
    )
    expected_max_payload_bytes = _required_int(
        expected_budget.get("balancedMaximumPayloadBytes"),
        field="expected budget balancedMaximumPayloadBytes",
    )
    if actual_max_payload_bytes != expected_max_payload_bytes:
        raise RuntimeError(
            "verified maximum payload bytes do not match the verifier-owned pinned tier budget"
        )
    report["schemaVersion"] = REPORT_SCHEMA_VERSION
    report["budget"] = {
        **expected_budget,
        "sourceStageResidualBytes": EXPECTED_STAGE_RESIDUAL_BYTES[stage_kind],
        "verifiedMaximumPayloadBytes": actual_max_payload_bytes,
    }
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_external_data", type=Path)
    parser.add_argument("probe_report", type=Path)
    parser.add_argument("materialization_report", type=Path)
    parser.add_argument("payload_dir", type=Path)
    parser.add_argument("--stage", required=True)
    parser.add_argument("--tier", required=True)
    parser.add_argument("--report-out", type=Path)
    args = parser.parse_args()

    probe_report, probe_report_sha256 = _load_json_with_sha256(args.probe_report)
    materialization, materialization_report_sha256 = _load_json_with_sha256(
        args.materialization_report
    )
    verification = verify_pinned_probe_materialization(
        args.source_external_data,
        probe_report,
        materialization,
        args.payload_dir,
        stage_kind=args.stage,
        tier=args.tier,
    )
    verification["inputReports"] = {
        "probeReportSha256": probe_report_sha256,
        "materializationReportSha256": materialization_report_sha256,
    }
    rendered = json.dumps(verification, indent=2, ensure_ascii=False) + "\n"
    if args.report_out is not None:
        if args.report_out.exists() or args.report_out.is_symlink():
            raise FileExistsError(f"refusing to overwrite existing verification report: {args.report_out}")
        args.report_out.parent.mkdir(parents=True, exist_ok=True)
        with args.report_out.open("x", encoding="utf-8") as stream:
            stream.write(rendered)
    print(rendered, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
