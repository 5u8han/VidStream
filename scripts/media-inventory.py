#!/usr/bin/env python3
"""Summarize a media tree using directory entries and file sizes only."""

import argparse
from collections import Counter, defaultdict
from dataclasses import dataclass, field
import json
import os


KNOWN_EXTENSIONS = set("""
    3gp aac arw ass avi avif bmp cr2 cr3 dng flac gif heic heif jpeg jpg json
    m2ts m4a m4v mkv mov mp3 mp4 mpeg mpg mts nef nfo ogg ogv orf pdf png
    raf raw srt ssa svg tif tiff ts txt vtt wav webm webp wma wmv xmp zip
""".split())


@dataclass
class Totals:
    directories: int = 0
    files: int = 0
    size: int = 0
    types: Counter = field(default_factory=Counter)

    def add_file(self, name, size):
        extension = os.path.splitext(name)[1][1:].lower()
        kind = extension if extension in KNOWN_EXTENSIONS else "other" if extension else "no extension"
        self.files += 1
        self.size += size
        self.types[kind] += 1


def scan(root):
    buckets = defaultdict(Totals)
    deepest = 0
    skipped = Counter()
    pending = [(root, (), 0)]
    total = buckets[()]

    while pending:
        directory, prefix, depth = pending.pop()
        scopes = [total]
        scopes.extend(buckets[prefix[:length]] for length in range(1, len(prefix) + 1))
        deepest = max(depth, deepest)
        if depth:
            for scope in scopes:
                scope.directories += 1

        try:
            with os.scandir(directory) as entries:
                for entry in entries:
                    if entry.name.startswith('.'):
                        skipped['hidden'] += 1
                        continue
                    try:
                        if entry.is_symlink():
                            skipped['links'] += 1
                        elif entry.is_dir(follow_symlinks=False):
                            child_prefix = prefix + (entry.name,) if depth < 2 else prefix
                            pending.append((entry.path, child_prefix, depth + 1))
                        elif entry.is_file(follow_symlinks=False):
                            size = entry.stat(follow_symlinks=False).st_size
                            for scope in scopes:
                                scope.add_file(entry.name, size)
                            if depth == 0:
                                buckets[None].add_file(entry.name, size)
                    except OSError:
                        skipped['errors'] += 1
        except OSError:
            skipped['errors'] += 1

    return buckets, deepest, skipped


def row(label, totals):
    kinds = ', '.join(f'{kind} {count:,}' for kind, count in totals.types.most_common(4)) or 'empty'
    print(f'{label:<12} {totals.files:>10,} files  {totals.size / (1 << 30):>11,.3f} GiB  '
          f'{totals.directories:>8,} dirs  {kinds}')


def report(buckets, depth, skipped, show_names):
    total = buckets[()]
    groups = []
    children = defaultdict(list)
    for key in buckets:
        if key and len(key) == 1:
            groups.append(key)
        elif key and len(key) == 2:
            children[key[0]].append(key)

    def largest_first(key):
        return -buckets[key].size, -buckets[key].files, key

    def label(alias, key):
        return alias + ' ' + json.dumps('/'.join(key)) if show_names else alias

    print('VidStream media inventory (logical file sizes)')
    row('Total', total)
    print(f'Top-level directories {len(groups):,} | Deepest directory level {depth:,}')
    print(f'Skipped {skipped["hidden"]:,} hidden entries and {skipped["links"]:,} symlinks | '
          f'Read errors {skipped["errors"]:,}')
    print('File counts by extension: ' + ', '.join(f'{kind} {count:,}' for kind, count in total.types.most_common()))
    print('\nLargest top-level directories (each total includes descendants)')
    if None in buckets:
        row('Root files', buckets[None])
    for number, key in enumerate(sorted(groups, key=largest_first)[:15], 1):
        alias = f'D{number:02d}'
        row(label(alias, key), buckets[key])
        group_children = sorted(children[key[0]], key=largest_first)
        for index, child in enumerate(group_children[:3], 1):
            row(label(f'  {alias}.{index:02d}', child), buckets[child])
        if len(group_children) > 3:
            print(f'  + {len(group_children) - 3:,} other immediate subdirectories')
    if len(groups) > 15:
        print(f'+ {len(groups) - 15:,} other top-level directories included in the total')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('media', help='directory containing your media')
    parser.add_argument('--show-folder-names', action='store_true', help='include relative folder names in the report')
    options = parser.parse_args()
    media = os.path.expanduser(options.media)
    if not os.path.isdir(media):
        parser.error('select an existing media directory')
    report(*scan(media), options.show_folder_names)
