#!/usr/bin/env python3
"""Convert the bundled Instagram ZIP to deterministic local test inputs. No AI or network."""
import argparse
import hashlib
import json
import re
import zipfile
from pathlib import Path
from urllib.parse import urlparse

APP_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = APP_ROOT / "fixtures" / "instagram-export"
ARCHIVE = DATA_DIR / "instagram-080.014-2026-11-04-bV80AR5s.zip"
POSTS_ENTRY = "your_instagram_activity/saved/saved_posts.json"
COLLECTIONS_ENTRY = "your_instagram_activity/saved/saved_collections.json"


def repair_text(value):
    if not isinstance(value, str):
        return ""
    try:
        return value.encode("latin1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return value


def read_json(archive, name):
    info = archive.getinfo(name)
    if info.file_size > 32 * 1024 * 1024:
        raise ValueError("JSON entry is larger than 32 MB")
    return json.loads(archive.read(info))


def prepare(archive_path, output_dir):
    with zipfile.ZipFile(archive_path) as archive:
        records = read_json(archive, POSTS_ENTRY)
        collections = read_json(archive, COLLECTIONS_ENTRY)
        if not isinstance(records, list) or not isinstance(collections, list):
            raise ValueError("Expected exported posts and collections lists")
        items = []
        seen = set()
        for record in records:
            fields = {}
            for entry in record.get("label_values", []):
                label = repair_text(entry.get("label"))
                if label:
                    fields.setdefault(label, []).append(entry)
            urls = fields.get("URL", [])
            source_url = next((x.get("href") or x.get("value") for x in urls if x.get("href") or x.get("value")), "")
            parsed = urlparse(source_url)
            match = re.fullmatch(r"/(?:p|reel|tv)/([A-Za-z0-9_-]+)/?", parsed.path)
            if parsed.scheme != "https" or parsed.hostname not in {"www.instagram.com", "instagram.com"} or not match:
                raise ValueError("A saved post has an unsupported URL")
            item_id = "ig_" + match.group(1)
            if item_id in seen:
                raise ValueError("Duplicate post URL in the export")
            seen.add(item_id)
            caption = "\n\n".join(repair_text(x.get("value")) for x in fields.get("캡션", []) if repair_text(x.get("value")).strip())
            title = next((repair_text(x.get("value")) for x in fields.get("제목", []) if repair_text(x.get("value")).strip()), "")
            if not title:
                title = caption.strip().splitlines()[0][:100] if caption.strip() else "Instagram 저장 게시물"
            items.append({
                "id": item_id,
                "url": source_url,
                "title": title,
                "sourceCaption": caption,
                "exportTimestamp": record.get("timestamp"),
                "exportFbid": str(record.get("fbid", "")),
            })
        manifest = {
            "archive": ARCHIVE.name if archive_path.name == ARCHIVE.name else archive_path.name,
            "archive_sha256": hashlib.sha256(archive_path.read_bytes()).hexdigest(),
            "archive_bytes": archive_path.stat().st_size,
            "post_count": len(items),
            "caption_available": sum(bool(x["sourceCaption"].strip()) for x in items),
            "collection_count": len(collections),
            "media_entries": sum(len(x.get("media", [])) for x in records),
            "archive_entries": archive.namelist(),
            "source_posts_entry": POSTS_ENTRY,
            "text_encoding_repair": "latin1-to-utf8 only when the round trip is valid",
            "ai_calls": 0,
            "limitations": ["ZIP에는 원본 사진·영상이 없습니다.", "내보내기 timestamp를 게시물 생성일로 간주하지 않습니다.", "컬렉션과 저장 이유를 AI 입력에 넣지 않습니다."],
        }
    output_dir.mkdir(parents=True, exist_ok=True)
    for name, value in [("pinmap-items.json", items), ("manifest.json", manifest)]:
        (output_dir / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, default=ARCHIVE)
    parser.add_argument("--output", type=Path, default=DATA_DIR)
    args = parser.parse_args()
    print(json.dumps(prepare(args.archive, args.output), ensure_ascii=False))
