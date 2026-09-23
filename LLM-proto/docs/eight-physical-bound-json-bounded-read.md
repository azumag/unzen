# Bounded provenance-sidecar JSON reads

The provenance-bound 8-physical RSS verifiers treat bound sidecars and validated preflight reports as control inputs. `readStableBoundJsonFile()` therefore reads them through one opened, non-symlink regular-file descriptor and applies a configured byte ceiling before parsing.

The reader first accepts an initial regular-file snapshot only when its size is within `1..maxBytes`. It then reads at most that accepted snapshot size plus one byte from the same descriptor. The extra byte is only a growth probe: receiving it is rejected as `size changed while reading`. A short read is rejected the same way. This keeps concurrent growth from turning the initial size check into an unbounded `readFileSync(fd)` allocation.

After the bounded descriptor read, the verifier still requires descriptor metadata and pathname metadata to match the original snapshot, including device/inode, size, modification time, and change time. Final symlinks remain rejected. UTF-8 decoding is fatal and JSON parsing remains fail-closed.

This shared reader is consumed by the cancellation bound verifier, the normal-completion bound verifier, and the bound GPU-process RSS proxy. The change is host-side evidence-input reliability hardening only; it does not alter evidence schemas, evidence promotion rules, browser/WebGPU execution, deployment, credentials, billing, or model acquisition.

Related: #167, #1507, #1508, #1509.
