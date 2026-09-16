# Multi-segment output collision preflight

`prepare_budgeted_multi_split()` treats the source ONNX graph and every referenced source external-data file as immutable inputs for the duration of generation. Before any segment graph, segment external-data file, or final `split-manifest.json` is written, every planned destination is checked against those source artifacts.

The check has two layers. Resolved-path comparison preserves the existing protection against direct path reuse and symlink aliases. For destinations that already exist, filesystem identity comparison with `Path.samefile()` also rejects hard links that resolve to a different pathname but share the same underlying source file. The final `split-manifest.json` destination is part of the same preflight set, so an external-data file named `split-manifest.json` cannot be silently replaced at the end of generation.

A collision is reported before output files are opened for writing. Regression coverage verifies that both a hard-linked `segment0.onnx` destination and a source artifact occupying the manifest destination are rejected while the source bytes remain unchanged.

This is a pre-generation overwrite guard, not a general filesystem transaction mechanism. Callers must still prevent concurrent hostile mutation of the output directory while a split run is in progress.
