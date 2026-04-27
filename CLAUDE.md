# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build        # Compile TypeScript → dist/
npm start            # Run compiled server (requires env vars)
npm run dev          # Run via ts-node (no build step)
```

No test suite exists. Validate manually:
```bash
CONFLUENCE_URL=https://your-domain.atlassian.net/wiki \
CONFLUENCE_EMAIL=you@email.com \
CONFLUENCE_TOKEN=your_token \
npm start
```

## Architecture

Single-file MCP server (`src/index.ts`) backed by two modules:

| File | Role |
|------|------|
| `src/index.ts` | MCP server, tool schemas (Zod), request dispatch |
| `src/converter.ts` | Markdown → Confluence storage format; Mermaid → PNG via kroki.io |
| `src/confluence.ts` | Confluence REST API client (Basic auth) |

**Flow:** `index.ts` receives MCP tool call → calls `convertMarkdownToConfluence()` → passes resulting HTML + attachments to `ConfluenceClient` methods → returns page URL.

**Mermaid rendering:** Diagrams are extracted pre-parse, sent to `https://kroki.io/mermaid/png`, returned as `Buffer`, and uploaded as page attachments. Filename is `mermaid-<md5hash>.png` — same content = same filename = skip re-upload.

**Tool routing logic (important):**
- `upload_page`: page URL provided → update; space key only → create at root
- `create_child_page`: always creates under a parent page ID/URL
- `sync_file`: reads file from disk path directly; do NOT infer path from page title

## Environment Variables

| Variable | Description |
|----------|-------------|
| `CONFLUENCE_URL` | Base URL, e.g. `https://your-domain.atlassian.net/wiki` |
| `CONFLUENCE_EMAIL` | Atlassian account email |
| `CONFLUENCE_TOKEN` | API token from id.atlassian.com/manage-profile/security/api-tokens |

## Publishing

```bash
npm run build   # runs automatically via prepublishOnly
npm publish
```
