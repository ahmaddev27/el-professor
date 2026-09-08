#!/usr/bin/env python3
import sys

if len(sys.argv) < 2:
    sys.exit(0)

f = sys.argv[1]
if not (f.endswith('.ts') or f.endswith('.tsx')):
    sys.exit(0)

try:
    lines = open(f).readlines()
except Exception:
    sys.exit(0)

valid_starts = (
    'import ', 'export ', '//', '/*', 'const ', 'let ', 'var ',
    'type ', 'interface ', 'class ', 'function ', 'enum ', 'declare ',
    'abstract ', '"use ', "'use ", '@', 'React', '{'
)

i = 0
while i < len(lines) and not any(lines[i].lstrip().startswith(s) for s in valid_starts):
    i += 1

if i > 0:
    open(f, 'w').writelines(lines[i:])
    print(f'Stripped {i} prose line(s) from {f}', file=sys.stderr)
