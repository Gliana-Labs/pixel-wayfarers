"""Pixel Harvest pipeline: roll traits -> generate with Workers AI -> pixelate -> metadata.

Usage: python pipeline/harvest.py <command> [options]   (see README.md)
"""
import argparse
import base64
import hashlib
import io
import json
import os
import random
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests
import yaml
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "config"
BUILD = ROOT / "build"
MANIFEST = BUILD / "manifest.json"
RAW = BUILD / "raw"
IMAGES = BUILD / "images"
METADATA = BUILD / "metadata"
SHEETS = BUILD / "sheets"
STYLE_REF = ROOT / "art" / "style-ref.png"

TIER_ORDER = ["common", "uncommon", "rare", "epic", "legendary"]
GRID = 128        # pixel-art resolution each image is snapped to
OUT_SIZE = 1024   # final PNG size (GRID upscaled with nearest-neighbour)


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
    if not MANIFEST.exists():
        sys.exit("no manifest yet, run: python pipeline/harvest.py roll")
    return json.loads(MANIFEST.read_text())


def parse_ids(spec, manifest):
    """'1-50,77' -> [1..50, 77]; None -> every token."""
    if not spec:
        return [t["id"] for t in manifest]
    ids = []
    for part in spec.split(","):
        if "-" in part:
            lo, hi = part.split("-")
            ids.extend(range(int(lo), int(hi) + 1))
        else:
            ids.append(int(part))
    return ids


# ---------------------------------------------------------------- roll

def build_prompt(cfg, tier, fragments, use_ref):
    parts = [cfg["style"]["base"]]
    parts += [f for f in fragments if f]
    if cfg["tiers"][tier].get("flavor"):
        parts.append(cfg["tiers"][tier]["flavor"])
    prompt = ", ".join(parts)
    if use_ref:
        prompt = f"{cfg['style']['with_reference']} {prompt}"
    return prompt


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


def cmd_roll(args):
    cfg, legendaries = load_config()
    rng = random.Random(cfg["collection"]["seed"])
    use_ref = STYLE_REF.exists()

    tiers = [t for t in TIER_ORDER for _ in range(cfg["tiers"][t]["count"])]
    rng.shuffle(tiers)  # rarity is spread across token ids, not clustered

    tokens, seen, legendary_iter = [], set(), iter(legendaries)
    for token_id, tier in enumerate(tiers, start=1):
        if tier == "legendary":
            legend = next(legendary_iter)
            tokens.append({
                "id": token_id, "tier": tier, "name": legend["name"],
                "traits": legend["traits"],
                "prompt": build_prompt(cfg, tier, [legend["prompt"]], use_ref),
                "seed": rng.randrange(2**31),
            })
            continue
        for _ in range(1000):
            traits, fragments = roll_traits(cfg, tier, rng)
            key = json.dumps(traits, sort_keys=True)
            if key not in seen:
                seen.add(key)
                break
        else:
            sys.exit(f"could not find a unique combo for token {token_id}; add more traits")
        tokens.append({
            "id": token_id, "tier": tier, "traits": traits,
            "prompt": build_prompt(cfg, tier, fragments, use_ref),
            "seed": rng.randrange(2**31),
        })

    BUILD.mkdir(exist_ok=True)
    MANIFEST.write_text(json.dumps(tokens, indent=2))
    print(f"rolled {len(tokens)} tokens -> {MANIFEST.relative_to(ROOT)}"
          f" (style reference: {'yes' if use_ref else 'no, art/style-ref.png missing'})")
    cmd_stats(args)


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


# ---------------------------------------------------------------- generate

def run_workers_ai(model, prompt, params, seed, ref_png):
    account = os.environ.get("CF_ACCOUNT_ID")
    token = os.environ.get("CF_API_TOKEN")
    if not account or not token:
        sys.exit("set CF_ACCOUNT_ID and CF_API_TOKEN in .env")
    url = f"https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/{model}"
    form = {"prompt": (None, prompt), "seed": (None, str(seed))}
    for key, value in params.items():
        form[key] = (None, str(value))
    if ref_png:
        form["input_image_0"] = ("ref.png", ref_png, "image/png")

    for attempt in range(5):
        resp = requests.post(url, headers={"Authorization": f"Bearer {token}"},
                             files=form, timeout=180)
        if resp.status_code == 429 or resp.status_code >= 500:
            time.sleep(2 ** attempt * 3)
            continue
        if resp.headers.get("content-type", "").startswith("image/"):
            return resp.content
        body = resp.json()
        if not body.get("success", True) or resp.status_code >= 400:
            raise RuntimeError(f"{resp.status_code}: {body.get('errors') or body}")
        return base64.b64decode(body["result"]["image"])
    raise RuntimeError(f"gave up after retries (last status {resp.status_code})")


