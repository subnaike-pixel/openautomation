# 🔐 CypherStudio

Your personal project workspace, connected to CypherAgent.

## Launch

```powershell
cd C:\Users\subna\.openclaw\workspace\cypherstudio
npm start
```

## What it does

- **Projects** — each project has its own isolated chat, notes, and files
- **Chat** — live streaming chat with CypherAgent, history saved locally per project
- **Notes** — markdown editor with live preview, auto-saves every second
- **Files** — drop files into `data/projects/<id>/files/` and browse them in-app

## Data location

Everything is saved to:
```
cypherstudio/data/
├── projects.json              ← project list
├── device-keypair.json        ← your stable device identity (don't delete)
└── projects/
    └── <project-id>/
        ├── chat-local.json    ← chat backup
        ├── notes.md           ← project notes
        └── files/             ← project files
```

> Even after OpenClaw updates, your data folder is untouched. Just run `npm start` again.

## Requirements

- OpenClaw gateway running (`openclaw gateway` or auto-started)
- Node.js (already installed if OpenClaw works)

## Shortcuts

- `Enter` — send message
- `Shift+Enter` — new line in chat
- `Escape` — close modals / cancel new project form
