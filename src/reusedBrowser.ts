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

import { TestConfig } from './playwrightTest';
import { TestModel, TestProject } from './testModel';
import { createGuid } from './utils';
import * as vscodeTypes from './vscodeTypes';
import path from 'path';
import fs from 'fs';
import { installBrowsers } from './installer';
import { SettingsModel } from './settingsModel';
import { BackendServer, BackendClient } from './backend';

export class ReusedBrowser implements vscodeTypes.Disposable {
  private _vscode: vscodeTypes.VSCode;
  private _backend: Backend | undefined;
  private _cancelRecording: (() => void) | undefined;
  private _updateOrCancelInspecting: ((params: { selector?: string, cancel?: boolean }) => void) | undefined;
  private _isRunningTests = false;
  private _editor: vscodeTypes.TextEditor | undefined;
  private _insertedEditActionCount = 0;
  private _envProvider: () => NodeJS.ProcessEnv;
  private _disposables: vscodeTypes.Disposable[] = [];
  private _pageCount = 0;
  readonly onPageCountChanged: vscodeTypes.Event<number>;
  private _onPageCountChangedEvent: vscodeTypes.EventEmitter<number>;
  readonly onRunningTestsChanged: vscodeTypes.Event<boolean>;
  readonly _onHighlightRequestedForTestEvent: vscodeTypes.EventEmitter<string>;
  readonly onHighlightRequestedForTest: vscodeTypes.Event<string>;
  private _onRunningTestsChangedEvent: vscodeTypes.EventEmitter<boolean>;
  private _editOperations = Promise.resolve();
  private _pausedOnPagePause = false;
  private _settingsModel: SettingsModel;

  constructor(vscode: vscodeTypes.VSCode, settingsModel: SettingsModel, envProvider: () => NodeJS.ProcessEnv) {
    this._vscode = vscode;
    this._envProvider = envProvider;
    this._onPageCountChangedEvent = new vscode.EventEmitter();
    this.onPageCountChanged = this._onPageCountChangedEvent.event;
    this._onRunningTestsChangedEvent = new vscode.EventEmitter();
    this.onRunningTestsChanged = this._onRunningTestsChangedEvent.event;
    this._onHighlightRequestedForTestEvent = new vscode.EventEmitter();
    this.onHighlightRequestedForTest = this._onHighlightRequestedForTestEvent.event;
    this._settingsModel = settingsModel;

    this._disposables.push(settingsModel.showBrowser.onChange(value => {
      if (!value)
        this.closeAllBrowsers();
    }));
  }

  dispose() {
    this._stop();
    for (const d of this._disposables)
      d.dispose();
    this._disposables = [];
  }

  private async _startBackendIfNeeded(config: TestConfig) {
    // Unconditionally close selector dialog, it might send inspect(enabled: false).
    if (this._backend) {
      this._resetNoWait();
      return;
    }

    const args = [
      config.cli,
      'run-server',
      `--path=/${createGuid()}`
    ];
    const cwd = config.workspaceFolder;
    const envProvider = () => ({
      ...this._envProvider(),
      PW_CODEGEN_NO_INSPECTOR: '1',
      PW_EXTENSION_MODE: '1',
    });

    const backendServer = new BackendServer<Backend>(this._vscode, {
      args,
      cwd,
      envProvider,
      clientFactory: () => new Backend(this._vscode)
    });
    const backend = await backendServer.start();
    if (!backend)
      return;
    backend.onClose(() => {
      if (backend === this._backend) {
        this._backend = undefined;
        this._resetNoWait();
      }
    });
    backend.onError(e => {
      if (backend === this._backend) {
        this._vscode.window.showErrorMessage(e.message);
        this._backend = undefined;
        this._resetNoWait();
      }
    });

    this._backend = backend;

    this._backend.on('inspectRequested', params => {
      if (!this._updateOrCancelInspecting)
        this._showInspectingBox();
      this._updateOrCancelInspecting?.({ selector: params.locator || params.selector });
    });

    this._backend.on('setModeRequested', params => {
      if (params.mode === 'standby')
        this._resetNoWait();
    });

    this._backend.on('paused', async params => {
      if (!this._pausedOnPagePause && params.paused) {
        this._pausedOnPagePause = true;
        await this._vscode.window.showInformationMessage('Paused', { modal: false }, 'Resume');
        this._pausedOnPagePause = false;
        this._backend?.resumeNoWait();
      }
    });
    this._backend.on('stateChanged', params => {
      this._pageCountChanged(params.pageCount);
    });
    this._backend.on('sourceChanged', async params => {
      this._scheduleEdit(async () => {
        if (!this._editor)
          return;
        if (!params.actions || !params.actions.length)
          return;
        const targetIndentation = guessIndentation(this._editor);

        // Previous action committed, insert new line & collapse selection.
        if (params.actions.length > 1 && params.actions?.length > this._insertedEditActionCount) {
          const range = new this._vscode.Range(this._editor.selection.end, this._editor.selection.end);
          await this._editor.edit(async editBuilder => {
            editBuilder.replace(range, '\n' + ' '.repeat(targetIndentation));
          });
          this._editor.selection = new this._vscode.Selection(this._editor.selection.end, this._editor.selection.end);
          this._insertedEditActionCount = params.actions.length;
        }

        // Replace selection with the current action.
        if (params.actions.length) {
          const selectionStart = this._editor.selection.start;
          await this._editor.edit(async editBuilder => {
            if (!this._editor)
              return;
            const action = params.actions[params.actions.length - 1];
            editBuilder.replace(this._editor.selection, indentBlock(action, targetIndentation));
          });
          const selectionEnd = this._editor.selection.end;
          this._editor.selection = new this._vscode.Selection(selectionStart, selectionEnd);
        }
      });
    });
  }

