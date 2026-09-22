#!/usr/bin/env python3
"""Compare full tied-weight embedding Gather with tiled endpoint payload routing.

This issue #223 S0 probe keeps the candidate architecture diagnostic-only. It
uses the pinned Llama-3.2-1B-Instruct q4 source embedding as an ORT CPU reference,
then routes token IDs spanning all eight vocabulary execution tiles through the
already-materialized four preferred physical payloads. The outputs are restored
to original token order and compared with the full-weight Gather result.

It does not select the 4-way/8-tile layout, exercise decoder/KV/checkpoint
execution, or change manifest/cache/runtime/dispatcher semantics.
"""
from __future__ import annotations

import argparse
import gc
import hashlib
import json
import mmap
import os
from pathlib import Path
import platform
import stat
import tempfile
import time

import numpy as np
import onnx
import onnxruntime as ort
from onnx import TensorProto, helper

from multi_segment_onnx import (
    DEFAULT_SOURCE_GRAPH_MAX_BYTES,
    _read_source_graph_snapshot as _read_shared_source_graph_snapshot,
)
import probe_llama_1b_endpoint_layout_candidates as layout_probe
import probe_llama_1b_endpoint_preferred_tile_ort_cpu as tile_probe

REPORT_KIND = "unzen-pinned-llama-1b-endpoint-embedding-composition-ort-cpu-probe"
REPORT_SCHEMA_VERSION = "1.0.0"
PINNED_ORT_VERSION = "1.22.0"
EMBEDDING_INITIALIZER = "model.embed_tokens.weight"
VOCAB_ROWS = 128256
HIDDEN_SIZE = 2048
FLOAT32_BYTES = 4
SOURCE_WEIGHT_BYTES = VOCAB_ROWS * HIDDEN_SIZE * FLOAT32_BYTES
TOKEN_IDS = [0, 16031, 16032, 32063, 32064, 48095, 48096, 64127, 64128, 80159, 80160, 96191, 96192, 112223, 112224, 128255]


def _identity(s: os.stat_result) -> tuple[int,int,int,int,int]:
    return (s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)


def _read_source_graph_snapshot(
    source_model: Path,
    *,
    max_bytes: int = DEFAULT_SOURCE_GRAPH_MAX_BYTES,
) -> tuple[Path,bytes]:
    """Adapt the shared bounded graph snapshot to the probe's path-plus-bytes API."""
    if not isinstance(max_bytes,int) or isinstance(max_bytes,bool) or max_bytes <= 0:
        raise ValueError("max_bytes must be a positive integer")
    requested=source_model
    resolved=requested.resolve(strict=True)
    graph_bytes,_=_read_shared_source_graph_snapshot(resolved,max_bytes=max_bytes)
    try:
        current_resolved=requested.resolve(strict=True)
    except (FileNotFoundError,OSError):
        raise RuntimeError("source graph path changed after reading") from None
    if current_resolved != resolved:
        raise RuntimeError("source graph path changed after reading")
    return resolved,graph_bytes


def _sha256_fd(fd: int, size: int) -> str:
    h=hashlib.sha256(); off=0
    while off<size:
        b=os.pread(fd,min(8*1024*1024,size-off),off)
        if not b: raise RuntimeError("unexpected EOF while hashing pinned source")
        h.update(b); off+=len(b)
    return h.hexdigest()


def _open_pinned_source_external_data(path: Path) -> tuple[int, os.stat_result]:
    try:
        snap=path.lstat()
    except OSError as error:
        raise RuntimeError(f"source external data is not readable: {path}: {error}") from error
    if stat.S_ISLNK(snap.st_mode) or not stat.S_ISREG(snap.st_mode):
        raise RuntimeError(f"source external data must be a regular non-symlink file: {path}")
    flags=os.O_RDONLY | getattr(os,"O_BINARY",0) | getattr(os,"O_CLOEXEC",0)
    flags |= getattr(os,"O_NOFOLLOW",0) | getattr(os,"O_NONBLOCK",0)
    try:
        fd=os.open(path,flags)
    except OSError as error:
        raise RuntimeError(f"source external data could not be opened safely: {path}: {error}") from error
    try:
        opened=os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode):
            raise RuntimeError(f"source external data must remain a regular file: {path}")
        if _identity(opened)!=_identity(snap):
            raise RuntimeError("source external data changed while opening")
        return fd,opened
    except Exception:
        os.close(fd)
        raise


