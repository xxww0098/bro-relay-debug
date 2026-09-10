import { buildSkill } from './build.mjs';
import { cp, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'skills', 'bro-connect');
await buildSkill(root);
await mkdir(destination, { recursive: true });
await cp(join(root, 'skills/bro-connect'), destination, { recursive: true });
await rm(join(destination, 'runtime.json'), { force: true });
console.log(JSON.stringify({ skill: 'bro-connect', path: destination }));
