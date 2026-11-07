---
name: threejs-scroll-storytelling
description: Build scroll-driven 3D storytelling pages with Three.js (React Three Fiber).
---

# threejs-scroll-storytelling

When asked to build a scroll-driven 3D scene with Three.js:
1. Use React Three Fiber (Canvas) with drei helpers; avoid raw WebGL boilerplate.
2. Map page scroll to the scene via useScroll (drei): camera moves or object rotation/position per scroll progress.
3. Keep performance: enable antialias, cap pixelRatio at 2, reuse materials and geometries.
4. Add scroll sections with the canvas fixed behind; each section triggers a scene state change.
5. Fall back gracefully on low-end devices (reduce motion, lower DPR).
