import * as vscode from 'vscode';
import { SearchOptions, buildSearchPattern, toGlob } from './searchUtils';

interface FileDecorationProvider {
    setMatchingFiles(files: string[]): void;
    clearMatches(): void;
}

interface FileResult {
    path: string;
    fsPath: string;
    fileName: string;
    isFolder?: boolean;
}

export class FileScoutWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = 'fileScoutView';
    private _view?: vscode.WebviewView;
    private _searchGeneration = 0;
    private _searchCts?: vscode.CancellationTokenSource;
    private _fileCache?: { key: string; files: vscode.Uri[]; truncated: boolean };
    private readonly _disposables: vscode.Disposable[] = [];

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _decorationProvider: FileDecorationProvider
    ) {
        // The cached file list is only valid until the workspace layout changes
        const watcher = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);
        const invalidate = () => { this._fileCache = undefined; };
        this._disposables.push(
            watcher,
            watcher.onDidCreate(invalidate),
            watcher.onDidDelete(invalidate),
            vscode.workspace.onDidChangeWorkspaceFolders(invalidate),
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('fileScout') || e.affectsConfiguration('files.exclude')) {
                    invalidate();
                }
            })
        );
    }

    public dispose(): void {
        this._searchCts?.cancel();
        this._searchCts?.dispose();
        this._disposables.forEach(d => d.dispose());
    }

    public postMessage(message: unknown): void {
        this._view?.webview.postMessage(message);
    }

    public async openFile(fsPath: string): Promise<void> {
        try {
            await vscode.window.showTextDocument(vscode.Uri.file(fsPath));
        } catch (error) {
            vscode.window.showErrorMessage(`File Scout: could not open "${fsPath}" (${error instanceof Error ? error.message : error}).`);
        }
    }

    public async revealFolder(fsPath: string): Promise<void> {
        try {
            await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(fsPath));
        } catch (error) {
            vscode.window.showErrorMessage(`File Scout: could not reveal "${fsPath}" (${error instanceof Error ? error.message : error}).`);
        }
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.onDidDispose(() => {
            if (this._view === webviewView) {
                this._view = undefined;
            }
            this._searchGeneration++;
            this._searchCts?.cancel();
            this._decorationProvider.clearMatches();
        });

        webviewView.webview.onDidReceiveMessage(async data => {
            switch (data?.type) {
                case 'search':
                    await this._performSearch(String(data.query ?? ''), data.options);
                    break;
                case 'openFile':
                    if (typeof data.fsPath === 'string') { await this.openFile(data.fsPath); }
                    break;
                case 'revealFolder':
                    if (typeof data.fsPath === 'string') { await this.revealFolder(data.fsPath); }
                    break;
                case 'openInEditor': {
                    const document = await vscode.workspace.openTextDocument({
                        content: String(data.content ?? ''),
                        language: 'markdown'
                    });
                    await vscode.window.showTextDocument(document);
                    break;
                }
            }
        });
    }

    private _postResults(files: FileResult[], extra: { message?: string; truncated?: boolean } = {}): void {
        this._view?.webview.postMessage({ type: 'results', files, ...extra });
    }

    private async _findFiles(
        include: string,
        exclude: string | undefined,
        token: vscode.CancellationToken
    ): Promise<{ files: vscode.Uri[]; truncated: boolean } | undefined> {
        const maxResults = vscode.workspace.getConfiguration('fileScout').get<number>('maxFiles', 10000);
        const key = `${include}\u0000${exclude ?? ''}\u0000${maxResults}`;
        if (this._fileCache?.key === key) {
            return this._fileCache;
        }

        const files = await vscode.workspace.findFiles(include, exclude, maxResults, token);
        if (token.isCancellationRequested) { return undefined; }

        this._fileCache = { key, files, truncated: files.length >= maxResults };
        return this._fileCache;
    }

    private async _performSearch(query: string, options?: SearchOptions): Promise<void> {
        const generation = ++this._searchGeneration;
        this._searchCts?.cancel();
        this._searchCts?.dispose();
        const cts = this._searchCts = new vscode.CancellationTokenSource();

        if (query.trim() === '') {
            this._decorationProvider.clearMatches();
            this._postResults([]);
            return;
        }

        const searchPattern = buildSearchPattern(query, options);
        if (!searchPattern) {
            this._decorationProvider.clearMatches();
            this._postResults([], { message: 'Invalid regular expression' });
            return;
        }

        try {
            const found = await this._findFiles(
                toGlob(options?.filesToInclude) ?? '**/*',
                toGlob(options?.filesToExclude),
                cts.token
            );

            // Discard stale results if a newer search was started
            if (!found || generation !== this._searchGeneration) { return; }

            const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
            const fileResults: FileResult[] = [];
            const folderResults = new Map<string, FileResult>();

            for (const uri of found.files) {
                const folder = vscode.workspace.getWorkspaceFolder(uri);
                const relativePath = vscode.workspace.asRelativePath(uri, false);
                const prefix = multiRoot && folder ? `${folder.name}/` : '';
                const parts = relativePath.split('/');
                const fileName = parts[parts.length - 1];

                if (searchPattern.test(fileName)) {
                    fileResults.push({
                        path: prefix + relativePath,
                        fsPath: uri.fsPath,
                        fileName
                    });
                }

                // Folders: every ancestor directory whose name matches
                if (!folder) { continue; }
                for (let i = 0; i < parts.length - 1; i++) {
                    if (!searchPattern.test(parts[i])) { continue; }
                    const folderUri = vscode.Uri.joinPath(folder.uri, ...parts.slice(0, i + 1));
                    if (!folderResults.has(folderUri.fsPath)) {
                        folderResults.set(folderUri.fsPath, {
                            path: prefix + parts.slice(0, i + 1).join('/'),
                            fsPath: folderUri.fsPath,
                            fileName: parts[i],
                            isFolder: true
                        });
                    }
                }
            }

            const byPath = (a: FileResult, b: FileResult) => a.path.localeCompare(b.path);
            const results = [
                ...[...folderResults.values()].sort(byPath),
                ...fileResults.sort(byPath)
            ];

            this._decorationProvider.setMatchingFiles(fileResults.map(r => r.fsPath));
            this._postResults(results, { truncated: found.truncated });
        } catch (error) {
            if (generation !== this._searchGeneration) { return; }
            console.error('File Scout search error:', error);
            this._decorationProvider.clearMatches();
            this._postResults([], { message: `Search failed: ${error instanceof Error ? error.message : error}` });
        }
    }

    private _getHtmlForWebview(_webview: vscode.Webview): string {
        const nonce = getNonce();

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
            <title>File Scout</title>
            <style>
                body {
                    padding: 0;
                    margin: 0;
                    font-family: var(--vscode-font-family);
                    color: var(--vscode-foreground);
                }
                .file-icon {
                    width: 16px;
                    height: 16px;
                    margin-right: 6px;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 11px;
                    font-weight: 600;
                    border-radius: 2px;
                    flex-shrink: 0;
                }
                .icon-ts { background: #3178c6; color: white; }
                .icon-js { background: #f7df1e; color: black; }
                .icon-jsx { background: #61dafb; color: black; }
                .icon-tsx { background: #3178c6; color: white; }
                .icon-json { background: #5c5c5c; color: #ffd700; }
                .icon-html { background: #e44d26; color: white; }
                .icon-css { background: #264de4; color: white; }
                .icon-scss { background: #c66394; color: white; }
                .icon-md { background: transparent; color: #6eb7ff; }
                .icon-py { background: #387eb8; color: #ffd845; }
                .icon-xml { background: #e37933; color: white; }
                .icon-svg { background: #ffb13b; color: white; }
                .icon-git { background: #f14e32; color: white; }
                .icon-default { background: transparent; color: var(--vscode-foreground); opacity: 0.7; }
                .icon-folder { color: var(--vscode-icon-foreground); opacity: 0.8; }
                .icon-chevron { color: var(--vscode-icon-foreground); opacity: 0.6; }
                
                .search-container {
                    padding: 10px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                }
                .search-box {
                    position: relative;
                    display: flex;
                    align-items: center;
                    gap: 4px;
                }
                .search-input {
                    flex: 1;
                    padding: 8px;
                    padding-right: 90px;
                    background: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 4px;
                    font-size: 13px;
                }
                .search-input:focus {
                    outline: 1px solid var(--vscode-focusBorder);
                }
                .search-options {
                    position: absolute;
                    right: 4px;
                    display: flex;
                    gap: 2px;
                    z-index: 1;
                }
                .option-button {
                    width: 24px;
                    height: 24px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background: transparent;
                    border: 1px solid transparent;
                    border-radius: 3px;
                    cursor: pointer;
                    color: var(--vscode-icon-foreground);
                    font-size: 14px;
                    font-weight: 600;
                    transition: all 0.1s;
                }
                .option-button:hover {
                    background: var(--vscode-toolbar-hoverBackground);
                }
                .option-button.active {
                    background: var(--vscode-inputOption-activeBackground);
                    border-color: var(--vscode-inputOption-activeBorder);
                    color: var(--vscode-inputOption-activeForeground);
                }
                .view-options {
                    display: flex;
                    gap: 8px;
                    margin-top: 8px;
                    padding: 4px 0;
                    align-items: center;
                    justify-content: space-between;
                }
                .view-toggle {
                    width: 28px;
                    height: 28px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background: transparent;
                    border: 1px solid var(--vscode-button-border);
                    border-radius: 3px;
                    cursor: pointer;
                    color: var(--vscode-icon-foreground);
                    font-size: 16px;
                    transition: all 0.1s;
                }
                .view-toggle:hover {
                    background: var(--vscode-toolbar-hoverBackground);
                }
                .results-count {
                    font-size: 12px;
                    color: var(--vscode-descriptionForeground);
                    flex: 1;
                    text-align: left;
                }
                .open-editor-button {
                    padding: 4px 8px;
                    font-size: 12px;
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    border-radius: 3px;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    gap: 4px;
                }
                .open-editor-button:hover {
                    background: var(--vscode-button-hoverBackground);
                }
                .filters-section {
                    margin-top: 8px;
                }
                .filter-toggle {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    width: 24px;
                    height: 24px;
                    cursor: pointer;
                    color: var(--vscode-icon-foreground);
                    user-select: none;
                    border-radius: 3px;
                    transition: background 0.1s;
                }
                .filter-toggle:hover {
                    background: var(--vscode-toolbar-hoverBackground);
                }
                .filter-inputs {
                    max-height: 0;
                    overflow: hidden;
                    transition: max-height 0.2s ease-out;
                }
                .filter-inputs.expanded {
                    max-height: 400px;
                    overflow-y: auto;
                }
                .filter-input {
                    width: calc(100% - 20px);
                    padding: 6px 8px;
                    margin: 4px 0;
                    background: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 3px;
                    font-size: 12px;
                }
                .filter-input::placeholder {
                    color: var(--vscode-input-placeholderForeground);
                }
                .filter-input:focus {
                    outline: 1px solid var(--vscode-focusBorder);
                }
                .filter-label {
                    font-size: 11px;
                    color: var(--vscode-descriptionForeground);
                    margin: 8px 0 2px 0;
                }
                .exclude-option {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    padding: 4px 0;
                    font-size: 12px;
                    user-select: none;
                }
                .exclude-checkbox {
                    cursor: pointer;
                }
                .exclude-label {
                    cursor: pointer;
                    color: var(--vscode-foreground);
                }
                .exclude-label:hover {
                    color: var(--vscode-textLink-activeForeground);
                }
                .exclude-toggle {
                    font-size: 11px;
                    color: var(--vscode-textLink-foreground);
                    cursor: pointer;
                    margin: 4px 0;
                    text-decoration: underline;
                }
                .exclude-toggle:hover {
                    color: var(--vscode-textLink-activeForeground);
                }
                .exclude-checkboxes {
                    max-height: 0;
                    overflow: hidden;
                    transition: max-height 0.2s ease-out;
                }
                .exclude-checkboxes.expanded {
                    max-height: 300px;
                }
                .results-container {
                    padding: 10px;
                }
                .file-item {
                    padding: 6px 8px;
                    cursor: pointer;
                    border-radius: 3px;
                    display: flex;
                    align-items: center;
                    font-size: 13px;
                }
                .file-item:focus-visible, .folder-item:focus-visible, .list-item:focus-visible {
                    outline: 1px solid var(--vscode-focusBorder);
                    outline-offset: -1px;
                }
                .file-item:hover {
                    background: var(--vscode-list-hoverBackground);
                }
                .folder-item {
                    padding: 4px 8px;
                    cursor: pointer;
                    border-radius: 3px;
                    display: flex;
                    align-items: center;
                    font-size: 13px;
                    font-weight: 500;
                    user-select: none;
                    gap: 6px;
                }
                .folder-item:hover {
                    background: var(--vscode-list-hoverBackground);
                }
                .folder-children {
                    padding-left: 16px;
                    display: none;
                }
                .folder-children.expanded {
                    display: block;
                }
                .no-results {
                    padding: 20px;
                    text-align: center;
                    color: var(--vscode-descriptionForeground);
                    font-size: 13px;
                }
                .welcome {
                    padding: 20px;
                    text-align: center;
                    color: var(--vscode-descriptionForeground);
                }
                .list-item {
                    padding: 6px 8px;
                    cursor: pointer;
                    border-radius: 3px;
                    display: flex;
                    align-items: center;
                    font-size: 13px;
                    gap: 6px;
                }
                .list-item:hover {
                    background: var(--vscode-list-hoverBackground);
                }
                .list-item-path {
                    margin-left: auto;
                    font-size: 11px;
                    color: var(--vscode-descriptionForeground);
                    opacity: 0.8;
                }
            </style>
        </head>
        <body>
            <div class="search-container">
                <div class="search-box">
                    <input 
                        type="text" 
                        class="search-input" 
                        id="searchInput"
                        placeholder="Search files and folders by name..."
                        aria-label="Search files and folders by name"
                        autofocus
                    />
                    <div class="search-options">
                        <button 
                            class="option-button" 
                            id="btnMatchCase"
                            title="Match Case (Ctrl+Alt+C / Cmd+Alt+C)" aria-label="Match Case" aria-pressed="false"
                        >Aa</button>
                        <button 
                            class="option-button" 
                            id="btnMatchWord"
                            title="Match Whole Word: match exact filename (Ctrl+Alt+W / Cmd+Alt+W)"
                            aria-label="Match Whole Word" aria-pressed="false"
                        >Ab</button>
                        <button 
                            class="option-button" 
                            id="btnUseRegex"
                            title="Use Regular Expression (Ctrl+Alt+R / Cmd+Alt+R)" aria-label="Use Regular Expression" aria-pressed="false"
                        >.*</button>
                    </div>
                </div>
                
                <div class="filters-section">
                    <div class="filter-toggle" id="filterToggleBtn" title="Toggle Search Details">
                        <span style="font-size: 16px; font-weight: bold;">&#x22EF;</span>
                    </div>
                    <div class="filter-inputs" id="filterInputs">
                        <div class="filter-label">Files to include</div>
                        <input 
                            type="text" 
                            class="filter-input" 
                            id="filesToInclude"
                            placeholder="e.g., **/*.ts, src/**"
                        />
                        <div class="filter-label" style="margin-top: 12px;">Files to exclude</div>
                        <div class="exclude-toggle" id="excludeToggleBtn">
                            &#x25B6; Common folders to exclude
                        </div>
                        <div class="exclude-checkboxes" id="excludeCheckboxes">
                            <div class="exclude-option">
                                <input type="checkbox" class="exclude-checkbox" id="exclude-node-modules" checked>
                                <label class="exclude-label" for="exclude-node-modules">node_modules/</label>
                            </div>
                            <div class="exclude-option">
                                <input type="checkbox" class="exclude-checkbox" id="exclude-dist">
                                <label class="exclude-label" for="exclude-dist">dist/</label>
                            </div>
                            <div class="exclude-option">
                                <input type="checkbox" class="exclude-checkbox" id="exclude-build">
                                <label class="exclude-label" for="exclude-build">build/</label>
                            </div>
                            <div class="exclude-option">
                                <input type="checkbox" class="exclude-checkbox" id="exclude-out">
                                <label class="exclude-label" for="exclude-out">out/</label>
                            </div>
                            <div class="exclude-option">
                                <input type="checkbox" class="exclude-checkbox" id="exclude-git">
                                <label class="exclude-label" for="exclude-git">.git/</label>
                            </div>
                            <div class="exclude-option">
                                <input type="checkbox" class="exclude-checkbox" id="exclude-vscode">
                                <label class="exclude-label" for="exclude-vscode">.vscode/</label>
                            </div>
                            <div class="exclude-option">
                                <input type="checkbox" class="exclude-checkbox" id="exclude-coverage">
                                <label class="exclude-label" for="exclude-coverage">coverage/</label>
                            </div>
                            <div class="exclude-option">
                                <input type="checkbox" class="exclude-checkbox" id="exclude-temp">
                                <label class="exclude-label" for="exclude-temp">temp/, tmp/</label>
                            </div>
                        </div>
                        <input 
                            type="text" 
                            class="filter-input" 
                            id="filesToExclude"
                            placeholder="Custom patterns: e.g., **/*.test.ts, docs/**"
                        />
                    </div>
                </div>
                <div class="view-options">
                    <button 
                        class="view-toggle" 
                        id="btnViewToggle"
                        title="Toggle Tree/List View"
                    >&#x1F333;</button>
                    <span class="results-count" id="resultsCount"></span>
                    <button 
                        class="open-editor-button" 
                        id="btnOpenEditor"
                        title="Open results in editor"
                        style="display: none;"
                    >&#x1F4DD; Open in Editor</button>
                </div>
            </div>
            <div class="results-container" id="results">
                <div class="welcome">
                    &#x1F50D; Search for files and folders by name
                </div>
            </div>

            <script nonce="${nonce}">
                const vscode = acquireVsCodeApi();
                const searchInput = document.getElementById('searchInput');
                const resultsContainer = document.getElementById('results');
                const filesToInclude = document.getElementById('filesToInclude');
                const filesToExclude = document.getElementById('filesToExclude');

                let searchTimeout;
                let searchOptions = {
                    matchCase: false,
                    matchWholeWord: false,
                    useRegex: false
                };
                let viewMode = 'tree';
                let currentFiles = [];

                function escapeHtml(str) {
                    return String(str)
                        .replace(/&/g, '&amp;')
                        .replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;')
                        .replace(/"/g, '&quot;')
                        .replace(/'/g, '&#39;');
                }

                function applyViewModeButton() {
                    const btn = document.getElementById('btnViewToggle');
                    btn.innerHTML = viewMode === 'tree' ? '&#x1F333;' : '&#x1F4C4;';
                    btn.title = viewMode === 'tree' ? 'Switch to List View' : 'Switch to Tree View';
                    btn.setAttribute('aria-label', btn.title);
                }

                function toggleViewMode() {
                    viewMode = viewMode === 'tree' ? 'list' : 'tree';
                    applyViewModeButton();
                    saveState();
                    
                    if (currentFiles.length > 0) {
                        displayResults(currentFiles);
                    }
                }

                function updateResultsCount(files) {
                    const fileCount = files.filter(function(f) { return !f.isFolder; }).length;
                    const folderCount = files.filter(function(f) { return f.isFolder; }).length;
                    
                    const parts = [];
                    if (fileCount > 0) parts.push(fileCount + ' file' + (fileCount !== 1 ? 's' : ''));
                    if (folderCount > 0) parts.push(folderCount + ' folder' + (folderCount !== 1 ? 's' : ''));
                    
                    document.getElementById('resultsCount').textContent = parts.join(', ');
                    document.getElementById('btnOpenEditor').style.display = files.length > 0 ? 'flex' : 'none';
                }

                function openInEditor() {
                    if (currentFiles.length === 0) return;
                    
                    let content = '# File Scout Search Results\\n';
                    content += '# Query: "' + searchInput.value + '"\\n';
                    content += '# Found ' + currentFiles.length + ' result' + (currentFiles.length !== 1 ? 's' : '') + '\\n\\n';
                    
                    currentFiles.forEach(function(file) {
                        if (file.isFolder) {
                            content += '\\uD83D\\uDCC1 ' + file.path + '/\\n';
                        } else {
                            content += '\\uD83D\\uDCC4 ' + file.path + '\\n';
                        }
                    });
                    
                    vscode.postMessage({ type: 'openInEditor', content: content });
                }

                function toggleExcludeOptions(evt) {
                    const checkboxesDiv = document.getElementById('excludeCheckboxes');
                    const toggle = evt.currentTarget;
                    
                    if (checkboxesDiv.classList.contains('expanded')) {
                        checkboxesDiv.classList.remove('expanded');
                        toggle.innerHTML = '&#x25B6; Common folders to exclude';
                    } else {
                        checkboxesDiv.classList.add('expanded');
                        toggle.innerHTML = '&#x25BC; Common folders to exclude';
                    }
                }

                function updateExcludePattern() {
                    const excludePatterns = [];
                    
                    if (document.getElementById('exclude-node-modules').checked) excludePatterns.push('**/node_modules/**');
                    if (document.getElementById('exclude-dist').checked) excludePatterns.push('**/dist/**');
                    if (document.getElementById('exclude-build').checked) excludePatterns.push('**/build/**');
                    if (document.getElementById('exclude-out').checked) excludePatterns.push('**/out/**');
                    if (document.getElementById('exclude-git').checked) excludePatterns.push('**/.git/**');
                    if (document.getElementById('exclude-vscode').checked) excludePatterns.push('**/.vscode/**');
                    if (document.getElementById('exclude-coverage').checked) excludePatterns.push('**/coverage/**');
                    if (document.getElementById('exclude-temp').checked) {
                        excludePatterns.push('**/temp/**');
                        excludePatterns.push('**/tmp/**');
                    }
                    
                    const customPattern = filesToExclude.value.trim();
                    if (customPattern) {
                        excludePatterns.push(customPattern);
                    }
                    
                    filesToExclude.dataset.effectivePattern = excludePatterns.join(', ');
                    saveState();
                    
                    if (searchInput.value.trim()) {
                        performSearch();
                    }
                }

                function syncOptionButtons() {
                    [['btnMatchCase', 'matchCase'], ['btnMatchWord', 'matchWholeWord'], ['btnUseRegex', 'useRegex']].forEach(function(pair) {
                        const btn = document.getElementById(pair[0]);
                        btn.classList.toggle('active', !!searchOptions[pair[1]]);
                        btn.setAttribute('aria-pressed', searchOptions[pair[1]] ? 'true' : 'false');
                    });
                }

                function toggleOption(option) {
                    searchOptions[option] = !searchOptions[option];
                    // Regex and whole word are mutually exclusive
                    if (searchOptions[option]) {
                        if (option === 'useRegex') { searchOptions.matchWholeWord = false; }
                        if (option === 'matchWholeWord') { searchOptions.useRegex = false; }
                    }
                    syncOptionButtons();
                    performSearch();
                }

                const EXCLUDE_IDS = ['node-modules', 'dist', 'build', 'out', 'git', 'vscode', 'coverage', 'temp'];

                function saveState() {
                    const excludes = {};
                    EXCLUDE_IDS.forEach(function(id) {
                        excludes[id] = document.getElementById('exclude-' + id).checked;
                    });
                    vscode.setState({
                        query: searchInput.value,
                        options: searchOptions,
                        include: filesToInclude.value,
                        exclude: filesToExclude.value,
                        excludes: excludes,
                        viewMode: viewMode,
                        filtersExpanded: document.getElementById('filterInputs').classList.contains('expanded')
                    });
                }

                function loadState() {
                    const state = vscode.getState();
                    if (!state) return;
                    searchInput.value = state.query || '';
                    searchOptions = Object.assign({ matchCase: false, matchWholeWord: false, useRegex: false }, state.options);
                    filesToInclude.value = state.include || '';
                    filesToExclude.value = state.exclude || '';
                    EXCLUDE_IDS.forEach(function(id) {
                        if (state.excludes && id in state.excludes) {
                            document.getElementById('exclude-' + id).checked = !!state.excludes[id];
                        }
                    });
                    if (state.viewMode === 'list') { viewMode = 'list'; applyViewModeButton(); }
                    if (state.filtersExpanded) { document.getElementById('filterInputs').classList.add('expanded'); }
                    syncOptionButtons();
                }

                function toggleFilters() {
                    document.getElementById('filterInputs').classList.toggle('expanded');
                    saveState();
                }

                function performSearch() {
                    saveState();
                    const query = searchInput.value;
                    const effectiveExclude = filesToExclude.dataset.effectivePattern || '';
                    vscode.postMessage({ 
                        type: 'search', 
                        query: query,
                        options: {
                            matchCase: searchOptions.matchCase,
                            matchWholeWord: searchOptions.matchWholeWord,
                            useRegex: searchOptions.useRegex,
                            filesToInclude: filesToInclude.value.trim(),
                            filesToExclude: effectiveExclude
                        }
                    });
                }

                searchInput.addEventListener('input', function() {
                    clearTimeout(searchTimeout);
                    searchTimeout = setTimeout(performSearch, 300);
                });

                searchInput.addEventListener('keydown', function(e) {
                    if (e.key === 'Enter') {
                        clearTimeout(searchTimeout);
                        performSearch();
                    }
                });

                filesToInclude.addEventListener('input', function() {
                    clearTimeout(searchTimeout);
                    searchTimeout = setTimeout(performSearch, 500);
                });

                [filesToInclude, filesToExclude].forEach(function(input) {
                    input.addEventListener('keydown', function(e) {
                        if (e.key === 'Enter') {
                            clearTimeout(searchTimeout);
                            if (input === filesToExclude) { updateExcludePattern(); } else { performSearch(); }
                        }
                    });
                });

                filesToExclude.addEventListener('input', function() {
                    clearTimeout(searchTimeout);
                    searchTimeout = setTimeout(updateExcludePattern, 500);
                });

                // Button event listeners (no inline onclick)
                document.getElementById('btnMatchCase').addEventListener('click', function() { toggleOption('matchCase'); });
                document.getElementById('btnMatchWord').addEventListener('click', function() { toggleOption('matchWholeWord'); });
                document.getElementById('btnUseRegex').addEventListener('click', function() { toggleOption('useRegex'); });
                document.getElementById('btnViewToggle').addEventListener('click', toggleViewMode);
                document.getElementById('btnOpenEditor').addEventListener('click', openInEditor);
                document.getElementById('filterToggleBtn').addEventListener('click', toggleFilters);
                document.getElementById('excludeToggleBtn').addEventListener('click', function(evt) { toggleExcludeOptions(evt); });

                document.querySelectorAll('.exclude-checkbox').forEach(function(cb) {
                    cb.addEventListener('change', updateExcludePattern);
                });

                window.addEventListener('message', function(event) {
                    const message = event.data;
                    if (message.type === 'toggleMatchCase') {
                        toggleOption('matchCase');
                    } else if (message.type === 'toggleMatchWholeWord') {
                        toggleOption('matchWholeWord');
                    } else if (message.type === 'toggleRegex') {
                        toggleOption('useRegex');
                    } else if (message.type === 'focusInput') {
                        searchInput.focus();
                        searchInput.select();
                    } else if (message.type === 'results') {
                        displayResults(message.files, message.message, message.truncated);
                    }
                });

                function displayResults(files, message, truncated) {
                    currentFiles = files;
                    
                    if (files.length === 0) {
                        updateResultsCount([]);
                        if (message) {
                            resultsContainer.innerHTML = '<div class="no-results">' + escapeHtml(message) + '</div>';
                        } else if (searchInput.value.trim() === '') {
                            resultsContainer.innerHTML = '<div class="welcome">&#x1F50D; Search for files and folders by name</div>';
                        } else {
                            resultsContainer.innerHTML = '<div class="no-results">No files found</div>';
                        }
                        return;
                    }

                    updateResultsCount(files);
                    if (truncated) {
                        document.getElementById('resultsCount').textContent += ' (workspace scan limit reached)';
                    }

                    if (viewMode === 'tree') {
                        const tree = buildFileTree(files);
                        resultsContainer.innerHTML = renderTree(tree);
                    } else {
                        resultsContainer.innerHTML = renderList(files);
                    }
                }

                function renderList(files) {
                    return files.map(function(file) {
                        if (file.isFolder) {
                            return '<div class="list-item" tabindex="0" role="button" data-action="revealFolder" data-path="' + escapeHtml(file.fsPath) + '" title="Click to reveal in Explorer">' +
                                '<span class="icon-folder" style="font-size: 16px;">&#x1F4C1;</span>' +
                                '<span>' + escapeHtml(file.fileName) + '</span>' +
                                '<span class="list-item-path">' + escapeHtml(file.path) + '</span>' +
                                '</div>';
                        } else {
                            const icon = getFileIcon(file.fileName);
                            return '<div class="list-item" tabindex="0" role="button" data-action="openFile" data-path="' + escapeHtml(file.fsPath) + '" title="Click to open file">' +
                                '<span class="file-icon ' + icon.cssClass + '">' + icon.text + '</span>' +
                                '<span>' + escapeHtml(file.fileName) + '</span>' +
                                '<span class="list-item-path">' + escapeHtml(file.path) + '</span>' +
                                '</div>';
                        }
                    }).join('');
                }

                function buildFileTree(files) {
                    const tree = {};
                    
                    // fsPath of the ancestor 'levelsUp' directories above a given fsPath
                    function ancestorFsPath(fsPath, levelsUp) {
                        let p = fsPath;
                        for (let k = 0; k < levelsUp; k++) {
                            p = p.substring(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\\\')));
                        }
                        return p;
                    }
                    
                    files.forEach(function(file) {
                        if (file.isFolder) {
                            const parts = file.path.split('/');
                            let current = tree;
                            
                            for (let i = 0; i < parts.length; i++) {
                                const folder = parts[i];
                                const folderPath = parts.slice(0, i + 1).join('/');
                                const folderFsPath = ancestorFsPath(file.fsPath, parts.length - 1 - i);
                                
                                if (!current[folder]) {
                                    current[folder] = { 
                                        __type: 'folder', 
                                        __children: {}, 
                                        __isMatch: i === parts.length - 1,
                                        __fsPath: folderFsPath,
                                        __path: folderPath
                                    };
                                } else if (i === parts.length - 1) {
                                    current[folder].__isMatch = true;
                                    current[folder].__fsPath = folderFsPath;
                                }
                                current = current[folder].__children;
                            }
                        } else {
                            const parts = file.path.split('/');
                            let current = tree;
                            let currentPath = '';
                            
                            for (let i = 0; i < parts.length - 1; i++) {
                                const folder = parts[i];
                                currentPath = currentPath ? currentPath + '/' + folder : folder;
                                const folderFsPath = ancestorFsPath(file.fsPath, parts.length - 1 - i);
                                
                                if (!current[folder]) {
                                    current[folder] = { 
                                        __type: 'folder', 
                                        __children: {}, 
                                        __isMatch: false,
                                        __path: currentPath,
                                        __fsPath: folderFsPath
                                    };
                                }
                                current = current[folder].__children;
                            }
                            
                            const fileName = parts[parts.length - 1];
                            current[fileName] = { __type: 'file', __data: file };
                        }
                    });
                    
                    return tree;
                }

                function getFileIcon(fileName) {
                    const ext = fileName.includes('.') ? (fileName.split('.').pop() || '').toLowerCase() : '';
                    const lowerFileName = fileName.toLowerCase();
                    
                    if (lowerFileName === 'package.json') return { cssClass: 'icon-json', text: '&#x1F4E6;' };
                    if (lowerFileName === 'package-lock.json') return { cssClass: 'icon-json', text: '&#x1F512;' };
                    if (lowerFileName === 'tsconfig.json') return { cssClass: 'icon-json', text: '&#x2699;' };
                    if (lowerFileName === 'readme.md') return { cssClass: 'icon-md', text: '&#x1F4D8;' };
                    if (lowerFileName.startsWith('.git')) return { cssClass: 'icon-git', text: 'git' };
                    if (lowerFileName === 'dockerfile') return { cssClass: 'icon-default', text: '&#x1F433;' };
                    if (lowerFileName === '.env') return { cssClass: 'icon-default', text: '&#x1F510;' };
                    
                    const iconMap = {
                        'ts': { cssClass: 'icon-ts', text: 'TS' },
                        'tsx': { cssClass: 'icon-tsx', text: 'TS' },
                        'js': { cssClass: 'icon-js', text: 'JS' },
                        'jsx': { cssClass: 'icon-jsx', text: 'JS' },
                        'mjs': { cssClass: 'icon-js', text: 'JS' },
                        'cjs': { cssClass: 'icon-js', text: 'JS' },
                        'json': { cssClass: 'icon-json', text: '{}' },
                        'html': { cssClass: 'icon-html', text: 'H' },
                        'htm': { cssClass: 'icon-html', text: 'H' },
                        'css': { cssClass: 'icon-css', text: 'C' },
                        'scss': { cssClass: 'icon-scss', text: 'S' },
                        'sass': { cssClass: 'icon-scss', text: 'S' },
                        'less': { cssClass: 'icon-scss', text: 'L' },
                        'md': { cssClass: 'icon-md', text: 'M' },
                        'markdown': { cssClass: 'icon-md', text: 'M' },
                        'py': { cssClass: 'icon-py', text: 'Py' },
                        'xml': { cssClass: 'icon-xml', text: 'X' },
                        'svg': { cssClass: 'icon-svg', text: '&#x2B21;' },
                        'yml': { cssClass: 'icon-default', text: 'Y' },
                        'yaml': { cssClass: 'icon-default', text: 'Y' },
                        'txt': { cssClass: 'icon-default', text: '&#x1F4DD;' },
                        'sh': { cssClass: 'icon-default', text: '$' },
                        'gitignore': { cssClass: 'icon-git', text: 'git' }
                    };
                    
                    return iconMap[ext] || { cssClass: 'icon-default', text: '&#x1F4C4;' };
                }

                function renderTree(tree, level, parentPath) {
                    level = level || 0;
                    parentPath = parentPath || '';
                    
                    const entries = Object.entries(tree).sort(function(a, b) {
                        const aIsFolder = a[1].__type === 'folder';
                        const bIsFolder = b[1].__type === 'folder';
                        if (aIsFolder && !bIsFolder) return -1;
                        if (!aIsFolder && bIsFolder) return 1;
                        return a[0].localeCompare(b[0]);
                    });

                    return entries.map(function(entry) {
                        const name = entry[0];
                        const node = entry[1];
                        
                        if (node.__type === 'folder') {
                            const folderId = 'folder-' + Math.random().toString(36).substr(2, 9);
                            const hasChildren = Object.keys(node.__children).length > 0;
                            const isMatchingFolder = node.__isMatch === true;
                            const folderFsPath = node.__fsPath || '';
                            const folderPath = node.__path || (parentPath ? parentPath + '/' + name : name);
                            
                            if (!hasChildren && isMatchingFolder) {
                                return '<div class="folder-item" tabindex="0" role="button" data-action="revealFolder" data-path="' + escapeHtml(folderFsPath) + '" title="Click to reveal in Explorer">' +
                                    '<span style="width: 16px;"></span>' +
                                    '<span class="icon-folder" style="font-size: 16px;">&#x1F4C1;</span>' +
                                    '<span>' + escapeHtml(name) + '</span>' +
                                    '<span style="margin-left: auto; font-size: 11px; color: var(--vscode-descriptionForeground);">(folder match)</span>' +
                                    '</div>';
                            }
                            
                            return '<div class="folder-item" tabindex="0" role="button" data-action="toggleFolder" data-folder-id="' + folderId + '" data-folder-path="' + escapeHtml(folderFsPath) + '" title="Click to expand/collapse, Alt+Click to reveal in Explorer">' +
                                '<span class="icon-chevron" id="icon-' + folderId + '" style="font-size: 10px;">&#x25BC;</span>' +
                                '<span class="icon-folder" style="font-size: 16px;">&#x1F4C1;</span>' +
                                '<span>' + escapeHtml(name) + '</span>' +
                                '</div>' +
                                '<div class="folder-children expanded" id="' + folderId + '">' +
                                renderTree(node.__children, level + 1, folderPath) +
                                '</div>';
                        } else {
                            const icon = getFileIcon(node.__data.fileName);
                            return '<div class="file-item" tabindex="0" role="button" data-action="openFile" data-path="' + escapeHtml(node.__data.fsPath) + '">' +
                                '<span class="file-icon ' + icon.cssClass + '">' + icon.text + '</span>' +
                                '<span>' + escapeHtml(name) + '</span>' +
                                '</div>';
                        }
                    }).join('');
                }

                function toggleFolder(folderId) {
                    const folder = document.getElementById(folderId);
                    const icon = document.getElementById('icon-' + folderId);
                    if (!folder || !icon) return;
                    
                    if (folder.classList.contains('expanded')) {
                        folder.classList.remove('expanded');
                        icon.innerHTML = '&#x25B6;';
                    } else {
                        folder.classList.add('expanded');
                        icon.innerHTML = '&#x25BC;';
                    }
                }

                resultsContainer.addEventListener('keydown', function(e) {
                    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[data-action]')) {
                        e.preventDefault();
                        e.target.click();
                    }
                });

                // Event delegation for dynamically rendered items
                resultsContainer.addEventListener('click', function(e) {
                    const item = e.target.closest('[data-action]');
                    if (!item) return;
                    
                    const action = item.dataset.action;
                    const path = item.dataset.path;
                    
                    if (action === 'openFile' && path) {
                        vscode.postMessage({ type: 'openFile', fsPath: path });
                    } else if (action === 'revealFolder' && path) {
                        vscode.postMessage({ type: 'revealFolder', fsPath: path });
                    } else if (action === 'toggleFolder') {
                        if (e.altKey && item.dataset.folderPath) {
                            vscode.postMessage({ type: 'revealFolder', fsPath: item.dataset.folderPath });
                        } else {
                            toggleFolder(item.dataset.folderId);
                        }
                    }
                });

                // Restore the previous UI state (survives the webview being re-created) and re-run the search
                loadState();
                updateExcludePattern(); // also runs the restored search, if any
                searchInput.focus();
            </script>
        </body>
        </html>`;
    }
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
