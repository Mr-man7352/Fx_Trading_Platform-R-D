/**
 * FE-004 — emit JSON Schema for every registered contract to dist/schemas/.
 * Python CI runs datamodel-code-generator over these files (QN-003).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { contractSchemas } from '../src/index.js';

const outDir = join(import.meta.dirname, '..', 'dist', 'schemas');
mkdirSync(outDir, { recursive: true });

for (const [name, schema] of Object.entries(contractSchemas)) {
  const jsonSchema = z.toJSONSchema(schema, { target: 'draft-2020-12' });
  const file = join(outDir, `${name}.json`);
  writeFileSync(file, `${JSON.stringify({ title: name, ...jsonSchema }, null, 2)}\n`);
  console.log(`emitted ${file}`);
}
