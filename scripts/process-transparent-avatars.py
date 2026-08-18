import os
from PIL import Image
from collections import deque

def flood_fill_transparent_bg(img_path, out_path, is_black=True, tolerance=30):
    img = Image.open(img_path).convert("RGBA")
    width, height = img.size
    pixels = img.load()
    
    visited = [[False for _ in range(height)] for _ in range(width)]
    queue = deque()
    
    # Target color: black (0,0,0) or white (255,255,255)
    def matches_bg(r, g, b):
        if is_black:
            return max(r, g, b) <= tolerance
        else:
            return min(r, g, b) >= (255 - tolerance)
            
    # Initialize queue with all 4 outer borders
    for x in range(width):
        for y in (0, height - 1):
            r, g, b, a = pixels[x, y]
            if matches_bg(r, g, b) and not visited[x][y]:
                visited[x][y] = True
                queue.append((x, y))
                
    for y in range(height):
        for x in (0, width - 1):
            r, g, b, a = pixels[x, y]
            if matches_bg(r, g, b) and not visited[x][y]:
                visited[x][y] = True
                queue.append((x, y))
                
    # 4-direction BFS
    while queue:
        cx, cy = queue.popleft()
        pixels[cx, cy] = (255, 255, 255, 0)
        
        for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            nx, ny = cx + dx, cy + dy
            if 0 <= nx < width and 0 <= ny < height and not visited[nx][ny]:
                r, g, b, a = pixels[nx, ny]
                if matches_bg(r, g, b):
                    visited[nx][ny] = True
                    queue.append((nx, ny))
                elif is_black and max(r, g, b) <= tolerance + 25:
                    # Antialiasing feather edge
                    visited[nx][ny] = True
                    alpha = int(((max(r, g, b) - tolerance) / 25.0) * 255)
                    pixels[nx, ny] = (r, g, b, max(0, min(255, alpha)))
                elif not is_black and min(r, g, b) >= 255 - tolerance - 25:
                    # Antialiasing feather edge
                    visited[nx][ny] = True
                    alpha = int(((255 - min(r, g, b) - tolerance) / 25.0) * 255)
                    pixels[nx, ny] = (r, g, b, max(0, min(255, alpha)))

    img.save(out_path, "PNG")
    print(f"BFS FloodFill Processed: {out_path}")

assets_dir = "/Users/lyong/work/ai/agent-mesh-platform/preview/assets"

# 1. Fin둥이 (Yellow Shiba) - White bg outer flood fill
flood_fill_transparent_bg(
    os.path.join(assets_dir, "agent-fin.jpg"),
    os.path.join(assets_dir, "agent-fin.png"),
    is_black=False,
    tolerance=25
)

# 2. Fin자 (Grey puppy with headset) - Black bg outer flood fill
flood_fill_transparent_bg(
    os.path.join(assets_dir, "agent-support.jpg"),
    os.path.join(assets_dir, "agent-support.png"),
    is_black=True,
    tolerance=30
)

# 3. 아름이 (Anime girl with heart) - Black bg outer flood fill
flood_fill_transparent_bg(
    os.path.join(assets_dir, "agent-assistant.jpg"),
    os.path.join(assets_dir, "agent-assistant.png"),
    is_black=True,
    tolerance=30
)
