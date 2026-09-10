#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const cli = fileURLToPath(new URL('./runtime/cli/index.js', import.meta.url));
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('error', () => { console.error('Bro Relay Debug runtime unavailable. Copy the complete bro-connect skill directory.'); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
