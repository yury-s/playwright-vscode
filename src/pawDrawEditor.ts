/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import * as vscode from 'vscode';
import { spawn } from 'child_process';

/**
  * Define the document (the data model) used for paw draw files.
  */
class PawDrawDocument implements vscode.CustomDocument {
  private _process!: import('child_process').ChildProcess;
  private _traceViewerUrlPromise!: Promise<string>;

  static async create(
    uri: vscode.Uri,
    backupId: string | undefined,
  ): Promise<PawDrawDocument | PromiseLike<PawDrawDocument>> {
    return new PawDrawDocument(uri);
  }

  private readonly _uri: vscode.Uri;

  private constructor(
    uri: vscode.Uri,
  ) {
    this._uri = uri;
    this._spawnTraceViewer();
  }

  public get uri() { return this._uri; }

  /**
   * Fired when the document is disposed of.
   */

  private _spawnTraceViewer() {
    this._process = spawn('npx', ['playwright', 'serve-trace', this.uri.fsPath], {
      cwd: vscode.workspace.getWorkspaceFolder(this.uri)?.uri.fsPath,
    });
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    let resolveTraceViewerUrl = (url: string) => { };
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    let rejectTraceViewerUrl = (error: Error) => { };
    this._traceViewerUrlPromise = new Promise<string>((resolve, reject) => {
      resolveTraceViewerUrl = resolve;
      rejectTraceViewerUrl = reject;
    });
    this._process.stdout!.on('data', (data: Buffer) => {
      const line = data.toString().trimEnd();
      if (line.includes('Running on'))
        resolveTraceViewerUrl(data.toString().slice(12));
    });
    this._process.on('error', (error) => {
      rejectTraceViewerUrl(error);
    });
    this._process.on('exit', code => {
      rejectTraceViewerUrl(new Error(`Process exited, code: ${code}`));
    });
  }

  public traceViewerUrl(): Promise<string> {
    return this._traceViewerUrlPromise;
  }

  /**
   * Called by VS Code when there are no more references to the document.
   *
   * This happens when all editors for it have been closed.
   */
  dispose(): void {
    this._process.kill();
  }

}


export class PawDrawEditorProvider implements vscode.CustomEditorProvider<PawDrawDocument> {
  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      PawDrawEditorProvider.viewType,
      new PawDrawEditorProvider(context),
      {
        // For this demo extension, we enable `retainContextWhenHidden` which keeps the
        // webview alive even when it is not visible. You should avoid using this setting
        // unless is absolutely required as it does have memory overhead.
        webviewOptions: {
          retainContextWhenHidden: true,
        },
        supportsMultipleEditorsPerDocument: false,
      });
  }

  private static readonly viewType = 'catCustoms.pawDraw';

  /**
   * Tracks all known webviews
   */
  private readonly webviews = new WebviewCollection();

  constructor(
    private readonly _context: vscode.ExtensionContext
  ) { }

  //#region CustomEditorProvider

  async openCustomDocument(
    uri: vscode.Uri,
    openContext: { backupId?: string },
    _token: vscode.CancellationToken
  ): Promise<PawDrawDocument> {
    const document: PawDrawDocument = await PawDrawDocument.create(uri, openContext.backupId);

    return document;
  }

  async resolveCustomEditor(
    document: PawDrawDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    // Add the webview to our internal set of active webviews
    this.webviews.add(document.uri, webviewPanel);

    // Setup initial content for the webview
    webviewPanel.webview.options = {
      enableScripts: true,
    };
    webviewPanel.webview.html = await this.getHtmlForWebview(webviewPanel.webview, document);
  }

  private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<PawDrawDocument>>();
  public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async saveCustomDocument(document: PawDrawDocument, cancellation: vscode.CancellationToken): Promise<void> {
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async saveCustomDocumentAs(document: PawDrawDocument, destination: vscode.Uri, cancellation: vscode.CancellationToken): Promise<void> {
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async revertCustomDocument(document: PawDrawDocument, cancellation: vscode.CancellationToken): Promise<void> {
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async backupCustomDocument(document: PawDrawDocument, context: vscode.CustomDocumentBackupContext, cancellation: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
    return {
      id: context.destination.toString(),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      delete: async () => {
      }
    };
  }

  //#endregion

  /**
   * Get the static HTML used for in our editor's webviews.
   */
  private async getHtmlForWebview(webview: vscode.Webview, document: PawDrawDocument): Promise<string> {
    const iframeSrc = await document.traceViewerUrl();
    return /* html */`
       <!DOCTYPE html>
       <html lang="en">
       <head>
         <meta charset="UTF-8">
 
         <!--
         Use a content security policy to only allow loading images from https or from our extension directory,
         and only allow scripts that have a specific nonce.
         -->
         <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self' 'unsafe-inline'; frame-src ${iframeSrc};">
 
         <meta name="viewport" content="width=device-width, initial-scale=1.0">
 
         <title>Paw Draw</title>
       </head>
       <body style="padding: 0;">
         <iframe src="${iframeSrc}" style="height: calc(100vh - 3px); width: 100vw;border: 0; background-color: white;"></iframe>
       </body>
       </html>`;
  }
}



/**
  * Tracks all webviews.
  */
class WebviewCollection {

  private readonly _webviews = new Set<{
    readonly resource: string;
    readonly webviewPanel: vscode.WebviewPanel;
  }>();

  /**
   * Get all known webviews for a given uri.
   */
  public *get(uri: vscode.Uri): Iterable<vscode.WebviewPanel> {
    const key = uri.toString();
    for (const entry of this._webviews) {
      if (entry.resource === key) {
        yield entry.webviewPanel;
      }
    }
  }

  /**
   * Add a new webview to the collection.
   */
  public add(uri: vscode.Uri, webviewPanel: vscode.WebviewPanel) {
    const entry = { resource: uri.toString(), webviewPanel };
    this._webviews.add(entry);

    webviewPanel.onDidDispose(() => {
      this._webviews.delete(entry);
    });
  }
}