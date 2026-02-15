/**
 * Practical server-side sample functions for unzen core demo
 *
 * These functions demonstrate the core value proposition:
 * "Safely delegate server-side computation to the browser sandbox"
 *
 * Each function is a string of JavaScript code that runs inside QuickJS sandbox.
 * The code is wrapped in `function run(...args)` by the framework.
 *
 * Why code strings? The same code runs both server-side (fallback) and
 * client-side (QuickJS Wasm in browser). Code must be serializable.
 */

// ============================================================
// formValidate: Tamper-proof form validation
//
// Traditional approach: Server validates to prevent devtools bypass.
// Unzen approach: QuickJS sandbox is tamper-proof (frozen prototypes,
// no eval), so validation can safely run in browser with same security.
//
// Input: { email?, creditCard?, phone?, password? }
// Output: { valid: boolean, errors: Record<string, string> }
// ============================================================
export const formValidateCode = `(fields) => {
  var errors = {};

  // Email validation: RFC 5322 simplified pattern
  // Checks for local@domain.tld format with allowed characters
  if (fields.email !== undefined) {
    var emailRegex = /^[a-zA-Z0-9.!#$%&'*+\\/=?^_\`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\\.[a-zA-Z]{2,}$/;
    if (!emailRegex.test(fields.email)) {
      errors.email = 'Invalid email format';
    }
  }

  // Credit card validation: Luhn algorithm (ISO/IEC 7812-1)
  // Strips spaces/hyphens, then applies double-every-other-digit checksum
  if (fields.creditCard !== undefined) {
    var digits = fields.creditCard.replace(/[\\s-]/g, '');
    if (digits.length < 13 || digits.length > 19 || !/^\\d+$/.test(digits)) {
      errors.creditCard = 'Invalid card number format';
    } else {
      // Luhn checksum: sum digits from right, doubling every second
      var sum = 0;
      var isDouble = false;
      for (var i = digits.length - 1; i >= 0; i--) {
        var d = parseInt(digits[i], 10);
        if (isDouble) {
          d *= 2;
          if (d > 9) d -= 9;
        }
        sum += d;
        isDouble = !isDouble;
      }
      if (sum % 10 !== 0 || sum === 0) {
        // sum === 0 rejects all-zero card numbers (technically valid Luhn but not real cards)
        errors.creditCard = 'Card number failed Luhn check';
      }
    }
  }

  // Phone validation: International format with country code
  // Accepts +XX-XXX-XXX-XXXX and similar patterns (7-15 digits after +)
  if (fields.phone !== undefined) {
    var phoneDigits = fields.phone.replace(/[\\s()-]/g, '');
    var phoneRegex = /^\\+?\\d[\\d-]{6,14}\\d$/;
    if (!phoneRegex.test(phoneDigits)) {
      errors.phone = 'Invalid phone number format';
    }
  }

  // Password strength: minimum 8 chars required
  // Strong = has uppercase, lowercase, digit, and special character
  if (fields.password !== undefined) {
    if (fields.password.length < 8) {
      errors.password = 'Password must be at least 8 characters';
    }
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors: errors,
  };
}`;

