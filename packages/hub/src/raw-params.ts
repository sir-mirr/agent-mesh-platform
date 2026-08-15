/**
 * Locating the `params` member in a received request, byte for byte.
 *
 * Its own module because it is a pure function over text and imports nothing —
 * `signature.ts` opens the database at load, which would make this untestable
 * without a state directory, and a function this easy to get subtly wrong is
 * one that has to be testable in isolation.
 */

/**
 * Extract the exact bytes of the `params` member from the received text.
 *
 * **The preimage covers the bytes as they arrived, not a re-serialisation.**
 * JSON has no canonical byte form: key order, whitespace, number formatting and
 * string escaping all survive a parse/stringify round trip differently, so a
 * preimage rebuilt from the parsed object can differ from the one the client
 * signed even when the content is identical. That failure is intermittent — it
 * depends on what the client's serialiser happened to emit — which is worse
 * than a consistent one.
 *
 * The scan is string-aware because it has to be: `"params"` may legitimately
 * appear inside a string value, and matching it there would capture the wrong
 * span. Only a key at depth 1 counts.
 *
 * Returns null when there is no `params` member, which is a valid request with
 * no parameters — the caller signs `{}` in that case, matching the encoder.
 */
export function rawParams(text: string): string | null {
  let depth = 0;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i]!;

    if (ch === '"') {
      const start = i;
      i = skipString(text, i);
      // A key at depth 1 is followed by a colon; anything else is a value.
      if (depth === 1 && text.slice(start, i) === '"params"') {
        let j = i;
        while (j < n && /\s/.test(text[j]!)) j++;
        if (text[j] === ":") {
          j++;
          while (j < n && /\s/.test(text[j]!)) j++;
          const end = skipValue(text, j);
          return end > j ? text.slice(j, end) : null;
        }
      }
      continue;
    }

    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    i++;
  }
  return null;
}

/** Index just past the closing quote of the string starting at `i`. */
function skipString(text: string, i: number): number {
  i++; // opening quote
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"') return i + 1;
    i++;
  }
  return i;
}

/** Index just past the JSON value starting at `i`. */
function skipValue(text: string, i: number): number {
  const ch = text[i];
  if (ch === '"') return skipString(text, i);
  if (ch === "{" || ch === "[") {
    let depth = 0;
    while (i < text.length) {
      const c = text[i]!;
      if (c === '"') {
        i = skipString(text, i);
        continue;
      }
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    return i;
  }
  // A literal: number, true, false, null. Ends at the next structural character.
  while (i < text.length && !",}] \t\n\r".includes(text[i]!)) i++;
  return i;
}
