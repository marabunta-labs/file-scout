# Change Log

All notable changes to the "file-scout" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

## [1.1.0] - 2026-11-23

### Fixed
- Include/exclude fields now accept comma-separated globs (as the placeholder promised).
- File names containing quotes no longer break result items (proper HTML escaping).
- Multi-root workspaces: folder results and tree paths resolve to the right root.
- Keyboard shortcuts no longer toggle twice when the view has focus; tooltips show the real shortcuts.
- Search state (query, options, filters, view mode) is preserved when the view is re-created; `retainContextWhenHidden` is now set where VS Code honours it.
- Invalid regex / failed searches show a message and clear stale decorations.
- Stale searches are cancelled; file list is cached until the workspace changes.
- Decorations are cleared when the view is disposed, and only changed files are refreshed.
- `File Scout: Open File` is hidden from the Command Palette (it needs an argument).

### Added
- `File Scout: Focus Search` command, `fileScout.maxFiles` setting, truncation notice, sorted results, keyboard navigation and ARIA attributes, unit tests for glob/pattern helpers.