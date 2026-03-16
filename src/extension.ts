import * as path from 'node:path';
import * as vscode from 'vscode';
import { TracyUiServer } from './tracyUiServer';

const COMMAND_OPEN_TRACE = 'vscode-tracy.openTrace';
const COMMAND_SHOW_OUTPUT = 'vscode-tracy.showOutput';
const OUTPUT_CHANNEL_NAME = 'Tracy';

let tracyUiServer: TracyUiServer | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  const log = (message: string): void => {
    const line = `[${new Date().toLocaleTimeString('en-GB', { hour12: false })}] ${message}`;
    output.appendLine(line);
  };

  context.subscriptions.push(output);

  tracyUiServer = new TracyUiServer(context.extensionUri, log);
  context.subscriptions.push(tracyUiServer);
  log('Extension activated.');

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_OPEN_TRACE, async (resource?: vscode.Uri) => {
      await openTrace(resolveCommandResource(resource), log);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_SHOW_OUTPUT, () => {
      output.show(true);
    }),
  );
}

function resolveCommandResource(resource?: vscode.Uri): vscode.Uri | undefined {
  if (resource) {
    return resource;
  }

  const activeEditorUri = vscode.window.activeTextEditor?.document.uri;
  if (activeEditorUri) {
    return activeEditorUri;
  }

  const activeTabInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (activeTabInput instanceof vscode.TabInputText) {
    return activeTabInput.uri;
  }

  if (activeTabInput instanceof vscode.TabInputTextDiff) {
    return activeTabInput.modified;
  }

  if (activeTabInput instanceof vscode.TabInputCustom) {
    return activeTabInput.uri;
  }

  if (activeTabInput instanceof vscode.TabInputNotebook) {
    return activeTabInput.uri;
  }

  if (activeTabInput instanceof vscode.TabInputNotebookDiff) {
    return activeTabInput.modified;
  }

  return undefined;
}

async function openTrace(traceUri: vscode.Uri | undefined, log: (message: string) => void): Promise<void> {
  if (!traceUri) {
    void vscode.window.showErrorMessage('Select a file first.');
    return;
  }

  if (!tracyUiServer) {
    throw new Error('Tracy UI server is not initialized.');
  }

  const source = traceUri.toString(true);
  const fileName = getTraceFileName(traceUri);
  log(`Open requested: ${source}`);

  try {
    const uiUrl = await tracyUiServer.createTraceUrl(traceUri);
    log(`Resolved Tracy UI URL: ${uiUrl}`);
    await openInVsCodeBrowser(uiUrl, log);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Open failed for ${fileName}: ${message}`);
    void vscode.window.showErrorMessage(`Failed to open ${fileName}: ${message}`);
  }
}

async function openInVsCodeBrowser(url: string, log: (message: string) => void): Promise<void> {
  log('Opening Tracy in the integrated browser.');
  await vscode.commands.executeCommand('workbench.action.browser.open', url);
}
function getTraceFileName(resource: vscode.Uri): string {
  return path.posix.basename(resource.path) || resource.toString(true);
}
