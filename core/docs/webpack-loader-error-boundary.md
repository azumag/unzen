# Webpack loader error boundary

The dependency-bundling path in `unzenWebpackLoader()` crosses build-tool-owned and caller-owned failure boundaries. In particular, webpack's `addDependency()` callback can throw arbitrary JavaScript values, and the asynchronous dependency transform can reject with a non-`Error` value.

Loader error reporting must not call coercion hooks on arbitrary object or function failures. `normalizeWebpackLoaderError()` therefore preserves genuine `Error` instances, preserves useful primitive rejection text, and replaces object/function failures with a stable generic `Error` without invoking `String(value)`, `Symbol.toPrimitive`, `valueOf`, or `toString` on the thrown value.

This normalization only affects failure reporting. Successful dependency bundling, source-map selection, loader cache disabling, watch-file registration, callback shape, and transformed output are unchanged. A failure still invokes the async loader callback exactly once with an `Error` and without transformed output.
