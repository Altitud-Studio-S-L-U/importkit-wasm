// Builds the WebAssembly module with the pinned Rust toolchain, then the TypeScript wrapper, into dist/.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, shell: false });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}.`);
};

rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true });
run('cargo', ['build', '--release', '--locked', '--target', 'wasm32-unknown-unknown', '--package', 'importkit-csv']);
run(process.execPath, [fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)), '-p', 'tsconfig.json']);
mkdirSync(new URL('../dist', import.meta.url), { recursive: true });
copyFileSync(new URL('../target/wasm32-unknown-unknown/release/importkit_csv.wasm', import.meta.url), new URL('../dist/importkit_csv.wasm', import.meta.url));
