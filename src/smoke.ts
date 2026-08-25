/**
 * Headless check of src/parquet.ts — the half of the extension that VS Code
 * cannot exercise from a test. Run with `npm run smoke`.
 */
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { isRemote, openSource, sourceLabel } from './source'
import {
  buildInfo,
  buildSchema,
  formatCell,
  formatFull,
  humanBytes,
  openParquet,
  readCell,
  readPage,
} from './parquet'
import {
  buildSortedView,
  effectivePageSize,
  identityView,
  readViewCell,
  readViewPage,
  sortRefusal,
  totalPages,
} from './view'

const fixtures = join(__dirname, '..', 'test')

/** What package.json ships as the default; the host reads it from settings. */
const PAGE_SIZE = 100

let failures = 0

function check(label: string, condition: boolean, actual?: unknown) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures++
    console.log(`  FAIL ${label}${actual === undefined ? '' : ` — got ${JSON.stringify(actual)}`}`)
  }
}

/**
 * A throwaway origin for the remote checks. With `ranges` off it behaves like a
 * server that ignores the Range header — the case the viewer must refuse.
 */
async function serve(body: Buffer, ranges: boolean) {
  let sent = 0
  let requests = 0
  let plainGets = 0

  const server = createServer((request, response) => {
    requests++
    const asked = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? '')
    if (!ranges || !asked) {
      plainGets++
      sent += body.length
      response.writeHead(200, { 'content-length': String(body.length) })
      response.end(body)
      return
    }
    const start = Number(asked[1])
    const end = asked[2] ? Math.min(Number(asked[2]), body.length - 1) : body.length - 1
    const slice = body.subarray(start, end + 1)
    sent += slice.length
    response.writeHead(206, {
      'content-range': `bytes ${start}-${end}/${body.length}`,
      'content-length': String(slice.length),
    })
    response.end(slice)
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    bytesSent: () => sent,
    requests: () => requests,
    plainGets: () => plainGets,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

async function main() {
  console.log('\nsample.parquet')
  const path = join(fixtures, 'sample.parquet')
  const handle = await openParquet(await openSource(path))
  const info = buildInfo(handle, 'sample.parquet')
  const schema = buildSchema(handle)
  const page0 = await readPage(handle, 0, PAGE_SIZE)

  check('250 rows', info.totalRows === '250', info.totalRows)
  check('5 columns', info.totalCols === 5, info.totalCols)
  check('codec reported', info.codec === 'SNAPPY', info.codec)
  check('page holds PAGE_SIZE rows', page0.length === PAGE_SIZE, page0.length)
  check('every cell is a string', page0.every(r => r.every(c => typeof c === 'string')))

  // The postMessage boundary is JSON — a stray BigInt would throw here.
  let serialisable = true
  try {
    JSON.stringify({ info, schema, rows: page0 })
  } catch {
    serialisable = false
  }
  check('payload survives JSON.stringify (no BigInt leak)', serialisable)

  const [id, name, score, active, createdAt] = page0[0]
  check('INT64 renders as digits', id === '1', id)
  check('null renders as NULL', name === 'NULL', name)
  check('null double renders as NULL', score === 'NULL', score)
  check('boolean renders', active === 'true', active)
  check('timestamp renders readable', createdAt === '2024-01-01 00:00:00', createdAt)

  console.log('\nschema tab')
  const byName = new Map(schema.map(c => [c.name, c]))
  const idCol = byName.get('id')!
  const nameCol = byName.get('name')!
  const tsCol = byName.get('created_at')!
  check('leaf count matches', schema.length === 5, schema.length)
  check('id min/max from statistics', idCol.min === '1' && idCol.max === '250', [
    idCol.min,
    idCol.max,
  ])
  check('name null count', nameCol.nullCount === '15', nameCol.nullCount)
  check('name logical type', nameCol.logical === 'UTF8' || nameCol.logical === 'STRING', nameCol.logical)
  check('missing statistics degrade to em dash', tsCol.min === '—' && tsCol.max === '—', [
    tsCol.min,
    tsCol.max,
  ])
  check('sizes formatted', /\d (B|KB|MB)/.test(idCol.compressed), idCol.compressed)

  console.log('\npagination')
  const pages = Math.ceil(handle.totalRows / PAGE_SIZE)
  const last = await readPage(handle, pages - 1, PAGE_SIZE)
  check('3 pages for 250 rows', pages === 3, pages)
  check('last page holds the remainder', last.length === 50, last.length)
  check('page 1 starts at row 101', (await readPage(handle, 1, PAGE_SIZE))[0][0] === '101')
  check('past the end returns nothing', (await readPage(handle, 99, PAGE_SIZE)).length === 0)

  console.log('\nempty.parquet')
  const emptyHandle = await openParquet(await openSource(join(fixtures, 'empty.parquet')))
  check('reports 0 rows', emptyHandle.totalRows === 0, emptyHandle.totalRows)
  check('columns still known', emptyHandle.dataColumns.length === 2)
  check('no rows returned', (await readPage(emptyHandle, 0, PAGE_SIZE)).length === 0)
  check('schema still builds', buildSchema(emptyHandle).length === 2)

  console.log('\nnested.parquet — cell detail')
  const nested = await openParquet(await openSource(join(fixtures, 'nested.parquet')))
  const nestedRows = await readPage(nested, 0, PAGE_SIZE)
  const gridCell = nestedRows[0][1]
  const fullCell = await readCell(nested, 0, 1)

  check('nested column labelled by its logical type', nested.dataColumns[1].type === 'VARIANT',
    nested.dataColumns[1].type)
  check('grid cell stays capped at 201 chars', gridCell.length === 201, gridCell.length)
  check('detail returns far more than the grid', fullCell.length > gridCell.length, fullCell.length)
  check('detail is pretty-printed', fullCell.includes('\n  "user"'), fullCell.slice(0, 40))
  check('detail keeps the whole 300-char string', fullCell.includes('x'.repeat(300)))
  check('detail is JSON-parseable', JSON.parse(fullCell).user.tags.length === 3)
  check('null cell reads as NULL', (await readCell(nested, 2, 1)) === 'NULL')
  check('scalar cell matches the grid', (await readCell(nested, 1, 0)) === nestedRows[1][0])
  check('row past the end is NULL', (await readCell(nested, 99, 0)) === 'NULL')
  check('unknown column is NULL', (await readCell(nested, 0, 9)) === 'NULL')

  console.log('\nbroken.parquet')
  let threw = ''
  try {
    await openParquet(await openSource(join(fixtures, 'broken.parquet')))
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  check('rejects a non-parquet file', threw.length > 0, threw)

  console.log('\nremote source')
  check('http is remote', isRemote('https://x/y.parquet'))
  check('s3 is remote', isRemote('s3://bucket/key.parquet'))
  check('a plain path is not', !isRemote('/tmp/a.parquet'))
  check('label ignores the query string',
    sourceLabel('https://x/data/sample.parquet?X-Amz-Signature=abc') === 'sample.parquet')
  check('label of an s3 url', sourceLabel('s3://bucket/a/b/file.parquet') === 'file.parquet')

  const bytes = readFileSync(path)
  const ranged = await serve(bytes, true)
  try {
    const remote = await openParquet(await openSource(`${ranged.url}/sample.parquet`))
    const remoteInfo = buildInfo(remote, sourceLabel(`${ranged.url}/sample.parquet`))
    const afterOpen = ranged.requests()
    const remotePage = await readPage(remote, 1, PAGE_SIZE)

    check('reads over http', remote.totalRows === 250, remote.totalRows)
    check('size comes from Content-Range', remoteInfo.fileSize === humanBytes(bytes.length),
      remoteInfo.fileSize)
    check('every request was ranged', ranged.plainGets() === 0, ranged.plainGets())
    check('paging works over http', remotePage[0][0] === '101', remotePage[0][0])
    check('cell detail works over http', (await readCell(remote, 0, 1)) === 'NULL')
    // Under 512 KB hyparquet caches the file whole, so later reads must cost nothing.
    check('paging and cell detail hit the cache, not the network',
      ranged.requests() === afterOpen, [afterOpen, ranged.requests()])
    check('the file crossed the wire once', ranged.bytesSent() <= bytes.length + 1,
      ranged.bytesSent())
  } finally {
    await ranged.close()
  }

  const wholeFileOnly = await serve(bytes, false)
  try {
    let refused = ''
    try {
      await openSource(`${wholeFileOnly.url}/sample.parquet`)
    } catch (error) {
      refused = error instanceof Error ? error.message : String(error)
    }
    check('refuses a server that ignores Range', /Range header/.test(refused), refused)
  } finally {
    await wholeFileOnly.close()
  }

  console.log('\npage size')
  // Reading costs the same at any page size; rendering does not. See SPEC-v2.md §8.
  check('the default passes through on a narrow file', effectivePageSize(100, 5) === 100)
  check('1000 rows is allowed at 4 columns', effectivePageSize(1000, 4) === 1000)
  check('60 columns lowers it to 333', effectivePageSize(1000, 60) === 333,
    effectivePageSize(1000, 60))
  check('a very wide file still gets the floor', effectivePageSize(1000, 5000) === 25,
    effectivePageSize(1000, 5000))
  check('below the floor is raised', effectivePageSize(1, 5) === 25, effectivePageSize(1, 5))
  check('above the ceiling is capped', effectivePageSize(99999, 4) === 1000,
    effectivePageSize(99999, 4))

  console.log('\nsortable columns')
  check('a scalar column is sortable', nested.dataColumns[0].sortable === true)
  check('a nested column is not', nested.dataColumns[1].sortable === false)
  check('every sample column is sortable', handle.dataColumns.every(c => c.sortable))
  // A column the user cannot sort has to say why; silence reads as a broken header.
  const nestedReason = nested.dataColumns[1].unsortableReason ?? ''
  check('a nested column explains itself', nestedReason.length > 0, nestedReason)
  check('the explanation names the type', nestedReason.includes(nested.dataColumns[1].type),
    nestedReason)
  check('a sortable column carries no excuse',
    nested.dataColumns[0].unsortableReason === undefined)
  check('no sample column carries one',
    handle.dataColumns.every(c => c.unsortableReason === undefined))

  console.log('\nsort budget')
  const refusal = sortRefusal(handle, 10) ?? ''
  check('a small file may sort', sortRefusal(handle, 500_000) === undefined)
  check('over budget is refused', refusal.length > 0, refusal)
  check('the refusal names the file and the limit',
    refusal.includes('1,250') && refusal.includes('10'), refusal)
  check('a zero budget turns sorting off', sortRefusal(handle, 0) !== undefined)

  console.log('\nsorting')
  const identity = identityView(handle)
  const idAsc = await buildSortedView(handle, { column: 0, dir: 'asc' })
  const idDesc = await buildSortedView(handle, { column: 0, dir: 'desc' })
  const firstPage = (view: typeof identity) => readViewPage(handle, view, 0, PAGE_SIZE)
  const lastPage = (view: typeof identity) =>
    readViewPage(handle, view, totalPages(view, PAGE_SIZE) - 1, PAGE_SIZE)

  check('the identity view reads exactly like a plain page',
    JSON.stringify(await firstPage(identity)) === JSON.stringify(page0))
  check('sorting keeps every row', idAsc.total === 250, idAsc.total)

  const ascTop = await firstPage(idAsc)
  // As strings these would run 1, 10, 100 — proof the sort compared raw values.
  check('INT64 ascending is numeric, not lexicographic',
    ascTop.slice(0, 3).map(r => r[0]).join(',') === '1,2,3', ascTop.slice(0, 3).map(r => r[0]))
  check('INT64 descending starts at the largest', (await firstPage(idDesc))[0][0] === '250')
  check('a sorted middle page starts where it should',
    (await readViewPage(handle, idAsc, 1, PAGE_SIZE))[0][0] === '101')
  const ascEnd = await lastPage(idAsc)
  check('a sorted last page holds the remainder', ascEnd.length === 50, ascEnd.length)
  check('a sorted last page ends at the largest', ascEnd[ascEnd.length - 1][0] === '250')

  const nameAsc = await buildSortedView(handle, { column: 1, dir: 'asc' })
  const nameDesc = await buildSortedView(handle, { column: 1, dir: 'desc' })
  const tailValue = async (view: typeof identity, col: number) => {
    const rows = await lastPage(view)
    return rows[rows.length - 1][col]
  }
  check('STRING ascending is lexicographic', (await firstPage(nameAsc))[0][1] === 'user_1',
    (await firstPage(nameAsc))[0][1])
  check('STRING descending reverses it', (await firstPage(nameDesc))[0][1] === 'user_99',
    (await firstPage(nameDesc))[0][1])
  // NULL is the absence of a value, not the smallest one — it parks last either way.
  check('NULLs sort last ascending', (await tailValue(nameAsc, 1)) === 'NULL')
  check('NULLs sort last descending too', (await tailValue(nameDesc, 1)) === 'NULL')

  const scoreAsc = await buildSortedView(handle, { column: 2, dir: 'asc' })
  check('DOUBLE ascending starts at the smallest', (await firstPage(scoreAsc))[0][2] === '1.37',
    (await firstPage(scoreAsc))[0][2])
  const boolAsc = await buildSortedView(handle, { column: 3, dir: 'asc' })
  check('BOOLEAN ascending puts false first', (await firstPage(boolAsc))[0][3] === 'false')
  const timeAsc = await buildSortedView(handle, { column: 4, dir: 'asc' })
  check('TIMESTAMP sorts chronologically',
    (await firstPage(timeAsc))[0][4] === '2024-01-01 00:00:00', (await firstPage(timeAsc))[0][4])

  console.log('\ncell detail through a view')
  check('the identity view still reads from the file',
    (await readViewCell(handle, identity, 0, 0)) === '1')
  // The row index counts within the view: row 0 of a descending sort is the largest id.
  check('a sorted view resolves the row the user sees',
    (await readViewCell(handle, idDesc, 0, 0)) === '250')
  check('a sorted view returns the untruncated value',
    (await readViewCell(handle, nameAsc, 0, 1)) === 'user_1')
  check('past the end of a sorted view is NULL',
    (await readViewCell(handle, idDesc, 999, 0)) === 'NULL')
  check('an unknown column is NULL', (await readViewCell(handle, idDesc, 0, 9)) === 'NULL')

  console.log('\nformatCell')
  check('Uint8Array is summarised', formatCell(new Uint8Array([1, 2, 3])) === '0x010203 (3 B)')
  check('object becomes JSON', formatCell({ a: 1 }) === '{"a":1}')
  check('nested BigInt is safe', formatCell({ a: 1n }) === '{"a":"1"}')
  check('long strings are truncated', formatCell('x'.repeat(500)).length === 201)
  check('undefined is NULL', formatCell(undefined) === 'NULL')
  check('formatFull leaves long strings alone', formatFull('x'.repeat(500)).length === 500)
  check('formatFull indents objects', formatFull({ a: 1 }) === '{\n  "a": 1\n}')
  check('formatFull is still BigInt-safe', formatFull({ a: 1n }).includes('"1"'))

  console.log(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n')
  process.exit(failures ? 1 : 0)
}

main().catch(error => {
  console.error('smoke run crashed:', error)
  process.exit(1)
})
