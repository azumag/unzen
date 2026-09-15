# Capture-bundle JSON descriptor snapshot boundary

`tools/verify_multi_segment_capture_bundle.py` treats `run-summary.json` and `same-machine-evidence.json` as control evidence. Their parsed JSON and reported SHA-256 values must therefore come from one identical byte snapshot.

The verifier opens each JSON file once with read-only/nonblocking flags, requires the opened object to be a regular file, reads the bytes through that descriptor, and checks descriptor metadata before and after the read. It also verifies that the pathname still names the opened object after the read. Path replacement, symlink/non-regular input, or in-place mutation fails closed.

The SHA-256 digest is updated from the same bytes that are decoded and passed to `json.loads()`. `runSummarySha256` and the observed same-machine evidence digest therefore no longer depend on a second pathname open.

This is host-side evidence-integrity hardening only. It does not create new real-model, WebGPU, multi-browser, deployment, or production evidence for #167/#158.
