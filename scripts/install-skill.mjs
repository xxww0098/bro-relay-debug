import { cp, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'skills', 'bro-connect');
await mkdir(destination, { recursive: true });
await cp(join(root, 'skills/bro-connect'), destination, { recursive: true });
await writeFile(join(destination, 'runtime.json'), JSON.stringify({ cli: join(root, 'cli/index.js') }, null, 2) + '\n');
console.log(JSON.stringify({ skill: 'bro-connect', path: destination }));
