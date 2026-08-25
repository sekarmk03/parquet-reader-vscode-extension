import * as vscode from 'vscode'
import { attachPanel } from './panel'
import { isRemote, sourceLabel } from './source'

const VIEW_TYPE = 'sekarmk03.parquetReader.table'

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      VIEW_TYPE,
      new ParquetEditorProvider(context.extensionUri),
      {
        supportsMultipleEditorsPerDocument: false,
        webviewOptions: { retainContextWhenHidden: true },
      },
    ),
    vscode.commands.registerCommand('sekarmk03.parquetReader.openUrl', () => openUrl(context.extensionUri)),
    // Local files come back through the custom editor; URL panels have only this.
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: { source?: string }) {
        if (!state?.source) {
          panel.dispose()
          return
        }
        await attachPanel(state.source, panel, context.extensionUri)
      },
    }),
  )
}

/**
 * A remote file has no document to hang a custom editor off, so this opens a
 * webview panel directly. Same panel, same wiring — only the entry point differs.
 */
async function openUrl(extensionUri: vscode.Uri): Promise<void> {
  const url = await vscode.window.showInputBox({
    title: 'Open Parquet from URL',
    prompt: 'https://… or s3://bucket/key.parquet',
    placeHolder: 'https://example.com/data.parquet',
    ignoreFocusOut: true,
    validateInput: value =>
      !value.trim() || isRemote(value.trim())
        ? undefined
        : 'Must start with http://, https:// or s3://',
  })
  if (!url?.trim()) return

  const source = url.trim()
  const panel = vscode.window.createWebviewPanel(
    VIEW_TYPE,
    sourceLabel(source),
    vscode.ViewColumn.Active,
    { retainContextWhenHidden: true },
  )
  await attachPanel(source, panel, extensionUri)
}

export function deactivate(): void {}

/** Read-only: the viewer never writes back, so there is no document model to keep. */
class ParquetEditorProvider implements vscode.CustomReadonlyEditorProvider {
  constructor(private readonly extensionUri: vscode.Uri) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => {} }
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    await attachPanel(document.uri.fsPath, webviewPanel, this.extensionUri)
  }
}
