# Design

`wasmCsvReader()` is a CSV reader for [ImportKit](https://github.com/Altitud-Studio-S-L-U/importkit) whose parser is written in Rust and runs as WebAssembly. It yields the same records as ImportKit's `csvReader()` and carries the same reader ID, so the two are interchangeable within an import.

## Why

A profile of ImportKit 1.0 on a synthetic 200 MB CSV (2,583,975 records, seven columns, Node.js 24.11.1, Windows x64) showed where an import spends its time:

| Step | Time |
| --- | ---: |
| Read the file and hash it | 0.4 s |
| `csv-parse` alone, producing arrays | 8.0 s |
| `csvReader()`: `csv-parse` plus record objects, line numbers and limits | 10.6 s |
| Derive 2,583,975 record IDs | 4.5 s |
| `importFile()` with a destination that does nothing | 18.4–18.6 s |

Parsing is the largest share, and it is CPU work on bytes, which is where a compiled parser helps. A prototype of this crate parsed the same file and built the same objects in 2.4 s. Record IDs were made faster in ImportKit itself, without Rust.

## Contract

- `wasmCsvReader(options)` accepts the options of `csvReader(options)`, rejects the same invalid ones, and returns a reader whose `id` equals `csvReader(options).id`.
- Record IDs include the reader ID. Sharing it is safe only because, for every valid input, both readers yield the same records: the same values, field order and line numbers. An import can start with one reader and resume with the other.
- For an input with one error, both readers fail with the same `ImportKitError` code, message and line.
- For an input with more than one error, `wasmCsvReader` reports the first in source order. `csvReader` can report a later one: it validates UTF-8 one part ahead of parsing, and its parser and consumer run concurrently.
- Records yielded before an error are always records of the input, in order.

## CSV dialect

These are the rules of `csvReader()`, which configures `csv-parse` 7 with `bom: true`, `columns: false`, `skip_empty_lines: false`, `relax_column_count: false` and `max_record_size`. Bytes, not characters, are counted.

1. Input must be valid UTF-8. A UTF-8 byte order mark at the start is skipped but counts toward the first record's size.
2. The field delimiter is one ASCII byte other than `"`, CR, LF or NUL; the default is `,`.
3. The record delimiter is the first of CRLF, LF or CR found outside quotes, checked in that order. Afterwards only that sequence ends a record; the other line-break bytes are field content.
4. A field that starts with `"` is quoted: delimiters and line breaks inside it are content, and `""` is one quote. Its closing quote must be followed by a field delimiter, the record delimiter or the end of input. Before the record delimiter is known, any CR or LF counts as its start.
5. A `"` inside an unquoted field that already has content is an error.
6. A line with no content is a record with one empty field.
7. The end of input ends the last record if it has a field, content or a quoted field. A trailing record delimiter does not start another record.
8. A quoted field still open at the end of input is an error.
9. The first record is the header. Every record must have as many fields as the header. Header names must be nonempty after trimming, unique, and none of `__proto__`, `prototype` or `constructor`.
10. A record's serialized size runs from its first byte through its record delimiter, or through the end of input for the last record. A record larger than `maxRecordBytes` is an error, raised as soon as its bytes exceed the limit, so an unbounded record never reaches memory.
11. A record's line is one plus the number of LF bytes before its first byte. CR alone does not start a line.

## Errors

| Cause | Code | Message | Line |
| --- | --- | --- | --- |
| Invalid UTF-8 | `PARSE_ERROR` | Input must contain valid UTF-8. | none |
| Rules 5, 8 or a field count that differs from the header's | `PARSE_ERROR` | Invalid CSV input. | the record's |
| Rule 9 header names | `PARSE_ERROR` | CSV headers must be nonempty, unique, and must not use reserved object keys. | the header's |
| Rule 10 | `LIMIT_EXCEEDED` | A serialized record exceeds maxRecordBytes. | the record's |

Messages never contain input values.

## Architecture

- `crates/csv` is a Rust library with no dependencies. `Parser` is a byte-level state machine that consumes input in pieces of any size and keeps one partial record between them. It validates UTF-8, applies the dialect and the size limit, and counts lines.
- After each piece, the parser exposes the completed records as one buffer of unescaped UTF-8 field content, the end of every field in UTF-16 code units, the field count and the line of every record. JavaScript decodes one string per piece and slices the fields from it, instead of decoding every field.
- `src/abi.rs` exports that state to WebAssembly through a small C ABI, without `wasm-bindgen`.
- The JavaScript reader compiles the module once per process and creates one instance per `read()`, so concurrent imports share no state. An instance holds at most one piece of input and one partial record.
- ImportKit is a peer dependency: errors are ImportKit's own `ImportKitError`, and its `csvReader()` is the reference in the tests.

## Verification

- Rust unit tests cover the state machine.
- Every CSV test of ImportKit's reader suite runs against both readers.
- A property test generates CSV and broken CSV, splits it into random pieces and limits, and compares three implementations. For valid inputs the records of `wasmCsvReader`, `csvReader` and a small reference model in `test/reference.mjs` must be identical. For invalid inputs `wasmCsvReader` must equal the reference model, which encodes the source-order rule, and `csvReader` must also fail.
- A benchmark compares both readers and full imports on generated files, and its report records the platform without machine details.
