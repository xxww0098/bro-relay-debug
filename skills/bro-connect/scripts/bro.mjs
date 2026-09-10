#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

let cli = fileURLToPath(new URL('../../../cli/index.js', import.meta.url));
try {
  ({ cli } = JSON.parse(await readFile(new URL('../runtime.json', import.meta.url), 'utf8')));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('error', () => { console.error('Bro Relay Debug runtime unavailable. Run npm run skill:install in the project.'); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
