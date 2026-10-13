# Sonora

Sonora turns Markdown notes into a listening queue. Listen chapter by chapter, resume where you stopped, and record a voice response that remains in your vault.

## Current capabilities

- Add the active Markdown note to a persistent listening queue.
- Treat headings as chapters and remove common Markdown syntax before speech.
- Play, pause, restart, and move between chapters with configurable speed.
- Expose play, pause, previous, and next actions through the browser Media Session API when available.
- Record a voice response and optionally append its local embed to the source note.
- Use the same responsive view on desktop and mobile.
- Turn a vocabulary note into a looping language drill with a configurable recall pause.

## Vocabulary drills

Use a heading for each term and Markdown list fields for its answer:

```md
## resilient

- meaning: 回復力がある
- pronunciation: /rɪˈzɪliənt/
- example: The system must remain resilient.
```

Run **Sonora: Add active note as a vocabulary drill**. Sonora reads the term, waits for the configured recall interval, reads the answer and example, then advances. Loop can be toggled from the player.

The same episode model is intended to support generated connection podcasts later. AI generation is not included yet because a secure provider and credential boundary must be selected before implementation.

Sonora uses the device speech-synthesis and recording APIs. It does not send note or audio content to an external service.

## Known limitation

Background speech and headset controls depend on the capabilities exposed by Obsidian Mobile's web view and the operating system. The plugin exposes Media Session controls, but uninterrupted playback while the screen is locked must be verified on each supported mobile release.

## Development

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
```
