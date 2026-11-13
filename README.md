# Dominote

A fast, local note app for macOS. Rust (Tauri) backend, plain HTML/JS editor, no framework.

## Where notes live

Every page is a Markdown file. Every folder is a real folder.

- Default location: `~/Documents/Dominote`
- Override: set `DOMINOTE_DIR=/some/path` before launching.

## For AI agents

Point the agent at `~/Documents/Dominote`. It can read, create, edit, move, and delete `.md` files with normal file tools. The app picks up changes within 2 seconds.

Supported Markdown: `#`/`##`/`###` headings, `-` lists, `1.` lists, `- [ ]` to-dos, `>` quotes, `> [!NOTE]` callouts, `---` dividers, fenced code blocks, and GitHub-style tables. Inline: `**bold**`, `*italic*`, `` `code` ``, `~~strike~~`, `[links](https://...)`.

## Develop

```sh
cargo run                 # launch the app
cargo test                # Rust tests
node tests/md.test.js     # Markdown round-trip test
```

## Build the .dmg

```sh
npx @tauri-apps/cli@2 build
```

Output: `target/release/bundle/dmg/`.
