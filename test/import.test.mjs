// End to end through ImportKit: the same record IDs, and an import started with one reader resumes with the other.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { csvReader, fileCheckpointStore, fileSource, importFile } from '@altitud-studio/importkit';
import { wasmCsvReader } from '../dist/index.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'importkit-wasm-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'orders.csv');
  const rows = Array.from({ length: 250 }, (_, index) => `${index},"Customer ${index % 7}, ""VIP""",${(index * 3.5).toFixed(2)}`);
  await writeFile(path, `﻿id,customer,amount\r\n${rows.join('\r\n')}\r\n`);
  return { directory, path };
}

const options = (path, reader, extra) => ({
  source: fileSource(path), reader, importId: 'orders-2026-11', transformVersion: 'v1', batchSize: 40, mapRecord: (value) => value, ...extra,
});

test('both readers import the same records with the same IDs and contexts', async (t) => {
  const { directory, path } = await fixture(t);
  const runs = [];
  for (const [name, reader] of [['csv', csvReader()], ['wasm', wasmCsvReader()]]) {
    const delivered = [];
    const result = await importFile(options(path, reader, {
      checkpointStore: fileCheckpointStore(join(directory, `${name}.json`)),
      mapRecord: (value, context) => ({ value: { ...value }, context }),
      async commitBatch(records) { delivered.push(...records); },
    }));
    assert.equal(result.status, 'completed');
    runs.push({ delivered, sourceHash: result.sourceHash });
  }
  assert.equal(runs[1].delivered.length, 250);
  assert.deepEqual(runs[1], runs[0]);
});

test('an import that csvReader started resumes with wasmCsvReader, and the reverse', async (t) => {
  const { directory, path } = await fixture(t);
  for (const [first, second] of [[csvReader, wasmCsvReader], [wasmCsvReader, csvReader]]) {
    const checkpointStore = fileCheckpointStore(join(directory, `${first.name}-then-${second.name}.json`));
    const delivered = new Map();
    let batches = 0;
    await assert.rejects(importFile(options(path, first(), {
      checkpointStore,
      async commitBatch(records) {
        if (++batches === 3) throw new Error('destination unavailable');
        for (const { id, index } of records) delivered.set(id, index);
      },
    })), (error) => error.cause?.message === 'destination unavailable');
    const resumed = await importFile(options(path, second(), {
      checkpointStore,
      async commitBatch(records) { for (const { id, index } of records) delivered.set(id, index); },
    }));
    assert.equal(resumed.status, 'completed');
    assert.equal(resumed.resumedFrom, 80);
    assert.deepEqual([...delivered.values()].sort((a, b) => a - b), Array.from({ length: 250 }, (_, index) => index + 1));
  }
});
