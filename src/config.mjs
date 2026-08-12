import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Load a local install configuration without adding another runtime dependency.
// .env is gitignored and is created by the Windows installer on the teacher's PC.
export function loadLocalEnv(root) {
  const file = join(root, '.env');
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}