def _external_map(t: TensorProto) -> dict[str,str]:
    return {e.key:e.value for e in t.external_data}


def _source_embedding_contract(
    source_model: Path,
    layout: dict[str,object],
    *,
    expected_graph_bytes: int | None = None,
) -> tuple[Path,int,int]:
    source_model,graph_bytes=_read_source_graph_snapshot(source_model)
    if expected_graph_bytes is not None:
        if (
            not isinstance(expected_graph_bytes,int)
            or isinstance(expected_graph_bytes,bool)
            or expected_graph_bytes < 0
        ):
            raise RuntimeError("expected source graph byte length must be a non-negative integer")
        if len(graph_bytes) != expected_graph_bytes:
            raise RuntimeError(
                f"source graph byte length mismatch: expected {expected_graph_bytes}, got {len(graph_bytes)}"
            )
    observed=hashlib.sha256(graph_bytes).hexdigest()
    expected=layout.get("sourceGraphSha256")
    if observed != expected:
        raise RuntimeError(f"source graph SHA-256 mismatch: expected {expected}, got {observed}")
    model=onnx.load_from_string(graph_bytes)
    matches=[i for i in model.graph.initializer if i.name==EMBEDDING_INITIALIZER]
    if len(matches)!=1: raise RuntimeError("expected exactly one pinned embedding initializer")
    t=matches[0]
    if t.data_type != TensorProto.FLOAT or list(t.dims) != [VOCAB_ROWS,HIDDEN_SIZE]:
        raise RuntimeError("pinned embedding initializer dtype/shape drift")
    ext=_external_map(t)
    location=ext.get("location"); offset=int(ext.get("offset","0")); length=int(ext.get("length","0"))
    if not location or offset < 0 or length != SOURCE_WEIGHT_BYTES:
        raise RuntimeError("pinned embedding external-data geometry drift")
    path=(source_model.parent/location).resolve()
    expected_source=layout.get("pinnedSourceExternalDataIdentity")
    if not isinstance(expected_source,dict): raise RuntimeError("missing pinned source external-data identity")
    if path.name != expected_source.get("location"):
        raise RuntimeError("pinned source external-data location drift")
    return path,offset,length


def _save_reference_model(*, fd:int, source_offset:int) -> Path:
    t=TensorProto(); t.name="full_weight"; t.data_type=TensorProto.FLOAT; t.dims.extend([VOCAB_ROWS,HIDDEN_SIZE]); t.data_location=TensorProto.EXTERNAL
    for k,v in (("location",f"/dev/fd/{fd}"),("offset",str(source_offset)),("length",str(SOURCE_WEIGHT_BYTES))):
        e=t.external_data.add(); e.key=k; e.value=v
    inp=helper.make_tensor_value_info("input_ids",TensorProto.INT64,[None])
    out=helper.make_tensor_value_info("embedding",TensorProto.FLOAT,[None,HIDDEN_SIZE])
    g=helper.make_graph([helper.make_node("Gather",["full_weight","input_ids"],["embedding"],axis=0)],"unzen-full-embedding-reference",[inp],[out],[t])
    m=helper.make_model(g,opset_imports=[helper.make_opsetid("",21)],ir_version=10,producer_name="unzen-diagnostic")
    f=tempfile.NamedTemporaryFile(mode="wb",prefix=".unzen-full-embedding-",suffix=".onnx",delete=False); path=Path(f.name); f.close(); onnx.save(m,path); return path


def _run_session(path: Path, feeds: dict[str,np.ndarray]) -> tuple[np.ndarray,float,float]:
    opts=ort.SessionOptions(); opts.intra_op_num_threads=1
    started=time.perf_counter(); sess=ort.InferenceSession(str(path),sess_options=opts,providers=["CPUExecutionProvider"]); create=(time.perf_counter()-started)*1000
    if sess.get_providers()!=["CPUExecutionProvider"]: raise RuntimeError("unexpected ORT provider")
    started=time.perf_counter(); out=sess.run(None,feeds)[0]; run=(time.perf_counter()-started)*1000
    del sess; gc.collect(); return out,create,run


