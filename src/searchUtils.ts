export interface SearchOptions {
    matchCase?: boolean;
    matchWholeWord?: boolean;
    useRegex?: boolean;
    filesToInclude?: string;
    filesToExclude?: string;
}

/**
 * Splits a comma-separated list of globs (ignoring commas inside `{}`), as the
 * native search box does, and combines them into a single glob understood by
 * `workspace.findFiles`.
 */
export function toGlob(input: string | undefined): string | undefined {
    if (!input) { return undefined; }

    const parts: string[] = [];
    let depth = 0;
    let current = '';
    for (const ch of input) {
        if (ch === '{') { depth++; }
        if (ch === '}') { depth = Math.max(0, depth - 1); }
        if (ch === ',' && depth === 0) {
            parts.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    parts.push(current);

    const globs = parts
        .map(p => p.trim())
        .filter(p => p.length > 0)
        .map(p => (p.endsWith('/') ? p + '**' : p));

    if (globs.length === 0) { return undefined; }
    return globs.length === 1 ? globs[0] : `{${globs.join(',')}}`;
}

/** Builds the matcher for a query, or undefined when a regex is invalid. */
export function buildSearchPattern(query: string, options?: SearchOptions): RegExp | undefined {
    const flags = options?.matchCase ? '' : 'i';
    try {
        if (options?.useRegex) {
            return new RegExp(query, flags);
        }
        let escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (options?.matchWholeWord) {
            escaped = `^${escaped}(\\.|$)`;
        }
        return new RegExp(escaped, flags);
    } catch {
        return undefined;
    }
}
