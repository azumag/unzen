export function exactByteSum(values, label = 'byte total') {
  if (!Array.isArray(values)) {
    throw new TypeError(`${label} inputs must be an array`);
  }

  let total = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${label}[${index}] must be a non-negative safe integer`);
    }
    if (total > Number.MAX_SAFE_INTEGER - value) {
      throw new Error(`${label} exceeds JavaScript safe integer range`);
    }
    total += value;
  }
  return total;
}
