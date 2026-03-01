import * as vscode from 'vscode';

interface FileDecorationProvider {
    setMatchingFiles(files: string[]): void;
    clearMatches(): void;
}

export class FileScoutWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'fileScoutView';
    public _view?: vscode.WebviewView;
    private _lastQuery: string = '';
    private _lastOptions: any = {};
    private _lastResults: any[] = [];

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _decorationProvider: FileDecorationProvider
    ) { }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Listen to visibility changes
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible && (this._lastResults.length > 0 || this._lastQuery)) {
                // Restore file decorations
                const matchingFilePaths = this._lastResults
                    .filter(r => !r.isFolder)
                    .map(r => r.fsPath);
                this._decorationProvider.setMatchingFiles(matchingFilePaths);
                
                // Send the state back to rebuild the UI
                setTimeout(() => {
                    webviewView.webview.postMessage({ 
                        type: 'restore', 
                        query: this._lastQuery,
                        options: this._lastOptions,
                        files: this._lastResults
                    });
                }, 300);
            }
        });

        // Initial restore on first load
        if (this._lastResults.length > 0 || this._lastQuery) {
            // Restore file decorations first
            const matchingFilePaths = this._lastResults
                .filter(r => !r.isFolder)
                .map(r => r.fsPath);
            this._decorationProvider.setMatchingFiles(matchingFilePaths);
            
            // Send the state back to rebuild the UI
            setTimeout(() => {
                webviewView.webview.postMessage({ 
                    type: 'restore', 
                    query: this._lastQuery,
                    options: this._lastOptions,
                    files: this._lastResults
                });
            }, 300);
        }

        // Escuchar mensajes desde el webview
        webviewView.webview.onDidReceiveMessage(async data => {
            switch (data.type) {
                case 'search':
                    // Save query and options for state restoration
                    this._lastQuery = data.query;
                    this._lastOptions = data.options || {};
                    await this.performSearch(data.query, data.options);
                    break;
                case 'openFile':
                    const uri = vscode.Uri.file(data.fsPath);
                    await vscode.window.showTextDocument(uri);
                    break;
                case 'revealFolder':
                    const folderUri = vscode.Uri.file(data.fsPath);
                    await vscode.commands.executeCommand('revealInExplorer', folderUri);
                    break;
                case 'openInEditor':
                    // Create a new untitled document with the results
                    const document = await vscode.workspace.openTextDocument({
                        content: data.content,
                        language: 'markdown'
                    });
                    await vscode.window.showTextDocument(document);
                    break;
            }
        });
    }

    private async performSearch(query: string, options?: {
        matchCase?: boolean;
        matchWholeWord?: boolean;
        useRegex?: boolean;
        filesToInclude?: string;
        filesToExclude?: string;
    }) {
        if (!query || query.trim() === '') {
            this._decorationProvider.clearMatches();
            this._lastResults = [];
            this._view?.webview.postMessage({ type: 'results', files: [] });
            return;
        }

        const includePattern = options?.filesToInclude || '**/*';
        const excludePattern = options?.filesToExclude || '';
        
        try {
            // Get all files matching the include/exclude patterns
            const foundFiles = await vscode.workspace.findFiles(
                includePattern,
                excludePattern || undefined,
                2000
            );

            // Build search pattern for filename matching
            let searchPattern: RegExp;
            try {
                if (options?.useRegex) {
                    const flags = options?.matchCase ? '' : 'i';
                    searchPattern = new RegExp(query, flags);
                } else {
                    // Escape special regex characters
                    let escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    
                    if (options?.matchWholeWord) {
                        // For filenames, whole word means exact name match (before extension)
                        escapedQuery = `^${escapedQuery}(\\.|$)`;
                    }
                    
                    const flags = options?.matchCase ? '' : 'i';
                    searchPattern = new RegExp(escapedQuery, flags);
                }
            } catch (e) {
                // Invalid regex, return empty results
                this._lastResults = [];
                this._view?.webview.postMessage({ type: 'results', files: [] });
                return;
            }

            // Filter files: include if filename matches OR folder name matches (but smartly)
            const results: any[] = [];
            const matchingFolderPaths = new Set<string>();
            
            // First pass: find all folders that match the pattern
            foundFiles.forEach(uri => {
                const relativePath = vscode.workspace.asRelativePath(uri);
                const pathParts = relativePath.split('/');
                
                // Check each folder in the path
                for (let i = 0; i < pathParts.length - 1; i++) {
                    const folderName = pathParts[i];
                    if (searchPattern.test(folderName)) {
                        // Store the full path to this matching folder
                        const folderPath = pathParts.slice(0, i + 1).join('/');
                        matchingFolderPaths.add(folderPath);
                    }
                }
            });
            
            // Track which matching folders have files
            const foldersWithMatchingFiles = new Set<string>();
            
            // Second pass: include files based on matching criteria
            foundFiles.forEach(uri => {
                const relativePath = vscode.workspace.asRelativePath(uri);
                const fileName = uri.path.split('/').pop() || '';
                
                // Check if filename matches
                const fileNameMatches = searchPattern.test(fileName);
                
                // Check if file is directly inside a matching folder
                let matchingFolderPath: string | null = null;
                for (const folderPath of matchingFolderPaths) {
                    if (relativePath.startsWith(folderPath + '/')) {
                        matchingFolderPath = folderPath;
                        break;
                    }
                }
                
                // Include file if:
                // 1. Filename matches (regardless of folder)
                // 2. File is inside a matching folder AND the filename also matches
                if (fileNameMatches) {
                    results.push({
                        path: relativePath,
                        fsPath: uri.fsPath,
                        fileName: fileName
                    });
                    
                    // Mark this folder as having matching files
                    if (matchingFolderPath) {
                        foldersWithMatchingFiles.add(matchingFolderPath);
                    }
                }
            });
            
            // Third pass: add all matching folders as folder entries
            for (const folderPath of matchingFolderPaths) {
                // Add folder entry (regardless of whether it has matching files)
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (workspaceFolders && workspaceFolders.length > 0) {
                    const folderUri = vscode.Uri.joinPath(workspaceFolders[0].uri, folderPath);
                    results.push({
                        path: folderPath,
                        fsPath: folderUri.fsPath,
                        fileName: folderPath.split('/').pop() || folderPath,
                        isFolder: true
                    });
                }
            }

            // Update file decorations in Explorer
            const matchingFilePaths = results
                .filter(r => !r.isFolder)
                .map(r => r.fsPath);
            this._decorationProvider.setMatchingFiles(matchingFilePaths);

            this._lastResults = results;
            this._view?.webview.postMessage({ type: 'results', files: results });
        } catch (error) {
            console.error('Search error:', error);
            this._decorationProvider.clearMatches();
            this._lastResults = [];
            this._view?.webview.postMessage({ type: 'results', files: [] });
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
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
                .exclude-options {
                    margin: 8px 0;
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
                .action-button {
                    padding: 2px 6px;
                    font-size: 11px;
                    background: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                    border: none;
                    border-radius: 2px;
                    cursor: pointer;
                    margin-left: 4px;
                }
                .action-button:hover {
                    background: var(--vscode-button-secondaryHoverBackground);
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
                            title="Match Case - Case sensitive search (Alt+C)"
                            onclick="toggleOption('matchCase')"
                        >Aa</button>
                        <button 
                            class="option-button" 
                            id="btnMatchWord"
                            title="Match Whole Word - Match exact filename (Alt+W)"
                            onclick="toggleOption('matchWholeWord')"
                        >Ab</button>
                        <button 
                            class="option-button" 
                            id="btnUseRegex"
                            title="Use Regular Expression (Alt+R)"
                            onclick="toggleOption('useRegex')"
                        >.*</button>
                    </div>
                </div>
                
                <div class="filters-section">
                    <div class="filter-toggle" onclick="toggleFilters()" title="Toggle Search Details">
                        <span style="font-size: 16px; font-weight: bold;">⋯</span>
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
                        <div class="exclude-toggle" onclick="toggleExcludeOptions()">
                            ▶ Common folders to exclude
                        </div>
                        <div class="exclude-checkboxes" id="excludeCheckboxes">
                            <div class="exclude-option">
                                <input type="checkbox" class="exclude-checkbox" id="exclude-node-modules" checked onchange="updateExcludePattern()">
                                <label class="exclude-label" for="exclude-node-modules">node_modules/</label>
                            </div>
                            <div class="exclude-option">
                                <input type="checkbox" class="exclude-checkbox" id="exclude-dist" onchange="updateExcludePattern()">
                                <label class="exclude-label" for="exclude-dist">dist/</label>
                            </div>
                            <div class="exclude-option">
                                <input type="checkbox" class="exclude-checkbox" id="exclude-build" onchange="updateExcludePattern()">
                                <label class="exclude-label" for="exclude-build">build/</label>
                            </div>
                            <div class="exclude-option">
                                <input type="checkbox" class="exclude-checkbox" id="exclude-out" onchange="updateExcludePattern()">
                                <label class="exclude-label" for="exclude-out">out/</label>
                            </div>
                            <div class="exclude-option">
                                <input type="checkbox" class="exclude-checkbox" id="exclude-git" onchange="updateExcludePattern()">
                                <label class="exclude-label" for="exclude-git">.git/</label>
                            </div>
                            <div class="exclude-option">
                                <input type="checkbox" class="exclude-checkbox" id="exclude-vscode" onchange="updateExcludePattern()">
                                <label class="exclude-label" for="exclude-vscode">.vscode/</label>
                            </div>
                            <div class="exclude-option">
                                <input type="checkbox" class="exclude-checkbox" id="exclude-coverage" onchange="updateExcludePattern()">
                                <label class="exclude-label" for="exclude-coverage">coverage/</label>
                            </div>
                            <div class="exclude-option">
                                <input type="checkbox" class="exclude-checkbox" id="exclude-temp" onchange="updateExcludePattern()">
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
                        onclick="toggleViewMode()"
                    >🌳</button>
                    <span class="results-count" id="resultsCount"></span>
                    <button 
                        class="open-editor-button" 
                        id="btnOpenEditor"
                        title="Open results in editor"
                        onclick="openInEditor()"
                        style="display: none;"
                    >📝 Open in Editor</button>
                </div>            </div>
            <div class="results-container" id="results">
                <div class="welcome">
                    � Search for files and folders by name
                </div>
            </div>

            <script>
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
                let viewMode = 'tree'; // 'tree' or 'list'
                let currentFiles = []; // Store current results

                function toggleViewMode() {
                    viewMode = viewMode === 'tree' ? 'list' : 'tree';
                    
                    // Update button icon
                    document.getElementById('btnViewToggle').textContent = viewMode === 'tree' ? '🌳' : '📄';
                    document.getElementById('btnViewToggle').title = viewMode === 'tree' ? 'Switch to List View' : 'Switch to Tree View';
                    
                    // Re-render current results
                    if (currentFiles.length > 0) {
                        displayResults(currentFiles);
                    }
                }

                function updateResultsCount(files) {
                    const fileCount = files.filter(f => !f.isFolder).length;
                    const folderCount = files.filter(f => f.isFolder).length;
                    
                    const countText = [];
                    if (fileCount > 0) countText.push(\`\${fileCount} file\${fileCount !== 1 ? 's' : ''}\`);
                    if (folderCount > 0) countText.push(\`\${folderCount} folder\${folderCount !== 1 ? 's' : ''}\`);
                    
                    document.getElementById('resultsCount').textContent = countText.join(', ');
                    
                    // Show/hide "Open in Editor" button
                    document.getElementById('btnOpenEditor').style.display = files.length > 0 ? 'flex' : 'none';
                }

                function openInEditor() {
                    if (currentFiles.length === 0) return;
                    
                    // Create content for the editor
                    let content = \`# File Scout Search Results\\n\`;
                    content += \`# Query: "\${searchInput.value}"\\n\`;
                    content += \`# Found \${currentFiles.length} result\${currentFiles.length !== 1 ? 's' : ''}\\n\`;
                    content += \`\\n\`;
                    
                    currentFiles.forEach(file => {
                        if (file.isFolder) {
                            content += \`📁 \${file.path}/\\n\`;
                        } else {
                            content += \`📄 \${file.path}\\n\`;
                        }
                    });
                    
                    vscode.postMessage({ 
                        type: 'openInEditor', 
                        content: content,
                        language: 'markdown'
                    });
                }

                // Initialize exclude pattern from checkboxes
                function initializeExcludePattern() {
                    updateExcludePattern();
                }

                function toggleExcludeOptions() {
                    const checkboxesDiv = document.getElementById('excludeCheckboxes');
                    const toggle = event.target;
                    
                    if (checkboxesDiv.classList.contains('expanded')) {
                        checkboxesDiv.classList.remove('expanded');
                        toggle.textContent = '▶ Common folders to exclude';
                    } else {
                        checkboxesDiv.classList.add('expanded');
                        toggle.textContent = '▼ Common folders to exclude';
                    }
                }

                function updateExcludePattern() {
                    const excludePatterns = [];
                    
                    if (document.getElementById('exclude-node-modules').checked) {
                        excludePatterns.push('**/node_modules/**');
                    }
                    if (document.getElementById('exclude-dist').checked) {
                        excludePatterns.push('**/dist/**');
                    }
                    if (document.getElementById('exclude-build').checked) {
                        excludePatterns.push('**/build/**');
                    }
                    if (document.getElementById('exclude-out').checked) {
                        excludePatterns.push('**/out/**');
                    }
                    if (document.getElementById('exclude-git').checked) {
                        excludePatterns.push('**/.git/**');
                    }
                    if (document.getElementById('exclude-vscode').checked) {
                        excludePatterns.push('**/.vscode/**');
                    }
                    if (document.getElementById('exclude-coverage').checked) {
                        excludePatterns.push('**/coverage/**');
                    }
                    if (document.getElementById('exclude-temp').checked) {
                        excludePatterns.push('**/temp/**', '**/tmp/**');
                    }
                    
                    // Add custom pattern if any
                    const customPattern = filesToExclude.value.trim();
                    if (customPattern) {
                        excludePatterns.push(customPattern);
                    }
                    
                    // Update the exclude input (hidden from user, but used for search)
                    let combinedPattern = '';
                    if (excludePatterns.length > 1) {
                        combinedPattern = \`{\${excludePatterns.join(',')}}\`;
                    } else if (excludePatterns.length === 1) {
                        combinedPattern = excludePatterns[0];
                    }
                    filesToExclude.dataset.effectivePattern = combinedPattern;
                    
                    // Re-search with new pattern
                    if (searchInput.value.trim()) {
                        performSearch();
                    }
                }

                function toggleOption(option) {
                    const btnId = option === 'matchCase' ? 'btnMatchCase' : 
                                  option === 'matchWholeWord' ? 'btnMatchWord' : 'btnUseRegex';
                    const button = document.getElementById(btnId);
                    
                    // If this option is already active, deactivate it
                    if (searchOptions[option]) {
                        searchOptions[option] = false;
                        if (button) button.classList.remove('active');
                    } else {
                        // Deactivate all options first (they are mutually exclusive)
                        const allOptions = ['matchCase', 'matchWholeWord', 'useRegex'];
                        allOptions.forEach(opt => {
                            searchOptions[opt] = false;
                            const optBtnId = opt === 'matchCase' ? 'btnMatchCase' : 
                                          opt === 'matchWholeWord' ? 'btnMatchWord' : 'btnUseRegex';
                            const btn = document.getElementById(optBtnId);
                            if (btn) btn.classList.remove('active');
                        });
                        
                        // Activate the selected option
                        searchOptions[option] = true;
                        if (button) button.classList.add('active');
                    }
                    
                    // Re-search with new options
                    performSearch();
                }

                function toggleFilters() {
                    const filterInputs = document.getElementById('filterInputs');
                    
                    if (filterInputs.classList.contains('expanded')) {
                        filterInputs.classList.remove('expanded');
                    } else {
                        filterInputs.classList.add('expanded');
                    }
                }

                function performSearch() {
                    const query = searchInput.value;
                    const effectiveExclude = filesToExclude.dataset.effectivePattern || '';
                    const options = {
                        ...searchOptions,
                        filesToInclude: filesToInclude.value.trim(),
                        filesToExclude: effectiveExclude
                    };
                    
                    vscode.postMessage({ 
                        type: 'search', 
                        query,
                        options 
                    });
                }

                searchInput.addEventListener('input', (e) => {
                    clearTimeout(searchTimeout);
                    searchTimeout = setTimeout(() => {
                        performSearch();
                    }, 300);
                });

                searchInput.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') {
                        clearTimeout(searchTimeout);
                        performSearch();
                    }
                });

                filesToInclude.addEventListener('input', () => {
                    clearTimeout(searchTimeout);
                    searchTimeout = setTimeout(() => {
                        performSearch();
                    }, 500);
                });

                filesToExclude.addEventListener('input', () => {
                    clearTimeout(searchTimeout);
                    searchTimeout = setTimeout(() => {
                        updateExcludePattern();
                    }, 500);
                });

                // Keyboard shortcuts
                document.addEventListener('keydown', (e) => {
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

                window.addEventListener('message', event => {
                    const message = event.data;
                    console.log("Received message:", message.type);
                    if (message.type === 'toggleMatchCase') {
                        toggleOption('matchCase');
                    } else if (message.type === 'toggleMatchWholeWord') {
                        toggleOption('matchWholeWord');
                    } else if (message.type === 'toggleRegex') {
                        toggleOption('useRegex');
                    } else if (message.type === 'results') {
                        displayResults(message.files);
                    } else if (message.type === 'restore') {
                        // Restore previous search state
                        searchInput.value = message.query || '';
                        
                        // Clear all active states first
                        document.querySelectorAll('.option-button.active').forEach(btn => {
                            btn.classList.remove('active');
                        });
                        
                        // Restore options
                        if (message.options) {
                            if (message.options.matchCase) {
                                document.getElementById('btnMatchCase').classList.add('active');
                            }
                            if (message.options.matchWholeWord) {
                                document.getElementById('btnMatchWord').classList.add('active');
                            }
                            if (message.options.useRegex) {
                                document.getElementById('btnUseRegex').classList.add('active');
                            }
                            if (message.options.filesToInclude) {
                                filesToInclude.value = message.options.filesToInclude;
                            }
                            if (message.options.filesToExclude) {
                                // Restore exclude pattern and update checkboxes accordingly
                                const excludePattern = message.options.filesToExclude;
                                
                                // Check which patterns are included
                                document.getElementById('exclude-node-modules').checked = excludePattern.includes('node_modules');
                                document.getElementById('exclude-dist').checked = excludePattern.includes('**/dist/**');
                                document.getElementById('exclude-build').checked = excludePattern.includes('**/build/**');
                                document.getElementById('exclude-out').checked = excludePattern.includes('**/out/**');
                                document.getElementById('exclude-git').checked = excludePattern.includes('.git');
                                document.getElementById('exclude-vscode').checked = excludePattern.includes('.vscode');
                                document.getElementById('exclude-coverage').checked = excludePattern.includes('**/coverage/**');
                                document.getElementById('exclude-temp').checked = excludePattern.includes('**/temp/**') || excludePattern.includes('**/tmp/**');
                                
                                // Extract custom pattern (anything that's not a checkbox pattern)
                                const standardPatterns = [
                                    '**/node_modules/**', '**/dist/**', '**/build/**', '**/out/**',
                                    '**/.git/**', '**/.vscode/**', '**/coverage/**', '**/temp/**', '**/tmp/**'
                                ];
                                const patterns = excludePattern.split(',').map(p => p.trim());
                                const customPatterns = patterns.filter(p => !standardPatterns.includes(p));
                                if (customPatterns.length > 0) {
                                    filesToExclude.value = customPatterns.join(', ');
                                }
                                
                                // Update the effective pattern
                                updateExcludePattern();
                            }
                        }
                        
                        // Restore results
                        if (message.files && message.files.length > 0) {
                            displayResults(message.files);
                        }
                    }
                });

                function displayResults(files) {
                    // Store current results
                    currentFiles = files;
                    
                    if (files.length === 0) {
                        updateResultsCount([]);
                        if (searchInput.value.trim() === '') {
                            resultsContainer.innerHTML = '<div class="welcome">� Search for files and folders by name</div>';
                        } else {
                            resultsContainer.innerHTML = '<div class="no-results">No files found</div>';
                        }
                        return;
                    }

                    // Update results count
                    updateResultsCount(files);

                    // Render based on view mode
                    if (viewMode === 'tree') {
                        const tree = buildFileTree(files);
                        resultsContainer.innerHTML = renderTree(tree);
                    } else {
                        resultsContainer.innerHTML = renderList(files);
                    }
                }

                function renderList(files) {
                    return files.map(file => {
                        if (file.isFolder) {
                            return \`
                                <div class="list-item" onclick="revealFolder('\${file.fsPath}')" title="Click to reveal in Explorer">
                                    <span class="icon-folder" style="font-size: 16px;">📁</span>
                                    <span>\${file.fileName}</span>
                                    <span class="list-item-path">\${file.path}</span>
                                </div>
                            \`;
                        } else {
                            const icon = getFileIcon(file.fileName);
                            return \`
                                <div class="list-item" onclick="openFile('\${file.fsPath}')" title="Click to open file">
                                    <span class="file-icon \${icon.class}">\${icon.text}</span>
                                    <span>\${file.fileName}</span>
                                    <span class="list-item-path">\${file.path}</span>
                                </div>
                            \`;
                        }
                    }).join('');
                }

                function buildFileTree(files) {
                    const tree = {};
                    
                    // Get workspace base path from first file
                    let workspaceBasePath = '';
                    if (files.length > 0 && !files[0].isFolder) {
                        const firstFilePath = files[0].fsPath;
                        const relativePath = files[0].path;
                        workspaceBasePath = firstFilePath.substring(0, firstFilePath.length - relativePath.length);
                    } else if (files.length > 0 && files[0].isFolder) {
                        const folderPath = files[0].fsPath;
                        const relativePath = files[0].path;
                        workspaceBasePath = folderPath.substring(0, folderPath.length - relativePath.length);
                    }
                    
                    files.forEach(file => {
                        if (file.isFolder) {
                            // This is a matching folder with no matching files
                            const parts = file.path.split('/');
                            let current = tree;
                            
                            // Build folder structure up to this folder
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
                            // This is a file
                            const parts = file.path.split('/');
                            let current = tree;
                            let currentPath = '';
                            
                            // Build folder structure
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
                            
                            // Add file
                            const fileName = parts[parts.length - 1];
                            current[fileName] = { __type: 'file', __data: file };
                        }
                    });
                    
                    return tree;
                }

                function getFileIcon(fileName) {
                    const ext = fileName.split('.').pop()?.toLowerCase() || '';
                    const lowerFileName = fileName.toLowerCase();
                    
                    // Special files
                    if (lowerFileName === 'package.json') return { class: 'icon-json', text: '📦' };
                    if (lowerFileName === 'package-lock.json') return { class: 'icon-json', text: '🔒' };
                    if (lowerFileName === 'tsconfig.json') return { class: 'icon-json', text: '⚙️' };
                    if (lowerFileName === 'readme.md') return { class: 'icon-md', text: '📘' };
                    if (lowerFileName.startsWith('.git')) return { class: 'icon-git', text: 'git' };
                    if (lowerFileName === 'dockerfile') return { class: 'icon-default', text: '🐳' };
                    if (lowerFileName === '.env') return { class: 'icon-default', text: '🔐' };
                    
                    // Extensions with colored badges
                    const iconMap = {
                        'ts': { class: 'icon-ts', text: 'TS' },
                        'tsx': { class: 'icon-tsx', text: 'TS' },
                        'js': { class: 'icon-js', text: 'JS' },
                        'jsx': { class: 'icon-jsx', text: 'JS' },
                        'mjs': { class: 'icon-js', text: 'JS' },
                        'cjs': { class: 'icon-js', text: 'JS' },
                        'json': { class: 'icon-json', text: '{}' },
                        'html': { class: 'icon-html', text: 'H' },
                        'htm': { class: 'icon-html', text: 'H' },
                        'css': { class: 'icon-css', text: 'C' },
                        'scss': { class: 'icon-scss', text: 'S' },
                        'sass': { class: 'icon-scss', text: 'S' },
                        'less': { class: 'icon-scss', text: 'L' },
                        'md': { class: 'icon-md', text: 'M' },
                        'markdown': { class: 'icon-md', text: 'M' },
                        'py': { class: 'icon-py', text: 'Py' },
                        'xml': { class: 'icon-xml', text: 'X' },
                        'svg': { class: 'icon-svg', text: '⬡' },
                        'yml': { class: 'icon-default', text: 'Y' },
                        'yaml': { class: 'icon-default', text: 'Y' },
                        'txt': { class: 'icon-default', text: '📝' },
                        'sh': { class: 'icon-default', text: '$' },
                        'gitignore': { class: 'icon-git', text: 'git' },
                    };
                    
                    return iconMap[ext] || { class: 'icon-default', text: '📄' };
                }

                function renderTree(tree, level = 0, parentPath = '') {
                    const entries = Object.entries(tree).sort((a, b) => {
                        const aIsFolder = a[1].__type === 'folder';
                        const bIsFolder = b[1].__type === 'folder';
                        if (aIsFolder && !bIsFolder) return -1;
                        if (!aIsFolder && bIsFolder) return 1;
                        return a[0].localeCompare(b[0]);
                    });

                    return entries.map(([name, node]) => {
                        if (node.__type === 'folder') {
                            const folderId = 'folder-' + Math.random().toString(36).substr(2, 9);
                            const hasChildren = Object.keys(node.__children).length > 0;
                            const isMatchingFolder = node.__isMatch === true;
                            const folderPath = node.__path || (parentPath ? parentPath + '/' + name : name);
                            const folderFsPath = node.__fsPath;
                            
                            // If empty matching folder, show clickable to reveal in explorer
                            if (!hasChildren && isMatchingFolder) {
                                return \`
                                    <div class="folder-item" onclick="revealFolder('\${folderFsPath}')" style="cursor: pointer;" title="Click to reveal in Explorer">
                                        <span style="width: 16px;"></span>
                                        <span class="icon-folder" style="font-size: 16px;">📁</span>
                                        <span>\${name}</span>
                                        <span style="margin-left: auto; font-size: 11px; color: var(--vscode-descriptionForeground);">(empty match)</span>
                                    </div>
                                \`;
                            }
                            
                            // Regular folder with children - also clickable
                            return \`
                                <div class="folder-item" onclick="handleFolderClick(event, '\${folderId}', '\${folderFsPath || ''}')" title="Click to expand/collapse, Alt+Click to reveal in Explorer">
                                    <span class="icon-chevron" id="icon-\${folderId}" style="font-size: 10px;">▼</span>
                                    <span class="icon-folder" style="font-size: 16px;">📁</span>
                                    <span>\${name}</span>
                                </div>
                                <div class="folder-children expanded" id="\${folderId}">
                                    \${renderTree(node.__children, level + 1, folderPath)}
                                </div>
                            \`;
                        } else {
                            const icon = getFileIcon(node.__data.fileName);
                            return \`
                                <div class="file-item" onclick="openFile('\${node.__data.fsPath}')">
                                    <span class="file-icon \${icon.class}">\${icon.text}</span>
                                    <span>\${name}</span>
                                </div>
                            \`;
                        }
                    }).join('');
                }

                function toggleFolder(folderId) {
                    const folder = document.getElementById(folderId);
                    const icon = document.getElementById('icon-' + folderId);
                    
                    if (folder.classList.contains('expanded')) {
                        folder.classList.remove('expanded');
                        icon.textContent = '▶';
                    } else {
                        folder.classList.add('expanded');
                        icon.textContent = '▼';
                    }
                }

                function handleFolderClick(event, folderId, fsPath) {
                    // Alt+Click to reveal in explorer
                    if (event.altKey && fsPath) {
                        event.stopPropagation();
                        revealFolder(fsPath);
                    } else {
                        // Normal click to toggle
                        toggleFolder(folderId);
                    }
                }

                function revealFolder(fsPath) {
                    if (fsPath) {
                        vscode.postMessage({ type: 'revealFolder', fsPath });
                    }
                }

                function openFile(fsPath) {
                    vscode.postMessage({ type: 'openFile', fsPath });
                }

                // Initialize exclude pattern on load
                initializeExcludePattern();

                // Manejar apertura de archivos
                window.addEventListener('message', event => {
                    const message = event.data;
                    if (message.type === 'openFile') {
                        // VS Code will handle this
                    }
                });
            </script>
        </body>
        </html>`;
    }
}
