"""One-off helper: verify generated icons have rounded (transparent) corners."""
from PIL import Image

for path in ["build/icon.png", "src-tauri/icons/32x32.png", "src-tauri/icons/128x128.png", "src-tauri/icons/icon.png"]:
    try:
        img = Image.open(path).convert("RGBA")
    except FileNotFoundError:
        print(path, "MISSING")
        continue
    w, h = img.size
    corners = [
        img.getpixel((0, 0))[3],
        img.getpixel((w - 1, 0))[3],
        img.getpixel((0, h - 1))[3],
        img.getpixel((w - 1, h - 1))[3],
    ]
    print(path, "size", img.size, "corner alphas:", corners)
