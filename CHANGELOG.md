# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `wasmCsvReader(options)`: an ImportKit reader for CSV whose parser is Rust compiled to WebAssembly. It accepts the options of `csvReader()`, shares its reader ID, and yields the same records, values and line numbers, so either reader can resume an import the other started.
- `importkit-csv`, the dependency-free Rust crate behind it, with the dialect and error order documented in `docs/design.md`.
- Conformance tests: ImportKit's CSV reader tests against both readers, a differential property test against `csvReader()` and a reference model, and import tests that resume across readers.
- `npm run benchmark`, which compares both readers alone and in a full import.
