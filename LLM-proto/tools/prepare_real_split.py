#!/usr/bin/env python3
"""Prepare browser-ready real split artifacts without duplicating the full q4 file.

This wraps ``split_llama_1b_onnx.split_model`` and then repacks only the
external-data byte ranges referenced by each extracted subgraph. The result is
one compact weight file per segment, so Browser A and Browser B do not each
need to download/mount the original full-model external-data blob.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import BinaryIO

import onnx
from onnx import TensorProto

from split_llama_1b_onnx import sha256_file, split_model


COPY_CHUNK_BYTES = 8 * 1024 * 1024


def _external_metadata(initializer: TensorProto) -> dict[str, str]:
    return {entry.key: entry.value for entry in initializer.external_data}


def _replace_external_metadata(
    initializer: TensorProto,
    *,
    location: str,
    offset: int,
    length: int,
) -> None:
    del initializer.external_data[:]
    for key, value in (
        ("location", location),
        ("offset", str(offset)),
        ("length", str(length)),
    ):
        entry = initializer.external_data.add()
        entry.key = key
        entry.value = value
    initializer.data_location = TensorProto.EXTERNAL


def _copy_range(source: BinaryIO, destination: BinaryIO, offset: int, length: int) -> None:
    source.seek(offset)
    remaining = length
    while remaining:
        chunk = source.read(min(COPY_CHUNK_BYTES, remaining))
        if not chunk:
            raise EOFError(f"external data ended before {length} bytes could be copied from offset {offset}")
        destination.write(chunk)
        remaining -= len(chunk)


def repack_segment_external_data(
    model_path: Path,
    source_model_dir: Path,
    output_data_name: str,
) -> dict[str, object] | None:
    model = onnx.load_model(str(model_path), load_external_data=False)
    external = [
        initializer
        for initializer in model.graph.initializer
        if initializer.data_location == TensorProto.EXTERNAL
    ]
    if not external:
        return None

    output_data_path = model_path.parent / output_data_name
    range_offsets: dict[tuple[str, int, int], int] = {}
    open_sources: dict[str, BinaryIO] = {}
    try:
        with output_data_path.open("wb") as destination:
            for initializer in external:
                metadata = _external_metadata(initializer)
                location = metadata.get("location")
                if not location:
                    raise ValueError(f"external initializer {initializer.name!r} has no location")
                source_location = Path(location)
                if source_location.is_absolute() or ".." in source_location.parts:
                    raise ValueError(f"unsafe source external-data location: {location}")
                if "length" not in metadata:
                    raise ValueError(
                        f"external initializer {initializer.name!r} has no length; "
                        "streaming repack requires explicit ONNX external-data length"
                    )
                source_offset = int(metadata.get("offset", "0"))
                length = int(metadata["length"])
                if source_offset < 0 or length < 0:
                    raise ValueError(f"invalid external-data range for {initializer.name!r}")

                key = (location, source_offset, length)
                destination_offset = range_offsets.get(key)
                if destination_offset is None:
                    destination_offset = destination.tell()
                    source_path = source_model_dir / source_location
                    source_key = str(source_path.resolve())
                    source = open_sources.get(source_key)
                    if source is None:
                        source = source_path.open("rb")
                        open_sources[source_key] = source
                    _copy_range(source, destination, source_offset, length)
                    range_offsets[key] = destination_offset

                _replace_external_metadata(
                    initializer,
                    location=output_data_name,
                    offset=destination_offset,
                    length=length,
                )
    finally:
        for source in open_sources.values():
            source.close()

    onnx.save_model(model, str(model_path))
    onnx.checker.check_model(str(model_path), full_check=False)
    return {
        "location": output_data_name,
        "bytes": output_data_path.stat().st_size,
        "sha256": sha256_file(output_data_path),
        "uniqueSourceRanges": len(range_offsets),
    }


def prepare_real_split(
    source_model_path: Path,
    output_dir: Path,
    *,
    split_layer: int = 8,
    hidden_size: int = 2048,
    hash_source_external_data: bool = True,
) -> dict[str, object]:
    # Symlink mode makes the extracted graphs checker-valid before repacking,
    # without making another full copy of the source q4 blob.
    manifest = split_model(
        source_model_path,
        output_dir,
        split_layer=split_layer,
        hidden_size=hidden_size,
        external_data_mode="symlink",
        hash_external_data=hash_source_external_data,
    )

    for segment in manifest["segments"]:
        index = int(segment["index"])
        model_path = output_dir / str(segment["path"])
        external = repack_segment_external_data(
            model_path,
            source_model_path.parent,
            f"segment{index}.onnx_data",
        )
        segment["sha256"] = sha256_file(model_path)
        segment["externalData"] = [] if external is None else [external]

    # The split graphs now point to segment-specific data files. Remove only
    # symlinks created for the temporary shared-data validation; never unlink a
    # normal file supplied by the operator.
    for entry in manifest["sourceModel"].get("externalData", []):
        location = Path(str(entry["location"]))
        temporary = output_dir / location
        if temporary.is_symlink():
            temporary.unlink()

    manifest["artifactLayout"] = "per-segment-external-data"
    manifest_path = output_dir / "split-manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return manifest


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_model", type=Path, help="Path to the source model_q4.onnx")
    parser.add_argument("output_dir", type=Path, help="Directory for browser-ready split artifacts")
    parser.add_argument("--split-layer", type=int, default=8)
    parser.add_argument("--hidden-size", type=int, default=2048)
    parser.add_argument(
        "--skip-source-external-digest",
        action="store_true",
        help="Skip hashing the original full external-data file; segment files are always hashed",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    manifest = prepare_real_split(
        args.source_model,
        args.output_dir,
        split_layer=args.split_layer,
        hidden_size=args.hidden_size,
        hash_source_external_data=not args.skip_source_external_digest,
    )
    print(json.dumps(manifest, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