// ============================================================
// calculatePrice: Tamper-proof price computation
//
// Traditional approach: Server computes price to prevent manipulation.
// Unzen approach: Sandbox prevents tampering, RTT drops from ~100ms to ~2ms.
//
// Input: { items: [{name, price, quantity, weight?}], region, discount? }
// Output: { subtotal, discount, tax, shipping, total }
//
// Tax rates: US-CA 7.25%, US-NY 8%, US-TX 6.25%, JP 10%, EU-DE 19%,
//            EU-FR 20%, GB 20%, default 0%
// Discount: percentage (% off), fixed ($ off), tiered ($100+=5%, $200+=10%, $500+=15%)
// Shipping: $5 base + $2/kg, free domestic for $100+ orders
// ============================================================
export const calculatePriceCode = `(order) => {
  // Tax rate lookup table by region
  var taxRates = {
    'US-CA': 0.0725,
    'US-NY': 0.08,
    'US-TX': 0.0625,
    'JP': 0.10,
    'EU-DE': 0.19,
    'EU-FR': 0.20,
    'GB': 0.20,
  };

  // Step 1: Calculate subtotal from items
  var subtotal = 0;
  var totalWeight = 0;
  for (var i = 0; i < order.items.length; i++) {
    var item = order.items[i];
    subtotal += item.price * item.quantity;
    // Accumulate weight for shipping calculation (default 0.5kg per item)
    totalWeight += (item.weight || 0.5) * item.quantity;
  }

  // Step 2: Calculate discount
  var discountAmount = 0;
  if (order.discount) {
    if (order.discount.type === 'percentage') {
      discountAmount = subtotal * (order.discount.value / 100);
    } else if (order.discount.type === 'fixed') {
      discountAmount = Math.min(order.discount.value, subtotal);
    } else if (order.discount.type === 'tiered') {
      // Tiered: $100+ = 5%, $200+ = 10%, $500+ = 15%
      if (subtotal >= 500) {
        discountAmount = subtotal * 0.15;
      } else if (subtotal >= 200) {
        discountAmount = subtotal * 0.10;
      } else if (subtotal >= 100) {
        discountAmount = subtotal * 0.05;
      }
    }
  }

  // Step 3: Apply tax on (subtotal - discount)
  var afterDiscount = subtotal - discountAmount;
  var taxRate = taxRates[order.region] || 0;
  var tax = afterDiscount * taxRate;

  // Step 4: Calculate shipping
  // Base $5 + $2/kg, but free for domestic orders $100+ or empty orders
  var shipping = 0;
  if (order.items.length > 0 && subtotal < 100) {
    shipping = 5 + (totalWeight * 2);
  }
  // International shipping not free regardless of amount
  // (simplified: US-* and JP are "domestic" for their respective regions)

  // Step 5: Compute total
  // Round to 2 decimal places for currency precision
  var total = Math.round((afterDiscount + tax + shipping) * 100) / 100;

  return {
    subtotal: Math.round(subtotal * 100) / 100,
    discount: Math.round(discountAmount * 100) / 100,
    tax: Math.round(tax * 100) / 100,
    shipping: Math.round(shipping * 100) / 100,
    total: total,
  };
}`;

