import * as vscode from 'vscode'
import {
  PAGE_SIZE,
  ParquetHandle,
  buildInfo,
  buildSchema,
  openParquet,
  readCell,
  readPage,
} from './parquet'
import { openSource, sourceLabel } from './source'
import type { FromWebview, ToWebview } from './types'

/**
 * Wires one webview panel to one parquet source — a local path or a remote URL.
 * The panel never learns which it is.
 */
export async function attachPanel(
  source: string,
  panel: vscode.WebviewPanel,
  extensionUri: vscode.Uri,
): Promise<void> {
  const mediaRoot = vscode.Uri.joinPath(extensionUri, 'media')
  panel.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] }
  panel.webview.html = buildHtml(panel.webview, mediaRoot)

  let handle: ParquetHandle | undefined
  const post = (message: ToWebview) => panel.webview.postMessage(message)

  const sendPage = async (requested: number) => {
    if (!handle) return
    const totalPages = Math.max(1, Math.ceil(handle.totalRows / PAGE_SIZE))
    const page = Math.min(Math.max(0, requested), totalPages - 1)
    post({
      type: 'page',
      rows: await readPage(handle, page),
      page,
      totalPages,
      rowOffset: page * PAGE_SIZE,
    })
  }

  panel.webview.onDidReceiveMessage(async (message: FromWebview) => {
    try {
      if (message.type === 'ready') {
        handle = await openParquet(await openSource(source))
        post({
          type: 'init',
          source,
          info: buildInfo(handle, sourceLabel(source)),
          dataColumns: handle.dataColumns,
          schema: buildSchema(handle),
        })
        await sendPage(0)
      } else if (message.type === 'requestPage') {
        await sendPage(message.page)
      } else if (message.type === 'requestCell') {
        if (!handle) return
        const column = handle.dataColumns[message.col]
        if (!column) return
        post({
          type: 'cell',
          row: message.row,
          col: message.col,
          column: column.name,
          value: await readCell(handle, message.row, message.col),
        })
      } else if (message.type === 'copy') {
        // The host clipboard works regardless of webview focus rules.
        await vscode.env.clipboard.writeText(message.text)
      }
    } catch (error) {
      post({ type: 'error', message: describeError(error) })
    }
  })
}

function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  if (/magic|PAR1|not a parquet/i.test(raw)) {
    return `Not a valid Parquet file — the PAR1 magic bytes are missing.\n\n${raw}`
  }
  if (/unsupported compression|codec/i.test(raw)) {
    return `Unsupported compression codec.\n\n${raw}`
  }
  return raw
}

/**
 * Tab icons, inline rather than an icon font: the webview CSP is `default-src 'none'`,
 * and `currentColor` keeps them in step with the active/inactive tab colour.
 */
const ICON_TABLE = `<svg viewBox="0 0 16 16" aria-hidden="true" fill="none"
  stroke="currentColor" stroke-width="1.2"><rect x="1.6" y="2.6" width="12.8" height="10.8"
  rx="1.2"/><path d="M1.6 6.2h12.8M6.4 6.2v7.2"/></svg>`

const ICON_LIST = `<svg viewBox="0 0 16 16" aria-hidden="true" fill="none"
  stroke="currentColor" stroke-width="1.2"><path d="M6.2 3.8h8M6.2 8h8M6.2 12.2h8"
  stroke-linecap="round"/><circle cx="3" cy="3.8" r="1" fill="currentColor" stroke="none"/><circle
  cx="3" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="3" cy="12.2" r="1"
  fill="currentColor" stroke="none"/></svg>`

function buildHtml(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
  const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, file))
  const nonce = randomNonce()

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${asset('style.css')}">
<title>Parquet Table</title>
</head>
<body>
  <header id="info">
    <div class="fname">Loading…</div>
    <div class="meta"></div>
  </header>

  <nav id="tabs">
    <button class="tab active" data-tab="data" type="button">${ICON_TABLE}<span>Data</span></button>
    <button class="tab" data-tab="schema" type="button">${ICON_LIST}<span>Schema</span></button>
  </nav>

  <main>
    <div id="pane-data" class="pane"><div class="scroll"><table id="tbl-data"></table></div></div>
    <div id="pane-schema" class="pane hidden"><div class="scroll"><table id="tbl-schema"></table></div></div>
  </main>

  <section id="detail" class="hidden">
    <div class="detail-head">
      <span id="detail-title"></span>
      <span class="spacer"></span>
      <button id="detail-copy" type="button">Copy</button>
      <button id="detail-close" type="button" title="Esc">✕</button>
    </div>
    <pre id="detail-body"></pre>
  </section>

  <footer id="pager">
    <button id="prev" type="button" disabled>◀ Prev</button>
    <span id="pageinfo" class="dim"></span>
    <button id="next" type="button" disabled>Next ▶</button>
    <span id="range" class="dim"></span>
  </footer>

  <script nonce="${nonce}" src="${asset('main.js')}"></script>
</body>
</html>`
}

function randomNonce(): string {
  const bytes = new Uint8Array(16)
  ;(globalThis.crypto as Crypto).getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}
