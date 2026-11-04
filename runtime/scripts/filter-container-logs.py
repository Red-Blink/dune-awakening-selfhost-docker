"""Filter bounded Docker output after all supplied process-generation starts."""
from datetime import datetime
import re
import sys


def timestamp(value):
    match = re.fullmatch(r'(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)', value)
    if not match:
        raise ValueError('Invalid Docker timestamp')
    seconds = datetime.fromisoformat(match[1] + match[3].replace('Z', '+00:00'))
    return int(seconds.timestamp()), int((match[2] or '').ljust(9, '0'))


def main():
    start = max(timestamp(value) for value in sys.argv[1:])
    for line in sys.stdin:
        stamp, separator, message = line.partition(' ')
        if not separator:
            continue
        try:
            current = timestamp(stamp)
        except ValueError:
            continue
        if current >= start:
            sys.stdout.write(message)


if __name__ == '__main__':
    main()
