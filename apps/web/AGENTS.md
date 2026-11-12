<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Shared UI lives in @optipeople/ui

Base components, design tokens and reusable blocks come from the package `@optipeople/ui` (repo `Optipeople/optipeople.ui`, usually checked out next to this repo). Do not create or edit a local copy of a shared component, and do not add design tokens to `globals.css`.

- To fix or change a shared component, or to add a new one: do it in `optipeople.ui`, bump its version and push (that publishes it), then update `@optipeople/ui` here.
- A component that only this app will ever need can live here. If a second app could use it, it belongs in the package under `src/blocks`.
- Never patch `node_modules`.