def _snapshot_physical_artifacts(
    physical: list[object],
    *,
    expected_count: int = 4,
) -> dict[int,int]:
    """Validate and snapshot the physical artifact fields consumed by this probe."""
    if (
        not isinstance(expected_count,int)
        or isinstance(expected_count,bool)
        or expected_count <= 0
    ):
        raise RuntimeError("physical artifact count invalid")
    if len(physical) != expected_count:
        raise RuntimeError("physical artifact count drift")
    by_index: dict[int,int]={}
    for item in physical:
        if not isinstance(item,dict):
            raise RuntimeError("physical artifact must be object")
        index=item.get("index")
        if (
            not isinstance(index,int)
            or isinstance(index,bool)
            or index < 0
            or index >= expected_count
        ):
            raise RuntimeError("physical artifact index invalid")
        if index in by_index:
            raise RuntimeError(f"duplicate physical artifact index {index}")
        byte_length=item.get("byteLength")
        if (
            not isinstance(byte_length,int)
            or isinstance(byte_length,bool)
            or byte_length <= 0
        ):
            raise RuntimeError(f"physical artifact {index} byte length invalid")
        by_index[index]=byte_length
    if sorted(by_index) != list(range(expected_count)):
        raise RuntimeError("physical artifact indexes incomplete")
    return by_index


def _route_probe_tokens(
    tiles: list[object],
    *,
    physical_artifact_count: int = 4,
    physical_artifact_bytes: dict[int,int] | None = None,
) -> list[tuple[dict[str,object],int,int,int,int,list[int]]]:
    """Snapshot the canonical full-vocabulary tile partition and probe-token routing."""
    if (
        not isinstance(physical_artifact_count,int)
        or isinstance(physical_artifact_count,bool)
        or physical_artifact_count <= 0
    ):
        raise RuntimeError("physical artifact count invalid")
    if len(tiles) != 8:
        raise RuntimeError("execution tile count drift")
    if physical_artifact_bytes is not None:
        if not isinstance(physical_artifact_bytes,dict):
            raise RuntimeError("physical artifact byte table invalid")
        if set(physical_artifact_bytes) != set(range(physical_artifact_count)):
            raise RuntimeError("physical artifact byte table incomplete")
        if any(
            not isinstance(value,int) or isinstance(value,bool) or value <= 0
            for value in physical_artifact_bytes.values()
        ):
            raise RuntimeError("physical artifact byte table invalid")

    assignments=[0]*len(TOKEN_IDS)
    routed: list[tuple[dict[str,object],int,int,int,int,list[int]]]=[]
    expected_start=0
    for tile_position,tile in enumerate(tiles):
        if not isinstance(tile,dict):
            raise RuntimeError("tile must be object")
        ti=tile.get("tileIndex"); start=tile.get("startRow"); end=tile.get("endRowExclusive")
        if not all(isinstance(x,int) and not isinstance(x,bool) for x in (ti,start,end)):
            raise RuntimeError("tile geometry invalid")
        if start < 0 or start >= end or end > VOCAB_ROWS:
            raise RuntimeError("tile row range invalid")
        if ti != tile_position:
            raise RuntimeError("execution tile index must match canonical list position")
        if start != expected_start:
            raise RuntimeError("execution tile ranges must be ordered and contiguous")
        expected_start=end
        slices=tile.get("physicalSlices")
        if not isinstance(slices,list) or len(slices)!=1 or not isinstance(slices[0],dict):
            raise RuntimeError("preferred tile slice drift")
        physical_slice=slices[0]
        ai=physical_slice.get("physicalArtifactIndex")
        if (
            not isinstance(ai,int)
            or isinstance(ai,bool)
            or ai < 0
            or ai >= physical_artifact_count
        ):
            raise RuntimeError("physical artifact index drift")

        execution_tile=tile
        if physical_artifact_bytes is not None:
            row_count=physical_slice.get("rowCount")
            artifact_byte_offset=physical_slice.get("artifactByteOffset")
            byte_length=physical_slice.get("byteLength")
            if (
                not isinstance(row_count,int)
                or isinstance(row_count,bool)
                or row_count <= 0
                or not isinstance(artifact_byte_offset,int)
                or isinstance(artifact_byte_offset,bool)
                or artifact_byte_offset < 0
                or not isinstance(byte_length,int)
                or isinstance(byte_length,bool)
                or byte_length <= 0
            ):
                raise RuntimeError("physical slice geometry invalid")
            expected_rows=end-start
            if row_count != expected_rows:
                raise RuntimeError("physical slice row count drift")
            expected_bytes=row_count*HIDDEN_SIZE*FLOAT32_BYTES
            if byte_length != expected_bytes:
                raise RuntimeError("physical slice byte length drift")
            if artifact_byte_offset + byte_length > physical_artifact_bytes[ai]:
                raise RuntimeError("physical slice exceeds physical artifact bytes")
            execution_tile={
                "tileIndex":ti,
                "startRow":start,
                "endRowExclusive":end,
                "physicalSlices":[
                    {
                        "physicalArtifactIndex":ai,
                        "rowCount":row_count,
                        "artifactByteOffset":artifact_byte_offset,
                        "byteLength":byte_length,
                    }
                ],
            }

        positions=[pos for pos,tok in enumerate(TOKEN_IDS) if start <= tok < end]
        for position in positions:
            assignments[position]+=1
        routed.append((execution_tile,ti,start,end,ai,positions))
    if expected_start != VOCAB_ROWS:
        raise RuntimeError("execution tile ranges must cover the full vocabulary")
    if any(count != 1 for count in assignments):
        raise RuntimeError("execution tile routing must cover every probe token exactly once")
    return routed


