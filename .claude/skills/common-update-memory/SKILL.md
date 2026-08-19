---
name: common-update-memory
description: >
  Reviews staged changes and updates CLAUDE.md to reflect any architectural,
  structural, or conceptual changes. Called automatically by common-pr-commit
  before committing. Can also be invoked manually via "update memory",
  "sync claude.md", or "update project docs".
---

# Update Project Memory (CLAUDE.md)

You review the current staged changes (or recent diff) and update CLAUDE.md to keep it accurate. This runs before every commit to ensure the project documentation stays in sync with the codebase.

## What to check

Read the staged diff (`git diff --cached`) and look for changes that affect any section of CLAUDE.md:

### Repository structure
- New or renamed files/folders in `.claude/skills/`, `company/`, `ebos/`, `common/`
- New skill folders → add to the structure tree and "What goes where" section
- New `{domain}-shared/` folders → document what they contain
- New file patterns (e.g., `company/2026-Q2-*-rocks.md`) → document the pattern
- Deleted skills or folders → remove from the structure tree

### Key concepts
- New terms, frameworks, or methodologies introduced in skill definitions or reference files
- Updated definitions (e.g., Rock format changed from SMART to Title+Dream+KRs)
- New acronyms used in skills or company docs

### MCP integrations
- New MCP tools referenced in skills (e.g., ClickUp task types, Google Drive folders)
- New ClickUp list IDs, space IDs, or document IDs used in skills
- New external service connections

### ClickUp user ID mappings
- New people referenced in skills or company docs

### Conventions
- New naming patterns (e.g., `{domain}-shared` for shared reference folders)
- New rules about how skills should reference shared files
- New workflow conventions (e.g., "never duplicate reference content across skills")

### Key people
- New team members, role changes, or department changes in `company/departments.md`

## How to update

1. Read the staged diff
2. Read current CLAUDE.md
3. For each section, check if the diff introduces something that should be reflected
4. If yes — edit CLAUDE.md with the minimal change needed (don't rewrite sections that aren't affected)
5. If no changes needed — do nothing, don't touch the file
6. Stage CLAUDE.md if it was modified (`git add CLAUDE.md`)

## Rules

- **Minimal changes only** — don't reorganize or rewrite sections that weren't affected by the diff
- **Don't add speculative content** — only document what's actually in the codebase now
- **Don't remove content** unless the corresponding code/files were deleted
- **Keep the same style** — match the existing formatting, tone, and level of detail in CLAUDE.md
- **No commit messages or changelogs** — CLAUDE.md describes the current state, not the history
