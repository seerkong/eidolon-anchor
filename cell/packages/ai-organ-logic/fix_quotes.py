"""Fix broken TypeScript syntax using hex escapes."""
import pathlib

path = pathlib.Path('/Users/kongweixian/ai/eidolon/eidolon-anchor/cell/packages/ai-organ-logic/src/permissions/LocalPermissionEvaluator.ts')
content = path.read_text()

# The broken text has ONE double-quote char (0x22):     + " + line.trimStart()
# The fixed text should have TWO double-quote chars:     + " + line.trimStart()
#                                                         ^^^- this is the string " "

# Use hex escape \x22 to represent double-quote unambiguously
old1 = '+ \x22 + line.trimStart()'
new1 = '+ \x22 \x22 + line.trimStart()'
print(f'old1 length: {len(old1)}, repr: {repr(old1)}')
print(f'new1 length: {len(new1)}, repr: {repr(new1)}')

count_before = content.count(old1)
content = content.replace(old1, new1)
count_after = content.count(old1)
print(f'Backslash join: {count_before} -> {count_after}')

old2 = '+= \x22 + line;'
new2 = '+= \x22 \x22 + line;'
print(f'old2 length: {len(old2)}, repr: {repr(old2)}')
print(f'new2 length: {len(new2)}, repr: {repr(new2)}')

count_before2 = content.count(old2)
content = content.replace(old2, new2)
count_after2 = content.count(old2)
print(f'Quote join: {count_before2} -> {count_after2}')

path.write_text(content)

# Verify
content2 = path.read_text()
for i, line in enumerate(content2.split('\n')):
    if 'prev.slice' in line and 'line.trimStart' in line:
        dq = line.count('"')
        print(f'Line {i+1}: {dq} double-quotes: {line.strip()}')
    if 'result[result.length - 1] +=' in line:
        dq = line.count('"')
        print(f'Line {i+1}: {dq} double-quotes: {line.strip()}')
