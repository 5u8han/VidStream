# User communication preference

Whenever giving the user terminal commands to run, explain what each command does. Mention file deletion or effects on media, configuration, and Docker data when applicable. Do not provide unexplained command blocks. This also applies to commands included in project documentation.

# Permanent product direction

VidStream is downloadable, self-hosted software. People clone/download it, run it on their own machines, and view/share locally available media from those machines. It must not drift into a centrally hosted service that accepts uploads into our cloud. Remind the user if a future request conflicts with this direction.

Keep browsing and playback fast. Design polish must preserve dense, zero-gutter media layouts, browser-local effects choices, reduced-motion support, and immediate controls. Animation must not block access or introduce ongoing work across the whole media catalog.

Media enhancement belongs outside VidStream. The user prepares finished files separately (for example with ComfyUI); do not reintroduce video upscaling, frame interpolation, enhancement model installation or processing jobs without an explicit new request. Preserve historical outputs and records during upgrades. Optional recognition tags for library search are separate from media enhancement.

Keep only main and VidStream-node as active development branches. At the user's explicit request, main now includes the reviewed multi-node library switching checkpoint and is the official integrated application. VidStream-node remains available for separate future node development; do not merge further experiments into main without the user's request. Each node keeps its own media, database, security and jobs; discovery must not copy credentials or silently join/replicate libraries.
