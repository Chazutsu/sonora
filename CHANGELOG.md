# Changelog

All notable changes to Sonora are documented here.

## [Unreleased]

### Fixed

- Scoped recording-recovery metadata to the active vault through Obsidian's storage API, with a one-time, non-destructive migration of valid legacy values.

## [0.1.2] - 2026-10-13

### Changed

- Renamed the Open listening workspace command ID from `sonora:open-sonora` to `sonora:open-workspace` to satisfy the Obsidian Community Plugin policy. Existing 0.1.1 hotkey assignments for this command must be assigned again; other Sonora hotkeys are unaffected ([#3](https://github.com/Chazutsu/sonora/issues/3)).
- Aligned plugin unload behavior, build-config type coverage, CSS compatibility, and deprecated development dependencies with the official Obsidian community scanner ([#3](https://github.com/Chazutsu/sonora/issues/3)).

## [0.1.1] - 2026-10-13

### Added

- Added direct GitHub Issues and GitHub Sponsors links to settings, documentation, and release verification output ([#2](https://github.com/Chazutsu/sonora/issues/2)).

### Fixed

- Continue Listening now shows a Pause action for the actively playing item while paused, idle, and inactive items retain a Play action, keeping the icon, accessible label, and behavior aligned ([#1](https://github.com/Chazutsu/sonora/issues/1)).

## [0.1.0] - 2026-10-13

### Added

- Persistent Markdown listening queue with heading-based chapters, playback speed, chapter navigation, and Media Session controls.
- Local voice-response recording with source-note linking and bounded request, record, stop, save, and unload lifecycles.
- Looping language drills with bilingual vocabulary fields, recall intervals, local voice selection, and synchronized lyrics.
- Vault-wide fuzzy note selection and responsive desktop, tablet, and mobile layouts.
- Generation-aware source refreshes, serialized persistence, recovery journals, and Unicode-safe iCloud path repair.
- Visual regression coverage for desktop and mobile interaction states.

### Fixed

- Playback, recording, queue mutation, and source refresh races now return to recoverable states.
- Mobile navigation, menus, player controls, touch targets, and dark-mode contrast remain inside the viewport.
- Saved voice-response embeds are excluded from speech parsing and remain attached to their originating note.
- Media Session handlers, delayed language-drill answers, and recording resources are cleaned up on unload.

### Changed

- Queue persistence stores paths and progress instead of duplicating note bodies.
- Visible workspace copy follows the selected English or Japanese locale.
- Listening notes and language drills use distinct queue, player, and lyrics context.
