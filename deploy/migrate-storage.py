#!/usr/bin/env python3
"""Copy Storage objects from the hosted project to the VPS stack.

Public buckets are downloaded from the public object endpoint, which needs no
credentials. Private buckets need the hosted project's service_role key, passed
as PROD_SERVICE_KEY — without it they are listed and skipped rather than failing
silently, so the summary always says what was left behind.

Uploads go through our own Storage API rather than into the volume directly, so
storage-api writes both the file and its storage.objects row itself. Writing the
volume by hand produces files the API does not know about.
"""
import os, sys, json, urllib.request, urllib.parse, urllib.error

PROD = "https://hnrvzakckwyomjwfizua.supabase.co"
OURS = os.environ["OUR_URL"]
OUR_KEY = os.environ["OUR_SERVICE_KEY"]
PROD_KEY = os.environ.get("PROD_SERVICE_KEY", "")

objects = json.load(open(sys.argv[1]))          # [{bucket, name, public, mime}]

def req(url, data=None, headers=None, method=None):
    r = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    return urllib.request.urlopen(r, timeout=120)

ok = skipped = failed = 0
for o in objects:
    b, name, is_public = o["bucket"], o["name"], o["public"]
    quoted = urllib.parse.quote(name, safe="/")
    bq = urllib.parse.quote(b, safe="")

    if is_public:
        src = f"{PROD}/storage/v1/object/public/{bq}/{quoted}"
        hdrs = {}
    elif PROD_KEY:
        src = f"{PROD}/storage/v1/object/{bq}/{quoted}"
        hdrs = {"Authorization": f"Bearer {PROD_KEY}", "apikey": PROD_KEY}
    else:
        print(f"SKIP (private, no key) {b}/{name}")
        skipped += 1
        continue

    try:
        body = req(src, headers=hdrs).read()
    except urllib.error.HTTPError as e:
        print(f"FAIL download {b}/{name}: HTTP {e.code}")
        failed += 1
        continue

    dst = f"{OURS}/storage/v1/object/{bq}/{quoted}"
    up = {"Authorization": f"Bearer {OUR_KEY}", "apikey": OUR_KEY,
          "Content-Type": o.get("mime") or "application/octet-stream",
          "x-upsert": "true"}
    try:
        req(dst, data=body, headers=up, method="POST").read()
        print(f"OK {b}/{name} ({len(body)} bytes)")
        ok += 1
    except urllib.error.HTTPError as e:
        print(f"FAIL upload {b}/{name}: HTTP {e.code} {e.read()[:120].decode(errors='replace')}")
        failed += 1

print(f"\n════ uploaded={ok} skipped={skipped} failed={failed} ════")
