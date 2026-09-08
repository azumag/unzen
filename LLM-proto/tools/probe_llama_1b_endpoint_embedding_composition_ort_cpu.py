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


def _sha256_fd(fd: int, size: int) -> str:
    h=hashlib.sha256(); off=0
    while off<size:
        b=os.pread(fd,min(8*1024*1024,size-off),off)
        if not b: raise RuntimeError("unexpected EOF while hashing pinned source")
        h.update(b); off+=len(b)
    return h.hexdigest()


def _external_map(t: TensorProto) -> dict[str,str]:
    return {e.key:e.value for e in t.external_data}


def _source_embedding_contract(source_model: Path, layout: dict[str,object]) -> tuple[Path,int,int]:
    source_model = source_model.resolve()
    before = source_model.stat()
    graph_bytes = source_model.read_bytes()
    after = source_model.stat()
    if _identity(before) != _identity(after):
        raise RuntimeError("source graph changed while reading")
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

    source_path,source_offset,source_length=_source_embedding_contract(source_model,layout)
    snap=source_path.stat(); flags=os.O_RDONLY | (getattr(os,'O_NOFOLLOW',0)); source_fd=os.open(source_path,flags)
    payload_fds: dict[int,tuple[int,Path,tuple[int,int,int,int,int]]]={}
    try:
        opened=os.fstat(source_fd)
        if _identity(opened)!=_identity(snap): raise RuntimeError("source external data changed while opening")
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

        physical_by_index={int(a["index"]):a for a in physical if isinstance(a,dict)}
        for index in range(4):
            a=physical_by_index.get(index)
            if a is None: raise RuntimeError(f"missing physical artifact {index}")
            expected_bytes=a.get("byteLength")
            expected_sha=tile_probe.PINNED_PREFERRED_PAYLOAD_SHA256[index]
            fd,verified,pinned=tile_probe._open_pinned_payload(payload_root/f"payload-{index:04d}.bin",expected_bytes=expected_bytes,expected_sha256=expected_sha)
            payload_fds[index]=(fd,payload_root/f"payload-{index:04d}.bin",pinned)

        actual=np.empty_like(reference)
        tile_runs=[]
        for tile in tiles:
            if not isinstance(tile,dict): raise RuntimeError("tile must be object")
            ti=tile.get("tileIndex"); start=tile.get("startRow"); end=tile.get("endRowExclusive")
            if not all(isinstance(x,int) and not isinstance(x,bool) for x in (ti,start,end)): raise RuntimeError("tile geometry invalid")
            positions=[pos for pos,tok in enumerate(TOKEN_IDS) if start <= tok < end]
            if not positions: continue
            slices=tile.get("physicalSlices")
            if not isinstance(slices,list) or len(slices)!=1 or not isinstance(slices[0],dict): raise RuntimeError("preferred tile slice drift")
            ai=slices[0].get("physicalArtifactIndex")
            if not isinstance(ai,int) or isinstance(ai,bool): raise RuntimeError("physical artifact index drift")
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
        if _identity(os.fstat(source_fd)) != _identity(opened) or _identity(source_path.stat()) != _identity(opened): raise RuntimeError("source external-data snapshot changed during execution")

        return {"schemaVersion":REPORT_SCHEMA_VERSION,"kind":REPORT_KIND,"status":"pass","decisionStatus":"diagnostic-only","sourceGraphSha256":layout.get("sourceGraphSha256"),"pinnedSourceExternalDataIdentity":expected_source,"embeddingInitializer":{"name":EMBEDDING_INITIALIZER,"rows":VOCAB_ROWS,"hiddenSize":HIDDEN_SIZE,"sourceOffset":source_offset,"byteLength":source_length},"onnxruntime":{"version":ort.__version__,"provider":"CPUExecutionProvider"},"environment":{"pythonVersion":platform.python_version(),"numpyVersion":np.__version__,"onnxVersion":onnx.__version__,"system":platform.system(),"machine":platform.machine()},"tokenIds":TOKEN_IDS,"reference":{"sessionCreateMs":ref_create,"runMs":ref_run},"tileRuns":tile_runs,"comparison":{"exactEqual":exact,"maxAbsDiff":max_abs,"shape":list(actual.shape)},"conclusion":"The pinned full tied-weight embedding Gather and a routed 8-way vocabulary-tile composition backed by four preferred physical payloads produced byte-exact embeddings for token IDs spanning every tile under pinned CPU ORT. This remains diagnostic-only and does not select the candidate layout or prove decoder/KV/checkpoint full-model staged equivalence."}
    finally:
        for fd,_,_ in payload_fds.values():
            try: os.close(fd)
            except OSError: pass
        os.close(source_fd)


def main() -> int:
    ap=argparse.ArgumentParser(description=__doc__); ap.add_argument('source_model',type=Path); ap.add_argument('payload_root',type=Path); args=ap.parse_args(); print(json.dumps(build_report(args.source_model,args.payload_root),indent=2,ensure_ascii=False)); return 0
if __name__=='__main__': raise SystemExit(main())