  private _scheduleEdit(callback: () => Promise<void>) {
    this._editOperations = this._editOperations.then(callback).catch(e => console.log(e));
  }

  isRunningTests() {
    return this._isRunningTests;
  }

  pageCount() {
    return this._pageCount;
  }

  private _pageCountChanged(pageCount: number) {
    this._pageCount = pageCount;
    this._onPageCountChangedEvent.fire(pageCount);
    if (this._isRunningTests)
      return;
    if (pageCount)
      return;
    this._stop();
  }

  browserServerWSEndpoint() {
    return this._backend?.wsEndpoint;
  }

  async inspect(models: TestModel[]) {
    if (!this._checkVersion(models[0].config, 'selector picker'))
      return;

    await this._startBackendIfNeeded(models[0].config);
    try {
      await this._backend?.setMode({ mode: 'inspecting' });
    } catch (e) {
      showExceptionAsUserError(this._vscode, models[0], e as Error);
      return;
    }

    this._showInspectingBox();
  }

  private _showInspectingBox() {
    const selectorExplorerBox = this._vscode.window.createInputBox();
    selectorExplorerBox.title = this._vscode.l10n.t('Pick locator');
    selectorExplorerBox.value = '';
    selectorExplorerBox.prompt = this._vscode.l10n.t('Accept to copy locator into clipboard');
    selectorExplorerBox.ignoreFocusOut = true;
    selectorExplorerBox.onDidChangeValue(selector => {
      this._backend?.highlight({ selector }).catch(() => {});
    });
    selectorExplorerBox.onDidHide(() => this._resetNoWait());
    selectorExplorerBox.onDidAccept(() => {
      this._vscode.env.clipboard.writeText(selectorExplorerBox!.value);
      selectorExplorerBox.hide();
    });
    selectorExplorerBox.show();
    this._updateOrCancelInspecting = params => {
      if (params.cancel)
        selectorExplorerBox.dispose();
      else if (params.selector)
        selectorExplorerBox.value = params.selector;
    };
  }

  canRecord() {
    return !this._isRunningTests;
  }

  canClose() {
    return !this._isRunningTests && !!this._pageCount;
  }

  async record(models: TestModel[], recordNew: boolean) {
    if (!this._checkVersion(models[0].config))
      return;
    if (!this.canRecord()) {
      this._vscode.window.showWarningMessage(
          this._vscode.l10n.t('Can\'t record while running tests')
      );
      return;
    }
    await this._vscode.window.withProgress({
      location: this._vscode.ProgressLocation.Notification,
      title: 'Playwright codegen',
      cancellable: true
    }, async (progress, token) => this._doRecord(progress, models[0], recordNew, token));
  }

  highlight(selector: string) {
    this._backend?.highlight({ selector }).catch(() => {});
    this._onHighlightRequestedForTestEvent.fire(selector);
  }

  hideHighlight() {
    this._backend?.hideHighlight().catch(() => {});
    this._onHighlightRequestedForTestEvent.fire('');
  }

  private _checkVersion(
    config: TestConfig,
    message: string = this._vscode.l10n.t('this feature')
  ): boolean {
    if (config.version < 1.25) {
      this._vscode.window.showWarningMessage(
          this._vscode.l10n.t('Playwright v1.25+ is required for {0} to work, v{1} found', message, config.version)
      );
      return false;
    }

    if (this._vscode.env.uiKind === this._vscode.UIKind.Web && !process.env.DISPLAY) {
      this._vscode.window.showWarningMessage(
          this._vscode.l10n.t('Show browser mode does not work in remote vscode')
      );
      return false;
    }

    return true;
  }

  private async _doRecord(progress: vscodeTypes.Progress<{ message?: string; increment?: number }>, model: TestModel, recordNew: boolean, token: vscodeTypes.CancellationToken) {
    const startBackend = this._startBackendIfNeeded(model.config);
    let editor: vscodeTypes.TextEditor | undefined;
    if (recordNew)
      editor = await this._createFileForNewTest(model);
    else
      editor = this._vscode.window.activeTextEditor;
    await startBackend;
    this._editor = editor;
    this._insertedEditActionCount = 0;

    progress.report({ message: 'starting\u2026' });

    if (recordNew) {
      await this._backend?.resetForReuse();
      await this._backend?.navigate({ url: 'about:blank' });
    }

    try {
      await this._backend?.setMode({ mode: 'recording', testIdAttributeName: model.config.testIdAttributeName });
    } catch (e) {
      showExceptionAsUserError(this._vscode, model, e as Error);
      this._stop();
      return;
    }

    progress.report({ message: 'recording\u2026' });

    await Promise.race([
      new Promise<void>(f => token.onCancellationRequested(f)),
      new Promise<void>(f => this._cancelRecording = f),
    ]);
    this._resetNoWait();
  }

