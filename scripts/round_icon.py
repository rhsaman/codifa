"""One-off helper: round the corners of build/icon.png (macOS squircle mask)."""
from PIL import Image, ImageDraw

img = Image.open("build/icon.png").convert("RGBA")
size = img.size[0]
# macOS squircle corner radius ~ 22.37% of icon size
r = int(size * 0.2237)
mask = Image.new("L", (size, size), 0)
d = ImageDraw.Draw(mask)
d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=255)
img.putalpha(mask)
img.save("build/icon.png")
print("rounded", size, "radius", r)
