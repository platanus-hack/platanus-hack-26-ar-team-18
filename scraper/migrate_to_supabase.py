"""Migrate the scraped CSV to Supabase: upload images to Storage, upsert rows to Postgres."""

import argparse
import math
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import quote

import pandas as pd
import requests

SUPABASE_URL = "https://tmeixwnumxqkpiipubqq.supabase.co"
BUCKET = "fotos_inmuebles"
TABLE = "propiedades"
IMAGE_SEP = "|"

NUMERIC_INT_COLS = ["image_count", "rooms_0", "bedrooms_0", "bathrooms_0", "parking_0"]
NUMERIC_FLOAT_COLS = [
    "latitude",
    "longitude",
    "price_value",
    "expenses_value",
    "square_meters_area_0",
]

CSV_TO_DB = {
    "url": "url",
    "posting_id": "posting_id",
    "posting_type": "posting_type",
    "image_count": "image_count",
    "address": "address",
    "address_visibility": "address_visibility",
    "neighborhood": "neighborhood",
    "location_label": "location_label",
    "city": "city",
    "latitude": "latitude",
    "longitude": "longitude",
    "price_value": "price_value",
    "price_type": "price_type",
    "expenses_value": "expenses_value",
    "expenses_type": "expenses_type",
    "square_meters_area_0": "square_meters_area",
    "rooms_0": "rooms",
    "bedrooms_0": "bedrooms",
    "bathrooms_0": "bathrooms",
    "parking_0": "parking",
    "location": "location",
    "description": "description",
}


