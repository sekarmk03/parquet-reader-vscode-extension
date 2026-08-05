// Generates the fixtures used to exercise the viewer.
import { parquetWriteFile } from 'hyparquet-writer'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const out = name => join(here, name)

const N = 250

parquetWriteFile({
  filename: out('sample.parquet'),
  compressed: true,
  columnData: [
    { name: 'id', type: 'INT64', data: Array.from({ length: N }, (_, i) => BigInt(i + 1)) },
    {
      name: 'name',
      type: 'STRING',
      data: Array.from({ length: N }, (_, i) => (i % 17 === 0 ? null : `user_${i}`)),
    },
    {
      name: 'score',
      type: 'DOUBLE',
      data: Array.from({ length: N }, (_, i) =>
        i % 23 === 0 ? null : Math.round(i * 1.37 * 100) / 100,
      ),
    },
    { name: 'active', type: 'BOOLEAN', data: Array.from({ length: N }, (_, i) => i % 2 === 0) },
    {
      name: 'created_at',
      type: 'TIMESTAMP',
      data: Array.from({ length: N }, (_, i) => new Date(Date.UTC(2024, 0, 1 + (i % 365)))),
    },
  ],
})

// Zero rows: the table must still render its header.
parquetWriteFile({
  filename: out('empty.parquet'),
  columnData: [
    { name: 'id', type: 'INT64', data: [] },
    { name: 'name', type: 'STRING', data: [] },
  ],
})

// Nested values: the grid shortens them, the detail pane must show them whole.
parquetWriteFile({
  filename: out('nested.parquet'),
  compressed: true,
  columnData: [
    { name: 'id', type: 'INT64', data: [1n, 2n, 3n] },
    {
      name: 'payload',
      type: 'VARIANT',
      shredding: true,
      data: [
        { user: { id: 42, name: 'x'.repeat(300), tags: ['a', 'b', 'c'] }, meta: { ok: true } },
        { user: { id: 7, name: 'short', tags: [] }, meta: { ok: false } },
        null,
      ],
    },
  ],
})

// Not a parquet file at all: the viewer must show a readable error.
writeFileSync(out('broken.parquet'), 'this is plain text, not parquet\n')

console.log('fixtures written: sample.parquet, empty.parquet, nested.parquet, broken.parquet')
