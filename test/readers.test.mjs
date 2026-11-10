// ImportKit's CSV reader tests, run against both readers.
import assert from 'node:assert/strict';
import test from 'node:test';
import { csvReader } from '@altitud-studio/importkit';
import { wasmCsvReader } from '../dist/index.js';
import { pieces, read, readers, records } from './helpers.mjs';

test('the WebAssembly reader shares the reader ID of csvReader for every delimiter', () => {
  for (const delimiter of [undefined, ',', ';', '\t', '|']) {
    const options = delimiter === undefined ? undefined : { delimiter };
    assert.equal(wasmCsvReader(options).id, csvReader(options).id);
  }
});

for (const [name, reader] of readers) {
  test(`${name}: preserves quoted delimiters, quotes, multiline text, CRLF, BOM, and split UTF-8`, async () => {
    const values = await read(reader(), '﻿id,note\r\n1,"Café, ""sí""\nnext"\r\n2,plain', { size: 1 });
    assert.deepEqual(values.map((value) => ({ ...value })), [{ id: '1', note: 'Café, "sí"\nnext' }, { id: '2', note: 'plain' }]);
    assert.equal(Object.getPrototypeOf(values[0]), null);
  });

  test(`${name}: supports a declared delimiter`, async () => {
    assert.deepEqual((await read(reader({ delimiter: ';' }), 'id;name\n1;one\n')).map((value) => ({ ...value })), [{ id: '1', name: 'one' }]);
  });

  test(`${name}: empty input and a header-only file contain no records`, async () => {
    assert.deepEqual(await read(reader(), ''), []);
    assert.deepEqual(await read(reader(), 'id,name\n'), []);
  });

  test(`${name}: rejects malformed input and invalid or dangerous headers`, async () => {
    for (const input of ['id,id\n1,2', 'id,\n1,2', 'id, \n1,2', '__proto__\nx', 'constructor\nx', 'prototype\nx', 'id,name\n1', 'id\n"unclosed', 'id\n"x"oops']) {
      await assert.rejects(read(reader(), input), { code: 'PARSE_ERROR' }, input);
    }
  });

  test(`${name}: rejects invalid UTF-8 without exposing values in its error`, async () => {
    await assert.rejects(read(reader(), Buffer.from([0x69, 0x64, 0x0a, 0xc3, 0x28])), (error) => error.code === 'PARSE_ERROR' && !error.message.includes('('));
    await assert.rejects(read(reader(), 'id\n"private-value"extra'), (error) => error.code === 'PARSE_ERROR' && !error.message.includes('private-value'));
  });

  test(`${name}: enforces serialized bytes, including quotes, delimiters and terminators`, async () => {
    assert.deepEqual((await read(reader(), 'a,b\n1,2\n', { maxRecordBytes: 4, size: 1 })).map((value) => ({ ...value })), [{ a: '1', b: '2' }]);
    await assert.rejects(read(reader(), 'a,b\n1,é\n', { maxRecordBytes: 4, size: 1 }), { code: 'LIMIT_EXCEEDED' });
    await assert.rejects(read(reader(), 'a,b\n"",""\n', { maxRecordBytes: 5 }), { code: 'LIMIT_EXCEEDED' });
  });

  test(`${name}: stops an unbounded record of empty fields before consuming the source`, async () => {
    let supplied = 0;
    async function* source() {
      while (supplied < 1000) {
        supplied++;
        yield Buffer.from(',');
      }
    }
    await assert.rejects(Array.fromAsync(reader().read(source(), { maxRecordBytes: 16 })), { code: 'LIMIT_EXCEEDED' });
    assert.ok(supplied <= 20, 'a rejected record may consume four bytes of parser lookahead');
  });

  test(`${name}: handles many records per chunk`, async () => {
    const result = await read(reader(), `id\n${Array.from({ length: 500 }, (_, index) => `${index}\n`).join('')}`, { size: 8192 });
    assert.equal(result.length, 500);
    assert.equal(result[499].id, '499');
  });

  test(`${name}: byte limits remain exact at chunk and record boundaries`, async () => {
    for (const ending of ['\n', '\r\n', '\r', '']) {
      const last = `"Café","a,b"${ending}`;
      const header = `name,note${ending || '\n'}`;
      const input = `${header}${last}`;
      const exactLimit = Math.max(Buffer.byteLength(header), Buffer.byteLength(last));
      for (const size of [1, 2, 3, 4, 7, 64]) {
        const values = await read(reader(), input, { size, maxRecordBytes: exactLimit });
        assert.deepEqual(values.map((value) => ({ ...value })), [{ name: 'Café', note: 'a,b' }]);
        await assert.rejects(read(reader(), input, { size, maxRecordBytes: exactLimit - 1 }), { code: 'LIMIT_EXCEEDED' });
      }
    }
  });

  test(`${name}: validates its options`, async () => {
    for (const delimiter of ['', '||', 'é', '\n', '"', '\0']) assert.throws(() => reader({ delimiter }), { code: 'INVALID_OPTIONS' });
    for (const maxRecordBytes of [0, -1, NaN, Infinity, 1.5]) {
      await assert.rejects(read(reader(), '', { maxRecordBytes }), { code: 'INVALID_OPTIONS' });
    }
  });

  test(`${name}: closes its input when the consumer stops early`, async () => {
    let closed = false;
    async function* source() {
      try {
        for (let index = 0; index < 100; index++) yield Buffer.from(index === 0 ? 'id\n0\n' : `${index}\n`);
      } finally {
        closed = true;
      }
    }
    for await (const _record of reader().read(source(), { maxRecordBytes: 32 })) break;
    assert.equal(closed, true);
  });

  test(`${name}: reports the line where each record starts, counting line breaks inside quoted fields`, async () => {
    const crlf = await records(reader(), '﻿id,note\r\n1,"two\r\nlines"\r\n2,b\r\n', { size: 2 });
    assert.deepEqual(crlf.map(({ line }) => line), [2, 4]);
    const lf = await records(reader(), 'id,note\n1,a\n2,"x\ny\nz"\n3,last', { size: 2 });
    assert.deepEqual(lf.map(({ line }) => line), [2, 3, 6]);
  });

  test(`${name}: errors report the line where the failing record starts`, async () => {
    await assert.rejects(read(reader(), 'id,id\n1,2\n'), { code: 'PARSE_ERROR', line: 1 });
    await assert.rejects(read(reader(), 'id,note\n1,a\n2\n'), { code: 'PARSE_ERROR', line: 3 });
    await assert.rejects(read(reader(), 'id,note\n1,"a\nb"\n2,"open\nstill open'), { code: 'PARSE_ERROR', line: 4 });
    await assert.rejects(read(reader(), 'id\n1\n12345\n', { maxRecordBytes: 4 }), { code: 'LIMIT_EXCEEDED', line: 3 });
  });

  test(`${name}: settles when its consumer stops while parsed rows are buffered`, { timeout: 10_000 }, async () => {
    const rows = (header) => [header, ...Array.from({ length: 40 }, (_, index) => `${index},${index}`)].join('\n');
    await assert.rejects(read(reader(), rows('id,id'), { size: 65_536 }), { code: 'PARSE_ERROR', line: 1 });
    let seen = 0;
    for await (const _record of reader().read(pieces(rows('id,name'), 65_536), { maxRecordBytes: 64 })) {
      seen++;
      break;
    }
    assert.equal(seen, 1);
  });

  test(`${name}: keeps ImportKit's source errors and wraps others as SOURCE_ERROR`, async () => {
    async function* failing(error) {
      yield Buffer.from('id\n1\n');
      throw error;
    }
    await assert.rejects(Array.fromAsync(reader().read(failing(new Error('disk')), { maxRecordBytes: 64 })), { code: 'SOURCE_ERROR' });
  });
}
