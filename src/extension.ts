import * as vscode from 'vscode';
import { FileScoutWebviewProvider } from './fileScoutWebview';

class FileScoutDecorationProvider implements vscode.FileDecorationProvider {
    private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
    readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

    private matchingFiles = new Set<string>();

    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        if (this.matchingFiles.has(uri.fsPath)) {
            return {
                badge: '●',
                color: new vscode.ThemeColor('charts.blue'),
                tooltip: 'File Scout Match'
            };
        }
        return undefined;
    }

    setMatchingFiles(files: string[]): void {
        this.matchingFiles.clear();
        for (const file of files) {
            this.matchingFiles.add(file);
        }
        this._onDidChangeFileDecorations.fire(undefined);
    }

    clearMatches(): void {
        this.matchingFiles.clear();
        this._onDidChangeFileDecorations.fire(undefined);
    }

    dispose(): void {
        this._onDidChangeFileDecorations.dispose();
    }
}

export function activate(context: vscode.ExtensionContext) {
    const decorationProvider = new FileScoutDecorationProvider();
    const provider = new FileScoutWebviewProvider(context.extensionUri, decorationProvider);

    context.subscriptions.push(decorationProvider);
    context.subscriptions.push(
        vscode.window.registerFileDecorationProvider(decorationProvider)
    );

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(FileScoutWebviewProvider.viewType, provider)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('file-scout.openFile', async (fsPath: string) => {
            const uri = vscode.Uri.file(fsPath);
            await vscode.window.showTextDocument(uri);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('file-scout.revealFolder', async (fsPath: string) => {
            const uri = vscode.Uri.file(fsPath);
            await vscode.commands.executeCommand('revealInExplorer', uri);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('file-scout.toggleMatchCase', () => {
            provider.postMessage({ type: 'toggleMatchCase' });
        }),
        vscode.commands.registerCommand('file-scout.toggleMatchWholeWord', () => {
            provider.postMessage({ type: 'toggleMatchWholeWord' });
        }),
        vscode.commands.registerCommand('file-scout.toggleRegex', () => {
            provider.postMessage({ type: 'toggleRegex' });
        })
    );
}

export function deactivate() {}