// ============================================================
// markdownToHtml: Offload content rendering to client
//
// Traditional approach: SSR renders Markdown on server (CPU intensive).
// Unzen approach: Client sandbox renders Markdown, freeing server CPU.
//
// Supported syntax:
//   Headings (# to ######), bold (**), italic (*), inline code (`),
//   links [text](url), images ![alt](url), fenced code blocks (```),
//   unordered lists (- item), ordered lists (1. item), paragraphs
//
// Security: All inline HTML is escaped to prevent XSS.
// ============================================================
export const markdownToHtmlCode = `(markdown) => {
  // Escape HTML special characters to prevent XSS injection
  // All 5 dangerous characters must be escaped (OWASP recommendation)
  function escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Sanitize URL: only allow http, https, mailto, and relative paths
  // Blocks javascript:, data:, vbscript: and other dangerous schemes
  function sanitizeUrl(url) {
    // Strip ASCII control characters (0x00-0x1F, 0x7F) that browsers silently
    // remove when parsing URLs in HTML attributes. Without this stripping,
    // "java\\tscript:" bypasses indexOf check but browsers treat it as "javascript:"
    var stripped = url.replace(/[\\x00-\\x1f\\x7f]/g, '');
    // URL-decode before scheme check to prevent %3A (:) encoding bypass.
    // "javascript%3Aalert(1)" decodes to "javascript:alert(1)" in browsers.
    // Repeatedly decode until stable to handle any depth of encoding.
    var decoded = stripped;
    try {
      var prev = '';
      while (decoded !== prev) {
        prev = decoded;
        decoded = decodeURIComponent(decoded);
      }
    } catch(e) {
      // decodeURIComponent throws on malformed sequences (e.g., %ZZ)
      // Fall through with partially decoded value
    }
    var cleaned = decoded.trim().toLowerCase();
    if (cleaned.indexOf('javascript:') === 0 || cleaned.indexOf('data:') === 0 || cleaned.indexOf('vbscript:') === 0) {
      return '';
    }
    // Return stripped (control chars removed) but case-preserved URL
    // Using cleaned (lowercased) would break case-sensitive URL paths
    return stripped;
  }

  // Apply inline formatting: bold, italic, code, links, images
  function processInline(line) {
    // Order matters: process code first to avoid conflicts with other patterns
    line = line.replace(/\\\`([^\\\`]+)\\\`/g, '<code>$1</code>');
    line = line.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
    line = line.replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
    // Images must be processed before links (![alt](url) vs [text](url))
    // URLs are sanitized to prevent javascript: and data: injection
    line = line.replace(/!\\[([^\\]]*)\\]\\(([^)]+)\\)/g, function(match, alt, url) {
      var safe = sanitizeUrl(url);
      // Defense-in-depth: escape alt text even though callers already escape.
      // Prevents XSS if processInline is ever called on unescaped input.
      return safe ? '<img src="' + safe + '" alt="' + escapeHtml(alt) + '" />' : '';
    });
    line = line.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, function(match, text, url) {
      var safe = sanitizeUrl(url);
      return safe ? '<a href="' + safe + '">' + text + '</a>' : text;
    });
    return line;
  }

  var lines = markdown.split('\\n');
  var html = [];
  var inCodeBlock = false;
  var codeBlockContent = [];
  var inList = false;
  var listType = '';
  var paragraphLines = [];

  // Flush accumulated paragraph lines as a <p> tag
  function flushParagraph() {
    if (paragraphLines.length > 0) {
      html.push('<p>' + processInline(paragraphLines.join(' ')) + '</p>');
      paragraphLines = [];
    }
  }

  // Flush accumulated list items
  function flushList() {
    if (inList) {
      html.push('</' + listType + '>');
      inList = false;
      listType = '';
    }
  }

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    // Fenced code block toggling (triple backticks)
    if (line.trim().indexOf('\\\`\\\`\\\`') === 0) {
      if (!inCodeBlock) {
        flushParagraph();
        flushList();
        inCodeBlock = true;
        codeBlockContent = [];
      } else {
        html.push('<pre><code>' + escapeHtml(codeBlockContent.join('\\n')) + '</code></pre>');
        inCodeBlock = false;
      }
      continue;
    }

    // Inside code block: collect raw lines (no inline processing)
    if (inCodeBlock) {
      codeBlockContent.push(line);
      continue;
    }

    // Blank line: flush paragraph and list
    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }

    // Headings: # to ######
    var headingMatch = line.match(/^(#{1,6})\\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      var level = headingMatch[1].length;
      html.push('<h' + level + '>' + processInline(escapeHtml(headingMatch[2])) + '</h' + level + '>');
      continue;
    }

    // Unordered list items: - item or * item
    var ulMatch = line.match(/^[-*]\\s+(.+)$/);
    if (ulMatch) {
      flushParagraph();
      if (!inList || listType !== 'ul') {
        flushList();
        html.push('<ul>');
        inList = true;
        listType = 'ul';
      }
      html.push('<li>' + processInline(escapeHtml(ulMatch[1])) + '</li>');
      continue;
    }

    // Ordered list items: 1. item, 2. item, etc.
    var olMatch = line.match(/^\\d+\\.\\s+(.+)$/);
    if (olMatch) {
      flushParagraph();
      if (!inList || listType !== 'ol') {
        flushList();
        html.push('<ol>');
        inList = true;
        listType = 'ol';
      }
      html.push('<li>' + processInline(escapeHtml(olMatch[1])) + '</li>');
      continue;
    }

    // Default: accumulate as paragraph text
    // Escape HTML first, then inline formatting is applied on flush
    paragraphLines.push(escapeHtml(line));
  }

  // Flush any remaining content
  // If an unclosed code block exists, render what we have (graceful degradation)
  if (inCodeBlock && codeBlockContent.length > 0) {
    html.push('<pre><code>' + escapeHtml(codeBlockContent.join('\\n')) + '</code></pre>');
  }
  flushParagraph();
  flushList();

  return html.join('\\n');
}`;

