/**
 * Return whether currentLayerStart is the exact representable successor of
 * previousLayerEnd. Inputs are treated as runtime values even when callers have
 * already validated their segment records.
 */
export function isContiguousLayerSuccessor(
  previousLayerEnd: number,
  currentLayerStart: number,
): boolean {
  if (
    !Number.isSafeInteger(previousLayerEnd)
    || previousLayerEnd < 0
    || !Number.isSafeInteger(currentLayerStart)
    || currentLayerStart < 0
  ) {
    return false;
  }
  if (previousLayerEnd === Number.MAX_SAFE_INTEGER) return false;
  return currentLayerStart === previousLayerEnd + 1;
}
