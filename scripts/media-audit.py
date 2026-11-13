#!/usr/bin/env python3

import argparse
from collections import Counter
from contextlib import closing
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import subprocess
import sys


EXTENSIONS = {
    '.3g2', '.3gp', '.asf', '.avi', '.flv', '.m2ts', '.m4v', '.mkv', '.mov',
    '.mp4', '.mpeg', '.mpg', '.mts', '.ogv', '.ts', '.vob', '.webm', '.wmv',
}
INPUT_LIMITS = [
    '-protocol_whitelist', 'file',
    '-format_whitelist', 'asf,avi,flv,matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,mpeg,mpegts,mpegvideo,ogg',
    '-max_streams', '128',
]
PROBE_LIMIT = 256 * 1024
ERROR_LIMIT = 8192
AUDIT_VERSION = 1


def command_output(command, limit, *, merge_errors=False):
    with subprocess.Popen(
        command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT if merge_errors else subprocess.DEVNULL,
    ) as process:
        try:
            output = process.stdout.read(limit + 1)
            if len(output) > limit:
                process.kill()
                raise ValueError('Media tool output exceeded the audit limit')
            return process.wait(), output.decode('utf-8', errors='replace')
        finally:
            if process.poll() is None:
                process.kill()


def video_files(root, on_error):
    for directory, names, files in os.walk(root, onerror=on_error):
        names[:] = sorted(name for name in names if not name.startswith('.'))
        for name in sorted(files):
            if not name.startswith('.') and Path(name).suffix.lower() in EXTENSIONS:
                yield Path(directory, name)


def source_stat(source):
    details = source.stat(follow_symlinks=False)
    if not stat.S_ISREG(details.st_mode):
        return None
    return details.st_size, details.st_mtime_ns, details.st_ctime_ns


def playback_hint(probe, videos):
    formats = set(probe.get('format', {}).get('format_name', '').split(','))
    video = videos[0]
    audio = [stream for stream in probe['streams'] if stream.get('codec_type') == 'audio']
    if (formats.intersection({'mp4', 'mov'}) and video.get('codec_name') == 'h264'
            and video.get('pix_fmt') in {'yuv420p', 'yuvj420p'}
            and all(stream.get('codec_name') == 'aac' for stream in audio)):
        return 'mp4-family-h264-aac'
    return 'check-client-compatibility'


def audit(source, ffprobe, ffmpeg):
    try:
        status, output = command_output([
            ffprobe, '-v', 'quiet', *INPUT_LIMITS, '-show_error',
            '-show_entries', 'format=format_name,duration:stream=index,codec_name,codec_type,pix_fmt,color_transfer,width,height:stream_disposition=attached_pic',
            '-of', 'json', '-i', str(source),
        ], PROBE_LIMIT)
        probe = json.loads(output)
        if status:
            return 'probe_error', '', probe.get('error', {}).get('string', 'Media could not be probed')
        videos = [
            stream for stream in probe.get('streams', [])
            if stream.get('codec_type') == 'video' and not stream.get('disposition', {}).get('attached_pic')
        ]
        if not videos:
            return 'no_video', '', 'No video stream excluding cover art'
    except (OSError, ValueError) as error:
        return 'probe_error', '', str(error)

    try:
        status, output = command_output([
            ffmpeg, '-nostdin', '-v', 'error', '-xerror', '-err_detect', 'explode',
            *INPUT_LIMITS, '-i', str(source), '-map', '0:V', '-map', '0:a?',
            '-fps_mode', 'passthrough', '-abort_on', 'empty_output+empty_output_stream',
            '-f', 'null', '-',
        ], ERROR_LIMIT, merge_errors=True)
        if status or output.strip():
            return 'decode_error', '', output.strip() or f'FFmpeg exited with status {status}'
    except (OSError, ValueError) as error:
        return 'decode_error', '', str(error)
    return 'decode_ok', playback_hint(probe, videos), ''


def open_journal(file):
    file.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(file, timeout=10)
    connection.execute("""
        CREATE TABLE IF NOT EXISTS audit (
            library BLOB NOT NULL, path BLOB NOT NULL,
            size INTEGER, mtime_ns INTEGER, ctime_ns INTEGER,
            recipe TEXT NOT NULL, status TEXT NOT NULL, playback TEXT NOT NULL,
            detail TEXT NOT NULL, checked_at TEXT NOT NULL,
            PRIMARY KEY (library, path)
        )
    """)
    return connection


