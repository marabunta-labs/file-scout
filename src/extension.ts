import * as vscode from 'vscode';
import { FileScoutWebviewProvider } from './fileScoutWebview';

class FileScoutDecorationProvider implements vscode.FileDecorationProvider {
    private _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
    readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

    private matchingFiles = new Set<string>();

    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        const fsPath = uri.fsPath;
        
        if (this.matchingFiles.has(fsPath)) {
            return {
                badge: '●',
                color: new vscode.ThemeColor('charts.blue'),
                tooltip: 'File Scout Match'
            };
        }
        
        return undefined;
    }

    setMatchingFiles(files: string[]) {
        this.matchingFiles.clear();
        files.forEach(file => this.matchingFiles.add(file));
        this._onDidChangeFileDecorations.fire(undefined);
    }

    clearMatches() {
        this.matchingFiles.clear();
        this._onDidChangeFileDecorations.fire(undefined);
    }
}

export function activate(context: vscode.ExtensionContext) {
    const decorationProvider = new FileScoutDecorationProvider();
    const provider = new FileScoutWebviewProvider(context.extensionUri, decorationProvider);

    context.subscriptions.push(
        vscode.window.registerFileDecorationProvider(decorationProvider)
    );

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(FileScoutWebviewProvider.viewType, provider)
    );

    // Command to open files from the webview
    context.subscriptions.push(
        vscode.commands.registerCommand('file-scout.openFile', async (fsPath: string) => {
            const uri = vscode.Uri.file(fsPath);
            await vscode.window.showTextDocument(uri);
        })
    );

    // Command to reveal folder in explorer
    context.subscriptions.push(
        vscode.commands.registerCommand('file-scout.revealFolder', async (fsPath: string) => {
            const uri = vscode.Uri.file(fsPath);
            await vscode.commands.executeCommand('revealInExplorer', uri);
        })
    );
}

export function deactivate() {}