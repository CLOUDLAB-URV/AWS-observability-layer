Backup of the LIGHT diagram style, taken before switching to the dark render (2026-07-01).

Restores the previous look (white service cards, light containers, colored protocol arrows, themeID 4).

To roll back:
  cp backups/diagram-style-light-20260701/stateviz/prompt.md server/agents/stateviz/prompt.md
  cp backups/diagram-style-light-20260701/architect/prompt.md server/agents/architect/prompt.md
  cp backups/diagram-style-light-20260701/diagram.js server/diagram.js

Note: diagram.js backup is the whole file; the key line was 'themeID: 4' and the fill-N7 background strip.
