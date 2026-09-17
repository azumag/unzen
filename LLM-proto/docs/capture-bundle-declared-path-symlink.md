# Capture-bundle declared metadata paths and final symlinks

`tools/verify_multi_segment_capture_bundle.py` validates bundle-relative paths from `run-summary.json` before handing them to the manifest and evidence verifiers.

Containment checking needs a resolved path so that `..`-free paths which escape through a symlink are still rejected. The verifier must not, however, replace the declared pathname with that resolved target before the downstream read. Doing so would erase the final path component and could turn an in-bundle symlink into an apparently ordinary regular-file path, bypassing the downstream `lstat` / `O_NOFOLLOW` final-component check.

The path helper therefore uses `resolve()` only to prove that the declared path remains inside the capture directory, then returns the original absolute lexical candidate. Ordinary files behave as before; a final symlink remains visible to the downstream verifier and is rejected there. A symlink whose resolved target escapes the capture directory is rejected during containment validation.

This is a final-component audit-path hardening for #167. It does not claim component-anchored traversal for every capture metadata path and does not choose a concurrent-reader publication model for #908.
