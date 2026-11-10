// The dialect and error order of docs/design.md as a direct model of a whole input. It shares no code or technique
// with the Rust parser: it looks ahead instead of keeping a pending CR, decodes every field with TextDecoder, and
// finds invalid UTF-8 with V8's decoder. Errors carry a position so that the first in source order wins:
// a byte index, plus 0.25 for a record that grows past the limit at that byte and 0.5 for a structural error there.

const QUOTE = 0x22;
const CR = 0x0d;
const LF = 0x0a;
const RESERVED = ['__proto__', 'prototype', 'constructor'];

/** Index of the byte at which the input stops being UTF-8, `bytes.length + 0.1` if it ends mid-character, or Infinity. */
function invalidUtf8Position(bytes) {
  const validPrefix = (length) => {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length), { stream: true });
      return true;
    } catch {
      return false;
    }
  };
  if (!validPrefix(bytes.length)) {
    let low = 0;
    let high = bytes.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (validPrefix(middle + 1)) low = middle + 1;
      else high = middle;
    }
    return low;
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return Infinity;
  } catch {
    return bytes.length + 0.1;
  }
}

// Records after invalid UTF-8 are decoded leniently: they follow the error, so they are never returned.
const decode = (bytes) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(Uint8Array.from(bytes));

/** Reads `input` as `wasmCsvReader` must: `{ records, error }` like the tests' `outcome()`. */
export function referenceRead(input, { delimiter = ',', maxRecordBytes }) {
  const bytes = Buffer.from(input);
  const separator = delimiter.charCodeAt(0);
  const length = bytes.length;
  let newline;
  // Length of the record delimiter starting at `index`, deciding it on first sight.
  const recordDelimiterAt = (index) => {
    const crlf = bytes[index] === CR && bytes[index + 1] === LF;
    if (newline === undefined) {
      const found = crlf ? 'crlf' : bytes[index] === LF ? 'lf' : bytes[index] === CR ? 'cr' : undefined;
      if (found !== undefined) newline = found;
      return found === 'crlf' ? 2 : found === undefined ? 0 : 1;
    }
    if (newline === 'crlf') return crlf ? 2 : 0;
    return bytes[index] === (newline === 'lf' ? LF : CR) ? 1 : 0;
  };

  const records = [];
  const errors = [];
  const utf8 = invalidUtf8Position(bytes);
  if (utf8 !== Infinity) errors.push({ position: utf8, code: 'PARSE_ERROR', message: 'Input must contain valid UTF-8.' });
  let recordStart = 0;
  let fields = [];
  let field = [];
  let quotedFieldClosed = false;
  let expected;
  let stopped = Infinity;
  const lineOf = (start) => 1 + bytes.subarray(0, start).filter((byte) => byte === LF).length;
  const fail = (position, code = 'PARSE_ERROR', message = 'Invalid CSV input.') => {
    errors.push({ position, code, message, line: lineOf(recordStart) });
    stopped = Math.min(stopped, position);
  };
  // Completes the record whose last byte is `last`; the next one starts at `next`.
  const endRecord = (last, next) => {
    fields.push(field);
    const values = fields.map(decode);
    if (expected === undefined) expected = values.length;
    if (values.length !== expected) return fail(last + 0.5);
    records.push({ position: last + 0.5, fields: values, line: lineOf(recordStart), size: next - recordStart, start: recordStart });
    recordStart = next;
    fields = [];
    field = [];
    quotedFieldClosed = false;
  };

  let index = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  let quoted = false;
  while (index < length && stopped === Infinity) {
    const byte = bytes[index];
    if (quoted) {
      if (byte !== QUOTE) {
        field.push(byte);
        index++;
        continue;
      }
      if (bytes[index + 1] === QUOTE) {
        field.push(QUOTE);
        index += 2;
        continue;
      }
      // A closing quote must be followed by a delimiter, the record delimiter or the end of input.
      quoted = false;
      quotedFieldClosed = true;
      const after = index + 1;
      if (after === length) {
        index = after;
        break;
      }
      if (bytes[after] === separator) {
        fields.push(field);
        field = [];
        quotedFieldClosed = false;
        index = after + 1;
        continue;
      }
      const terminator = recordDelimiterAt(after);
      if (terminator === 0) {
        fail(after + 0.5);
        break;
      }
      endRecord(after + terminator - 1, after + terminator);
      index = after + terminator;
      continue;
    }
    if (byte === separator) {
      fields.push(field);
      field = [];
      index++;
      continue;
    }
    const terminator = recordDelimiterAt(index);
    if (terminator > 0) {
      endRecord(index + terminator - 1, index + terminator);
      index += terminator;
      continue;
    }
    if (byte === QUOTE) {
      if (field.length > 0) {
        fail(index + 0.5);
        break;
      }
      quoted = true;
      index++;
      continue;
    }
    field.push(byte);
    index++;
  }
  if (stopped === Infinity) {
    if (quoted) fail(length + 0.5);
    // The end of input closes the last record after a final check for a truncated character (length + 0.1).
    else if (fields.length > 0 || field.length > 0 || quotedFieldClosed) endRecord(length, length);
  }

  // A record that grows past the limit fails at the byte that does it, if parsing got that far.
  const partial = { start: recordStart, size: Math.min(stopped === Infinity ? length : Math.ceil(stopped), length) - recordStart };
  for (const record of [...records, partial]) {
    if (record.size > maxRecordBytes) {
      errors.push({ position: record.start + maxRecordBytes + 0.25, code: 'LIMIT_EXCEEDED', message: 'A serialized record exceeds maxRecordBytes.', line: lineOf(record.start) });
      break;
    }
  }
  // The header's names are checked once it is complete.
  const header = records[0];
  if (header !== undefined && (header.fields.some((name) => name.trim().length === 0 || RESERVED.includes(name)) || new Set(header.fields).size !== header.fields.length)) {
    errors.push({ position: header.position + 0.1, code: 'PARSE_ERROR', message: 'CSV headers must be nonempty, unique, and must not use reserved object keys.', line: header.line });
  }

  const first = errors.sort((left, right) => left.position - right.position)[0];
  const before = first === undefined ? records : records.filter((record) => record.position < first.position);
  const values = before.slice(1).map(({ fields: values, line }) => ({
    value: Object.fromEntries(header.fields.map((name, column) => [name, values[column]])),
    line,
  }));
  return { records: values, error: first === undefined ? undefined : { code: first.code, message: first.message, line: first.line } };
}
