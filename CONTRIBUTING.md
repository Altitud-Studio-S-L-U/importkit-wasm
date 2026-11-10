# Contributing

Changes are proposed through pull requests. Fork the repository, create a focused branch, and explain the observable behavior your change adds or fixes. The maintainer controls merges into the protected default branch.

## Local setup

Use Node.js 24 or newer, npm and rustup. `rust-toolchain.toml` selects the Rust version and installs the `wasm32-unknown-unknown` target.

```sh
npm ci
npm run check
npm run benchmark -- 50 2
```

`npm run check` checks Rust formatting, runs clippy for the host and WebAssembly targets, runs the Rust tests, type-checks the TypeScript, builds the package and runs the JavaScript tests: ImportKit's CSV reader tests against both readers, the import tests, and the differential property test. `DIFFERENTIAL_RUNS=50000 npm test` runs a longer differential search.

Every pull request runs the same checks on Linux, macOS and Windows with Node.js 24 and 26, and a CodeQL scan of the Rust, TypeScript and workflow sources. Include the results of the checks you ran in your pull request. Releases are published by the maintainer.

## Before opening a pull request

- Read [docs/design.md](docs/design.md). The reader shares `csvReader()`'s ID, so any change to which records it yields, or to their values or lines, breaks resumed imports; such a change belongs in ImportKit's reader first.
- Change the reference model in `test/reference.mjs` together with the parser, and explain the rule it encodes.
- Add a Rust test or a reader test for every fixed behavior. Preserve valid tests; do not weaken an assertion or lower `DIFFERENTIAL_RUNS` to make the suite pass.
- Report benchmark figures with their command, the platform line of the report and the number of rounds.
- Keep the crate free of dependencies and unsafe code outside `src/abi.rs`.
- Keep secrets, customer data, generated builds and downloaded dependencies out of commits.

For suspected vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