def env_or_die(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        sys.exit(f"missing env var: {name}")
    return value


def download_image(session: requests.Session, url: str, timeout: int = 20) -> bytes | None:
    try:
        r = session.get(url, timeout=timeout)
        if r.status_code == 200 and r.content:
            return r.content
        print(f"  download failed [{r.status_code}] {url}", file=sys.stderr)
    except requests.RequestException as e:
        print(f"  download error {url}: {e}", file=sys.stderr)
    return None


def upload_image(
    session: requests.Session, service_key: str, path: str, body: bytes
) -> bool:
    encoded = quote(path, safe="/")
    url = f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{encoded}"
    headers = {
        "Authorization": f"Bearer {service_key}",
        "apikey": service_key,
        "Content-Type": "image/jpeg",
        "x-upsert": "true",
        "Cache-Control": "public, max-age=31536000",
    }
    try:
        r = session.post(url, headers=headers, data=body, timeout=30)
        if r.status_code in (200, 201):
            return True
        print(f"  upload failed [{r.status_code}] {path}: {r.text[:200]}", file=sys.stderr)
    except requests.RequestException as e:
        print(f"  upload error {path}: {e}", file=sys.stderr)
    return False


def public_url(path: str) -> str:
    return f"{SUPABASE_URL}/storage/v1/object/public/{BUCKET}/{quote(path, safe='/')}"


def process_row_images(
    download_session: requests.Session,
    upload_session: requests.Session,
    service_key: str,
    posting_id: str,
    image_urls: list[str],
    workers: int,
) -> list[str]:
    """Download each source URL and upload it under {posting_id}/{i}.jpg. Returns the public URLs that succeeded."""

    def handle(i: int, src: str) -> tuple[int, str | None]:
        body = download_image(download_session, src)
        if body is None:
            return i, None
        path = f"{posting_id}/{i}.jpg"
        if not upload_image(upload_session, service_key, path, body):
            return i, None
        return i, public_url(path)

    results: list[tuple[int, str | None]] = []
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = [ex.submit(handle, i, src) for i, src in enumerate(image_urls)]
        for fut in as_completed(futures):
            results.append(fut.result())

    results.sort(key=lambda x: x[0])
    return [url for _, url in results if url]


def upsert_row(session: requests.Session, service_key: str, row: dict) -> bool:
    url = f"{SUPABASE_URL}/rest/v1/{TABLE}"
    headers = {
        "Authorization": f"Bearer {service_key}",
        "apikey": service_key,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    try:
        r = session.post(url, headers=headers, json=row, timeout=30)
        if r.status_code in (200, 201, 204):
            return True
        print(f"  upsert failed [{r.status_code}] {row.get('posting_id')}: {r.text[:300]}", file=sys.stderr)
    except requests.RequestException as e:
        print(f"  upsert error {row.get('posting_id')}: {e}", file=sys.stderr)
    return False


def existing_posting_ids(session: requests.Session, service_key: str) -> set[str]:
    """Page through the table to learn which posting_ids are already loaded so we can resume."""
    headers = {
        "Authorization": f"Bearer {service_key}",
        "apikey": service_key,
    }
    seen: set[str] = set()
    page_size = 1000
    offset = 0
    while True:
        r = session.get(
            f"{SUPABASE_URL}/rest/v1/{TABLE}",
            headers={**headers, "Range-Unit": "items", "Range": f"{offset}-{offset + page_size - 1}"},
            params={"select": "posting_id"},
            timeout=30,
        )
        if r.status_code not in (200, 206):
            print(f"  could not list existing rows [{r.status_code}]: {r.text[:200]}", file=sys.stderr)
            break
        batch = r.json()
        if not batch:
            break
        for item in batch:
            seen.add(str(item["posting_id"]))
        if len(batch) < page_size:
            break
        offset += page_size
    return seen


def clean_value(col: str, value):
    if pd.isna(value):
        return None
    if col in NUMERIC_INT_COLS:
        try:
            return int(float(value))
        except (TypeError, ValueError):
            return None
    if col in NUMERIC_FLOAT_COLS:
        try:
            f = float(value)
            return None if math.isnan(f) else f
        except (TypeError, ValueError):
            return None
    return value


def build_row(csv_row: pd.Series, image_urls_uploaded: list[str]) -> dict:
    row: dict = {}
    for csv_col, db_col in CSV_TO_DB.items():
        if csv_col in csv_row.index:
            row[db_col] = clean_value(csv_col, csv_row[csv_col])
    row["image_urls"] = image_urls_uploaded
    row["image_count"] = len(image_urls_uploaded)
    return row


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("csv", type=Path, help="path to the CSV exported by the scraper")
    parser.add_argument("--limit", type=int, default=None, help="only process first N rows (for testing)")
    parser.add_argument("--start", type=int, default=0, help="skip the first N rows")
    parser.add_argument("--image-workers", type=int, default=8, help="concurrent image downloads/uploads per row")
    parser.add_argument("--skip-existing", action="store_true", help="skip rows whose posting_id is already in the table")
    parser.add_argument("--no-images", action="store_true", help="upsert table rows without uploading images (debug)")
    args = parser.parse_args()

    if not args.csv.exists():
        sys.exit(f"csv not found: {args.csv}")

    service_key = env_or_die("SUPABASE_SERVICE_ROLE_KEY")

    print(f"reading {args.csv}")
    df = pd.read_csv(args.csv)
    if args.start:
        df = df.iloc[args.start:]
    if args.limit:
        df = df.iloc[: args.limit]
    print(f"processing {len(df)} rows")

    download_session = requests.Session()
    download_session.headers.update({
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Referer": "https://www.zonaprop.com.ar/",
    })
    upload_session = requests.Session()
    api_session = requests.Session()

    skip_ids: set[str] = set()
    if args.skip_existing:
        print("fetching existing posting_ids...")
        skip_ids = existing_posting_ids(api_session, service_key)
        print(f"  {len(skip_ids)} rows already loaded — will skip")

    started = time.time()
    ok = 0
    skipped = 0
    failed = 0

    for idx, (_, csv_row) in enumerate(df.iterrows(), 1):
        posting_id = str(csv_row["posting_id"]).strip()
        if not posting_id or posting_id == "nan":
            failed += 1
            continue
        if posting_id in skip_ids:
            skipped += 1
            continue

        if args.no_images or pd.isna(csv_row.get("image_urls")):
            uploaded = []
        else:
            image_urls = [u for u in str(csv_row["image_urls"]).split(IMAGE_SEP) if u]
            uploaded = process_row_images(
                download_session,
                upload_session,
                service_key,
                posting_id,
                image_urls,
                args.image_workers,
            )

        row = build_row(csv_row, uploaded)
        if upsert_row(api_session, service_key, row):
            ok += 1
        else:
            failed += 1

        if idx % 10 == 0 or idx == len(df):
            elapsed = time.time() - started
            rate = idx / elapsed if elapsed else 0
            remaining = (len(df) - idx) / rate if rate else 0
            print(
                f"[{idx}/{len(df)}] ok={ok} skipped={skipped} failed={failed} "
                f"rate={rate:.2f} rows/s eta={remaining/60:.1f} min"
            )

    print(f"done: ok={ok} skipped={skipped} failed={failed} in {time.time()-started:.0f}s")


if __name__ == "__main__":
    main()
