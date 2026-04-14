# Hermes Obsidian MVP

A minimal Obsidian plugin that opens a sidebar chat and talks to Hermes through ACP by spawning `hermes acp` locally.

## Current MVP

- Obsidian sidebar view
- Local Hermes ACP process transport
- Per-vault working directory
- Basic assistant text streaming into the chat UI
- Bundled build via esbuild

## Project layout

- `src/main.ts` - Obsidian plugin entrypoint and sidebar view
- `src/transport/hermes-acp-client.ts` - ACP stdio client wrapper
- `manifest.json` - Obsidian plugin manifest
- `main.js` - built plugin output

## Development

```bash
npm install
npm run build
```

Then copy these files into your Obsidian vault plugin folder:

```bash
manifest.json
main.js
```

## Notes

This is still an MVP. The current streaming parser is intentionally simple and should be hardened as we learn the exact Hermes ACP message shapes in live runs.
