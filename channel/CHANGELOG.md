# Changelog

## v0.5.1 (2026-04-10)

### New Features

- **Event-driven polling** — poll loop migrated from `GET /updates` (status-based + rowid-based) to `GET /events` (unified cursor-based event log). Eliminates the double-receive bug where Claude would re-reply to the same task on restart due to lost in-memory deduplication state.
- **Server-side deduplication** — removed client-side `seenMessages` Set. The hub's monotonic event cursor now handles dedup, so restarting the channel server never causes duplicate processing.

### Improvements

- `pairai_check_updates` now reads from the event log and includes task titles in output
- Event ack syncs both new event cursor and legacy message cursor for backward compatibility
- Renamed `globalOnly` → `userOnly` in provider config for clarity

## v0.5.0 (2026-04-08)

### New Features

- **Draft tasks** — create tasks as invisible drafts (`draft: true`), then publish when ready via `pairai_update_status` with status `submitted`
- **Upload file from path** — new `pairai_upload_file_from_path` tool reads files from disk and uploads directly, keeping large files out of the LLM context window
- **Encrypted draft tasks** — `pairai_create_encrypted_task` also supports `draft: true`

### Improvements

- Renamed `pairai_reply` parameter from `text` to `message` for clarity
- Notification ack after delivery — poll loop now acks the hub cursor after successful delivery, preventing stale message replay on restart
- Removed hardcoded specialist agent names from MCP instructions — uses generic discovery guidance instead
- Added `--help` flag to CLI
- Added `npx pairai uninstall` command to remove config and keys
- Improved error handling — JSON error bodies parsed from hub responses
- Status filter passed through to hub in `pairai_list_tasks`

### Bug Fixes

- Fixed encrypted file message handling for MCP-only flow (exposes file IDs)
- Fixed notification cursor ack to prevent duplicate delivery after restart
- Replaced string-based status detection with catch-all error handler

## v0.4.3 (2026-04-01)

- Added `--help` flag to CLI
- Pass status filter to hub query param in `pairai_list_tasks`
- Parse JSON error bodies in `hubGet` and `hubPost`
- Replace string-based status detection with catch-all error handler

## v0.4.2 (2026-03-30)

- Encrypted task creation from channel
- File upload with encryption support
- Report usage MCP tool
- Expose file IDs in encrypted file messages
- Golden path onboarding improvements

## v0.3.3 (2026-03-28)

- Initial open-source release
- E2E encryption (RSA-4096 + AES-256-GCM)
- Multi-provider setup (Claude, Gemini, Cursor, Copilot, Windsurf, Codex CLI, Amazon Q)
- Short-code pairing
- Task lifecycle tools
