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

---

## Getting it on a phone (works offline)

The camera only loads over **HTTPS** the first time. Once loaded, the app's
service worker caches everything on the phone, so it then runs with **no
internet** (airplane mode in the field is fine). Opening the file directly
(`file://`) will NOT work — phones block the camera there.

### Option A — Netlify Drop (easiest, free)

1. On a computer, go to <https://app.netlify.com/drop>.
2. Drag the **`PlantCount` folder** onto the page.
   (Delete the `Video_example` folder first to keep the upload small.)
3. You get a URL like `https://plantcount-xyz.netlify.app`.
4. On the phone (with internet, one time):
   - Open that URL in **Chrome** (Android) or **Safari** (iOS).
   - Tap **Live Camera** once to grant the camera permission.
   - Add to home screen:
     - Android: ⋮ menu → *Add to Home screen* / *Install*.
     - iOS: Share → *Add to Home Screen*.
5. In the field: launch from the home-screen icon. No internet needed.

### Option B — GitHub Pages

1. Create a GitHub repo and upload these files.
2. Settings → Pages → deploy from the `main` branch, root folder.
3. Open the `https://<user>.github.io/<repo>/` URL on the phone and add to
   home screen as above.

### Option C — local Wi-Fi, no internet at all

If you can't use any online host, serve it over HTTPS from a laptop on the
same Wi-Fi (the phone needs a *trusted* certificate, or Chrome will block the
camera):

```bash
# with Node installed on the laptop
npx http-server . -S -C cert.pem -K key.pem -p 8443
```

Then browse to `https://<laptop-ip>:8443` from the phone. This is fiddlier
than Option A because of the self-signed certificate — only use it if going
online once is truly impossible.

---

## Verifying it's truly offline

After adding to the home screen, turn on **airplane mode**, then launch the
app from its icon. The camera and counting should work normally. If it fails,
open it online once more so the service worker can finish caching, then retry.

## Privacy

No frames, photos, videos, counts, or locations are stored or transmitted.
Everything happens in the browser tab and is gone when you close it.

## Files

- `index.html` — markup and screens
- `css/app.css` — styling
- `js/detector.js` — green-blob image processing
- `js/tracker.js` — centroid tracker (assigns IDs, enables line-crossing count)
- `js/app.js` — UI, camera/video/photo modes, counting logic
- `sw.js` — service worker (offline cache)
- `manifest.json`, `icon.svg` — PWA install metadata