// ============================================================
// textStats: Text analysis computation
//
// Traditional approach: Server computes readability scores, word counts.
// Unzen approach: Pure computation with no I/O — ideal for sandbox.
//
// Output fields:
//   chars, words, sentences, paragraphs, avgWordLength,
//   syllables, readingTimeMinutes, fleschKincaidGrade
//
// Flesch-Kincaid formula:
//   0.39 * (words/sentences) + 11.8 * (syllables/words) - 15.59
// ============================================================
export const textStatsCode = `(text) => {
  // Handle empty text edge case
  if (!text || text.trim().length === 0) {
    return {
      chars: 0,
      words: 0,
      sentences: 0,
      paragraphs: 0,
      avgWordLength: 0,
      syllables: 0,
      readingTimeMinutes: 0,
      fleschKincaidGrade: 0,
    };
  }

  var chars = text.length;

  // Word count: split on whitespace, filter empties
  var wordList = text.trim().split(/\\s+/).filter(function(w) { return w.length > 0; });
  var words = wordList.length;

  // Sentence count: split on sentence-ending punctuation
  var sentenceEnders = text.match(/[.!?]+/g);
  var sentences = sentenceEnders ? sentenceEnders.length : 1;

  // Paragraph count: split on double newlines
  var paragraphs = text.split(/\\n\\s*\\n/).filter(function(p) { return p.trim().length > 0; }).length;
  if (paragraphs === 0) paragraphs = 1;

  // Average word length
  var totalChars = 0;
  for (var i = 0; i < wordList.length; i++) {
    // Strip punctuation from word for accurate character count
    totalChars += wordList[i].replace(/[^a-zA-Z0-9]/g, '').length;
  }
  var avgWordLength = words > 0 ? Math.round((totalChars / words) * 100) / 100 : 0;

  // Syllable counting heuristic for English text
  // Based on the common approach: count vowel groups, adjust for silent-e and common patterns
  function countSyllables(word) {
    word = word.toLowerCase().replace(/[^a-z]/g, '');
    if (word.length <= 2) return 1;

    // Count vowel groups (consecutive vowels = 1 syllable)
    var vowelGroups = word.match(/[aeiouy]+/g);
    var count = vowelGroups ? vowelGroups.length : 1;

    // Adjust: silent 'e' at end (e.g., 'make' = 1 syllable, not 2)
    if (word.endsWith('e') && !word.endsWith('le') && count > 1) {
      count--;
    }

    // Ensure at least 1 syllable
    return Math.max(count, 1);
  }

  var totalSyllables = 0;
  for (var j = 0; j < wordList.length; j++) {
    totalSyllables += countSyllables(wordList[j]);
  }

  // Reading time: 200 words per minute (average adult reading speed)
  var readingTimeMinutes = Math.round((words / 200) * 100) / 100;

  // Flesch-Kincaid Grade Level formula
  // FK = 0.39 * (words/sentences) + 11.8 * (syllables/words) - 15.59
  var fk = 0;
  if (words > 0 && sentences > 0) {
    fk = 0.39 * (words / sentences) + 11.8 * (totalSyllables / words) - 15.59;
    // Clamp to 0 minimum: FK formula can yield negative for very simple text
    fk = Math.max(0, Math.round(fk * 100) / 100);
  }

  return {
    chars: chars,
    words: words,
    sentences: sentences,
    paragraphs: paragraphs,
    avgWordLength: avgWordLength,
    syllables: totalSyllables,
    readingTimeMinutes: readingTimeMinutes,
    fleschKincaidGrade: fk,
  };
}`;
