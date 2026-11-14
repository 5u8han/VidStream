#!/usr/bin/env python3

import argparse
from collections import Counter
from contextlib import closing, contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
from uuid import uuid4


EXTENSIONS = {
    '.3g2', '.3gp', '.asf', '.avi', '.flv', '.m2ts', '.m4v', '.mkv', '.mov',
    '.mp4', '.mpeg', '.mpg', '.mts', '.ogv', '.ts', '.vob', '.webm', '.wmv',
}
PHOTO_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.tiff', '.tif', '.bmp'}
INPUT_LIMITS = [
    '-protocol_whitelist', 'file',
    '-format_whitelist', 'asf,avi,flv,matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,mpeg,mpegts,mpegvideo,ogg',
    '-max_streams', '128',
]
PROBE_LIMIT = 256 * 1024
ERROR_LIMIT = 8192
AUDIT_VERSION = 2
ARCHIVE = '.vidstream-source-originals'
AVC_PIXELS = {'yuv420p', 'yuvj420p'}


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


def video_files(root, on_error, on_media_directory=None):
    for directory, names, files in os.walk(root, onerror=on_error):
        names[:] = sorted(name for name in names if not name.startswith('.'))
        directory = Path(directory)
        if on_media_directory and any(
            not name.startswith('.') and Path(name).suffix.lower() in EXTENSIONS | PHOTO_EXTENSIONS
            and not (directory / name).is_symlink() and (directory / name).is_file()
            for name in files
        ):
            on_media_directory(directory)
        for name in sorted(files):
            if not name.startswith('.') and Path(name).suffix.lower() in EXTENSIONS:
                yield directory / name


def source_stat(source):
    details = source.stat(follow_symlinks=False)
    if not stat.S_ISREG(details.st_mode):
        return None
    return details.st_size, details.st_mtime_ns, details.st_ctime_ns


def playback_hint(source, probe, videos):
    formats = set(probe.get('format', {}).get('format_name', '').split(','))
    video = videos[0]
    audio = [stream for stream in probe['streams'] if stream.get('codec_type') == 'audio']
    if (source.suffix.lower() == '.mp4' and 'mp4' in formats
            and probe.get('format', {}).get('tags', {}).get('major_brand', '').strip() != 'qt'
            and video.get('codec_name') == 'h264' and video.get('pix_fmt') in AVC_PIXELS
            and all(stream.get('codec_name') == 'aac' for stream in audio)):
        return 'mp4-family-h264-aac'
    return 'check-client-compatibility'


def probe_media(source, ffprobe):
    try:
        status, output = command_output([
            ffprobe, '-v', 'quiet', *INPUT_LIMITS, '-show_error',
            '-show_entries',
            'format=format_name,duration:format_tags=major_brand:'
            'stream=index,codec_name,codec_type,pix_fmt,color_transfer,color_primaries,width,height,channels:'
            'stream_disposition=attached_pic:stream_side_data=side_data_type,rotation',
            '-of', 'json', '-i', str(source),
        ], PROBE_LIMIT)
        probe = json.loads(output)
        if status:
            return 'probe_error', probe.get('error', {}).get('string', 'Media could not be probed'), None
        videos = [
            stream for stream in probe.get('streams', [])
            if stream.get('codec_type') == 'video' and not stream.get('disposition', {}).get('attached_pic')
        ]
        if not videos:
            return 'no_video', 'No video stream excluding cover art', None
    except (OSError, ValueError) as error:
        return 'probe_error', str(error), None
    return None, '', probe


def check_decode(source, ffmpeg):

    try:
        status, output = command_output([
            ffmpeg, '-nostdin', '-v', 'error', '-xerror', '-err_detect', 'explode',
            *INPUT_LIMITS, '-i', str(source), '-map', '0:V', '-map', '0:a?',
            '-fps_mode', 'passthrough', '-abort_on', 'empty_output+empty_output_stream',
            '-f', 'null', '-',
        ], ERROR_LIMIT, merge_errors=True)
        if status or output.strip():
            return output.strip() or f'FFmpeg exited with status {status}'
    except (OSError, ValueError) as error:
        return str(error)
    return ''


def audit(source, ffprobe, ffmpeg):
    error, message, probe = probe_media(source, ffprobe)
    if error:
        return error, '', message, None
    if message := check_decode(source, ffmpeg):
        return 'decode_error', '', message, None
    videos = [stream for stream in probe['streams'] if stream.get('codec_type') == 'video'
              and not stream.get('disposition', {}).get('attached_pic')]
    return 'decode_ok', playback_hint(source, probe, videos), '', probe


