# PlantCount

Offline mobile web app that counts crop emergence with the phone camera.
Pure client-side image processing (green-blob detection + centroid tracking) —
no server, no machine-learning download, **records nothing**.

## How counting works

- Sweep the camera **left ↔ right** across the crop row.
- A vertical **cyan counting line** sits in the middle of the working area.
- Each plant is tallied **once** as it crosses the line; the total keeps
  climbing even after plants leave the screen.
- Drag the cyan handle to move the line. Use **Reset** to zero the count.

Three input modes (⇄ button switches between them):
- **Live Camera** — real-time counting in the field.
- **Load Video File** — replay field footage with a scrubber + slow-motion.
- **Analyse a Photo** — count every green seedling in a still image.

The **Sensitivity** slider (⚙) controls how small a green blob still counts —
right = more sensitive.

## Privacy

No frames, photos, videos, counts, or locations are stored or transmitted.
Everything happens in the browser tab and is gone when you close it.

## Files

- `index.html` — markup and screens
- `css/app.css` — styling
- `js/detector.js` — vegetation detection: Excess-Green index + Otsu auto-threshold,
  distance transform + peak finding to split touching seedlings (no ML)
- `js/tracker.js` — centroid tracker with smoothing (assigns IDs, enables line-crossing count)
- `js/app.js` — UI, camera/video/photo modes, counting logic
- `sw.js` — service worker (offline cache)
- `manifest.json`, `icon.svg` — PWA install metadata
