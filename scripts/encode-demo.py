"""Encode captured browser frames. Requires Pillow 12.2.0; no generated UI frames."""
from pathlib import Path
import sys
from PIL import Image

files = sorted(Path(sys.argv[1]).glob("*.png"))
if not files or len(files) > 240:
    raise RuntimeError("Unexpected recording length")
frames = []
for file in files:
    with Image.open(file) as image:
        frames.append(image.convert("RGB").quantize(colors=96))
frames[0].save(sys.argv[2], save_all=True, append_images=frames[1:], duration=250,
               loop=0, optimize=True, disposal=1)
print(f"{len(frames)} captured frames, {len(frames) / 4:.1f}s, {Path(sys.argv[2]).stat().st_size} bytes")