def conversion_streams(probe):
    streams = probe['streams']
    videos = [stream for stream in streams if stream.get('codec_type') == 'video'
              and not stream.get('disposition', {}).get('attached_pic')]
    audio = [stream for stream in streams if stream.get('codec_type') == 'audio']
    if len(videos) != 1 or len(streams) != 1 + len(audio):
        raise ValueError('Extra video, cover art, subtitle or data tracks require manual review')
    video = videos[0]
    if (video.get('color_transfer') in {'smpte2084', 'arib-std-b67'}
            or video.get('color_primaries') == 'bt2020'
            or any('dolby vision' in str(data.get('side_data_type', '')).lower()
                   for data in video.get('side_data_list', []))):
        raise ValueError('HDR or wide-gamut video requires manual review')
    return video, audio


def display_size(video):
    width, height = video['width'], video['height']
    rotation = next((data['rotation'] for data in video.get('side_data_list', [])
                     if 'rotation' in data), 0)
    return (height, width) if int(rotation) % 180 == 90 else (width, height)


def duration(probe):
    value = float(probe['format']['duration'])
    if not 0 < value < float('inf'):
        raise ValueError('Media duration could not be verified')
    return value


def make_viewing_copy(source, stage, original, ffprobe, ffmpeg):
    video, audio = conversion_streams(original)
    expected_duration = duration(original)
    args = [
        ffmpeg, '-n', '-nostdin', '-v', 'error', '-xerror', '-err_detect', 'explode',
        *INPUT_LIMITS, '-i', str(source), '-map', '0:V:0', '-map', '0:a?',
        '-map_metadata', '0', '-map_chapters', '0', '-c', 'copy',
    ]
    if video.get('codec_name') != 'h264' or video.get('pix_fmt') not in AVC_PIXELS:
        if any(dimension % 2 for dimension in display_size(video)):
            raise ValueError('Odd video dimensions require manual review')
        args.extend(['-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p',
                     '-fps_mode', 'passthrough'])
    for index, track in enumerate(audio):
        if track.get('codec_name') != 'aac':
            args.extend([f'-c:a:{index}', 'aac'])
    status, output = command_output(
        [*args, '-movflags', '+faststart', '-f', 'mp4', str(stage)], ERROR_LIMIT, merge_errors=True
    )
    if status or output.strip():
        raise ValueError(output.strip() or f'FFmpeg exited with status {status}')
    error, message, copy = probe_media(stage, ffprobe)
    if error:
        raise ValueError(message)
    copy_video, copy_audio = conversion_streams(copy)
    if (playback_hint(stage, copy, [copy_video]) == 'check-client-compatibility'
            or display_size(copy_video) != display_size(video)
            or abs(duration(copy) - expected_duration) > min(1, max(0.25, expected_duration * 0.001))
            or [track.get('channels') for track in copy_audio] != [track.get('channels') for track in audio]):
        raise ValueError('Viewing copy failed codec, track, duration or dimensions checks')
    if message := check_decode(stage, ffmpeg):
        raise ValueError(message)


def file_identity(path):
    try:
        details = path.stat(follow_symlinks=False)
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(details.st_mode):
        raise ValueError(f'Expected a regular file at {path}')
    return details.st_dev, details.st_ino, details.st_size, details.st_mtime_ns


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def ensure_archive(source_directory):
    if source_directory.resolve() != source_directory:
        raise ValueError(f'Source directory changed: {source_directory}')
    archive = source_directory / ARCHIVE
    archive.mkdir(mode=0o700, exist_ok=True)
    if not stat.S_ISDIR(archive.lstat().st_mode):
        raise ValueError(f'Archive path is not a directory: {archive}')
    sync_directory(source_directory)
    return archive


def record_result(connection, library, relative, details, recipe, status, playback, message):
    connection.execute(
        'INSERT OR REPLACE INTO audit VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        (library, relative, *details, recipe, status, playback,
         message[:2048], datetime.now(timezone.utc).isoformat()),
    )


