# McConnell Meshes
### Parametric 3D Footwear Design & Additive Manufacturing Studio
**Created by Keegan McConnell ([@keeganrmc](https://github.com/keeganrmc))**

![License](https://img.shields.io/badge/License-MIT-green.svg)
![Platform](https://img.shields.io/badge/Platform-Web%20%7C%20WebGL%20%7C%20Three.js-blue.svg)
![Target](https://img.shields.io/badge/3D%20Printing-TPU%20%7C%20Resin%20%7C%20PLA-purple.svg)

**McConnell Meshes** is an end-to-end generative footwear design system that builds customized, 3D-printable shoe models directly around a parametric foot last. Designed for industrial designers, footwear prototypers, and bespoke makers, the studio allows you to tailor the shoe to individual foot anatomy, dynamically adjust shell wall thicknesses, punch procedural breathability perforations, sculpt intricate outsole and upper topography, and rigorously validate the geometry for 3D printing (FDM TPU, SLA Resins, and prototyping polymers).

---

## ⚡ Quick Start

### 1. Launch the App
To run the local server on Windows:
- **Option A (One-Click):** Double-click `start.bat` in this folder.
- **Option B (PowerShell):** Right-click `run.ps1` &rarr; *Run with PowerShell*.
- **Option C (Command Line / Terminal):**
  ```bash
  node server.js
  ```

### 2. Open in Browser
Open **[http://127.0.0.1:8000/](http://127.0.0.1:8000/)** in Google Chrome, Microsoft Edge, or Apple Safari (WebGL 2.0 supported).

---

## 🌟 Core Features

### 1. 👟 Personal Foot & Last Calibration Station
- **Anatomical Fit Dials:** Directly calibrate foot length (in mm with live US/EU shoe size conversions), ball width (mm), ball girth, instep height, heel seat width, and toe spring angle.
- **Foot Morphology Archetypes:** Select between Standard Anatomical, Wide Forefoot (Natural Barefoot splay), High Arch, Flat Foot, Greek Foot (Morton’s toe), or Egyptian Foot.
- **Profile Presets & Storage:** Save personal foot profiles directly in your browser or export/import profile JSON files (e.g. *Keegan Daily Fit*, *Barefoot Zero-Drop*, *Athletic Sneaker*).
- **Asymmetric Foot Support:** Generate left, right, or mirrored shoe pairs tailored to anatomical differences between feet.

### 2. 📏 Shoe Model & Wall Thickness Studio
- **Conformal Shoe Growth:** Grows parametric shoe pieces (Upper shell, Midsole, Outsole, Collar, Insole) directly over the custom last.
- **Master Wall Thickness:** Continuously dial shell thickness from **0.8 mm up to 10.0 mm** with 0.1 mm precision.
  - *1.2 mm Ultralight:* Barefoot shells and flexible mesh layers.
  - *2.0 mm Performance:* Standard athletic running sneakers.
  - *3.2 mm Rugged:* Clogs, slides, and outdoor slip-ons.
  - *5.0 mm Chunky:* Structural outsoles and heavy-duty foam cushioning.
- **Offset & Gap Control:** Adjust the internal gap (0.0 mm to 6.0 mm) between the foot last and inner shoe wall to account for socks, custom orthotic insoles, or direct skin fit.
- **Variable Zone Stiffness:** Reinforce high-stress zones such as the toe box and heel counter while keeping the collar flexible.

### 3. 🕳️ Perforations & Ventilation Generator
- **Procedural Punching:** Punch clean, watertight perforations through the built shoe upper:
  - *Field Vents:* Procedural dart-throw distribution for maximum breathability.
  - *Brogue Rows:* Classic decorative perforation rows tracing the topline, vamp, or quarter margins.
  - *Lace Eyelets:* Structural eyelet arrays for shoe lace integration.
  - *Sole Drainage Ports:* Transverse drainage channels through the midsole.
- **Parametric Dials:** Independently adjust hole diameter (1.0 mm to 8.0 mm), center-to-center pitch (3.0 mm to 25.0 mm), and boundary margin clearances.
- **Reroll Seeds:** Procedurally regenerate pattern distributions with a single click.

### 4. 🏔️ Outsole Topography & Surface Sculptor
- **Tread Topography Presets:**
  - *Topographic Contours:* Real geographic elevation isolines and contour maps.
  - *Diamond Knurling:* Aggressive high-friction traction for wet or athletic grip.
  - *Hex Grip:* Geometric honeycomb lug matrices.
  - *Wave Flex Grooves:* Ergonomic sipes that flex with natural foot biomechanics.
  - *Voronoi Lugs:* Organic nature-inspired traction pads.
  - *Mountain Heightfield Relief:* Real elevation models (Mt. Aconcagua, Annapurna, Denali, Bryce Canyon, Matterhorn).
- **Relief Geometry:** Switch between **Carved** (inward sipes/grooves) and **Raised** (protruding lugs) with adjustable section profiles (Round, V-Groove, Square).

### 5. 🖨️ 3D Printability & Material Simulation Lab
- **Footwear Materials Matrix:**
  - **TPU 95A:** Industry standard for 3D printed footwear; flexible, abrasion-resistant, 45° self-supporting overhangs, 1.5 mm min wall.
  - **TPU 90A / 85A / 70A:** Softer cushioning filaments (NinjaFlex, Filaflex) down to ultra-soft foam-like densities.
  - **PLA / PETG:** Rapid sizing prototypes and fitting shells.
  - **Elastomeric & Tough Resins:** High-resolution SLA/DLP printing (Formlabs Elastic 50A/80A, Tough 1500).
- **Geometric Print Checks:**
  - *Watertight Mesh Solid Verification:* Detects non-manifold edges, open boundaries, or inverted normals.
  - *Overhang Angle Safety Analysis:* Identifies downward-facing triangles that exceed the material's critical angle (e.g. > 45°).
  - *Minimum Wall Thickness Alert:* Flags thin walls that could collapse or cause slicing voids.
- **Production Slicing Estimates:** Real-time calculation of estimated print duration, filament mass (grams), and material cost ($ USD).
- **One-Click Exports:**
  - **STL (Binary):** Ready for Bambu Studio, PrusaSlicer, OrcaSlicer, or Cura.
  - **3MF:** Complete project file embedding orientation and material profiles.
  - **OBJ:** High-fidelity mesh for rendering in Blender, KeyShot, or CAD.
  - **SVG & DXF:** 1:1 cutting dies and flat pattern unrolls.

---

## 🏗️ Architecture & Technology Stack

| Layer | Technologies |
|---|---|
| **Frontend UI** | HTML5, CSS3, ES Modules, IBM Plex Mono & Renato Symbols |
| **3D Rendering** | [Three.js](https://threejs.org/) (WebGL 2.0), Custom PBR Shaders |
| **Geometry Kernel** | B-Spline curves, Catmull-Clark subdivision, BVH Spatial Trees, QuadriFlow WASM |
| **CAD Export** | Rhino3dm (OpenNURBS WASM), Binary STL Writer, 3MF Package Writer |
| **Local Server** | Node.js Zero-Dependency HTTP Streaming Server (`server.js`) |
| **Persistence** | IndexedDB / PersistCore (Crash-proof autosave & undo history) |

---

## 📂 Project Directory Structure

```
McConnell Meshes/
├── index.html              # Core application entrypoint & viewport
├── mcconnell_studio.js     # McConnell Meshes Studio Hub logic & interactive engine
├── mcconnell_studio.css    # Scandinavian architectural light UI theme (WANDR Bento grid)
├── server.js               # Zero-dependency local Node.js server
├── start.bat               # Windows 1-click batch launcher
├── run.ps1                 # PowerShell script launcher
├── manifest.webmanifest    # Offline PWA manifest
├── assets/                 # 3DMM foot morphology models, base lasts, terrain heightfields
├── shoe/                   # Thickness, perforations, tread, printability, & slicing algorithms
├── kernel/                 # Geometry kernel, BVH spatial trees, Catmull-Clark subdivisions
├── vendor/                 # Three.js, Rhino3dm WASM, printer profiles, material specifications
├── patterns/               # 2D pattern unrolls & cutting die generators
└── README.md               # Project documentation
```

---

## 📜 Credits & Licensing

- **Creator & Author:** Keegan McConnell ([@keeganrmc](https://github.com/keeganrmc))
- **Geometry Core & Inspiration:** Phil Renato ([LastFirst](https://github.com/philrenato/lastfirst)) & Claude (Anthropic).
- **Libraries:** Three.js (MIT), Rhino3dm / openNURBS (MIT / openNURBS), QuadriFlow (BSD-3-Clause).
- **License:** [MIT License](LICENSE-LastFirst.txt). Free for personal, research, and commercial footwear development.

---
*Created with passion for bespoke industrial design & additive manufacturing.*
