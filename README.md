# ImportKit WASM

[![CI](https://github.com/Altitud-Studio-S-L-U/importkit-wasm/actions/workflows/ci.yml/badge.svg)](https://github.com/Altitud-Studio-S-L-U/importkit-wasm/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Altitud-Studio-S-L-U/importkit-wasm/actions/workflows/codeql.yml/badge.svg)](https://github.com/Altitud-Studio-S-L-U/importkit-wasm/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A CSV reader for [ImportKit](https://github.com/Altitud-Studio-S-L-U/importkit) whose parser is Rust compiled to WebAssembly. It yields the same records, line numbers and errors as ImportKit's `csvReader()` and carries the same reader ID, so it is a drop-in replacement: an import started with one reader resumes with the other.

On a 200 MB CSV it reads 3.5 times faster than `csvReader()`, and a full import takes 1.75 times less time.

## Install

The package is not on npm yet. Build it from a checkout with Node.js 24 or newer and [rustup](https://rustup.rs), then install it next to ImportKit:

```sh
git clone https://github.com/Altitud-Studio-S-L-U/importkit-wasm.git
cd importkit-wasm
npm ci
npm run build
cd /path/to/your-app
npm install @altitud-studio/importkit /path/to/importkit-wasm
```

`rust-toolchain.toml` selects the Rust version and installs the WebAssembly target. ImportKit 1.x is a peer dependency.

## Use

Replace `csvReader()` with `wasmCsvReader()`. It takes the same `delimiter` option.

```ts
import { fileCheckpointStore, fileSource, importFile } from '@altitud-studio/importkit';
import { wasmCsvReader } from '@altitud-studio/importkit-wasm';

const result = await importFile({
  source: fileSource('./uploads/orders.csv'),
  reader: wasmCsvReader(),
  importId: 'orders-2026-11',
  transformVersion: 'orders-v1',
  checkpointStore: fileCheckpointStore('./checkpoints/orders-2026-11.json'),
  mapRecord: (input) => parseOrder(input),
  async commitBatch(records) {
    await saveOrders(records);
  },
});
```

`validateFile()` accepts it the same way.

## Same records, same IDs

ImportKit derives every record's ID from the reader ID, so two readers may share an ID only if they yield the same records. `wasmCsvReader()` is held to that:

- **Valid input**: the same values, field order and line numbers as `csvReader()`.
- **Input with one error**: the same `ImportKitError` code, message and line.
- **Input with several errors**: the first error in source order. `csvReader()` can report a later one; [docs/design.md](docs/design.md#contract) explains why.

Three kinds of tests check it:

- ImportKit's CSV reader tests run against both readers.
- A property test generates CSV, damages it with the bytes that matter to the dialect, splits it into random pieces and limits, and compares three implementations: `wasmCsvReader()`, `csvReader()` and a small reference model in `test/reference.mjs`. A search of 50,000 inputs found no difference on valid input, and on 94.7% of the invalid inputs `csvReader()` reported exactly the same error.
- Import tests deliver the same record IDs through both readers, and resume a failed import with the other reader in both directions.

## Performance

`npm run benchmark -- 200 3` generates a 200 MB CSV of 2,570,193 records with seven columns, some quoted with embedded delimiters, quotes and non-ASCII text. It times each reader on its own, then a full `importFile()` whose destination does nothing. Three rounds with ImportKit 1.0.0 on Node.js 24.11.1, Windows x64 with 16 logical cores:

| | `csvReader()` | `wasmCsvReader()` | Median speedup |
| --- | ---: | ---: | ---: |
| Read and build records | 11.1–11.2 s | 3.1–3.2 s | 3.51× |
| Full import | 18.8–19.9 s | 11.1–11.3 s | 1.75× |

A full import also hashes the file, derives record IDs, batches and maps records, so a faster reader shortens only part of it. The report names the platform but not the machine: no CPU model, memory size, host name or paths.

## How it works

`crates/csv` is a Rust crate with no dependencies. Its parser is a byte-level state machine that validates UTF-8, applies the dialect and the record size limit, and counts lines while it consumes pieces of input of any size. Runs of plain ASCII inside a field are copied at once; every other byte takes the full path, so errors are reported at the same byte either way.

After each 64 KiB piece, the completed records are exposed as one buffer of unescaped UTF-8 with the end of every field in UTF-16 code units. JavaScript decodes one string per piece and slices the fields from it. Each `read()` has its own WebAssembly instance, holding at most one piece and one partial record. The crate denies unsafe code; the WebAssembly exports in `src/abi.rs` need only `#[unsafe(no_mangle)]`.

[docs/design.md](docs/design.md) states the dialect rule by rule, the error order and the architecture.

## Limits

- CSV only. `jsonlReader()` already uses V8's native `JSON.parse`.
- Node.js 24 or newer, like ImportKit.
- The first record is the header, as with `csvReader()`.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for the checks to run and [SECURITY.md](SECURITY.md) for the threat model and private vulnerability reports.

[MIT license](LICENSE), copyright 2026 Altitud Studio SLU.
