const isOptionalWhitespace = (character: string | undefined): boolean => (
  character === ' ' || character === '\t'
);

function opaqueTag(etag: string): string {
  return etag.startsWith('W/') ? etag.slice(2) : etag;
}

/**
 * Evaluate If-None-Match using weak comparison while rejecting malformed
 * fields. Entity tags are parsed before a match is accepted because commas
 * are valid inside the quoted opaque value.
 */
export function matchesIfNoneMatch(
  header: string | undefined,
  currentEtag: string,
): boolean {
  if (header === undefined) {
    return false;
  }

  let index = 0;
  let matched = false;
  let sawTag = false;

  const skipWhitespace = (): void => {
    while (index < header.length && isOptionalWhitespace(header[index])) {
      index += 1;
    }
  };

  skipWhitespace();
  if (header[index] === '*') {
    index += 1;
    skipWhitespace();
    return index === header.length;
  }

  const target = opaqueTag(currentEtag);
  while (index < header.length) {
    if (header.startsWith('W/', index)) {
      index += 2;
    }

    if (header[index] !== '"') {
      return false;
    }
    const tagStart = index;
    index += 1;

    while (index < header.length && header[index] !== '"') {
      const codePoint = header.charCodeAt(index);
      const isEtagCharacter = (
        codePoint === 0x21
        || (codePoint >= 0x23 && codePoint <= 0x7e)
        || (codePoint >= 0x80 && codePoint <= 0xff)
      );
      if (!isEtagCharacter) {
        return false;
      }
      index += 1;
    }

    if (index >= header.length) {
      return false;
    }
    index += 1;
    sawTag = true;
    matched ||= header.slice(tagStart, index) === target;

    skipWhitespace();
    if (index === header.length) {
      return sawTag && matched;
    }
    if (header[index] !== ',') {
      return false;
    }
    index += 1;
    skipWhitespace();
    if (index === header.length) {
      return false;
    }
  }

  return false;
}
