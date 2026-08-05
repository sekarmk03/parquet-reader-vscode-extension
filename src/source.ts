/**
 * Where the bytes come from. A local path, an http(s) URL and an s3:// URL all end
 * up as the same AsyncBuffer, so nothing downstream of here knows the difference.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { asyncBufferFromFile, asyncBufferFromUrl, cachedAsyncBuffer } from 'hyparquet'
import type { AsyncBuffer } from 'hyparquet'

const run = promisify(execFile)

/** How long a signature stays good — long enough to page through a big file. */
const PRESIGN_SECONDS = 3600

export function isRemote(input: string): boolean {
  return /^(https?|s3):\/\//i.test(input)
}

/** Name for the tab and the info bar: the last path segment, minus any query string. */
export function sourceLabel(input: string): string {
  const withoutQuery = input.split(/[?#]/)[0]
  return withoutQuery.split(/[/\\]/).filter(Boolean).pop() ?? input
}

export async function openSource(input: string): Promise<AsyncBuffer> {
  if (!isRemote(input)) return asyncBufferFromFile(input)

  const url = input.toLowerCase().startsWith('s3://') ? await presign(input) : input
  // One probe answers both questions: are ranged reads supported, and how big is it.
  const byteLength = await probeRange(url)
  return cachedAsyncBuffer(await asyncBufferFromUrl({ url, byteLength }))
}

/**
 * Ranged reads are the whole point — without them every slice() would drag the
 * entire object across the network, which is exactly what this viewer avoids.
 * So this fails loudly rather than quietly downloading gigabytes.
 */
async function probeRange(url: string): Promise<number> {
  let response: Response
  try {
    response = await fetch(url, { headers: { range: 'bytes=0-0' } })
  } catch (error) {
    throw new Error(`Cannot reach ${url}\n\n${error instanceof Error ? error.message : error}`)
  }
  await response.body?.cancel()

  if (response.status === 200) {
    throw new Error(
      'The server ignored the Range header and would send the whole file for every read.\n\n' +
        'Serve the file from something that supports byte ranges (S3, most CDNs, nginx).',
    )
  }
  if (response.status !== 206) {
    throw new Error(`Request failed: HTTP ${response.status} ${response.statusText}`)
  }

  // "bytes 0-0/524288" — the part after the slash is the total size.
  const total = /\/(\d+)\s*$/.exec(response.headers.get('content-range') ?? '')
  if (!total) throw new Error('The server accepted the range but did not report a total size.')
  return Number(total[1])
}

/**
 * s3:// is handed to the AWS CLI rather than an SDK: the user's existing profile
 * or SSO session does the signing, so no credential ever passes through here.
 */
async function presign(s3Url: string): Promise<string> {
  try {
    const { stdout } = await run('aws', [
      's3',
      'presign',
      s3Url,
      '--expires-in',
      String(PRESIGN_SECONDS),
    ])
    return stdout.trim()
  } catch (error) {
    throw new Error(describePresignFailure(error))
  }
}

function describePresignFailure(error: unknown): string {
  const code = (error as { code?: string }).code
  if (code === 'ENOENT') {
    return (
      'The AWS CLI is not installed, and s3:// URLs are signed with it.\n\n' +
      'Install it, or paste a presigned https:// URL instead.'
    )
  }
  const stderr = String((error as { stderr?: string }).stderr ?? '').trim()
  return `aws s3 presign failed.\n\n${stderr || (error instanceof Error ? error.message : error)}`
}
