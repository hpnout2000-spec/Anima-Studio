with open('src/main.js', 'rb') as f:
    content = f.read()

# The bad pattern: lines ending with \r (backslash + r) followed by \r\n
# These appear as b'...;\\\r\r\n' in the file
bad1 = b"const mergeKey = `${parentId}_${child.id}`;\\\r\r\n"
good1 = b"const mergeKey = `${parentId}_${child.id}`;\r\n"

bad2 = b"          window.mergedVideosMap = window.mergedVideosMap || {};\\\r\r\n"
good2 = b"          window.mergedVideosMap = window.mergedVideosMap || {};\r\n"

bad3 = b"\\\r\r\n          // savedMergedNode declared above (line ~5626); reuse it here\\\r\r\n"
good3 = b"\r\n          // savedMergedNode declared above; reuse it here\r\n"

bad4 = b"          const existingMergedUrl = savedMergedNode ? savedMergedNode.url : window.mergedVideosMap[mergeKey];\\\r\r\n"
good4 = b"          const existingMergedUrl = savedMergedNode ? savedMergedNode.url : window.mergedVideosMap[mergeKey];\r\n"

bad5 = b"          const existingMergedId = savedMergedNode ? savedMergedNode.id : null;\\\r\r\n"
good5 = b"          const existingMergedId = savedMergedNode ? savedMergedNode.id : null;\r\n"

replacements = [(bad1, good1), (bad2, good2), (bad3, good3), (bad4, good4), (bad5, good5)]
count = 0
for bad, good in replacements:
    if bad in content:
        content = content.replace(bad, good)
        count += 1
        print(f"Replaced pattern {count}")
    else:
        print(f"Pattern {count+1} not found, trying with single \\r...")
        # Try alternate endings
        alt_bad = bad.replace(b'\\\r\r\n', b'\\\r\n')
        if alt_bad in content:
            content = content.replace(alt_bad, good)
            count += 1
            print(f"Replaced alt pattern {count}")

with open('src/main.js', 'wb') as f:
    f.write(content)

# Show context around line 5647
lines = content.split(b'\n')
for i, line in enumerate(lines[5640:5660], start=5641):
    print(f"{i}: {repr(line[:80])}")
