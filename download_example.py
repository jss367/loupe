"""Download the pinned public Gloom example dataset for Loupe."""

import argparse
from pathlib import Path
from urllib.request import urlopen
import shutil

from server import DEFAULT_DATA, REVISION, SOURCE


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA)
    args = parser.parse_args()
    args.data_dir.mkdir(parents=True, exist_ok=True)
    for split in ("train", "test"):
        target = args.data_dir / f"gloom-{split}.parquet"
        url = f"{SOURCE}/resolve/{REVISION}/data/{split}-00000-of-00001.parquet"
        temporary = target.with_suffix(".parquet.part")
        print(f"Downloading {split} split to {target}...", flush=True)
        try:
            with urlopen(url, timeout=120) as response, temporary.open("wb") as output:
                shutil.copyfileobj(response, output)
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
    print("Ready. Run python server.py to open Loupe.")


if __name__ == "__main__":
    main()
