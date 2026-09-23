"""Pixel Wayfarers local tools: roll traits, pull finished art from the Worker, provenance, metadata.

Generation + pixelation run in the Cloudflare Worker (worker/).

Usage: python pipeline/wayfarers.py <command> [options]   (see README.md)
"""
import argparse
import hashlib
import json
import os
import random
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests
import yaml

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "config"
BUILD = ROOT / "build"
MANIFEST = BUILD / "manifest.json"
IMAGES = BUILD / "images"
METADATA = BUILD / "metadata"

TIER_ORDER = ["common", "uncommon", "rare", "epic", "legendary"]


def load_env():
    env_file = ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip())


def load_config():
    cfg = yaml.safe_load((CONFIG / "traits.yaml").read_text())
    legendaries = yaml.safe_load((CONFIG / "legendaries.yaml").read_text())
    counts = sum(t["count"] for t in cfg["tiers"].values())
    if counts != cfg["collection"]["supply"]:
        sys.exit(f"tier counts sum to {counts}, supply is {cfg['collection']['supply']}")
    if len(legendaries) != cfg["tiers"]["legendary"]["count"]:
        sys.exit(f"legendaries.yaml has {len(legendaries)} entries, tier count is "
                 f"{cfg['tiers']['legendary']['count']}")
    return cfg, legendaries


def load_manifest():
    """The token list from build/manifest.json."""
    if not MANIFEST.exists():
        sys.exit("no manifest yet, run: python pipeline/wayfarers.py roll")
    return json.loads(MANIFEST.read_text())["tokens"]


# ---------------------------------------------------------------- roll

def build_prompt(cfg, tier, fragments):
    parts = [cfg["style"]["base"]]
    parts += [f for f in fragments if f]
    if cfg["tiers"][tier].get("flavor"):
        parts.append(cfg["tiers"][tier]["flavor"])
    return ", ".join(parts)


def roll_traits(cfg, tier, rng):
    rank = TIER_ORDER.index(tier)
    boost = cfg.get("same_tier_boost", 1)
    traits, fragments = {}, []
    for trait_type, options in cfg["traits"].items():
        allowed = [o for o in options if TIER_ORDER.index(o.get("tier", "common")) <= rank]
        weights = [o.get("weight", 1) * (boost if o.get("tier", "common") == tier else 1)
                   for o in allowed]
        pick = rng.choices(allowed, weights=weights)[0]
        traits[trait_type] = pick["value"]
        fragments.append(pick.get("prompt", ""))
    return traits, fragments


def own_tier_count(cfg, tier, traits):
    """How many of a token's traits are exclusive to its own tier."""
    return sum(1 for trait_type, value in traits.items()
               for o in cfg["traits"][trait_type]
               if o["value"] == value and o.get("tier", "common") == tier)


def cmd_roll(args):
    cfg, legendaries = load_config()
    rng = random.Random(cfg["collection"]["seed"])

    tiers = [t for t in TIER_ORDER for _ in range(cfg["tiers"][t]["count"])]
    rng.shuffle(tiers)  # rarity is spread across token ids, not clustered

    tokens, seen, legendary_iter = [], [], iter(legendaries)
    min_diff = cfg.get("min_trait_difference", 1)
    min_own = cfg.get("min_own_tier_traits", {})
    for token_id, tier in enumerate(tiers, start=1):
        if tier == "legendary":
            legend = next(legendary_iter)
            tokens.append({
                "id": token_id, "tier": tier, "name": legend["name"],
                "traits": legend["traits"],
                "prompt": build_prompt(cfg, tier, [legend["prompt"]]),
                "seed": rng.randrange(2**31),
            })
            continue
        for _ in range(5000):
            traits, fragments = roll_traits(cfg, tier, rng)
            if own_tier_count(cfg, tier, traits) < min_own.get(tier, 0):
                continue
            # too similar = shares all but fewer than min_diff traits with an existing token
            if all(sum(traits[k] != other[k] for k in traits) >= min_diff for other in seen):
                seen.append(traits)
                break
        else:
            sys.exit(f"token {token_id}: no combo differs by {min_diff}+ traits from all others; "
                     "add trait values or lower min_trait_difference")
        item = next(o for o in cfg["traits"]["Item"] if o["value"] == traits["Item"])
        tokens.append({
            "id": token_id, "tier": tier, "traits": traits,
            "prompt": build_prompt(cfg, tier, fragments),
            "pose": item.get("pose", "hold"),
            "seed": rng.randrange(2**31),
        })

    manifest = {
        "tiers": {name: {"model": t["model"], "params": t.get("params", {}), "colors": t["colors"],
                         "template": t.get("template", False)}
                  for name, t in cfg["tiers"].items()},
        "tokens": tokens,
    }
    BUILD.mkdir(exist_ok=True)
    MANIFEST.write_text(json.dumps(manifest, indent=2))
    write_site_traits(cfg)
    print(f"rolled {len(tokens)} tokens -> {MANIFEST.relative_to(ROOT)}")
    print("upload: cd worker && npx wrangler r2 object put pixel-wayfarers/manifest.json "
          "--file ../build/manifest.json --content-type application/json --remote")
    cmd_stats(args)


