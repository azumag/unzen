/** Bounded primitives for reading caller-owned array containers. */

export interface ArrayBoundaryRead<T> {
  readonly ok: boolean;
  readonly value?: T;
}

/** `Array.isArray()` without leaking the native revoked-Proxy TypeError. */
export function isArrayContainer(value: unknown): boolean {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

/** Read a caller-owned array-like length without exposing the thrown value. */
export function readArrayLength(value: unknown): ArrayBoundaryRead<unknown> {
  try {
    return {
      ok: true,
      value: (value as { readonly length: unknown }).length,
    };
  } catch {
    return { ok: false };
  }
}

/** Read one caller-owned numeric slot without exposing the thrown value. */
export function readArrayIndex(value: unknown, index: number): ArrayBoundaryRead<unknown> {
  try {
    return {
      ok: true,
      value: (value as Record<number, unknown>)[index],
    };
  } catch {
    return { ok: false };
  }
}
