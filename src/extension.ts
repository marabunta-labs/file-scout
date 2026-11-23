import * as vscode from 'vscode';
import { FileScoutWebviewProvider } from './fileScoutWebview';

class FileScoutDecorationProvider implements vscode.FileDecorationProvider {
    private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
    readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

    private matchingFiles = new Map<string, vscode.Uri>();

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
        const previous = this.matchingFiles;
        const next = new Map<string, vscode.Uri>();
        for (const file of files) {
            next.set(file, previous.get(file) ?? vscode.Uri.file(file));
        }
        this.matchingFiles = next;

        // Only refresh the URIs whose decoration actually changed
        const changed: vscode.Uri[] = [];
        for (const [key, uri] of next) {
            if (!previous.has(key)) { changed.push(uri); }
        }
        for (const [key, uri] of previous) {
            if (!next.has(key)) { changed.push(uri); }
        }
        if (changed.length > 0) {
            this._onDidChangeFileDecorations.fire(changed);
        }
    }

    clearMatches(): void {
        this.setMatchingFiles([]);
    }

    dispose(): void {
        this._onDidChangeFileDecorations.dispose();
    }
}

export function activate(context: vscode.ExtensionContext) {
    const decorationProvider = new FileScoutDecorationProvider();
    const provider = new FileScoutWebviewProvider(context.extensionUri, decorationProvider);

    context.subscriptions.push(decorationProvider, provider);
    context.subscriptions.push(
        vscode.window.registerFileDecorationProvider(decorationProvider)
    );

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(FileScoutWebviewProvider.viewType, provider, {
            webviewOptions: { retainContextWhenHidden: true }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('file-scout.openFile', async (fsPath?: string) => {
            if (!fsPath) { return; }
            await provider.openFile(fsPath);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('file-scout.revealFolder', async (fsPath?: string) => {
            if (!fsPath) { return; }
            await provider.revealFolder(fsPath);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('file-scout.focus', async () => {
            await vscode.commands.executeCommand(`${FileScoutWebviewProvider.viewType}.focus`);
            provider.postMessage({ type: 'focusInput' });
        }),
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