  private async _createFileForNewTest(model: TestModel) {
    const project = model.projects.values().next().value as TestProject;
    if (!project)
      return;
    let file;
    for (let i = 1; i < 100; ++i) {
      file = path.join(project.testDir, `test-${i}.spec.ts`);
      if (fs.existsSync(file))
        continue;
      break;
    }
    if (!file)
      return;

    await fs.promises.writeFile(file, `import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  // Recording...
});`);

    const document = await this._vscode.workspace.openTextDocument(file);
    const editor = await this._vscode.window.showTextDocument(document);
    editor.selection = new this._vscode.Selection(new this._vscode.Position(3, 2), new this._vscode.Position(3, 2 + '// Recording...'.length));
    return editor;
  }

  async onWillRunTests(config: TestConfig, debug: boolean) {
    if (!this._settingsModel.showBrowser.get() && !debug)
      return;
    if (!this._checkVersion(config, 'Show & reuse browser'))
      return;
    this._pausedOnPagePause = false;
    this._isRunningTests = true;
    this._onRunningTestsChangedEvent.fire(true);
    await this._startBackendIfNeeded(config);
  }

  async onDidRunTests(debug: boolean) {
    if (debug && !this._settingsModel.showBrowser.get()) {
      this._stop();
    } else {
      if (!this._pageCount)
        this._stop();
    }
    this._isRunningTests = false;
    this._onRunningTestsChangedEvent.fire(false);
  }

  closeAllBrowsers() {
    if (this._isRunningTests) {
      this._vscode.window.showWarningMessage(
          this._vscode.l10n.t('Can\'t close browsers while running tests')
      );
      return;
    }
    this._stop();
  }

  private _resetExtensionState() {
    this._editor = undefined;
    this._insertedEditActionCount = 0;
    this._updateOrCancelInspecting?.({ cancel: true });
    this._updateOrCancelInspecting = undefined;
    this._cancelRecording?.();
    this._cancelRecording = undefined;
  }

  private _resetNoWait() {
    this._resetExtensionState();
    this._backend?.resetRecorderModeNoWait();
  }

  private _stop() {
    this._resetExtensionState();
    this._backend?.requestGracefulTermination();
    this._backend = undefined;
    this._pageCount = 0;
  }
}

export class Backend extends BackendClient {
  constructor(vscode: vscodeTypes.VSCode) {
    super(vscode);
  }

  override rewriteWsEndpoint(wsEndpoint: string): string {
    return wsEndpoint + '?debug-controller';
  }

  override rewriteWsHeaders(headers: Record<string, string>): Record<string, string> {
    return {
      ...headers,
      'x-playwright-debug-controller': 'true' // Remove after v1.35
    };
  }

  override async initialize() {
    await this.send('initialize', { codegenId: 'playwright-test', sdkLanguage: 'javascript' });
    await this.send('setReportStateChanged', { enabled: true });
  }

  override requestGracefulTermination() {
    this.send('kill').catch(() => {});
  }

  async resetForReuse() {
    await this.send('resetForReuse');
  }

  resetRecorderModeNoWait() {
    this.resetRecorderMode().catch(() => {});
  }

  async resetRecorderMode() {
    await this.send('setRecorderMode', { mode: 'none' });
  }

  async navigate(params: { url: string }) {
    await this.send('navigate', params);
  }

  async setMode(params: { mode: 'none' | 'inspecting' | 'recording', testIdAttributeName?: string }) {
    await this.send('setRecorderMode', params);
  }

  async highlight(params: { selector: string }) {
    await this.send('highlight', params);
  }

  async hideHighlight() {
    await this.send('hideHighlight');
  }

  resumeNoWait() {
    this.send('resume').catch(() => {});
  }
}

function showExceptionAsUserError(vscode: vscodeTypes.VSCode, model: TestModel, error: Error) {
  if (error.message.includes('Looks like Playwright Test or Playwright'))
    installBrowsers(vscode, model);
  else
    vscode.window.showErrorMessage(error.message);
}

function guessIndentation(editor: vscodeTypes.TextEditor): number {
  const lineNumber = editor.selection.start.line;
  for (let i = lineNumber; i >= 0; --i) {
    const line = editor.document.lineAt(i);
    if (!line.isEmptyOrWhitespace)
      return line.firstNonWhitespaceCharacterIndex;
  }
  return 0;
}

function indentBlock(block: string, indent: number) {
  const lines = block.split('\n');
  if (!lines.length)
    return block;

  const blockIndent = lines[0].match(/\s*/)![0].length;
  const shift = ' '.repeat(Math.max(0, indent - blockIndent));
  return lines.map((l, i) => i ? shift + l : l.trimStart()).join('\n');
}
