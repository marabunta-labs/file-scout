import * as vscode from 'vscode';

interface FileDecorationProvider {
    setMatchingFiles(files: string[]): void;
    clearMatches(): void;
}

interface SearchOptions {
    matchCase?: boolean;
    matchWholeWord?: boolean;
    useRegex?: boolean;
    filesToInclude?: string;
    filesToExclude?: string;
}

interface FileResult {
    path: string;
    fsPath: string;
    fileName: string;
    isFolder?: boolean;
}

export class FileScoutWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'fileScoutView';
    private _view?: vscode.WebviewView;
    private _lastQuery = '';
    private _lastOptions: SearchOptions = {};
    private _lastResults: FileResult[] = [];
    private _webviewReady = false;
    private _searchGeneration = 0;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _decorationProvider: FileDecorationProvider
    ) { }

    public postMessage(message: unknown): void {
        this._view?.webview.postMessage(message);
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;
        this._webviewReady = false;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible && this._lastResults.length > 0) {
                this._restoreState();
            }
        });

        webviewView.webview.onDidReceiveMessage(async data => {
            switch (data.type) {
                case 'ready':
                    this._webviewReady = true;
                    if (this._lastResults.length > 0 || this._lastQuery) {
                        this._restoreState();
                    }
                    break;
                case 'search':
                    this._lastQuery = data.query;
                    this._lastOptions = data.options || {};
                    await this._performSearch(data.query, data.options);
                    break;
                case 'openFile': {
                    const uri = vscode.Uri.file(data.fsPath);
                    await vscode.window.showTextDocument(uri);
                    break;
                }
                case 'revealFolder': {
                    const folderUri = vscode.Uri.file(data.fsPath);
                    await vscode.commands.executeCommand('revealInExplorer', folderUri);
                    break;
                }
                case 'openInEditor': {
                    const document = await vscode.workspace.openTextDocument({
                        content: data.content,
                        language: 'markdown'
                    });
                    await vscode.window.showTextDocument(document);
                    break;
                }
            }
        });
    }

    private _restoreState(): void {
        if (!this._webviewReady) { return; }
        const matchingFilePaths = this._lastResults
            .filter(r => !r.isFolder)
            .map(r => r.fsPath);
        this._decorationProvider.setMatchingFiles(matchingFilePaths);

        this._view?.webview.postMessage({
            type: 'restore',
            query: this._lastQuery,
            options: this._lastOptions,
            files: this._lastResults
        });
    }

    private async _performSearch(query: string, options?: SearchOptions): Promise<void> {
        const generation = ++this._searchGeneration;

        if (!query || query.trim() === '') {
            this._decorationProvider.clearMatches();
            this._lastResults = [];
            this._view?.webview.postMessage({ type: 'results', files: [] });
            return;
        }

        const includePattern = options?.filesToInclude || '**/*';
        const excludePattern = options?.filesToExclude || undefined;

        try {
            const foundFiles = await vscode.workspace.findFiles(
                includePattern,
                excludePattern,
                2000
            );

            let searchPattern: RegExp;
            try {
                if (options?.useRegex) {
                    const flags = options?.matchCase ? '' : 'i';
                    searchPattern = new RegExp(query, flags);
                } else {
                    let escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

                    if (options?.matchWholeWord) {
                        escapedQuery = `^${escapedQuery}(\\.|$)`;
                    }

                    const flags = options?.matchCase ? '' : 'i';
                    searchPattern = new RegExp(escapedQuery, flags);
                }
            } catch {
                if (generation !== this._searchGeneration) { return; }
                this._lastResults = [];
                this._view?.webview.postMessage({ type: 'results', files: [] });
                return;
            }

            const results: FileResult[] = [];
            const matchingFolderPaths = new Set<string>();

            // First pass: find matching folders
            for (const uri of foundFiles) {
                const relativePath = vscode.workspace.asRelativePath(uri);
                const pathParts = relativePath.split('/');

                for (let i = 0; i < pathParts.length - 1; i++) {
                    if (searchPattern.test(pathParts[i])) {
                        const folderPath = pathParts.slice(0, i + 1).join('/');
                        matchingFolderPaths.add(folderPath);
                    }
                }
            }

            // Second pass: find matching files
            for (const uri of foundFiles) {
                const relativePath = vscode.workspace.asRelativePath(uri);
                const fileName = uri.path.split('/').pop() || '';

                if (searchPattern.test(fileName)) {
                    results.push({
                        path: relativePath,
                        fsPath: uri.fsPath,
                        fileName
                    });
                }
            }

            // Third pass: add matching folders
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (workspaceFolders && workspaceFolders.length > 0) {
                for (const folderPath of matchingFolderPaths) {
                    const folderUri = vscode.Uri.joinPath(workspaceFolders[0].uri, folderPath);
                    results.push({
                        path: folderPath,
                        fsPath: folderUri.fsPath,
                        fileName: folderPath.split('/').pop() || folderPath,
                        isFolder: true
                    });
                }
            }

            // Discard stale results if a newer search was started
            if (generation !== this._searchGeneration) { return; }

            // Update decorations
            const matchingFilePaths = results
                .filter(r => !r.isFolder)
                .map(r => r.fsPath);
            this._decorationProvider.setMatchingFiles(matchingFilePaths);

            this._lastResults = results;
            this._view?.webview.postMessage({ type: 'results', files: results });
        } catch (error) {
            if (generation !== this._searchGeneration) { return; }
            console.error('File Scout search error:', error);
            this._decorationProvider.clearMatches();
            this._lastResults = [];
            this._view?.webview.postMessage({ type: 'results', files: [] });
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
                        autofocus
                    />
                    <div class="search-options">
                        <button 
                            class="option-button" 
                            id="btnMatchCase"
                            title="Match Case (Alt+C)"
                        >Aa</button>
                        <button 
                            class="option-button" 
                            id="btnMatchWord"
                            title="Match Whole Word: match exact filename (Alt+W)"
                            aria-label="Match Whole Word"
                        >Ab</button>
                        <button 
                            class="option-button" 
                            id="btnUseRegex"
                            title="Use Regular Expression (Alt+R)"
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
                            placeholder="Custom pattern: e.g., **/*.test.ts"
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
                    const div = document.createElement('div');
                    div.textContent = str;
                    return div.innerHTML;
                }

                function toggleViewMode() {
                    viewMode = viewMode === 'tree' ? 'list' : 'tree';
                    const btn = document.getElementById('btnViewToggle');
                    btn.innerHTML = viewMode === 'tree' ? '&#x1F333;' : '&#x1F4C4;';
                    btn.title = viewMode === 'tree' ? 'Switch to List View' : 'Switch to Tree View';
                    
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

                function initializeExcludePattern() {
                    updateExcludePattern();
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
                    
                    let combinedPattern = '';
                    if (excludePatterns.length > 1) {
                        combinedPattern = '{' + excludePatterns.join(',') + '}';
                    } else if (excludePatterns.length === 1) {
                        combinedPattern = excludePatterns[0];
                    }
                    filesToExclude.dataset.effectivePattern = combinedPattern;
                    
                    if (searchInput.value.trim()) {
                        performSearch();
                    }
                }

                function toggleOption(option) {
                    if (option === 'useRegex') {
                        if (searchOptions.useRegex) {
                            searchOptions.useRegex = false;
                            document.getElementById('btnUseRegex').classList.remove('active');
                        } else {
                            searchOptions.useRegex = true;
                            searchOptions.matchWholeWord = false;
                            document.getElementById('btnUseRegex').classList.add('active');
                            document.getElementById('btnMatchWord').classList.remove('active');
                        }
                    } else if (option === 'matchWholeWord') {
                        if (searchOptions.matchWholeWord) {
                            searchOptions.matchWholeWord = false;
                            document.getElementById('btnMatchWord').classList.remove('active');
                        } else {
                            searchOptions.matchWholeWord = true;
                            searchOptions.useRegex = false;
                            document.getElementById('btnMatchWord').classList.add('active');
                            document.getElementById('btnUseRegex').classList.remove('active');
                        }
                    } else if (option === 'matchCase') {
                        searchOptions.matchCase = !searchOptions.matchCase;
                        if (searchOptions.matchCase) {
                            document.getElementById('btnMatchCase').classList.add('active');
                        } else {
                            document.getElementById('btnMatchCase').classList.remove('active');
                        }
                    }
                    
                    performSearch();
                }

                function toggleFilters() {
                    document.getElementById('filterInputs').classList.toggle('expanded');
                }

                function performSearch() {
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

                searchInput.addEventListener('keypress', function(e) {
                    if (e.key === 'Enter') {
                        clearTimeout(searchTimeout);
                        performSearch();
                    }
                });

                filesToInclude.addEventListener('input', function() {
                    clearTimeout(searchTimeout);
                    searchTimeout = setTimeout(performSearch, 500);
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

                // Keyboard shortcuts
                document.addEventListener('keydown', function(e) {
                    if (e.altKey) {
                        if (e.key === 'c' || e.key === 'C') {
                            e.preventDefault();
                            toggleOption('matchCase');
                        } else if (e.key === 'w' || e.key === 'W') {
                            e.preventDefault();
                            toggleOption('matchWholeWord');
                        } else if (e.key === 'r' || e.key === 'R') {
                            e.preventDefault();
                            toggleOption('useRegex');
                        }
                    }
                });

                window.addEventListener('message', function(event) {
                    const message = event.data;
                    if (message.type === 'toggleMatchCase') {
                        toggleOption('matchCase');
                    } else if (message.type === 'toggleMatchWholeWord') {
                        toggleOption('matchWholeWord');
                    } else if (message.type === 'toggleRegex') {
                        toggleOption('useRegex');
                    } else if (message.type === 'results') {
                        displayResults(message.files);
                    } else if (message.type === 'restore') {
                        searchInput.value = message.query || '';
                        
                        document.querySelectorAll('.option-button.active').forEach(function(btn) {
                            btn.classList.remove('active');
                        });
                        
                        searchOptions = { matchCase: false, matchWholeWord: false, useRegex: false };
                        
                        if (message.options) {
                            if (message.options.matchCase) {
                                searchOptions.matchCase = true;
                                document.getElementById('btnMatchCase').classList.add('active');
                            }
                            if (message.options.matchWholeWord) {
                                searchOptions.matchWholeWord = true;
                                document.getElementById('btnMatchWord').classList.add('active');
                            }
                            if (message.options.useRegex) {
                                searchOptions.useRegex = true;
                                document.getElementById('btnUseRegex').classList.add('active');
                            }
                            if (message.options.filesToInclude) {
                                filesToInclude.value = message.options.filesToInclude;
                            }
                            if (message.options.filesToExclude) {
                                const excludePattern = message.options.filesToExclude;
                                document.getElementById('exclude-node-modules').checked = excludePattern.includes('node_modules');
                                document.getElementById('exclude-dist').checked = excludePattern.includes('**/dist/**');
                                document.getElementById('exclude-build').checked = excludePattern.includes('**/build/**');
                                document.getElementById('exclude-out').checked = excludePattern.includes('**/out/**');
                                document.getElementById('exclude-git').checked = excludePattern.includes('.git');
                                document.getElementById('exclude-vscode').checked = excludePattern.includes('.vscode');
                                document.getElementById('exclude-coverage').checked = excludePattern.includes('**/coverage/**');
                                document.getElementById('exclude-temp').checked = excludePattern.includes('**/temp/**') || excludePattern.includes('**/tmp/**');
                                filesToExclude.dataset.effectivePattern = excludePattern;
                            }
                        }
                        
                        if (message.files && message.files.length > 0) {
                            displayResults(message.files);
                        }
                    }
                });

                function displayResults(files) {
                    currentFiles = files;
                    
                    if (files.length === 0) {
                        updateResultsCount([]);
                        if (searchInput.value.trim() === '') {
                            resultsContainer.innerHTML = '<div class="welcome">&#x1F50D; Search for files and folders by name</div>';
                        } else {
                            resultsContainer.innerHTML = '<div class="no-results">No files found</div>';
                        }
                        return;
                    }

                    updateResultsCount(files);

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
                            return '<div class="list-item" data-action="revealFolder" data-path="' + escapeHtml(file.fsPath) + '" title="Click to reveal in Explorer">' +
                                '<span class="icon-folder" style="font-size: 16px;">&#x1F4C1;</span>' +
                                '<span>' + escapeHtml(file.fileName) + '</span>' +
                                '<span class="list-item-path">' + escapeHtml(file.path) + '</span>' +
                                '</div>';
                        } else {
                            const icon = getFileIcon(file.fileName);
                            return '<div class="list-item" data-action="openFile" data-path="' + escapeHtml(file.fsPath) + '" title="Click to open file">' +
                                '<span class="file-icon ' + icon.cssClass + '">' + icon.text + '</span>' +
                                '<span>' + escapeHtml(file.fileName) + '</span>' +
                                '<span class="list-item-path">' + escapeHtml(file.path) + '</span>' +
                                '</div>';
                        }
                    }).join('');
                }

                function buildFileTree(files) {
                    const tree = {};
                    
                    let workspaceBasePath = '';
                    if (files.length > 0) {
                        const first = files[0];
                        workspaceBasePath = first.fsPath.substring(0, first.fsPath.length - first.path.length);
                    }
                    
                    files.forEach(function(file) {
                        if (file.isFolder) {
                            const parts = file.path.split('/');
                            let current = tree;
                            
                            for (let i = 0; i < parts.length; i++) {
                                const folder = parts[i];
                                const folderPath = parts.slice(0, i + 1).join('/');
                                const folderFsPath = workspaceBasePath + folderPath;
                                
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
                                const folderFsPath = workspaceBasePath + currentPath;
                                
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
                    const ext = (fileName.split('.').pop() || '').toLowerCase();
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
                                return '<div class="folder-item" data-action="revealFolder" data-path="' + escapeHtml(folderFsPath) + '" title="Click to reveal in Explorer">' +
                                    '<span style="width: 16px;"></span>' +
                                    '<span class="icon-folder" style="font-size: 16px;">&#x1F4C1;</span>' +
                                    '<span>' + escapeHtml(name) + '</span>' +
                                    '<span style="margin-left: auto; font-size: 11px; color: var(--vscode-descriptionForeground);">(empty match)</span>' +
                                    '</div>';
                            }
                            
                            return '<div class="folder-item" data-action="toggleFolder" data-folder-id="' + folderId + '" data-folder-path="' + escapeHtml(folderFsPath) + '" title="Click to expand/collapse, Alt+Click to reveal in Explorer">' +
                                '<span class="icon-chevron" id="icon-' + folderId + '" style="font-size: 10px;">&#x25BC;</span>' +
                                '<span class="icon-folder" style="font-size: 16px;">&#x1F4C1;</span>' +
                                '<span>' + escapeHtml(name) + '</span>' +
                                '</div>' +
                                '<div class="folder-children expanded" id="' + folderId + '">' +
                                renderTree(node.__children, level + 1, folderPath) +
                                '</div>';
                        } else {
                            const icon = getFileIcon(node.__data.fileName);
                            return '<div class="file-item" data-action="openFile" data-path="' + escapeHtml(node.__data.fsPath) + '">' +
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

                // Initialize and notify extension we're ready
                initializeExcludePattern();
                vscode.postMessage({ type: 'ready' });
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
