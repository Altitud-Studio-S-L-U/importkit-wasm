// Generated CSV, broken CSV, random pieces and limits: three implementations must agree.
import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { csvReader } from '@altitud-studio/importkit';
import { wasmCsvReader } from '../dist/index.js';
import { outcome } from './helpers.mjs';
import { referenceRead } from './reference.mjs';

const RUNS = Number(process.env.DIFFERENTIAL_RUNS ?? 3000);

const textPart = fc.constantFrom('a', 'b', 'Z', '0', ' ', ',', ';', '\t', '"', '\r', '\n', 'é', '東', '🚀', '﻿');
const text = fc.array(textPart, { maxLength: 6 }).map((parts) => parts.join(''));

/** A field as it appears in the file: quoted when it must be, and sometimes when it need not be. */
const serialized = (value, delimiter, quoteAnyway) => {
  const needsQuotes = /["\r\n]/u.test(value) || value.includes(delimiter);
  return needsQuotes || quoteAnyway ? `"${value.replaceAll('"', '""')}"` : value;
};

const csvFile = fc.record({
  delimiter: fc.constantFrom(',', ';', '\t'),
  columns: fc.integer({ min: 1, max: 4 }),
  rows: fc.array(fc.array(fc.tuple(text, fc.boolean()), { minLength: 4, maxLength: 4 }), { maxLength: 6 }),
  header: fc.uniqueArray(fc.constantFrom('id', 'name', 'note', 'Ñ', 'a b', 'x'), { minLength: 4, maxLength: 4 }),
  newline: fc.constantFrom('\n', '\r\n', '\r'),
  finalNewline: fc.boolean(),
  bom: fc.boolean(),
}).map(({ delimiter, columns, rows, header, newline, finalNewline, bom }) => {
  const lines = [header.slice(0, columns).join(delimiter), ...rows.map((row) => row.slice(0, columns).map(([value, quote]) => serialized(value, delimiter, quote)).join(delimiter))];
  return { delimiter, bytes: Buffer.from(`${bom ? '﻿' : ''}${lines.join(newline)}${finalNewline ? newline : ''}`) };
});

/** Byte-level damage: insertions, deletions and replacements with the bytes that matter to the dialect. */
const damage = fc.array(fc.record({
  kind: fc.constantFrom('insert', 'delete', 'replace'),
  at: fc.nat(),
  byte: fc.constantFrom(0x22, 0x0d, 0x0a, 0x2c, 0x3b, 0x09, 0xc3, 0x28, 0xff, 0xef, 0xbb, 0xbf, 0xe6, 0xf0, 0x80, 0x61),
}), { maxLength: 3 });

const applyDamage = (bytes, edits) => {
  const result = [...bytes];
  for (const { kind, at, byte } of edits) {
    const index = result.length === 0 ? 0 : at % (result.length + (kind === 'insert' ? 1 : 0));
    if (kind === 'insert') result.splice(index, 0, byte);
    else if (result.length > 0 && kind === 'delete') result.splice(index, 1);
    else if (result.length > 0) result[index] = byte;
  }
  return Buffer.from(result);
};

async function* split(bytes, sizes) {
  let offset = 0;
  for (let index = 0; offset < bytes.length; index++) {
    const size = sizes.length === 0 ? bytes.length : sizes[index % sizes.length];
    yield bytes.subarray(offset, offset + size);
    offset += size;
  }
}

const isPrefix = (shorter, longer) => shorter.length <= longer.length && shorter.every((record, index) => {
  try {
    assert.deepEqual(record, longer[index]);
    return true;
  } catch {
    return false;
  }
});

test('wasmCsvReader equals the reference model, and csvReader agrees on every valid input', async () => {
  const tally = { valid: 0, invalid: 0, sameErrorAsCsvReader: 0 };
  await fc.assert(fc.asyncProperty(
    csvFile,
    damage,
    fc.oneof(fc.constant(1024), fc.integer({ min: 1, max: 48 })),
    fc.array(fc.integer({ min: 1, max: 9 }), { maxLength: 4 }),
    async ({ delimiter, bytes: clean }, edits, maxRecordBytes, sizes) => {
      const bytes = applyDamage(clean, edits);
      const expected = referenceRead(bytes, { delimiter, maxRecordBytes });
      const wasm = await outcome(wasmCsvReader({ delimiter }), split(bytes, sizes), maxRecordBytes);
      assert.deepEqual(wasm, expected, `input ${JSON.stringify(bytes.toString('latin1'))}`);
      const csv = await outcome(csvReader({ delimiter }), split(bytes, sizes), maxRecordBytes);
      if (expected.error === undefined) {
        tally.valid++;
        assert.deepEqual(csv, expected, `csvReader on ${JSON.stringify(bytes.toString('latin1'))}`);
      } else {
        tally.invalid++;
        assert.notEqual(csv.error, undefined, `csvReader accepted ${JSON.stringify(bytes.toString('latin1'))}`);
        assert.ok(isPrefix(csv.records, expected.records) || isPrefix(expected.records, csv.records), 'records before an error');
        try {
          assert.deepEqual(csv.error, expected.error);
          tally.sameErrorAsCsvReader++;
        } catch { /* Inputs with several errors may differ; docs/design.md explains why. */ }
      }
    },
  ), { numRuns: RUNS });
  test.diagnostic?.(JSON.stringify(tally));
  console.log(`differential: ${JSON.stringify(tally)}`);
  assert.ok(tally.valid > RUNS / 10 && tally.invalid > RUNS / 10, 'both valid and invalid inputs were generated');
});
