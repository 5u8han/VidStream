# Audit a media library

Use the standalone audit on a small, representative folder first. It runs
outside VidStream and reads the mounted media directory directly. Run it at
a different time from the initial VidStream import if both use the same DAS.
At 100 MB/s, a single sequential read of 12–14 TB takes about 33–39 hours.
Decoding, seeking, and writing any replacements take additional time.

## Probe and decode

Use Python 3.10 or newer and a current FFmpeg installation with `ffprobe`
available. From the VidStream checkout, run this on the machine attached to
the storage. Replace the sample directory with a real mounted folder.

```sh
python3 scripts/media-audit.py "/mnt/das/sample" --journal "$HOME/vidstream-audit.sqlite"
```

This probes video and audio stream information, then decodes the selected
audio and video streams to FFmpeg's null output. It checks decoder and
container errors, keeps one decoding process active at a time, and saves
one result per file to the SQLite journal. It creates no media outputs and
leaves source media, app configuration, and Docker volumes in place. Put
the journal on local storage outside the library. It contains filenames
and diagnostic text, so keep it private.

Use Ctrl+C to stop. Repeating the same command skips successfully decoded
files if their size and timestamps still match and the tool versions are
unchanged. Files with previous failures are retried. Add `--recheck` to
decode unchanged successes again. A file changed or disconnected during
an audit needs another attempt. The scanner checks known video extensions
and skips hidden entries and symbolic links. Use a trusted media mount and
keep your local FFmpeg updated.

```sh
python3 scripts/media-audit.py "/mnt/das/sample" --journal "$HOME/vidstream-audit.sqlite" --report
```

This reads the journal and prints its latest result for each recorded file
as one JSON object per line. It performs no decoding and writes no files.
The report retains results for files previously seen at that path, including
entries that have since been moved or deleted. A scan exits with status 1
when it encounters files or paths needing review, or 130 if interrupted.

A successful result means the chosen decoder completed with no reported
audio or video errors. Valid variable frame rates, intentional gaps, and
presentation-order differences do not establish corruption. The check
cannot know if the original camera skipped frames or verify visual quality,
exact audio sync, every subtitle and metadata byte, or match an independent
known-good source. To detect later bit rot, periodically verify files against
checksums from a known-good copy. Recover missing data from an independent
original or backup when available.
[FFmpeg options](https://ffmpeg.org/ffmpeg.html) · [ffprobe options](https://ffmpeg.org/ffprobe-all.html)

## Choose viewing copies after reviewing the results

The report's compatibility field is a hint, separate from decode results.
A healthy file can still use a codec your browser cannot play. For local
on-demand video, MP4 with 8-bit H.264, 4:2:0 chroma, AAC, and fast-start
metadata is a broadly compatible playback target. Keep HDR, alternate
audio, subtitles, and archive sources. MPEG-TS can carry HLS segments.
HLS uses playlists and independently requested segments and is most useful
here if you need adaptive bitrate over variable links.
[Browser codec guidance](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Video_codecs) · [Apple HLS overview](https://developer.apple.com/documentation/HTTP-Live-Streaming)

For a confirmed healthy input containing only H.264 video and compatible
AAC tracks, this example copies the audio and video streams into a separate
fast-start MP4. Check the track list first. The example selects only audio
and video and would omit subtitle and data streams.

```sh
ffmpeg -n -i "/mnt/das/sample/clip.mkv" -map 0:V -map '0:a?' -c copy -movflags +faststart "$HOME/clip-viewing.mp4"
```

This reads the MKV and writes a new file in your home directory without
re-encoding or replacing an existing file. Audit the new copy, compare its
duration and tracks, and play it before adding it to a viewing library.
A failed remux can leave a partial output. Inspect and remove only that
explicit output before retrying. Remuxing preserves the encoded packets and
cannot reconstruct lost frames. This utility reports faults for review and
does not automatically repair or replace library files.
[FFmpeg stream copy](https://ffmpeg.org/ffmpeg.html#Streamcopy) · [MP4 fast start](https://ffmpeg.org/ffmpeg-formats.html)