def report(file, library):
    with closing(sqlite3.connect(file.as_uri() + '?mode=ro', uri=True)) as connection:
        for relative, size, status, playback, detail, checked_at in connection.execute(
            'SELECT path, size, status, playback, detail, checked_at FROM audit WHERE library = ? ORDER BY path',
            (library,),
        ):
            print(json.dumps(dict(path=os.fsdecode(relative), bytes=size, status=status,
                                  playback=playback, detail=detail, checked_at=checked_at)))


def scan(connection, root, library, options, ffprobe, ffmpeg, recipe):
    counts = Counter()

    def on_walk_error(error):
        counts['walk_error'] += 1
        if counts['walk_error'] <= 10:
            print(f'walk_error: {str(error)!r}', file=sys.stderr)

    try:
        for source in video_files(root, on_walk_error):
            relative = os.fsencode(source.relative_to(root))
            before = (None, None, None)
            try:
                before = source_stat(source)
                if before is None:
                    counts['special_or_link'] += 1
                    continue
                if not options.recheck and connection.execute(
                    "SELECT 1 FROM audit WHERE library=? AND path=? AND size=? AND mtime_ns=? "
                    "AND ctime_ns=? AND recipe=? AND status='decode_ok'",
                    (library, relative, *before, recipe),
                ).fetchone():
                    counts['unchanged'] += 1
                    continue
                status, playback, message = audit(source, ffprobe, ffmpeg)
                if source_stat(source) != before:
                    status, playback, message = 'changed', '', 'File changed during the audit'
            except OSError as error:
                status, playback, message = 'unavailable', '', str(error)

            connection.execute(
                'INSERT OR REPLACE INTO audit VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                (library, relative, *before, recipe, status, playback,
                 message[:2048], datetime.now(timezone.utc).isoformat()),
            )
            connection.commit()
            counts[status] += 1
            if status != 'decode_ok' and counts[status] <= 10:
                print(f'{status}: {os.fsdecode(relative)!r}: {message[:200]!r}', file=sys.stderr)
            elif status == 'decode_ok' and counts['decode_ok'] % 100 == 0:
                print(f"Decoded {counts['decode_ok']:,} videos", file=sys.stderr)
    finally:
        print('Audit summary: ' + (', '.join(f'{key}={value:,}' for key, value in counts.items())
                                  or 'no videos audited'), file=sys.stderr)
    return int(any(key not in {'decode_ok', 'unchanged', 'special_or_link'} for key in counts))


def main():
    parser = argparse.ArgumentParser(description='Probe and decode local video files without modifying sources.')
    parser.add_argument('media', type=Path, help='mounted media directory to audit')
    parser.add_argument('--journal', type=Path, required=True, help='SQLite journal outside the media tree')
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--recheck', action='store_true', help='decode previously successful videos again')
    modes.add_argument('--report', action='store_true', help='print stored results as JSON Lines without decoding')
    options = parser.parse_args()
    root = options.media.expanduser().resolve()
    journal = options.journal.expanduser().resolve()
    if journal.is_relative_to(root):
        parser.error('place the journal outside the media tree')
    if not options.report and not root.is_dir():
        parser.error('select an existing mounted media directory')

    library = os.fsencode(root)
    if options.report:
        report(journal, library)
        return 0

    ffprobe, ffmpeg = shutil.which('ffprobe'), shutil.which('ffmpeg')
    if not ffprobe or not ffmpeg:
        parser.error('install FFmpeg and ffprobe and add them to PATH')
    version_results = [command_output([tool, '-version'], ERROR_LIMIT) for tool in (ffprobe, ffmpeg)]
    if any(status or not output.strip() for status, output in version_results):
        parser.error('could not read the FFmpeg and ffprobe versions')
    recipe = ' '.join([str(AUDIT_VERSION), *(output.splitlines()[0] for _, output in version_results)])
    os.umask(0o077)
    with closing(open_journal(journal)) as connection:
        return scan(connection, root, library, options, ffprobe, ffmpeg, recipe)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('Audit interrupted. Re-run to resume; completed results are saved.', file=sys.stderr)
        sys.exit(130)
    except (OSError, sqlite3.Error, ValueError) as error:
        print(f'Audit could not continue: {error}', file=sys.stderr)
        sys.exit(1)
