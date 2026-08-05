/**
 * demo-validate.js — pure input parsing / validation for the demo page.
 *
 * Every function here is free of DOM / browser APIs so the exact same logic
 * runs in the demo page and in vitest unit tests.
 *
 * Requirements covered (issue #104):
 * - Array input: invalid tokens are reported WITH their position, never
 *   silently dropped.
 * - JSON input: parse errors carry a 1-based line/column position and the
 *   expected shape is validated separately (with per-item messages).
 */

const isDigit = (code) => code >= 48 && code <= 57;
const isWhitespaceCode = (code) => code === 32 || code === 9 || code === 10 || code === 13;

/**
 * Parse a single decimal number. Accepts only well-formed finite numbers
 * (empty / "abc" / "NaN" / "Infinity" are rejected).
 *
 * @returns {{ ok: true, value: number } | { ok: false, value: null }}
 */
export function parseNumber(raw) {
  if (typeof raw !== 'string') raw = String(raw);
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, value: null };
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return { ok: false, value: null };
  return { ok: true, value };
}

// ============================================================
// Field-level format checks (mirror the sandbox function rules in
// server.ts / sample-functions.ts so per-field errors can be shown before the
// round-trip and be associated with aria-invalid / aria-describedby).
// ============================================================

/** RFC 5322-simplified email pattern (same intent as formValidate). */
const EMAIL_PATTERN =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;

/** Validate an email address string. */
export function isValidEmail(value) {
  return EMAIL_PATTERN.test(String(value));
}

/**
 * Luhn checksum (ISO/IEC 7812-1). Returns true for a syntactically valid card
 * number; rejects all-zero digit strings like the sandbox function does.
 */
export function isLuhnValid(digits) {
  const text = String(digits);
  if (!/^\d+$/.test(text)) return false;
  let sum = 0;
  let double = false;
  for (let i = text.length - 1; i >= 0; i -= 1) {
    let d = parseInt(text[i], 10);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0 && sum !== 0;
}

/**
 * Validate a credit card number: 13–19 digits after stripping spaces/hyphens,
 * all numeric, and passing the Luhn check.
 */
export function isValidCardNumber(value) {
  const digits = String(value).replace(/[\s-]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  return isLuhnValid(digits);
}

/** Validate an international phone number (7–15 digits after optional +). */
export function isValidPhone(value) {
  const digits = String(value).replace(/[\s()-]/g, '');
  return /^\+?\d[\d-]{6,14}\d$/.test(digits);
}

/** Validate password strength: at least 8 characters. */
export function isStrongPassword(value) {
  return String(value).length >= 8;
}

/**
 * Parse a comma-separated list of numbers.
 * Invalid tokens are collected with their 1-based position AND raw text so the
 * UI can point at exactly which parts of the input are wrong.
 *
 * @returns {{ ok, values: number[], invalid: {index, raw}[], isEmpty: boolean }}
 */
export function parseNumberList(raw) {
  const text = String(raw);
  if (text.trim() === '') return { ok: false, values: [], invalid: [], isEmpty: true };
  const parts = text.split(',');
  const values = [];
  const invalid = [];
  parts.forEach((part, index) => {
    const trimmed = part.trim();
    if (trimmed === '') {
      invalid.push({ index, raw: '' });
      return;
    }
    const value = Number(trimmed);
    if (Number.isFinite(value)) {
      values.push(value);
    } else {
      invalid.push({ index, raw: trimmed });
    }
  });
  return { ok: invalid.length === 0, values, invalid, isEmpty: false };
}

/**
 * Validate the shape of the Price Calculator "items" input.
 * Expected: [{ name: string, price: number, quantity: number, weight?: number }]
 *
 * @returns {{ ok: boolean, errors: {index: number|null, message: string}[] }}
 */
export function validatePriceItems(value) {
  if (!Array.isArray(value)) {
    return { ok: false, errors: [{ index: null, message: 'expected an array of items' }] };
  }
  const errors = [];
  if (value.length === 0) {
    errors.push({ index: null, message: 'expected at least one item' });
  }
  value.forEach((item, i) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      errors.push({ index: i, message: `item #${i + 1} must be an object` });
      return;
    }
    if (typeof item.name !== 'string' || item.name.length === 0) {
      errors.push({ index: i, message: `item #${i + 1} needs a non-empty "name" string` });
    }
    if (typeof item.price !== 'number' || !Number.isFinite(item.price) || item.price < 0) {
      errors.push({ index: i, message: `item #${i + 1} needs a non-negative numeric "price"` });
    }
    if (typeof item.quantity !== 'number' || !Number.isFinite(item.quantity) || item.quantity <= 0) {
      errors.push({ index: i, message: `item #${i + 1} needs a positive numeric "quantity"` });
    }
    if (
      item.weight != null &&
      (typeof item.weight !== 'number' || !Number.isFinite(item.weight) || item.weight < 0)
    ) {
      errors.push({ index: i, message: `item #${i + 1} "weight" must be a non-negative number` });
    }
  });
  return { ok: errors.length === 0, errors };
}