def reference_png():
    if not STYLE_REF.exists():
        return None
    img = Image.open(STYLE_REF).convert("RGB")
    img.thumbnail((504, 504))  # Workers AI requires input images under 512x512
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def cmd_generate(args):
    load_env()
    cfg, _ = load_config()
    manifest = {t["id"]: t for t in load_manifest()}
    RAW.mkdir(parents=True, exist_ok=True)
    ref = reference_png()

    todo = [i for i in parse_ids(args.ids, list(manifest.values()))
            if args.force or not (RAW / f"{i}.png").exists()]
    print(f"generating {len(todo)} images (style reference: {'yes' if ref else 'no'})")

    def job(token_id):
        token = manifest[token_id]
        tier_cfg = cfg["tiers"][token["tier"]]
        # --force gives a new seed so rerolls actually change the image
        seed = token["seed"] if not args.force else random.randrange(2**31)
        data = run_workers_ai(tier_cfg["model"], token["prompt"],
                              tier_cfg.get("params", {}), seed, ref)
        Image.open(io.BytesIO(data)).convert("RGB").save(RAW / f"{token_id}.png")
        return token_id

    failed = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(job, i): i for i in todo}
        for n, fut in enumerate(as_completed(futures), start=1):
            token_id = futures[fut]
            try:
                fut.result()
                print(f"[{n}/{len(todo)}] #{token_id} ok")
            except Exception as exc:  # keep going; failed ids are listed at the end
                failed.append(token_id)
                print(f"[{n}/{len(todo)}] #{token_id} FAILED: {exc}")
    if failed:
        print(f"\nfailed ids: {','.join(map(str, sorted(failed)))}")


def cmd_style(args):
    """Generate candidate style references; copy the best one to art/style-ref.png."""
    load_env()
    cfg, _ = load_config()
    out = ROOT / "art" / "style-candidates"
    out.mkdir(parents=True, exist_ok=True)
    prompt = build_prompt(cfg, "common", ["blooming spring farm fields", "brown messy hair",
                                          "blue denim overalls", "straw farmer hat"], False)
    model = cfg["tiers"]["common"]["model"]
    for i in range(1, args.count + 1):
        data = run_workers_ai(model, prompt, {"width": 1024, "height": 1024},
                              random.randrange(2**31), None)
        Image.open(io.BytesIO(data)).convert("RGB").save(out / f"{i}.png")
        pixelate(Image.open(out / f"{i}.png"), 32).save(out / f"{i}-pixel.png")
        print(f"wrote {(out / f'{i}.png').relative_to(ROOT)}")
    print("pick the best one: cp art/style-candidates/N.png art/style-ref.png, then re-run roll")


# ---------------------------------------------------------------- pixelate

def pixelate(img, colors):
    small = img.convert("RGB").resize((GRID, GRID), Image.BOX)
    small = small.quantize(colors=colors, method=Image.Quantize.MEDIANCUT,
                           dither=Image.Dither.NONE).convert("RGB")
    return small.resize((OUT_SIZE, OUT_SIZE), Image.NEAREST)


def cmd_pixelate(args):
    cfg, _ = load_config()
    manifest = {t["id"]: t for t in load_manifest()}
    IMAGES.mkdir(parents=True, exist_ok=True)
    done = 0
    for token_id in parse_ids(args.ids, list(manifest.values())):
        src = RAW / f"{token_id}.png"
        if not src.exists():
            continue
        colors = cfg["tiers"][manifest[token_id]["tier"]]["colors"]
        pixelate(Image.open(src), colors).save(IMAGES / f"{token_id}.png", optimize=True)
        done += 1
    print(f"pixelated {done} images -> {IMAGES.relative_to(ROOT)}")


# ---------------------------------------------------------------- review

def cmd_sheet(args):
    manifest = load_manifest()
    SHEETS.mkdir(parents=True, exist_ok=True)
    thumb, cols, per_sheet = 192, 10, 100
    tokens = [t for t in manifest if (IMAGES / f"{t['id']}.png").exists()]
    if args.tier:
        tokens = [t for t in tokens if t["tier"] == args.tier]
    for page in range(0, len(tokens), per_sheet):
        chunk = tokens[page:page + per_sheet]
        rows = (len(chunk) + cols - 1) // cols
        sheet = Image.new("RGB", (cols * thumb, rows * (thumb + 16)), "black")
        draw = ImageDraw.Draw(sheet)
        for i, token in enumerate(chunk):
            x, y = (i % cols) * thumb, (i // cols) * (thumb + 16)
            img = Image.open(IMAGES / f"{token['id']}.png").resize((thumb, thumb), Image.NEAREST)
            sheet.paste(img, (x, y))
            draw.text((x + 4, y + thumb + 2), f"#{token['id']} {token['tier']}", fill="white")
        name = f"sheet_{args.tier + '_' if args.tier else ''}{page // per_sheet + 1:02d}.png"
        sheet.save(SHEETS / name)
        print(f"wrote {(SHEETS / name).relative_to(ROOT)}")


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
    p = sub.add_parser("style", help="generate style-reference candidates")
    p.add_argument("--count", type=int, default=8)
    p = sub.add_parser("generate", help="generate raw images with Workers AI")
    p.add_argument("--ids", help="e.g. 1-20,55 (default: all)")
    p.add_argument("--force", action="store_true", help="regenerate with a fresh seed")
    p.add_argument("--workers", type=int, default=4)
    p = sub.add_parser("pixelate", help="snap raw images to the pixel grid + palette")
    p.add_argument("--ids")
    p = sub.add_parser("sheet", help="contact sheets for review")
    p.add_argument("--tier", choices=TIER_ORDER)
    sub.add_parser("provenance", help="hash all final images (commit before sale)")
    p = sub.add_parser("metadata", help="write OpenSea metadata JSON")
    p.add_argument("--image-cid", required=True, help="IPFS CID of the images folder")
    args = parser.parse_args()
    {"roll": cmd_roll, "stats": cmd_stats, "style": cmd_style, "generate": cmd_generate,
     "pixelate": cmd_pixelate, "sheet": cmd_sheet, "provenance": cmd_provenance,
     "metadata": cmd_metadata}[args.cmd](args)


if __name__ == "__main__":
    main()
