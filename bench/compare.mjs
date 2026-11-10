// Compares csvReader() and wasmCsvReader() on a generated CSV: the reader alone, then a full import with a
// destination that does nothing. Usage: node bench/compare.mjs [megabytes = 200] [rounds = 3]
// The JSON report names the platform, never the machine: no CPU model, memory size, host name or paths.
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { csvReader, fileSource, importFile } from '@altitud-studio/importkit';
import { wasmCsvReader } from '../dist/index.js';

const megabytes = Number(process.argv[2] ?? 200);
const rounds = Number(process.argv[3] ?? 3);
if (!Number.isInteger(megabytes) || megabytes < 1 || megabytes > 10_000 || !Number.isInteger(rounds) || rounds < 1 || rounds > 20) {
  throw new Error('Usage: node bench/compare.mjs [megabytes 1-10000] [rounds 1-20]');
}

const directory = await mkdtemp(join(tmpdir(), 'importkit-wasm-bench-'));
const path = join(directory, 'orders.csv');
let rows = 0;
let bytes = 0;
{
  const file = await open(path, 'w');
  const header = 'id,customer,email,amount,currency,status,note\n';
  await file.write(header);
  bytes += header.length;
  let batch = [];
  while (bytes < megabytes * 1_000_000) {
    // Mostly plain fields; every eleventh note is quoted with an embedded delimiter and escaped quotes.
    const note = rows % 11 === 0 ? '"quoted, ""with"" comma"' : rows % 13 === 0 ? 'café ñandú 東京' : 'standard order';
    const line = `${rows},Customer ${rows % 997},user${rows}@example.test,${(rows * 37 % 100_000 / 100).toFixed(2)},EUR,${rows % 7 ? 'paid' : 'refunded'},${note}\n`;
    batch.push(line);
    bytes += Buffer.byteLength(line);
    rows++;
    if (batch.length === 10_000) {
      await file.write(batch.join(''));
      batch = [];
    }
  }
  await file.write(batch.join(''));
  await file.close();
}

const elapsed = async (action) => {
  const start = process.hrtime.bigint();
  const result = await action();
  return { ms: Number(process.hrtime.bigint() - start) / 1e6, result };
};
const readAll = async (reader) => {
  let count = 0;
  for await (const _record of reader.read(createReadStream(path, { highWaterMark: 65_536 }), { maxRecordBytes: 1_048_576 })) count++;
  return count;
};
const importAll = (reader, round) => importFile({
  source: fileSource(path), reader, importId: `bench-${round}`, transformVersion: 'v1', batchSize: 1_000,
  maxSourceBytes: 2 ** 40, maxRecords: 1e12, mapRecord: (value) => value,
  checkpointStore: { async load() { return undefined; }, async save() {} },
  async commitBatch() {},
});

const results = { reader: { csvReader: [], wasmCsvReader: [] }, import: { csvReader: [], wasmCsvReader: [] } };
const readers = { csvReader, wasmCsvReader };
for (let round = 0; round < rounds; round++) {
  for (const [name, make] of Object.entries(readers)) {
    const read = await elapsed(() => readAll(make()));
    if (read.result !== rows) throw new Error(`${name} read ${read.result} of ${rows} records.`);
    results.reader[name].push(read.ms);
    const imported = await elapsed(() => importAll(make(), round));
    if (imported.result.status !== 'completed' || imported.result.processedRecords !== rows) throw new Error(`${name} did not import every record.`);
    results.import[name].push(imported.ms);
  }
}
await rm(directory, { recursive: true, force: true });

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const summary = (phase) => {
  const csv = median(results[phase].csvReader);
  const wasm = median(results[phase].wasmCsvReader);
  return {
    csvReaderMs: results[phase].csvReader.map(Math.round),
    wasmCsvReaderMs: results[phase].wasmCsvReader.map(Math.round),
    medianSpeedup: Number((csv / wasm).toFixed(2)),
    wasmMegabytesPerSecond: Number((bytes / 1e6 / (wasm / 1000)).toFixed(1)),
  };
};
const require = createRequire(import.meta.url);
console.log(JSON.stringify({
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  logicalCores: availableParallelism(),
  importkit: require('@altitud-studio/importkit/package.json').version,
  bytes,
  records: rows - 0,
  rounds,
  reader: summary('reader'),
  import: summary('import'),
}, null, 2));
