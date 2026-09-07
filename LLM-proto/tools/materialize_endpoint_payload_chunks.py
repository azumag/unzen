#!/usr/bin/env python3
"""Materialize diagnostic endpoint source-byte chunk blueprints without runtime semantics.

This helper consumes ``balancedSourcePayloadChunks`` emitted by
``probe_llama_1b_endpoint_chunk_envelope.py`` and copies those exact byte ranges
from an existing external-data file into standalone payload files.  The output
is measurement evidence only: it does not define a browser cache format,
manifest contract, execution stage, or approved #223 design.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
from typing import BinaryIO, Iterable


REPORT_KIND = "unzen-endpoint-source-payload-materialization"
REPORT_SCHEMA_VERSION = "1.1.0"
LEGACY_REPORT_SCHEMA_VERSION = "1.0.0"
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


def _expected_pinned_source_payload_chunks(*, stage_kind: str, tier: str) -> list[dict[str, object]]:
    """Return the only source-byte blueprint accepted for the pinned graph contract."""

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


def chunks_from_probe_report(
    report: dict[str, object],
    *,
    stage_kind: str,
    tier: str,
) -> list[dict[str, object]]:
    """Extract one exact pinned diagnostic chunk blueprint from a probe report."""

    source_identity_from_probe_report(report)
    envelopes = _required_dict(report.get("endpointChunkEnvelope"), field="endpointChunkEnvelope")
    stage = _required_dict(envelopes.get(stage_kind), field=f"endpointChunkEnvelope.{stage_kind}")
    tiers = _required_dict(stage.get("tiers"), field=f"endpointChunkEnvelope.{stage_kind}.tiers")
    selected = _required_dict(tiers.get(tier), field=f"endpointChunkEnvelope.{stage_kind}.tiers.{tier}")
    if selected.get("feasible") is not True:
        raise RuntimeError(f"selected diagnostic tier is not feasible: {stage_kind}/{tier}")
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
            "probe report balancedSourcePayloadChunks does not match the pinned deterministic blueprint: "
            f"{stage_kind}/{tier}"
        )
    return chunks


def source_identity_from_probe_report(report: dict[str, object]) -> dict[str, object]:
    """Validate the pinned probe contract and return its external-data identity."""

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
        "sha256": _required_str(
            identity.get("sha256"), field="pinnedSourceExternalDataIdentity.sha256"
        ).lower(),
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


def sha256_file(path: Path, *, buffer_bytes: int = DEFAULT_COPY_BUFFER_BYTES) -> str:
    if buffer_bytes <= 0:
        raise ValueError("buffer_bytes must be positive")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while True:
            block = stream.read(buffer_bytes)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def _canonical_json_sha256(value: object) -> str:
    rendered = json.dumps(
        value,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(rendered).hexdigest()


def materialization_provenance_from_probe_report(
    report: dict[str, object],
    *,
    stage_kind: str,
    tier: str,
    chunks: Iterable[dict[str, object]],
) -> dict[str, object]:
    """Bind materialization evidence to one exact pinned probe selection."""

    normalized_chunks = list(chunks)
    selected_chunks = chunks_from_probe_report(
        report,
        stage_kind=stage_kind,
        tier=tier,
    )
    if normalized_chunks != selected_chunks:
        raise RuntimeError(
            "materialization chunks do not match the selected pinned probe blueprint: "
            f"{stage_kind}/{tier}"
        )
    source_identity = source_identity_from_probe_report(report)
    return {
        "probeKind": EXPECTED_PROBE_KIND,
        "probeSchemaVersion": EXPECTED_PROBE_SCHEMA_VERSION,
        "sourceGraphSha256": EXPECTED_SOURCE_GRAPH_SHA256,
        "stageKind": stage_kind,
        "tier": tier,
        "blueprintSha256": _canonical_json_sha256(selected_chunks),
        "sourceExternalDataIdentity": source_identity,
    }


def validate_source_payload_chunks(
    chunks: Iterable[dict[str, object]],
) -> tuple[list[dict[str, object]], str, int, int]:
    """Validate row/source contiguity and return normalized coverage metadata."""

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


def _copy_exact_range(
    source: BinaryIO,
    destination: Path,
    *,
    source_offset: int,
    payload_bytes: int,
    buffer_bytes: int,
) -> str:
    if buffer_bytes <= 0:
        raise ValueError("buffer_bytes must be positive")
    digest = hashlib.sha256()
    remaining = payload_bytes
    source.seek(source_offset)
    output = destination.open("xb")
    try:
        with output:
            while remaining:
                block = source.read(min(buffer_bytes, remaining))
                if not block:
                    raise RuntimeError(
                        f"source data ended early while materializing {destination.name}: "
                        f"{remaining} bytes missing"
                    )
                output.write(block)
                digest.update(block)
                remaining -= len(block)
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    return digest.hexdigest()


def materialize_source_payload_chunks(
    source_path: Path,
    output_dir: Path,
    chunks: Iterable[dict[str, object]],
    *,
    buffer_bytes: int = DEFAULT_COPY_BUFFER_BYTES,
    expected_source_bytes: int | None = None,
    expected_source_sha256: str | None = None,
) -> dict[str, object]:
    """Copy validated source ranges and return a diagnostic measurement report."""

    normalized, source_location, coverage_start, coverage_end = validate_source_payload_chunks(chunks)
    if not source_path.is_file():
        raise FileNotFoundError(f"source external-data file not found: {source_path}")
    blueprint_name = PurePosixPath(source_location.replace("\\", "/")).name
    if blueprint_name != source_path.name:
        raise RuntimeError(
            "source file basename does not match blueprint sourceLocation: "
            f"expected={blueprint_name!r}, observed={source_path.name!r}"
        )

    source_bytes = source_path.stat().st_size
    if expected_source_bytes is not None and source_bytes != expected_source_bytes:
        raise RuntimeError(
            "source external-data byte size does not match pinned identity: "
            f"expected={expected_source_bytes}, observed={source_bytes}"
        )
    if coverage_end > source_bytes:
        raise RuntimeError(
            f"chunk blueprint exceeds source file size: end={coverage_end}, sourceBytes={source_bytes}"
        )
    source_sha256 = sha256_file(source_path, buffer_bytes=buffer_bytes)
    if expected_source_sha256 is not None and source_sha256 != expected_source_sha256.lower():
        raise RuntimeError(
            "source external-data SHA-256 does not match pinned identity: "
            f"expected={expected_source_sha256.lower()}, observed={source_sha256}"
        )

    destinations = [output_dir / f"payload-{index:04d}.bin" for index in range(len(normalized))]
    existing = [path for path in destinations if path.exists() or path.is_symlink()]
    if existing:
        raise FileExistsError(f"refusing to overwrite existing payload: {existing[0]}")
    output_dir.mkdir(parents=True, exist_ok=True)

    materialized: list[dict[str, object]] = []
    created_destinations: list[Path] = []
    total_payload_bytes = 0
    with source_path.open("rb") as source:
        try:
            for chunk, destination in zip(normalized, destinations, strict=True):
                source_offset = _required_int(chunk["sourceOffsetBytes"], field="sourceOffsetBytes")
                payload_bytes = _required_int(chunk["payloadBytes"], field="payloadBytes")
                digest = _copy_exact_range(
                    source,
                    destination,
                    source_offset=source_offset,
                    payload_bytes=payload_bytes,
                    buffer_bytes=buffer_bytes,
                )
                created_destinations.append(destination)
                actual_bytes = destination.stat().st_size
                if actual_bytes != payload_bytes:
                    raise RuntimeError(
                        f"materialized payload size mismatch for {destination.name}: "
                        f"expected={payload_bytes}, observed={actual_bytes}"
                    )
                total_payload_bytes += actual_bytes
                materialized.append(
                    {
                        "chunkIndex": chunk["chunkIndex"],
                        "outputFile": destination.name,
                        "bytes": actual_bytes,
                        "sha256": digest,
                        "startRow": chunk["startRow"],
                        "endRowExclusive": chunk["endRowExclusive"],
                        "sourceOffsetBytes": source_offset,
                        "sourceEndOffsetBytesExclusive": chunk["sourceEndOffsetBytesExclusive"],
                    }
                )
        except Exception:
            for destination in created_destinations:
                destination.unlink(missing_ok=True)
            raise

    return {
        "schemaVersion": LEGACY_REPORT_SCHEMA_VERSION,
        "kind": REPORT_KIND,
        "status": "pass",
        "decisionStatus": "diagnostic-only",
        "source": {
            "path": str(source_path),
            "bytes": source_bytes,
            "sha256": source_sha256,
            "blueprintLocation": source_location,
            "coverageStartBytes": coverage_start,
            "coverageEndBytesExclusive": coverage_end,
        },
        "payloadCount": len(materialized),
        "totalPayloadBytes": total_payload_bytes,
        "payloads": materialized,
        "conclusion": (
            "the diagnostic source-byte blueprint was materialized exactly; this report does not "
            "define or approve a browser artifact, cache, manifest, loader, or runtime contract"
        ),
    }


def materialize_pinned_probe_payload_chunks(
    source_path: Path,
    output_dir: Path,
    report: dict[str, object],
    *,
    stage_kind: str,
    tier: str,
    buffer_bytes: int = DEFAULT_COPY_BUFFER_BYTES,
) -> tuple[dict[str, object], list[dict[str, object]]]:
    """Materialize one validated pinned probe selection and bind its provenance."""

    chunks = chunks_from_probe_report(report, stage_kind=stage_kind, tier=tier)
    source_identity = source_identity_from_probe_report(report)
    provenance = materialization_provenance_from_probe_report(
        report,
        stage_kind=stage_kind,
        tier=tier,
        chunks=chunks,
    )
    materialization = materialize_source_payload_chunks(
        source_path,
        output_dir,
        chunks,
        buffer_bytes=buffer_bytes,
        expected_source_bytes=_required_int(source_identity["bytes"], field="source identity bytes"),
        expected_source_sha256=_required_str(source_identity["sha256"], field="source identity sha256"),
    )
    materialization["schemaVersion"] = REPORT_SCHEMA_VERSION
    materialization["provenance"] = provenance
    return materialization, chunks


def _validate_report_output_path(
    report_out: Path,
    *,
    source_path: Path,
    output_dir: Path,
    payload_count: int,
) -> None:
    if report_out.exists() or report_out.is_symlink():
        raise FileExistsError(f"refusing to overwrite existing report: {report_out}")
    target = report_out.resolve()
    payload_targets = {
        (output_dir / f"payload-{index:04d}.bin").resolve()
        for index in range(payload_count)
    }
    if target in payload_targets:
        raise RuntimeError("report output must not collide with a materialized payload path")
    if target == source_path.resolve():
        raise RuntimeError("report output must not collide with the source external-data file")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_external_data", type=Path)
    parser.add_argument("probe_report", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--stage", default="embedding-prefix")
    parser.add_argument("--tier", default="preferred")
    parser.add_argument("--report-out", type=Path)
    args = parser.parse_args()

    report = json.loads(args.probe_report.read_text(encoding="utf-8"))
    if not isinstance(report, dict):
        raise RuntimeError("probe report root must be an object")
    chunks = chunks_from_probe_report(report, stage_kind=args.stage, tier=args.tier)
    if args.report_out is not None:
        _validate_report_output_path(
            args.report_out,
            source_path=args.source_external_data,
            output_dir=args.output_dir,
            payload_count=len(chunks),
        )
    materialization, _ = materialize_pinned_probe_payload_chunks(
        args.source_external_data,
        args.output_dir,
        report,
        stage_kind=args.stage,
        tier=args.tier,
    )
    rendered = json.dumps(materialization, indent=2, ensure_ascii=False) + "\n"
    if args.report_out is not None:
        args.report_out.parent.mkdir(parents=True, exist_ok=True)
        with args.report_out.open("x", encoding="utf-8") as stream:
            stream.write(rendered)
    print(rendered, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
