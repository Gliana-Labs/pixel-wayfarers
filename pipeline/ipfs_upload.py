"""Pin the packed image + metadata folders on IPFS through a Filebase bucket.

    python pipeline/ipfs_upload.py

Each folder is packed into one CAR file first (npx ipfs-car pack build/images --no-wrap
--output build/images.car, same for build/metadata), so 1,000 files count as one object on
Filebase. Needs FILEBASE_KEY, FILEBASE_SECRET and FILEBASE_BUCKET (an IPFS bucket) in .env.
Checks that Filebase pinned exactly the root CID we packed.
"""
import os
import sys
from pathlib import Path

import boto3
import requests

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
FOLDERS = ["images", "metadata"]
SAMPLE = {"images": "1.png", "metadata": "1.json"}


def load_env():
    for line in (ROOT / ".env").read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())


def pinned_cid(s3, bucket, obj):
    """Root CID Filebase pinned for an object ("" if missing); metadata keys come back capitalized."""
    try:
        meta = s3.head_object(Bucket=bucket, Key=obj)["Metadata"]
    except s3.exceptions.ClientError:
        return ""
    return {k.lower(): v for k, v in meta.items()}.get("cid", "")


def main():
    load_env()
    key, secret, bucket = (os.environ.get(k, "") for k in ("FILEBASE_KEY", "FILEBASE_SECRET", "FILEBASE_BUCKET"))
    if not (key and secret and bucket):
        sys.exit("set FILEBASE_KEY, FILEBASE_SECRET and FILEBASE_BUCKET in .env")
    s3 = boto3.client("s3", endpoint_url="https://s3.filebase.com", region_name="us-east-1",
                      aws_access_key_id=key, aws_secret_access_key=secret)
    for name in FOLDERS:
        car = BUILD / f"{name}.car"
        expected = (BUILD / f"{name}.cid").read_text().strip()
        obj = f"pixel-wayfarers-{name}.car"
        if pinned_cid(s3, bucket, obj) != expected:
            print(f"uploading {car.name} ({car.stat().st_size // 1_000_000} MB)...", flush=True)
            with car.open("rb") as f:
                # import=car tells Filebase to unpack the CAR and pin its root folder
                s3.put_object(Bucket=bucket, Key=obj, Body=f, Metadata={"import": "car"})
        cid = pinned_cid(s3, bucket, obj)
        status = "OK" if cid == expected else f"MISMATCH (packed {expected})"
        print(f"{name}: pinned {cid} {status}")
        if cid != expected:
            sys.exit(1)
        url = f"https://ipfs.filebase.io/ipfs/{cid}/{SAMPLE[name]}"
        r = requests.get(url, timeout=120)
        print(f"  gateway check {url} -> {r.status_code}")


if __name__ == "__main__":
    main()