def write_site_traits(cfg):
    """Public trait list for the website (values + tier only, no prompts)."""
    site = {
        "tiers": {name: t["count"] for name, t in cfg["tiers"].items()},
        "traits": {trait_type: [{"value": o["value"], "tier": o.get("tier", "common")}
                                for o in options]
                   for trait_type, options in cfg["traits"].items()},
    }
    (ROOT / "worker" / "public" / "traits.json").write_text(json.dumps(site, indent=1))


def cmd_stats(_args):
    manifest = load_manifest()
    total = len(manifest)
    counts = {}
    for token in manifest:
        counts.setdefault("Rarity", {}).setdefault(token["tier"], 0)
        counts["Rarity"][token["tier"]] += 1
        if token["tier"] == "legendary":
            continue
        for trait_type, value in token["traits"].items():
            counts.setdefault(trait_type, {}).setdefault(value, 0)
            counts[trait_type][value] += 1
    for trait_type, values in counts.items():
        print(f"\n{trait_type}")
        for value, n in sorted(values.items(), key=lambda kv: -kv[1]):
            print(f"  {value:<20} {n:>4}  {100 * n / total:5.1f}%")


# ---------------------------------------------------------------- pull

def cmd_pull(args):
    """Download final images from the Worker's admin API into build/images/."""
    load_env()
    base = os.environ.get("WORKER_URL", "").rstrip("/")
    password = os.environ.get("ADMIN_PASSWORD")
    if not base or not password:
        sys.exit("set WORKER_URL and ADMIN_PASSWORD in .env")
    manifest = load_manifest()
    IMAGES.mkdir(parents=True, exist_ok=True)
    ids = [t["id"] for t in manifest
           if args.force or not (IMAGES / f"{t['id']}.png").exists()]
    session = requests.Session()
    session.auth = ("admin", password)

    def fetch(token_id):
        resp = session.get(f"{base}/admin/img/final/{token_id}.png", timeout=60)
        if resp.status_code == 404:
            return token_id, False
        resp.raise_for_status()
        (IMAGES / f"{token_id}.png").write_bytes(resp.content)
        return token_id, True

    missing = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        for token_id, ok in pool.map(fetch, ids):
            if not ok:
                missing.append(token_id)
    print(f"pulled {len(ids) - len(missing)} images -> {IMAGES.relative_to(ROOT)}")
    if missing:
        print(f"not generated yet: {len(missing)} (e.g. {missing[:10]})")


# ---------------------------------------------------------------- metadata

def cmd_provenance(_args):
    manifest = load_manifest()
    missing = [t["id"] for t in manifest if not (IMAGES / f"{t['id']}.png").exists()]
    if missing:
        sys.exit(f"{len(missing)} images missing, e.g. {missing[:10]}")
    hashes = "".join(hashlib.sha256((IMAGES / f"{t['id']}.png").read_bytes()).hexdigest()
                     for t in manifest)
    digest = hashlib.sha256(hashes.encode()).hexdigest()
    (BUILD / "provenance.txt").write_text(digest + "\n")
    print(f"provenance: 0x{digest}")


def cmd_metadata(args):
    cfg, _ = load_config()
    manifest = load_manifest()
    METADATA.mkdir(parents=True, exist_ok=True)
    coll = cfg["collection"]
    for token in manifest:
        name = token.get("name") or f"{coll['name']} #{token['id']}"
        attributes = [{"trait_type": "Rarity", "value": token["tier"].title()}]
        attributes += [{"trait_type": k, "value": v} for k, v in token["traits"].items()]
        meta = {
            "name": name,
            "description": coll["description"],
            "image": f"ipfs://{args.image_cid}/{token['id']}.png",
            "attributes": attributes,
        }
        if coll.get("external_url"):
            meta["external_url"] = coll["external_url"]
        (METADATA / f"{token['id']}.json").write_text(json.dumps(meta, indent=2))
    print(f"wrote {len(manifest)} metadata files -> {METADATA.relative_to(ROOT)}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("roll", help="roll tiers + traits into build/manifest.json")
    sub.add_parser("stats", help="print trait distribution")
    p = sub.add_parser("pull", help="download final images from the Worker")
    p.add_argument("--force", action="store_true", help="re-download existing files")
    sub.add_parser("provenance", help="hash all final images (commit before sale)")
    p = sub.add_parser("metadata", help="write OpenSea metadata JSON")
    p.add_argument("--image-cid", required=True, help="IPFS CID of the images folder")
    args = parser.parse_args()
    {"roll": cmd_roll, "stats": cmd_stats, "pull": cmd_pull,
     "provenance": cmd_provenance, "metadata": cmd_metadata}[args.cmd](args)


if __name__ == "__main__":
    main()
