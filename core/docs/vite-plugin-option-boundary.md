# Vite plugin option container boundary

`unzenVitePlugin()` treats its configuration as caller-owned runtime input even though the public API is typed. Construction snapshots the top-level option fields once before any transform/build state is created.

The top-level options bag must be a non-array object. Array classification is bounded because `Array.isArray()` can throw for a revoked Proxy; a revoked top-level container therefore fails with `Unzen Vite plugin options must be an object` rather than exposing a native Proxy exception.

`include` and `exclude` accept one `RegExp` or an array of `RegExp` values. Their container classification, `length`, and numeric-index reads are bounded. A revoked filter container fails as `<name> filters could not be read`. Arrays remain capped by `MAX_VITE_FILTER_PATTERNS` (1024), and the snapshot does not invoke caller `Symbol.iterator`.

RegExp values are copied from captured intrinsic `source` and `flags` getters, so caller-mutated `lastIndex`, overridden instance methods, or later array mutation do not alter the plugin's owned filter snapshot. This hardening does not change transform matching, declaration emission, dependency bundling, or Vite/Rollup output contracts.
