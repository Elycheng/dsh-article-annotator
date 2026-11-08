# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-07

Initial public release.

### Added

- **Right-click entry**: select text in a native document preview and the
  plugin's context menu offers "annotate this sentence", opening the tab and
  focusing the matching sentence; right-clicking a sentence inside the
  plugin's own page offers annotate / copy. Right-clicking a preview without a
  selection offers "open this article in Article Review".
- One-time onboarding hint that opens the tab, so the sidebar page is
  discoverable after install.
- Right-sidebar page **Article Review (文稿批注)**: article preview with
  sentence-level annotation anchors, a comment editor popover, a searchable /
  filterable comment list, status toggling (open / resolved), Markdown export
  and a "Send to Agent" action that writes a review digest into the composer
  as a draft (never sends automatically).
- Article extraction for Markdown / TXT / DOCX / PPTX / PDF:
  - Markdown: headings, paragraphs, lists, code blocks, tables, frontmatter
    title, inline-syntax stripping.
  - DOCX / PPTX: dependency-free ZIP + OOXML text extraction (headings, slide
    order, slide numbers).
  - PDF: text extraction through the machine's Python + `pypdf`, with a
    `pdftotext` fallback and a clear message when neither is available.
- Deterministic sentence segmentation for Chinese and English, with stable
  `blockId` / `sentenceIndex` anchors and text-based re-anchoring after edits.
- Durable review store under `$DSH_HOME/article-annotator` (atomic writes,
  bounded sizes): annotations per article, recent files, last article per
  session.
- Agent tools: `article_review`, `article_read`, `article_review_resolve`,
  `article_review_save_revision`, `writing_style_add`, `writing_style_get`.
- Long-term writing-style memory injected as a system-prompt section when
  rules exist (configurable rule count, prompt injection can be disabled).
- Same-origin JSON API (`/article-annotator/api/*`) guarded by the host
  connection fence, with a `probe` method reporting load state for
  diagnostics.
- Zero runtime npm dependencies; only the platform-level `react` is required
  by the browser bundle.
- Offline test suite: sentence splitting, four-format extraction (including
  real PDF extraction), annotation store + re-anchoring, API flow and fences,
  plugin wiring, client bundle registration, and a jsdom + React end-to-end
  annotation flow.
- Local install / uninstall scripts and a privacy scan script for releases.
