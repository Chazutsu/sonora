# Changelog

All notable changes to Sonora are documented here.

## [Unreleased]

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
