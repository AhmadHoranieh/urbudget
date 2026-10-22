#!/bin/sh
# Temporary check: lists every string the Swift compiler extracted for localization and whether
# Localizable.xcstrings has it in Arabic. Output lines start with I18N- for the CI log.
python3 - "$TARGET_TEMP_DIR" "$SRCROOT/UrBudget/Localizable.xcstrings" <<'EOF'
import json, os, plistlib, sys
root, catalog = sys.argv[1], sys.argv[2]
known = json.load(open(catalog, encoding="utf-8"))["strings"]
found = {}
sample = None
for dirpath, _, files in os.walk(root):
    for name in files:
        if not name.endswith(".stringsdata"):
            continue
        raw = open(os.path.join(dirpath, name), "rb").read()
        if sample is None:
            sample = raw[:600]
        try:
            data = json.loads(raw)
        except Exception:
            try:
                data = plistlib.loads(raw)
            except Exception as error:
                print("I18N-UNREADABLE\t%s\t%s" % (name, error))
                continue
        for table, entries in (data.get("tables") or {}).items():
            for entry in entries:
                key = entry.get("key")
                found.setdefault((table, key), name)
print("I18N-SAMPLE\t%r" % (sample,))
missing = 0
for (table, key), name in sorted(found.items(), key=lambda item: (item[0][0], str(item[0][1]))):
    ok = table == "Localizable" and key in known and "ar" in known[key].get("localizations", {})
    if not ok:
        missing += 1
    print("I18N-%s\t%s\t%s\t%s" % ("OK" if ok else "MISSING", table, name, json.dumps(key, ensure_ascii=False)))
unused = [key for key in known if ("Localizable", key) not in found]
for key in sorted(unused):
    print("I18N-UNUSED\t%s" % json.dumps(key, ensure_ascii=False))
print("I18N-SUMMARY\t%d extracted, %d missing, %d catalog keys not extracted" % (len(found), missing, len(unused)))
EOF
exit 0