def finish_conversion(connection, root, library, relative, operation):
    relative_path = Path(os.fsdecode(relative))
    if relative_path.is_absolute() or any(part.startswith('.') for part in relative_path.parts):
        raise ValueError('Pending conversion has an invalid media path')
    if not re.fullmatch(r'\.stage-[a-f0-9]{32}\.mp4', operation['stage']):
        raise ValueError('Pending conversion has an invalid staging path')
    source = root / relative_path
    if source.parent.resolve() != source.parent:
        raise ValueError('Pending conversion source directory changed since validation')
    archive = source.parent / ARCHIVE / source.name
    stage = archive.parent / operation['stage']
    destination = source.with_suffix('.mp4')
    original_id = tuple(operation['original_id'])
    output_id = tuple(operation['output_id'])
    if not stat.S_ISDIR(archive.parent.lstat().st_mode):
        raise ValueError(f'Archive path is not a directory: {archive.parent}')

    saved = file_identity(archive)
    current = file_identity(source)
    staged = file_identity(stage)
    published = file_identity(destination)
    already_published = staged is None and published == output_id and saved == original_id
    if (staged != output_id and not already_published) or (saved is not None and saved != original_id):
        raise ValueError('Staged copy or archived original changed since validation')
    allowed_at_source = (None, original_id, output_id) if source == destination else (None, original_id)
    allowed_at_destination = allowed_at_source if source == destination else (None, output_id)
    if current not in allowed_at_source:
        raise ValueError('Source changed since validation')
    if published not in allowed_at_destination:
        raise ValueError('Viewing copy destination already exists')
    if saved is None:
        if current != original_id:
            raise ValueError('Validated original is unavailable')
        os.link(source, archive, follow_symlinks=False)
    if file_identity(archive) != original_id:
        raise ValueError('Original changed before archiving')
    sync_directory(archive.parent)

    if source == destination and file_identity(source) == original_id:
        source.unlink()
    if file_identity(destination) is None:
        os.link(stage, destination, follow_symlinks=False)
    if file_identity(destination) != output_id:
        raise ValueError('Viewing copy could not be published')
    sync_directory(destination.parent)
    if source != destination and file_identity(source) == original_id:
        source.unlink()
        sync_directory(source.parent)

    stage.unlink(missing_ok=True)
    sync_directory(archive.parent)
    details = source_stat(destination)
    record_result(connection, library, relative, source_stat(archive) if source != destination else details,
                  operation['recipe'], 'converted',
                  'mp4-family-h264-aac', f'Original archived at {archive.relative_to(root)}')
    if source != destination:
        record_result(connection, library, os.fsencode(destination.relative_to(root)), details,
                      operation['recipe'], 'decode_ok', 'mp4-family-h264-aac', '')
    connection.execute('DELETE FROM conversions WHERE library=? AND path=?', (library, relative))
    connection.commit()


def convert(connection, root, library, relative, source, before, probe, ffprobe, ffmpeg, recipe):
    conversion_streams(probe)
    destination = source.with_suffix('.mp4')
    archive_dir = source.parent / ARCHIVE
    archive = archive_dir / source.name
    if destination != source and os.path.lexists(destination):
        raise ValueError(f'Viewing copy destination already exists: {destination.name}')
    if os.path.lexists(archive):
        raise ValueError(f'An archived original already exists: {archive.name}')
    ensure_archive(source.parent)
    stage = archive_dir / ('.stage-' + uuid4().hex + '.mp4')
    try:
        original = source.stat(follow_symlinks=False)
        original_id = file_identity(source)
        if source_stat(source) != before:
            raise ValueError('Source changed since audit')
        make_viewing_copy(source, stage, probe, ffprobe, ffmpeg)
        if source_stat(source) != before or file_identity(source) != original_id:
            raise ValueError('Source changed during conversion')
        stage.chmod(stat.S_IMODE(original.st_mode) & 0o777)
        mtime = original.st_mtime_ns
        if source == destination and stage.stat().st_size == original.st_size:
            mtime += 2_000_000_000
        os.utime(stage, ns=(original.st_atime_ns, mtime))
        with stage.open('rb') as output:
            os.fsync(output.fileno())
        sync_directory(archive_dir)
        operation = {'stage': stage.name, 'original_id': original_id, 'output_id': file_identity(stage),
                     'recipe': recipe}
        connection.execute('INSERT INTO conversions VALUES(?, ?, ?)',
                           (library, relative, json.dumps(operation)))
        connection.commit()
    finally:
        if not connection.execute('SELECT 1 FROM conversions WHERE library=? AND path=?',
                                  (library, relative)).fetchone():
            stage.unlink(missing_ok=True)
    finish_conversion(connection, root, library, relative, operation)


