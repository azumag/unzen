#!/usr/bin/env python3
"""Independently verify diagnostic endpoint payload materialization evidence.

This helper checks an existing ``materialize_endpoint_payload_chunks.py`` report and
its payload directory against an explicit pinned probe stage/tier selection.  It
re-hashes every payload and validates the producer report rather than trusting
producer-side success assertions.  The verification remains diagnostic-only and
does not approve a browser cache, manifest, loader, or runtime design for #223.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
from typing import Iterable

import materialize_endpoint_payload_chunks as materializer


REPORT_KIND = "unzen-endpoint-source-payload-materialization-verification"
REPORT_SCHEMA_VERSION = "1.0.0"
EXPECTED_MATERIALIZATION_KIND = materializer.REPORT_KIND
EXPECTED_MATERIALIZATION_SCHEMA_VERSION = materializer.REPORT_SCHEMA_VERSION


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


def _expected_payload_names(payload_count: int) -> list[str]:
    return [f"payload-{index:04d}.bin" for index in range(payload_count)]


def verify_materialization_payloads(
    materialization: dict[str, object],
    payload_dir: Path,
    *,
    expected_chunks: Iterable[dict[str, object]],
    expected_provenance: dict[str, object],
    expected_source_identity: dict[str, object],
    buffer_bytes: int = materializer.DEFAULT_COPY_BUFFER_BYTES,
) -> dict[str, object]:
    """Verify one materialization report and payload set against explicit expectations."""

    chunks = list(expected_chunks)
    if not chunks:
        raise RuntimeError("expected chunk blueprint must not be empty")
    materializer.validate_source_payload_chunks(chunks)

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
        "location": _required_str(expected_source_identity.get("location"), field="source identity location"),
        "bytes": _required_int(expected_source_identity.get("bytes"), field="source identity bytes"),
        "sha256": _normalized_sha256(expected_source_identity.get("sha256"), field="source identity sha256"),
    }
    source = _required_dict(materialization.get("source"), field="materialization.source")
    observed_source_bytes = _required_int(source.get("bytes"), field="materialization.source.bytes")
    observed_source_sha256 = _normalized_sha256(
        source.get("sha256"), field="materialization.source.sha256"
    )
    observed_blueprint_location = _required_str(
        source.get("blueprintLocation"), field="materialization.source.blueprintLocation"
    )
    source_path = _required_str(source.get("path"), field="materialization.source.path")
    source_basename = PurePosixPath(source_path.replace("\\", "/")).name
    expected_basename = PurePosixPath(source_identity["location"].replace("\\", "/")).name
    if source_basename != expected_basename:
        raise RuntimeError(
            "materialization source path basename does not match the pinned external-data location"
        )
    if observed_source_bytes != source_identity["bytes"]:
        raise RuntimeError("materialization source byte size does not match pinned external-data identity")
    if observed_source_sha256 != source_identity["sha256"]:
        raise RuntimeError("materialization source SHA-256 does not match pinned external-data identity")
    if observed_blueprint_location != source_identity["location"]:
        raise RuntimeError("materialization blueprintLocation does not match pinned external-data identity")

    coverage_start = _required_int(chunks[0].get("sourceOffsetBytes"), field="chunk[0].sourceOffsetBytes")
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
    if _required_int(materialization.get("payloadCount"), field="materialization.payloadCount") != len(chunks):
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
        actual_bytes = payload_path.stat().st_size
        if actual_bytes != expected_fields["bytes"]:
            raise RuntimeError(
                f"materialized payload size mismatch for {expected_name}: "
                f"expected={expected_fields['bytes']}, observed={actual_bytes}"
            )
        actual_sha256 = materializer.sha256_file(payload_path, buffer_bytes=buffer_bytes)
        if actual_sha256 != reported_sha256:
            raise RuntimeError(
                f"materialized payload SHA-256 mismatch for {expected_name}: "
                f"expected={reported_sha256}, observed={actual_sha256}"
            )
        verified_total_bytes += actual_bytes
        verified_payloads.append(
            {
                "chunkIndex": expected_fields["chunkIndex"],
                "outputFile": expected_name,
                "bytes": actual_bytes,
                "sha256": actual_sha256,
            }
        )

    if verified_total_bytes != expected_total_payload_bytes:
        raise RuntimeError("verified payload byte total does not match pinned blueprint")

    return {
        "schemaVersion": REPORT_SCHEMA_VERSION,
        "kind": REPORT_KIND,
        "status": "pass",
        "decisionStatus": "diagnostic-only",
        "provenance": expected_provenance,
        "payloadCount": len(verified_payloads),
        "totalPayloadBytes": verified_total_bytes,
        "payloads": verified_payloads,
        "conclusion": (
            "the diagnostic payload files independently match the pinned probe selection and "
            "producer materialization report; this verification does not define or approve a "
            "browser artifact, cache, manifest, loader, or runtime contract"
        ),
    }


def verify_pinned_probe_materialization(
    probe_report: dict[str, object],
    materialization: dict[str, object],
    payload_dir: Path,
    *,
    stage_kind: str,
    tier: str,
    buffer_bytes: int = materializer.DEFAULT_COPY_BUFFER_BYTES,
) -> dict[str, object]:
    """Derive the pinned expectations independently, then verify producer evidence."""

    chunks = materializer.chunks_from_probe_report(
        probe_report,
        stage_kind=stage_kind,
        tier=tier,
    )
    expected_provenance = materializer.materialization_provenance_from_probe_report(
        probe_report,
        stage_kind=stage_kind,
        tier=tier,
        chunks=chunks,
    )
    expected_source_identity = materializer.source_identity_from_probe_report(probe_report)
    return verify_materialization_payloads(
        materialization,
        payload_dir,
        expected_chunks=chunks,
        expected_provenance=expected_provenance,
        expected_source_identity=expected_source_identity,
        buffer_bytes=buffer_bytes,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
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