/**
 * Validate the shape of the optional Price Calculator "discount" input.
 * Expected: { type: 'percentage' | 'fixed', value: number }.
 *
 * @returns {{ ok: boolean, errors: {index: number|null, message: string}[] }}
 */
export function validateDiscount(value) {
  if (value === null || value === undefined) return { ok: true, errors: [] };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: [{ index: null, message: 'expected an object like {"type":"percentage","value":10}' }] };
  }
  const errors = [];
  if (value.type !== 'percentage' && value.type !== 'fixed') {
    errors.push({ index: null, message: '"type" must be "percentage" or "fixed"' });
  }
  if (typeof value.value !== 'number' || !Number.isFinite(value.value) || value.value < 0) {
    errors.push({ index: null, message: '"value" must be a non-negative number' });
  }
  return { ok: errors.length === 0, errors };
}

// ============================================================
// Lightweight JSON parser with error positions
// ============================================================

/** A JSON delimiter that can legally follow a number token. */
function isNumberDelimiter(ch) {
  return (
    ch === ',' || ch === ']' || ch === '}' ||
    ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
  );
}

/**
 * Parse a JSON document with a hand-rolled recursive-descent parser so syntax
 * errors carry a 1-based line/column position that is identical across
 * browsers (native JSON.parse error messages/positions are browser-specific).
 *
 * @returns {{ ok: true, value: unknown } | { ok: false, error: { message, position, line, column } }}
 */