@contextmanager
def conversion_lock(journal):
    import fcntl

    journal.parent.mkdir(parents=True, exist_ok=True)
    with journal.with_name(journal.name + '.lock').open('ab') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError('A conversion is already running for this journal') from error
        yield


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
    connection.execute('CREATE TABLE IF NOT EXISTS conversions (library BLOB, path BLOB, operation TEXT, '
                       'PRIMARY KEY (library, path))')
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

    def on_media_directory(directory):
        try:
            ensure_archive(directory)
        except (OSError, ValueError) as error:
            counts['archive_error'] += 1
            if counts['archive_error'] <= 10:
                print(f'archive_error: {str(error)!r}', file=sys.stderr)

    try:
        if options.convert:
            for relative, raw in connection.execute('SELECT path,operation FROM conversions WHERE library=?',
                                                    (library,)).fetchall():
                finish_conversion(connection, root, library, relative, json.loads(raw))
                counts['converted'] += 1
        for source in video_files(root, on_walk_error, on_media_directory if options.convert else None):
            relative = os.fsencode(source.relative_to(root))
            before = (None, None, None)
            try:
                before = source_stat(source)
                if before is None:
                    counts['special_or_link'] += 1
                    continue
                saved = connection.execute(
                    "SELECT 1 FROM audit WHERE library=? AND path=? AND size=? AND mtime_ns=? "
                    "AND ctime_ns=? AND recipe=? AND (status='converted' OR "
                    "(status='decode_ok' AND (?=0 OR playback='mp4-family-h264-aac')))",
                    (library, relative, *before, recipe, options.convert),
                ).fetchone()
                if not options.recheck and saved:
                    counts['unchanged'] += 1
                    continue
                status, playback, message, probe = audit(source, ffprobe, ffmpeg)
                if source_stat(source) != before:
                    status, playback, message = 'changed', '', 'File changed during the audit'
            except OSError as error:
                status, playback, message = 'unavailable', '', str(error)

            if options.convert and status == 'decode_ok' and playback == 'check-client-compatibility':
                try:
                    convert(connection, root, library, relative, source, before, probe, ffprobe, ffmpeg, recipe)
                except (ValueError, OSError) as error:
                    if connection.execute('SELECT 1 FROM conversions WHERE library=? AND path=?',
                                          (library, relative)).fetchone():
                        raise
                    status, message = 'conversion_review', str(error)
                else:
                    counts['converted'] += 1
                    if counts['converted'] % 100 == 0:
                        print(f"Published {counts['converted']:,} viewing copies", file=sys.stderr)
                    continue
            record_result(connection, library, relative, before, recipe, status, playback, message)
            connection.commit()
            counts[status] += 1
            if status != 'decode_ok' and counts[status] <= 10:
                print(f'{status}: {os.fsdecode(relative)!r}: {message[:200]!r}', file=sys.stderr)
            elif status == 'decode_ok' and counts['decode_ok'] % 100 == 0:
                print(f"Decoded {counts['decode_ok']:,} videos", file=sys.stderr)
    finally:
        print('Audit summary: ' + (', '.join(f'{key}={value:,}' for key, value in counts.items())
                                  or 'no videos audited'), file=sys.stderr)
    return int(any(key not in {'converted', 'decode_ok', 'unchanged', 'special_or_link'} for key in counts))


def main():
    parser = argparse.ArgumentParser(description='Probe and decode local video files without modifying sources.')
    parser.add_argument('media', type=Path, help='mounted media directory to audit')
    parser.add_argument('--journal', type=Path, required=True, help='SQLite journal outside the media tree')
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--recheck', action='store_true', help='decode previously successful videos again')
    modes.add_argument('--report', action='store_true', help='print stored results as JSON Lines without decoding')
    modes.add_argument('--convert', action='store_true', help='publish verified MP4 copies and move originals to hidden archives')
    options = parser.parse_args()
    root = options.media.expanduser().resolve()
    journal = options.journal.expanduser().resolve()
    if ARCHIVE in root.parts:
        parser.error('choose a library directory outside the originals archive')
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
    if options.convert:
        if os.name != 'posix':
            parser.error('conversion currently requires a Linux or macOS filesystem with hard-link support')
        with conversion_lock(journal), closing(open_journal(journal)) as connection:
            return scan(connection, root, library, options, ffprobe, ffmpeg, recipe)
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
