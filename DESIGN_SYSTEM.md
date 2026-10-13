# Sonora design system

Sonora is a listening library, not a dashboard. Its interface uses the familiar music-player structure of navigation, library, and a persistent player without visually copying Spotify.

## Principles

1. **Eyes optional.** Primary actions remain large, ordered, and usable without reading dense controls.
2. **Playback stays reachable.** Desktop keeps a bottom player. Mobile places the mini-player below the top tabs so Obsidian's floating controls can own the bottom edge.
3. **Useful density.** Library rows expose title, current chapter, content type, and progress without cards or dead space.
4. **Vault-native trust.** Source paths, recording destinations, and local-only behavior remain visible.
5. **Product-specific expression.** Sonora does not inherit Graphune or Taktune visual tokens.
6. **Modes stay legible.** Passive listening and active recall share playback mechanics but remain visibly distinct.

## Tokens

- Accent: Sonora violet `#6258e8` in light mode and `#8d84ff` in dark mode.
- Language drills use berry `#d65a95` to remain distinguishable from ordinary listening notes.
- Type: Obsidian's interface font with a compact music-library hierarchy.
- Corners: 6–10px for navigation, rows, and artwork; circular primary playback control.
- Motion: short state transitions only. Recording pulse is the sole continuous animation.
- Touch targets: at least 36px on desktop and 44px on mobile; primary play is 48px or larger.

## Layout

- Desktop uses narrow navigation, a dense library, and a persistent bottom player.
- Mobile uses top tabs, a single-row mini-player, a compact Add menu, and no duplicated featured player.
- Empty state presents three explicit starting actions instead of decorative whitespace.