export function parseJsonLite(raw) {
  const src = String(raw);
  let pos = 0;
  let error = null;

  const fail = (message, at) => {
    if (error !== null) return undefined;
    const position = at === undefined || at === null ? pos : at;
    let line = 1;
    let column = 1;
    for (let i = 0; i < position && i < src.length; i += 1) {
      if (src.charCodeAt(i) === 10) {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
    }
    error = { message, position, line, column };
    return undefined;
  };

  const skipWhitespace = () => {
    while (pos < src.length && isWhitespaceCode(src.charCodeAt(pos))) pos += 1;
  };

  const parseValue = () => {
    skipWhitespace();
    if (pos >= src.length) return fail('Unexpected end of JSON input');
    const ch = src[pos];
    if (ch === '{') return parseObject();
    if (ch === '[') return parseArray();
    if (ch === '"') return parseString();
    if (ch === 't') return parseKeyword('true', true);
    if (ch === 'f') return parseKeyword('false', false);
    if (ch === 'n') return parseKeyword('null', null);
    if (ch === '-' || isDigit(src.charCodeAt(pos))) return parseNumber();
    return fail(`Unexpected character '${ch}'`);
  };

  const parseObject = () => {
    pos += 1; // consume '{'
    skipWhitespace();
    if (src[pos] === '}') {
      pos += 1;
      return {};
    }
    const obj = {};
    for (;;) {
      skipWhitespace();
      if (src[pos] !== '"') return fail('Expected a string property name');
      const key = parseString();
      if (error !== null) return undefined;
      skipWhitespace();
      if (src[pos] !== ':') return fail("Expected ':' after property name");
      pos += 1;
      const value = parseValue();
      if (error !== null) return undefined;
      // Define the property on a null-prototype object so hostile input like
      // {"__proto__":{...}} can never pollute Object.prototype.
      Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
      skipWhitespace();
      if (src[pos] === ',') {
        pos += 1;
        continue;
      }
      if (src[pos] === '}') {
        pos += 1;
        return obj;
      }
      return fail("Expected ',' or '}' after property value");
    }
  };

  const parseArray = () => {
    pos += 1; // consume '['
    skipWhitespace();
    if (src[pos] === ']') {
      pos += 1;
      return [];
    }
    const arr = [];
    for (;;) {
      const value = parseValue();
      if (error !== null) return undefined;
      arr.push(value);
      skipWhitespace();
      if (src[pos] === ',') {
        pos += 1;
        continue;
      }
      if (src[pos] === ']') {
        pos += 1;
        return arr;
      }
      return fail("Expected ',' or ']' after array value");
    }
  };

  const parseString = () => {
    pos += 1; // consume opening quote
    let out = '';
    while (pos < src.length) {
      const ch = src[pos];
      if (ch === '"') {
        pos += 1;
        return out;
      }
      if (ch === '\\') {
        pos += 1;
        const esc = src[pos];
        switch (esc) {
          case '"': out += '"'; break;
          case '\\': out += '\\'; break;
          case '/': out += '/'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 't': out += '\t'; break;
          case 'u': {
            const hex = src.slice(pos + 1, pos + 5);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) return fail('Invalid unicode escape');
            out += String.fromCharCode(parseInt(hex, 16));
            pos += 4;
            break;
          }
          default:
            return fail(`Invalid escape character '${esc}'`);
        }
        pos += 1;
      } else if (ch === '\n' || ch === '\r') {
        return fail('Unterminated string (newline in string)');
      } else {
        out += ch;
        pos += 1;
      }
    }
    return fail('Unterminated string');
  };

  const parseNumber = () => {
    const start = pos;
    if (src[pos] === '-') pos += 1;
    while (pos < src.length && isDigit(src.charCodeAt(pos))) pos += 1;
    if (src[pos] === '.') {
      pos += 1;
      while (pos < src.length && isDigit(src.charCodeAt(pos))) pos += 1;
    }
    if (src[pos] === 'e' || src[pos] === 'E') {
      pos += 1;
      if (src[pos] === '+' || src[pos] === '-') pos += 1;
      while (pos < src.length && isDigit(src.charCodeAt(pos))) pos += 1;
    }
    const text = src.slice(start, pos);
    if (text === '' || text === '-' || /^[0-9]*\.$/.test(text) || /^[0-9]*\.?[0-9]*[eE][+-]?$/.test(text)) {
      return fail('Invalid number');
    }
    if (pos < src.length && !isNumberDelimiter(src[pos])) {
      return fail('Invalid number literal');
    }
    const value = Number(text);
    if (!Number.isFinite(value)) return fail('Number is out of range');
    return value;
  };

  const parseKeyword = (word, value) => {
    if (src.slice(pos, pos + word.length) !== word) {
      return fail(`Invalid literal (expected ${word})`);
    }
    pos += word.length;
    return value;
  };

  const value = parseValue();
  if (error !== null || value === undefined) {
    return {
      ok: false,
      error: error || { message: 'Invalid JSON', position: pos, line: 1, column: 1 },
    };
  }
  skipWhitespace();
  if (pos < src.length) {
    fail('Unexpected trailing content');
    return { ok: false, error };
  }
  return { ok: true, value };
}
