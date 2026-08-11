/** Count UTF-8 bytes without allocating an encoded copy of the string. */
export function utf8ByteLength(value: string, stopAfter = Number.POSITIVE_INFINITY): number {
  let byteLength = 0;
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      byteLength += 1;
    } else if (codeUnit <= 0x7ff) {
      byteLength += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        byteLength += 4;
        index += 1;
      } else {
        byteLength += 3;
      }
    } else {
      byteLength += 3;
    }

    if (byteLength > stopAfter) {
      return byteLength;
    }
  }
  return byteLength;
}

export function exceedsUtf8ByteLength(value: string, maximum: number): boolean {
  return utf8ByteLength(value, maximum) > maximum;
}
