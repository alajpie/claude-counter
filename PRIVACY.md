Privacy Policy for Claude Counter (minimal fork)

Last Updated: 2025/11/30

## Overview

This is a minimal fork of the original Claude Usage Tracker / Claude Counter extension.  
It focuses on per‑conversation token length, cache timers, and native usage bars for `claude.ai`, and **no longer** syncs usage data via Firebase.

## Data Collection and Storage

This extension processes the following information while you use `claude.ai`:

- **Claude conversation data (read‑only)**
  - Conversation metadata and messages fetched from Claude’s own API in order to:
    - Estimate per‑conversation token length.
    - Determine whether a conversation is cached and for how long.
- **Claude native usage data (read‑only)**
  - Usage summaries returned by Claude’s own `/usage` endpoint (session and weekly utilization and reset times).
- **Organization ID (orgId)**
  - Read from the `lastActiveOrg` cookie or via a small helper in the content script.
  - Used only to:
    - Know which Claude organization to query for usage (`/api/organizations/{orgId}/usage`).
    - De‑duplicate per‑org state in local storage (e.g., org IDs you’ve used in this browser).
- **Optional Anthropic API key (if you choose to set it)**
  - Stored locally in extension storage.
  - Used only to call Anthropic’s `count_tokens` endpoints to improve token counting accuracy for:
    - Text messages.
    - Attached files (if applicable).

The extension stores **only**:

- Your org IDs (`orgIds`) in local extension storage.
- Optional Anthropic API key (`apiKey`) if you explicitly provide it.
- Small internal caches (e.g., file token counts, per‑project token sizes) to avoid recomputing the same values repeatedly.

## What’s no longer collected/stored

Compared to the original extension, this fork:

- Does **not** record or sync:
  - Per‑model cumulative usage totals.
  - Historical usage windows.
  - Cap‑hit events or reset counters.
- Does **not** upload any usage data to Firebase or any third‑party backend.

All long‑term usage accounting is delegated to Claude itself; we only read what Claude already exposes.

## Data Usage

The collected data is used only to:

- Display per‑conversation token counts and cache timers inside the Claude UI.
- Display session and weekly usage bars (using Claude’s `/usage` endpoint).
- Optionally, improve local token counting accuracy via Anthropic’s `count_tokens` API **if** you configure an API key.

The extension does not send your data anywhere other than:

- `claude.ai` (Claude’s own web API and usage endpoint), which you are already using.
- `api.anthropic.com` **only** if you opt into providing an Anthropic API key for token counting.

## Data Sharing

- We do **not** share, sell, or distribute your data to any third parties.
- All data is used strictly within the extension for its UI and usage‑display functionality.

## Data Security

- All local state (org IDs, optional API key, token caches) is stored using the browser’s extension storage.
- No external database (such as Firebase) is used in this fork.
- You can remove all local data for the extension at any time by:
  - Removing the extension, and/or
  - Clearing extension data via your browser’s extension management UI.

## User Rights and Contact

This is an open‑source fork under the GPLv3 license.  
For privacy‑related questions about this fork, you can open an issue or PR in the repository where you obtained this code.
