import { csvReader } from '@altitud-studio/importkit';
import { wasmCsvReader } from '../dist/index.js';

/** Both readers, so every behavior test runs against the reference and the WebAssembly reader. */
export const readers = [['csvReader', csvReader], ['wasmCsvReader', wasmCsvReader]];

export async function* pieces(input, size = 3) {
  const bytes = typeof input === 'string' ? Buffer.from(input) : input;
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
}

export async function records(reader, input, { size = 3, maxRecordBytes = 1024 } = {}) {
  return Array.fromAsync(reader.read(pieces(input, size), { maxRecordBytes }));
}

export async function read(reader, input, options) {
  return (await records(reader, input, options)).map((record) => record.value);
}

/** Records as plain data: null-prototype values become ordinary objects for deep comparison. */
export const plain = (list) => list.map(({ value, line }) => ({ value: { ...value }, line }));

/** The outcome of reading: every record yielded, then the error, if any, as code, message and line. */
export async function outcome(reader, chunks, maxRecordBytes) {
  const yielded = [];
  try {
    for await (const record of reader.read(chunks, { maxRecordBytes })) yielded.push(record);
    return { records: plain(yielded), error: undefined };
  } catch (error) {
    if (typeof error?.code !== 'string') throw error;
    return { records: plain(yielded), error: { code: error.code, message: error.message, line: error.line } };
  }
}
