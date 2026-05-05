# Optional download planning

`extractors/` contains only pure Fanbox, Gank and Pawchive attachment planning/naming functions. They have no filesystem, browser-session, credential or network access. They are not imported by the Gallery runtime and cannot write registered libraries. They are **not plugins** or a supported downloader.

The former download orchestration, Pixiv authentication server and direct Venera/Pixiv source depended on separate sessions, private configuration or outdated protocols. They are not part of this public tree. Future integration must use explicit external credentials and a separate download destination, never registered source roots. No credentials have been rotated or external services contacted by repository cleanup.

Mature optional capabilities may be integrated directly into `internal/` or `frontend/`; there is no dynamic discovery mechanism.
