# Bundler option container boundary

`bundle()` treats its JavaScript configuration as caller-owned runtime input even though the public TypeScript API is typed. Configuration is snapshotted and validated before esbuild is invoked.

The top-level option bag must be a non-array object. Array classification is bounded because `Array.isArray()` can throw for a revoked Proxy; a revoked option container therefore fails with `Bundle options must be an object` instead of exposing a native Proxy exception.

`allowedModules` must be an array. Its array classification, `length`, and numeric-index reads are bounded, the list remains capped at `MAX_ALLOWED_MODULE_PATTERNS` (1024), each pattern retains the existing byte budget, and snapshotting does not invoke caller `Symbol.iterator`. A revoked container or throwing index getter is normalized to `allowedModules could not be read` without inspecting or coercing the thrown value.

`maxBundleSize` diagnostics preserve useful primitive values but do not stringify object/function inputs. Invalid object/function values are represented by stable type labels, so caller-owned `Symbol.toPrimitive`, `valueOf`, and `toString` hooks cannot run while validation is constructing an error.

This boundary hardening does not change valid bundle configuration, import-whitelist semantics, emitted code, dependency resolution, or bundle-size limits. It only makes invalid caller-owned runtime values fail closed before esbuild or filesystem/module-resolution side effects begin.