def build_report(source_model: Path, payload_root: Path) -> dict[str,object]:
    if ort.__version__ != PINNED_ORT_VERSION: raise RuntimeError(f"onnxruntime version drift: {ort.__version__}")
    if os.name!="posix" or not Path('/dev/fd').is_dir(): raise RuntimeError("probe requires POSIX /dev/fd")
    layout=layout_probe.build_report(source_model)
    if layout.get("kind")!=layout_probe.REPORT_KIND or layout.get("schemaVersion")!=layout_probe.REPORT_SCHEMA_VERSION or layout.get("status")!="pass" or layout.get("decisionStatus")!="diagnostic-only":
        raise RuntimeError("upstream endpoint layout contract drift")
    candidates=layout.get("candidates")
    if not isinstance(candidates,list): raise RuntimeError("missing layout candidates")
    cand=[c for c in candidates if isinstance(c,dict) and c.get("physicalArtifactCount")==4]
    if len(cand)!=1: raise RuntimeError("expected one 4-way candidate")
    cand=cand[0]; tiles=cand.get("executionTiles"); physical=cand.get("physicalArtifacts")
    if not isinstance(tiles,list) or len(tiles)!=8 or not isinstance(physical,list) or len(physical)!=4: raise RuntimeError("4-way/8-tile geometry drift")
    physical_by_index=_snapshot_physical_artifacts(physical,expected_count=len(physical))
    routed_tiles=_route_probe_tokens(
        tiles,
        physical_artifact_count=len(physical_by_index),
        physical_artifact_bytes=physical_by_index,
    )

    source_path,source_offset,source_length=_source_embedding_contract(source_model,layout)
    source_fd,opened=_open_pinned_source_external_data(source_path)
    payload_fds: dict[int,tuple[int,Path,tuple[int,int,int,int,int]]]={}
    try:
        source_sha=_sha256_fd(source_fd,opened.st_size)
        expected_source=layout["pinnedSourceExternalDataIdentity"]
        if source_sha != expected_source.get("sha256") or opened.st_size != expected_source.get("bytes"):
            raise RuntimeError("pinned source external-data identity mismatch")

        reference_model=_save_reference_model(fd=source_fd,source_offset=source_offset)
        ids=np.array(TOKEN_IDS,dtype=np.int64)
        try:
            reference,ref_create,ref_run=_run_session(reference_model,{"input_ids":ids})
        finally:
            reference_model.unlink(missing_ok=True)

        for index in range(4):
            expected_bytes=physical_by_index[index]
            expected_sha=tile_probe.PINNED_PREFERRED_PAYLOAD_SHA256[index]
            fd,verified,pinned=tile_probe._open_pinned_payload(payload_root/f"payload-{index:04d}.bin",expected_bytes=expected_bytes,expected_sha256=expected_sha)
            payload_fds[index]=(fd,payload_root/f"payload-{index:04d}.bin",pinned)

        actual=np.empty_like(reference)
        tile_runs=[]
        for tile,ti,start,end,ai,positions in routed_tiles:
            if not positions: continue
            fd=payload_fds[ai][0]
            model=tile_probe._save_external_model(tile=tile,hidden_size=HIDDEN_SIZE,mode="embedding",payload_fd=fd)
            local=np.array([TOKEN_IDS[p]-start for p in positions],dtype=np.int64)
            try:
                out,create_ms,run_ms=_run_session(model,{"local_ids":local})
            finally:
                model.unlink(missing_ok=True)
            actual[np.array(positions,dtype=np.int64)] = out
            tile_runs.append({"tileIndex":ti,"physicalArtifactIndex":ai,"positions":positions,"globalTokenIds":[TOKEN_IDS[p] for p in positions],"localTokenIds":[int(x) for x in local],"sessionCreateMs":create_ms,"runMs":run_ms})

        exact=bool(np.array_equal(actual,reference)); diff=np.abs(actual-reference); max_abs=float(np.max(diff,initial=0.0))
        if not exact: raise RuntimeError(f"complete tiled embedding diverged from full-weight Gather: maxAbsDiff={max_abs}")
        for fd,path,pinned in payload_fds.values(): tile_probe._assert_payload_path_identity(path,pinned_identity=pinned)
        current_source=source_path.lstat()
        if not stat.S_ISREG(current_source.st_mode) or _identity(os.fstat(source_fd)) != _identity(opened) or _identity(current_source) != _identity(opened): raise RuntimeError("source external-data snapshot changed during execution")

        return {"schemaVersion":REPORT_SCHEMA_VERSION,"kind":REPORT_KIND,"status":"pass","decisionStatus":"diagnostic-only","sourceGraphSha256":layout.get("sourceGraphSha256"),"pinnedSourceExternalDataIdentity":expected_source,"embeddingInitializer":{"name":EMBEDDING_INITIALIZER,"rows":VOCAB_ROWS,"hiddenSize":HIDDEN_SIZE,"sourceOffset":source_offset,"byteLength":source_length},"onnxruntime":{"version":ort.__version__,"provider":"CPUExecutionProvider"},"environment":{"pythonVersion":platform.python_version(),"numpyVersion":np.__version__,"onnxVersion":onnx.__version__,"system":platform.system(),"machine":platform.machine()},"tokenIds":TOKEN_IDS,"reference":{"sessionCreateMs":ref_create,"runMs":ref_run},"tileRuns":tile_runs,"comparison":{"exactEqual":exact,"maxAbsDiff":max_abs,"shape":list(actual.shape)},"conclusion":"The pinned full tied-weight embedding Gather and a routed 8-way vocabulary-tile composition backed by four preferred physical payloads produced byte-exact embeddings for token IDs spanning every tile under pinned CPU ORT. This remains diagnostic-only and does not select the candidate layout or prove decoder/KV/checkpoint full-model staged equivalence."}
    finally:
        for fd,_,_ in payload_fds.values():
            try: os.close(fd)
            except OSError: pass
        os.close(source_fd)


def main() -> int:
    ap=argparse.ArgumentParser(description=__doc__); ap.add_argument('source_model',type=Path); ap.add_argument('payload_root',type=Path); args=ap.parse_args(); print(json.dumps(build_report(args.source_model,args.payload_root),indent=2,ensure_ascii=False)); return 0
if __name__=='__main__': raise SystemExit(main())
