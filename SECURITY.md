# Security policy

`wasmCsvReader()` parses bytes that ImportKit hands it, in a WebAssembly instance inside your Node.js process. It reads no files and opens no connections of its own; ImportKit's source, limits and callbacks decide what reaches it.

## Report a vulnerability

Use GitHub's **Report a vulnerability** option on this repository. If it is unavailable, contact [Altitud Studio](https://altitudstudio.ad/en/#contact) and ask for a private channel.

Do not put credentials, customer files or exploit details in a public issue. A synthetic reproduction, the affected version or commit and the potential impact help us investigate. Fixes are released in a new version of the latest release line.

## Supported versions

| Version | Security fixes |
| --- | --- |
| 0.x | Yes, in the latest 0.x release |

## Threat model

| Input | Trusted | How the reader handles it |
| --- | --- | --- |
| Source content | No | Rejects invalid UTF-8, malformed quoting, inconsistent field counts and reserved header names, and fails a record as soon as it exceeds `maxRecordBytes`, so an unbounded record never reaches memory. Builds records without a prototype. Error messages never include source values. |
| `maxRecordBytes` and the delimiter | Chosen by your application | Validated as ImportKit's `csvReader()` validates them. |
| The WebAssembly module | Shipped in the package | Compiled from `crates/csv` with the pinned Rust toolchain. The crate has no dependencies and denies unsafe code; its exports only read and write the instance's own linear memory. |

Each `read()` uses its own WebAssembly instance, so concurrent imports share no parser state. Memory per instance is bounded by one 64 KiB piece of input plus the largest record allowed.

ImportKit's [security policy](https://github.com/Altitud-Studio-S-L-U/importkit/blob/main/SECURITY.md) covers sources, checkpoints and callbacks.
