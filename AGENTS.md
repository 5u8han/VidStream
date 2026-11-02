# User communication preference

Whenever giving the user terminal commands to run, explain what each command does. Mention file deletion or effects on media, configuration, and Docker data when applicable. Do not provide unexplained command blocks. This also applies to commands included in project documentation.

# Permanent product direction

VidStream is downloadable, self-hosted software. People clone/download it, run it on their own machines, and view/share locally available media from those machines. It must not drift into a centrally hosted service that accepts uploads into our cloud. Remind the user if a future request conflicts with this direction.

Keep browsing and playback fast. Design polish must preserve dense, zero-gutter media layouts, browser-local effects choices, reduced-motion support, and immediate controls. Animation must not block access or introduce ongoing work across the whole media catalog.

Multi-node library switching is developed separately on VidStream-node. Each machine keeps its own media, database, security and jobs. Discovery provides untrusted identity/address hints; it must not copy credentials or silently join/replicate libraries. Prefer direct browser-to-node playback and manual address fallback. No central cloud, shared writable SQLite, automatic disk pooling or Kubernetes requirement.
