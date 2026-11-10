import { readFile } from 'node:fs/promises';
import { ImportKitError, type ParsedRecord, type ReaderLimits, type RecordReader } from '@altitud-studio/importkit';

/** Options of `wasmCsvReader()`, the same as those of ImportKit's `csvReader()`. */
export interface WasmCsvReaderOptions {
  readonly delimiter?: string;
}

/** Bytes handed to the parser per call. Bounds the records completed, and the memory used, per call. */
const PIECE_BYTES = 65_536;

const UTF8_ERROR = 1;
const RECORD_SIZE_ERROR = 4;
const RESERVED_HEADERS = ['__proto__', 'prototype', 'constructor'];

interface ParserExports {
  readonly memory: { readonly buffer: ArrayBuffer };
  start(delimiter: number, maxRecordBytes: number): void;
  input(length: number): number;
  feed(): number;
  finish(): number;
  error_line(): number;
  records(): number;
  content_ptr(): number;
  content_len(): number;
  ends_ptr(): number;
  ends_len(): number;
  counts_ptr(): number;
  lines_ptr(): number;
  consume(): void;
}

let compiled: Promise<WebAssembly.Module> | undefined;

/** Compiles the module once per process; a failed compilation is retried by the next reader. */
function parserModule(): Promise<WebAssembly.Module> {
  if (compiled !== undefined) return compiled;
  const compiling = readFile(new URL('./importkit_csv.wasm', import.meta.url))
    .then((bytes) => WebAssembly.compile(bytes))
    .catch((error: unknown) => {
      compiled = undefined;
      throw error;
    });
  compiled = compiling;
  return compiling;
}

function assertReaderLimits(limits: ReaderLimits): void {
  if (!Number.isSafeInteger(limits.maxRecordBytes) || limits.maxRecordBytes < 1) {
    throw new ImportKitError('INVALID_OPTIONS', 'maxRecordBytes must be a positive safe integer.');
  }
}

function parserError(status: number, line: number): ImportKitError {
  if (status === UTF8_ERROR) return new ImportKitError('PARSE_ERROR', 'Input must contain valid UTF-8.');
  if (status === RECORD_SIZE_ERROR) return new ImportKitError('LIMIT_EXCEEDED', 'A serialized record exceeds maxRecordBytes.', { line });
  return new ImportKitError('PARSE_ERROR', 'Invalid CSV input.', { line });
}

/** Source errors keep ImportKit's own errors and wrap anything else, as `csvReader()` does. */
async function* sourceBytes(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  try {
    yield* chunks;
  } catch (error) {
    throw error instanceof ImportKitError ? error : new ImportKitError('SOURCE_ERROR', 'Unable to read source bytes.', { cause: error });
  }
}

/**
 * CSV with a header row and strict field counts, parsed by Rust compiled to WebAssembly. It yields the records,
 * lines and errors of ImportKit's `csvReader()` and shares its reader ID, so either can resume the other's import.
 */
export function wasmCsvReader(options: WasmCsvReaderOptions = {}): RecordReader {
  const delimiter = options.delimiter ?? ',';
  if (typeof delimiter !== 'string' || delimiter.length !== 1 || delimiter.charCodeAt(0) > 127 || /[\r\n"\0]/u.test(delimiter)) {
    throw new ImportKitError('INVALID_OPTIONS', 'The CSV delimiter must be one ASCII character other than quote, NUL, CR, or LF.');
  }
  const delimiterCode = delimiter.charCodeAt(0);

  return {
    id: `csv:v1:utf8-header:${delimiterCode.toString(16)}`,
    async *read(chunks, limits) {
      assertReaderLimits(limits);
      // One instance per read: concurrent imports share no parser state.
      const parser = (await WebAssembly.instantiate(await parserModule())).exports as unknown as ParserExports;
      parser.start(delimiterCode, limits.maxRecordBytes);
      // Field content is already validated UTF-8; a leading U+FEFF in it is content, not a byte order mark.
      const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
      let headers: string[] | undefined;

      // Yields the records the last call completed, then lets the parser drop them.
      function* completed(): Generator<ParsedRecord> {
        const count = parser.records();
        if (count === 0) return;
        const memory = parser.memory.buffer;
        const text = decoder.decode(new Uint8Array(memory, parser.content_ptr(), parser.content_len()));
        const ends = new Uint32Array(memory, parser.ends_ptr(), parser.ends_len());
        const counts = new Uint32Array(memory, parser.counts_ptr(), count);
        const lines = new Float64Array(memory, parser.lines_ptr(), count);
        let field = 0;
        let start = 0;
        for (let record = 0; record < count; record++) {
          const fields = new Array<string>(counts[record]!);
          for (let index = 0; index < fields.length; index++) {
            const end = ends[field++]!;
            fields[index] = text.slice(start, end);
            start = end;
          }
          const line = lines[record]!;
          if (headers === undefined) {
            if (fields.some((header) => header.trim().length === 0 || RESERVED_HEADERS.includes(header)) || new Set(fields).size !== fields.length) {
              throw new ImportKitError('PARSE_ERROR', 'CSV headers must be nonempty, unique, and must not use reserved object keys.', { line });
            }
            headers = fields;
            continue;
          }
          const value: Record<string, string> = Object.create(null) as Record<string, string>;
          for (const [index, header] of headers.entries()) value[header] = fields[index]!;
          yield { value, line };
        }
        parser.consume();
      }

      for await (const chunk of sourceBytes(chunks)) {
        for (let offset = 0; offset < chunk.byteLength; offset += PIECE_BYTES) {
          const piece = chunk.subarray(offset, offset + PIECE_BYTES);
          // input() can grow linear memory, which detaches any earlier view of it.
          const pointer = parser.input(piece.byteLength);
          new Uint8Array(parser.memory.buffer, pointer, piece.byteLength).set(piece);
          const status = parser.feed();
          // Records completed before an error precede it in the source, and so does a header error.
          yield* completed();
          if (status !== 0) throw parserError(status, parser.error_line());
        }
      }
      const status = parser.finish();
      yield* completed();
      if (status !== 0) throw parserError(status, parser.error_line());
    },
  };
}
