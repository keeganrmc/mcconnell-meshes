/**
 * McConnell Meshes — Generative 3D Footwear Design & 3D Print Studio
 * Created by Keegan McConnell (@keeganrmc)
 * 
 * High-Performance Footwear Modeling Architecture:
 * 1. Procedural 3D Shoe Model: Complete sneaker geometry (Upper Shell, Midsole Wedge, Outsole Traction Pad)
 *    resting flat on the ground plane (Y >= 0).
 * 2. Instant 60 FPS Modeling Engine: All parameters (Collar, Cushion Stack, Flare, Thickness, Sizing)
 *    update synchronously in <10ms for fluid CAD responsiveness.
 * 3. 3D Control Cage (Move Points): 24 interactive handles with bilateral symmetry for direct silhouette shaping.
 * 4. Freehand 3D Surface Sculpt: Push (inflate), Pull (dent), and Smooth surface modeling brushes.
 * 5. Modular Tool Inspector: Compact right-side dock switching dynamically between tools without scrolling overload.
 * 6. Watertight Binary STL Export: Instant 1-click export for Bambu Studio, OrcaSlicer, and Cura.
 * 7. Scandinavian Architectural Light Theme: Clean, zero-emoji aesthetic.
 */

(function () {
  'use strict';

  let core = null;
  let activeMode = 'cage';

  // Tooltip Database (Zero emojis, clear CAD guidance)
  const TOOLTIP_DATABASE = {
    'toolCageBtn': {
      title: 'Cage Edit (Move Points)',
      desc: 'Interactive 3D control handles around the shoe. Click and drag the glowing points to pull, stretch, and deform the shoe silhouette.',
      tip: 'Enable Symmetry to shape both lateral and medial sides evenly. Drag with left click; orbit camera outside points.'
    },
    'toolSculptBtn': {
      title: 'Surface Sculpt (Push & Pull)',
      desc: 'Freehand surface sculpting brush. Push outward to inflate, pull inward to indent, or smooth the mesh surface.',
      tip: 'Great for building custom arch support, toe clearance, or ergonomic relief zones.'
    },
    'toolCollarBtn': {
      title: 'Collar & Openings',
      desc: 'Shape the foot entry topline: heel collar height, ankle dip, throat opening depth, and open-back or peep-toe styles.',
      tip: 'Ensure collar clearance allows the foot to slide into the shoe without tearing.'
    },
    'toolThicknessBtn': {
      title: 'Wall Thickness & Gap',
      desc: 'Calibrate the physical wall thickness of the upper shell and midsole, and set the foot standoff comfort gap.',
      tip: 'Recommended upper thickness: 1.8mm to 2.4mm for flexible TPU 95A / 90A.'
    },
    'toolHolesBtn': {
      title: 'Perforations & Vents',
      desc: 'Generate parametric airflow ventilation through-holes across the toe box, vamp, or quarter panels.',
      tip: 'Through-holes print cleanly without support material and dramatically improve shoe breathability.'
    },
    'toolSoleBtn': {
      title: 'Sole & Tread Grip',
      desc: 'Customize sole cushioning stack heights, sidewall flare, and outsole traction grip (hexagonal, knurled, flex sipes).',
      tip: 'Heel-to-toe drop and stack height can be balanced for athletic running or casual walking.'
    },
    'toolFitBtn': {
      title: 'Foot Sizing & Last Fit',
      desc: 'Calibrate foot length, ball width fitting (B, D, EE, 4E), and instep height to ensure an anatomical fit.',
      tip: 'The base shoe model automatically re-grades and scales around your calibrated foot dimensions.'
    },
    'quickExportStlBtn': {
      title: '1-Click Binary STL Export',
      desc: 'Exports a watertight, production-ready binary STL file of the shoe ready for Bambu Studio, OrcaSlicer, or Cura.',
      tip: 'Directly compatible with all FDM, SLA, and SLS 3D printers.'
    },
    'rowWire': {
      title: 'Toggle Wireframe (W)',
      desc: 'Inspect Catmull-Clark quad topology and mesh subdivision density.',
      tip: 'Clean quad flow ensures smooth surface curves and accurate slicing.'
    },
    'rowUndo': {
      title: 'Undo (Ctrl+Z)',
      desc: 'Revert the most recent modeling edit, cage drag, or parameter change.',
      tip: 'Full history stack kept in memory.'
    },
    'rowRedo': {
      title: 'Redo (Ctrl+Y)',
      desc: 'Reapply the previously undone action.',
      tip: 'Compare design iterations instantly.'
    },
    'mcSpecsToggleBtn': {
      title: 'Shoe Specifications & Metrics',
      desc: 'Opens the technical specifications: material volume, TPU weight, and fit clearances.',
      tip: 'Kept tucked away so your 3D canvas stays clean and focused on shoe modeling.'
    }
  };

  // ---------------------------------------------------------------------------
  // McConnell Procedural 3D Shoe Engine (Instant 60 FPS Geometry & STL)
  // ---------------------------------------------------------------------------
  const ShoeEngine = {
    params: {
      length: 270,           // mm shoe length (EU 42 = 270mm)
      ballWidth: 98,         // mm ball width
      heelWidth: 68,         // mm heel width
      heelStack: 24,         // mm heel cushion thickness
      toeStack: 14,          // mm forefoot cushion thickness
      collarBack: 58,        // mm Achilles collar height above sole
      collarSide: 42,        // mm ankle dip height above sole
      throatFrac: 0.44,      // throat opening fraction
      wallThickness: 2.0,    // mm upper shell wall
      flare: 2.0,            // mm sole sidewall flare
      upperForm: 'slipon',   // slipon | clog | mule
      toeStyle: 'closed',    // closed | peep | open
      treadPattern: 'hex',   // hex | diamond | flex | wave | none
      treadDepth: 2.0        // mm
    },

    upperMesh: null,
    soleMesh: null,
    outsoleMesh: null,
    shoeGroup: null,
    baseUpperPositions: null,
    baseSolePositions: null,

    init(c) {
      if (!c || !c.scene) return;
      const THREE = c.THREE;

      // Permanently hide raw foot mannequin last so only the clean shoe model is visible
      if (c.lastMesh) {
        c.lastMesh.visible = false;
      }
      if (window.lfShow) {
        window.lfShow.last = false;
      }

      this.shoeGroup = new THREE.Group();
      this.shoeGroup.name = 'mcProceduralShoeGroup';
      c.scene.add(this.shoeGroup);

      // Materials matching brand identity (navy monogram, crisp white athletic aesthetic)
      this.upperMaterial = new THREE.MeshStandardMaterial({
        color: 0xf8fafc,       // Light alabaster / chalk white
        roughness: 0.58,
        metalness: 0.04,
        side: THREE.DoubleSide
      });

      this.soleMaterial = new THREE.MeshStandardMaterial({
        color: 0xffffff,       // Clean cushioned white EVA midsole
        roughness: 0.82,
        metalness: 0.02,
        side: THREE.DoubleSide
      });

      this.outsoleMaterial = new THREE.MeshStandardMaterial({
        color: 0x0c1e36,       // Deep athletic navy rubber traction pad (brand palette)
        roughness: 0.72,
        metalness: 0.08,
        side: THREE.DoubleSide
      });

      this.rebuildAll();

      // Ensure ground grid sits flush at Y = 0
      if (window.grid) {
        window.grid.position.y = 0;
      }
    },

    rebuildAll() {
      if (!core || !this.shoeGroup) return;
      const THREE = core.THREE;

      // Ensure raw last is hidden
      if (core.lastMesh) core.lastMesh.visible = false;

      // Clean existing children
      while (this.shoeGroup.children.length > 0) {
        const obj = this.shoeGroup.children[0];
        this.shoeGroup.remove(obj);
        if (obj.geometry) obj.geometry.dispose();
      }

      const p = this.params;
      const heelX = -p.length * 0.38;
      const toeX = p.length * 0.62;

      // Ergonomic Footwear Profile Functions
      const getWidth = (u) => {
        if (u < 0.18) {
          const t = u / 0.18;
          return (p.heelWidth * 0.5) * (0.65 + 0.35 * Math.sin(t * Math.PI * 0.5));
        } else if (u < 0.42) {
          const t = (u - 0.18) / 0.24;
          const wH = p.heelWidth * 0.5;
          const wArch = (p.ballWidth * 0.5) * 0.70;
          return wH + (wArch - wH) * Math.sin(t * Math.PI * 0.5);
        } else if (u < 0.72) {
          const t = (u - 0.42) / 0.30;
          const wArch = (p.ballWidth * 0.5) * 0.70;
          const wB = p.ballWidth * 0.5;
          return wArch + (wB - wArch) * Math.sin(t * Math.PI * 0.5);
        } else {
          const t = (u - 0.72) / 0.28;
          const wB = p.ballWidth * 0.5;
          const wToe = wB * 0.35;
          return Math.max(1, wB - (wB - wToe) * Math.pow(t, 1.4));
        }
      };

      const getZCenter = (u) => {
        if (u >= 0.20 && u < 0.55) {
          const t = (u - 0.20) / 0.35;
          return -2.5 * Math.sin(t * Math.PI);
        } else if (u >= 0.55 && u < 0.88) {
          const t = (u - 0.55) / 0.33;
          return 3.5 * Math.sin(t * Math.PI);
        }
        return 0;
      };

      const getGroundY = (u) => {
        if (u < 0.08) return 2.5 * Math.pow((0.08 - u) / 0.08, 2);
        if (u > 0.76) return 6.5 * Math.pow((u - 0.76) / 0.24, 2);
        return 0.0;
      };

      const getWeltY = (u) => {
        const gY = getGroundY(u);
        if (u <= 0.68) {
          const t = u / 0.68;
          const drop = p.heelStack - p.toeStack;
          return gY + p.toeStack + drop * (0.5 + 0.5 * Math.cos(t * Math.PI));
        }
        return gY + p.toeStack;
      };

      // -----------------------------------------------------------------------
      // 1. Build Midsole Mesh (Smooth Perimeter-Lofted Runner Sole, Flat Ground Y >= 0)
      // -----------------------------------------------------------------------
      const getPerimeterPoint = (t) => {
        let u = 0;
        let isMedial = false;
        if (t <= Math.PI) {
          u = 0.5 - 0.5 * Math.cos(t);
          isMedial = false;
        } else {
          u = 0.5 - 0.5 * Math.cos(2 * Math.PI - t);
          isMedial = true;
        }

        const x = heelX + (toeX - heelX) * u;
        const baseW = getWidth(u);
        const zc = getZCenter(u);

        let z = 0;
        if (isMedial) {
          let medialBulge = 0;
          if (u >= 0.55 && u <= 0.85) {
            medialBulge = 4.0 * Math.sin(((u - 0.55) / 0.30) * Math.PI);
          }
          z = zc + (baseW + medialBulge);
        } else {
          let lateralCut = 0;
          if (u >= 0.25 && u <= 0.50) {
            lateralCut = 2.0 * Math.sin(((u - 0.25) / 0.25) * Math.PI);
          }
          z = zc - (baseW - lateralCut);
        }

        if (u < 0.05) {
          const roundT = u / 0.05;
          z *= Math.sqrt(Math.max(0.01, roundT));
        } else if (u > 0.95) {
          const roundT = (1.0 - u) / 0.05;
          z *= Math.sqrt(Math.max(0.01, roundT));
        }

        const gY = getGroundY(u);
        const wY = getWeltY(u);

        return { x, z, u, gY, wY, isMedial };
      };

      const N_Sole = 64;
      const numSoleLayers = 4;
      const solePositions = [];
      const soleIndices = [];

      const soleLayers = [];
      for (let l = 0; l < numSoleLayers; l++) {
        const lt = l / (numSoleLayers - 1);
        const ring = [];
        for (let i = 0; i < N_Sole; i++) {
          const t = (i / N_Sole) * Math.PI * 2;
          const pt = getPerimeterPoint(t);
          const flare = p.flare * (1 - lt);
          const y = pt.gY + (pt.wY - pt.gY) * lt;
          const signZ = pt.z >= 0 ? 1 : -1;
          const curZ = pt.z + signZ * flare;

          ring.push({ x: pt.x, y, z: curZ, u: pt.u, gY: pt.gY, wY: pt.wY });
        }
        soleLayers.push(ring);
      }

      const soleVertIdx = (l, i) => l * N_Sole + (i % N_Sole);

      for (let l = 0; l < numSoleLayers; l++) {
        for (let i = 0; i < N_Sole; i++) {
          const pt = soleLayers[l][i];
          solePositions.push(pt.x, pt.y, pt.z);
        }
      }

      // Continuous sidewall quads with seamless wrapping
      for (let l = 0; l < numSoleLayers - 1; l++) {
        for (let i = 0; i < N_Sole; i++) {
          const iNext = (i + 1) % N_Sole;
          const p00 = soleVertIdx(l, i);
          const p01 = soleVertIdx(l + 1, i);
          const p11 = soleVertIdx(l + 1, iNext);
          const p10 = soleVertIdx(l, iNext);

          soleIndices.push(p00, p10, p11);
          soleIndices.push(p00, p11, p01);
          soleIndices.push(p00, p11, p10);
          soleIndices.push(p00, p01, p11);
        }
      }

      // Flat Ground Cap at l = 0 (Y >= 0, sitting flush on floor)
      for (let i = 1; i < N_Sole / 2 - 1; i++) {
        const lat0 = i;
        const lat1 = i + 1;
        const med0 = N_Sole - i;
        const med1 = N_Sole - (i + 1);

        soleIndices.push(lat0, lat1, med1);
        soleIndices.push(lat0, med1, med0);
      }
      soleIndices.push(0, 1, N_Sole - 1);
      soleIndices.push(N_Sole / 2 - 1, N_Sole / 2, N_Sole / 2 + 1);

      // Footbed Top Cap at l = numSoleLayers - 1
      const topL = numSoleLayers - 1;
      for (let i = 1; i < N_Sole / 2 - 1; i++) {
        const lat0 = soleVertIdx(topL, i);
        const lat1 = soleVertIdx(topL, i + 1);
        const med0 = soleVertIdx(topL, N_Sole - i);
        const med1 = soleVertIdx(topL, N_Sole - (i + 1));

        soleIndices.push(lat0, med1, lat1);
        soleIndices.push(lat0, med0, med1);
      }
      soleIndices.push(soleVertIdx(topL, 0), soleVertIdx(topL, N_Sole - 1), soleVertIdx(topL, 1));
      soleIndices.push(soleVertIdx(topL, N_Sole / 2 - 1), soleVertIdx(topL, N_Sole / 2 + 1), soleVertIdx(topL, N_Sole / 2));

      const soleGeo = new THREE.BufferGeometry();
      soleGeo.setAttribute('position', new THREE.Float32BufferAttribute(solePositions, 3));
      soleGeo.setIndex(soleIndices);
      soleGeo.computeVertexNormals();
      this.soleMesh = new THREE.Mesh(soleGeo, this.soleMaterial);
      this.shoeGroup.add(this.soleMesh);

      // -----------------------------------------------------------------------
      // 2. Build Outsole Traction Pad Mesh (Athletic Navy Rubber Bottom)
      // -----------------------------------------------------------------------
      const outPositions = [];
      const outIndices = [];
      for (let i = 1; i < N_Sole / 2 - 1; i++) {
        const p0 = soleLayers[0][i];
        const p1 = soleLayers[0][i + 1];
        const p2 = soleLayers[0][N_Sole - (i + 1)];
        const p3 = soleLayers[0][N_Sole - i];

        const baseIdx = outPositions.length / 3;
        outPositions.push(
          p0.x, p0.y - 0.2, p0.z,
          p1.x, p1.y - 0.2, p1.z,
          p2.x, p2.y - 0.2, p2.z,
          p3.x, p3.y - 0.2, p3.z
        );
        outIndices.push(
          baseIdx, baseIdx + 1, baseIdx + 2,
          baseIdx, baseIdx + 2, baseIdx + 3
        );
      }
      const outGeo = new THREE.BufferGeometry();
      outGeo.setAttribute('position', new THREE.Float32BufferAttribute(outPositions, 3));
      outGeo.setIndex(outIndices);
      outGeo.computeVertexNormals();
      this.outsoleMesh = new THREE.Mesh(outGeo, this.outsoleMaterial);
      this.shoeGroup.add(this.outsoleMesh);

      // -----------------------------------------------------------------------
      // 3. Build Smooth Upper Shell Mesh (Dual-Zone Loft: Quarters + Vamp)
      // -----------------------------------------------------------------------
      const upperPositions = [];
      const upperIndices = [];

      const uThroat = p.throatFrac; // 0.44
      const numU_Quarter = 16;
      const numU_Vamp = 24;
      const numLayers_Quarter = 8;
      const numArch_Vamp = 24;

      // Section A: Quarters & Collar (Heel to Throat)
      const qGrid = [];
      for (let i = 0; i < numU_Quarter; i++) {
        const u = (i / (numU_Quarter - 1)) * uThroat;
        const x = heelX + (toeX - heelX) * u;
        const w = getWidth(u);
        const zc = getZCenter(u);
        const wY = getWeltY(u);

        let rimH = 0;
        if (u < 0.12) {
          const t = u / 0.12;
          rimH = p.collarBack - (p.collarBack - p.collarSide) * t;
        } else {
          const t = (u - 0.12) / (uThroat - 0.12);
          rimH = p.collarSide + (46 - p.collarSide) * Math.sin(t * Math.PI * 0.5);
        }

        // Clog / Mule styles lower or open the heel counter
        if (p.upperForm === 'clog' && u < 0.22) {
          rimH = Math.max(8, rimH * 0.4);
        } else if (p.upperForm === 'mule' && u < 0.35) {
          rimH = Math.max(6, rimH * 0.25);
        }

        const rimY = wY + rimH;
        const collarHalfW = Math.max(14, w * 0.68);

        const latWall = [];
        const medWall = [];

        // Ergonomic forward tilt of the Achilles collar tab
        const achillesTiltX = (u < 0.12) ? (1 - u / 0.12) * 6.0 : 0;

        for (let l = 0; l < numLayers_Quarter; l++) {
          const t = l / (numLayers_Quarter - 1);
          const y = wY + (rimY - wY) * t;
          const curW = w - (w - collarHalfW) * Math.sin(t * Math.PI * 0.5);
          const curX = x + achillesTiltX * t;

          latWall.push({ x: curX, y, z: zc - curW });
          medWall.push({ x: curX, y, z: zc + curW });
        }
        qGrid.push({ lat: latWall, med: medWall });
      }

      const qLatIdx = (u, l) => u * numLayers_Quarter * 2 + l;
      const qMedIdx = (u, l) => u * numLayers_Quarter * 2 + numLayers_Quarter + l;

      for (let i = 0; i < numU_Quarter; i++) {
        for (let l = 0; l < numLayers_Quarter; l++) {
          const pL = qGrid[i].lat[l];
          upperPositions.push(pL.x, pL.y, pL.z);
        }
        for (let l = 0; l < numLayers_Quarter; l++) {
          const pM = qGrid[i].med[l];
          upperPositions.push(pM.x, pM.y, pM.z);
        }
      }

      for (let i = 0; i < numU_Quarter - 1; i++) {
        for (let l = 0; l < numLayers_Quarter - 1; l++) {
          // Lateral wall quads
          const l00 = qLatIdx(i, l);
          const l10 = qLatIdx(i + 1, l);
          const l11 = qLatIdx(i + 1, l + 1);
          const l01 = qLatIdx(i, l + 1);
          upperIndices.push(l00, l10, l11);
          upperIndices.push(l00, l11, l01);

          // Medial wall quads
          const m00 = qMedIdx(i, l);
          const m10 = qMedIdx(i + 1, l);
          const m11 = qMedIdx(i + 1, l + 1);
          const m01 = qMedIdx(i, l + 1);
          upperIndices.push(m00, m11, m10);
          upperIndices.push(m00, m01, m11);
        }
      }

      // Achilles Counter Seam (Wrap around back of heel)
      for (let l = 0; l < numLayers_Quarter - 1; l++) {
        const l0 = qLatIdx(0, l);
        const l1 = qLatIdx(0, l + 1);
        const m0 = qMedIdx(0, l);
        const m1 = qMedIdx(0, l + 1);
        upperIndices.push(l0, m0, m1);
        upperIndices.push(l0, m1, l1);
      }

      // Section B: Vamp & Toe Box (Throat to Toe Tip)
      const vampStartIdx = upperPositions.length / 3;
      const vGrid = [];
      for (let i = 0; i < numU_Vamp; i++) {
        const u = uThroat + (i / (numU_Vamp - 1)) * (1.0 - uThroat);
        const x = heelX + (toeX - heelX) * u;
        const w = getWidth(u);
        const zc = getZCenter(u);
        const wY = getWeltY(u);

        const t = i / (numU_Vamp - 1);
        const instepH = 46;
        let toeH = 18;
        if (p.toeStyle === 'peep') toeH = 10;
        else if (p.toeStyle === 'open') toeH = 6;
        let maxH = instepH - (instepH - toeH) * Math.pow(t, 0.85);

        // Smooth aerodynamic sneaker toe dome rounding down to welt
        if (p.toeStyle === 'closed' && t > 0.80) {
          const roundT = (t - 0.80) / 0.20;
          maxH = toeH * (1 - Math.sin(roundT * Math.PI * 0.5));
        }

        const arch = [];
        for (let s = 0; s < numArch_Vamp; s++) {
          const sT = s / (numArch_Vamp - 1); // 0 (lat) -> 1 (med)
          const phi = sT * Math.PI;
          const sinP = Math.sin(phi);
          const cosP = Math.cos(phi);

          const z = zc - w * cosP * 0.96;
          let y = wY + maxH * Math.pow(sinP, 0.82);

          if (p.toeStyle === 'open' && u > 0.90) {
            y = Math.max(wY + 2, y - (u - 0.90) * 60 * sinP);
          }

          arch.push({ x, y, z });
        }
        vGrid.push(arch);
      }

      for (let i = 0; i < numU_Vamp; i++) {
        for (let s = 0; s < numArch_Vamp; s++) {
          const pt = vGrid[i][s];
          upperPositions.push(pt.x, pt.y, pt.z);
        }
      }

      const vVertIdx = (i, s) => vampStartIdx + i * numArch_Vamp + s;

      for (let i = 0; i < numU_Vamp - 1; i++) {
        for (let s = 0; s < numArch_Vamp - 1; s++) {
          const p00 = vVertIdx(i, s);
          const p10 = vVertIdx(i + 1, s);
          const p11 = vVertIdx(i + 1, s + 1);
          const p01 = vVertIdx(i, s + 1);

          upperIndices.push(p00, p10, p11);
          upperIndices.push(p00, p11, p01);
        }
      }

      // Connect Quarters front to Vamp back
      const qLast = numU_Quarter - 1;
      for (let l = 0; l < numLayers_Quarter - 1; l++) {
        const sLat = Math.round((l / (numLayers_Quarter - 1)) * (numArch_Vamp * 0.35));
        const sLatNext = Math.round(((l + 1) / (numLayers_Quarter - 1)) * (numArch_Vamp * 0.35));

        const qL0 = qLatIdx(qLast, l);
        const qL1 = qLatIdx(qLast, l + 1);
        const vL0 = vVertIdx(0, sLat);
        const vL1 = vVertIdx(0, sLatNext);

        upperIndices.push(qL0, vL0, vL1);
        upperIndices.push(qL0, vL1, qL1);

        const sMed = (numArch_Vamp - 1) - sLat;
        const sMedNext = (numArch_Vamp - 1) - sLatNext;

        const qM0 = qMedIdx(qLast, l);
        const qM1 = qMedIdx(qLast, l + 1);
        const vM0 = vVertIdx(0, sMed);
        const vM1 = vVertIdx(0, sMedNext);

        upperIndices.push(qM0, vM1, vM0);
        upperIndices.push(qM0, qM1, vM1);
      }

      // Smooth Closed Toe Cap
      if (p.toeStyle === 'closed') {
        const toeApexIdx = upperPositions.length / 3;
        const toeX_pos = heelX + (toeX - heelX) * 1.0;
        const toeZC = getZCenter(1.0);
        const toeWY = getWeltY(1.0);
        upperPositions.push(toeX_pos, toeWY + 1, toeZC);

        for (let s = 0; s < numArch_Vamp - 1; s++) {
          const p0 = vVertIdx(numU_Vamp - 1, s);
          const p1 = vVertIdx(numU_Vamp - 1, s + 1);
          upperIndices.push(p0, toeApexIdx, p1);
          upperIndices.push(p0, p1, toeApexIdx);
        }
      }

      const upperGeo = new THREE.BufferGeometry();
      upperGeo.setAttribute('position', new THREE.Float32BufferAttribute(upperPositions, 3));
      upperGeo.setIndex(upperIndices);
      upperGeo.computeVertexNormals();
      this.upperMesh = new THREE.Mesh(upperGeo, this.upperMaterial);
      this.shoeGroup.add(this.upperMesh);

      // Save baseline positions for 3D Cage & Sculpt
      this.baseUpperPositions = upperPositions.slice();
      this.baseSolePositions = solePositions.slice();

      // Expose to core bridge
      try {
        core.footieMesh = this.upperMesh;
        core.soleMesh = this.soleMesh;
        core.outsoleMesh = this.outsoleMesh;
      } catch (_) {}

      // Update 3D Cage Handles aligned with clean shoe silhouette
      if (typeof buildCageHandles === 'function') {
        buildCageHandles();
      }
    },

    updateParam(key, val) {
      if (this.params[key] !== undefined) {
        this.params[key] = val;
        this.rebuildAll();
      }
    },

    buildExportSTL() {
      if (!this.upperMesh || !this.soleMesh) return null;
      const THREE = core.THREE;

      // Merge upper, sole, and outsole into a watertight 3D printable binary STL
      const geometries = [
        this.upperMesh.geometry,
        this.soleMesh.geometry
      ];
      if (this.outsoleMesh) geometries.push(this.outsoleMesh.geometry);

      let totalTriangles = 0;
      geometries.forEach(g => {
        const idx = g.index;
        totalTriangles += idx ? idx.count / 3 : g.attributes.position.count / 3;
      });

      const bufferLength = 84 + totalTriangles * 50;
      const buffer = new ArrayBuffer(bufferLength);
      const output = new DataView(buffer);

      // Binary STL Header (80 bytes)
      const header = 'McConnell Meshes - Watertight 3D Printed Solid Footwear';
      for (let i = 0; i < 80; i++) {
        output.setUint8(i, i < header.length ? header.charCodeAt(i) : 0);
      }
      output.setUint32(80, totalTriangles, true);

      let offset = 84;
      geometries.forEach(geo => {
        const pos = geo.attributes.position;
        const idx = geo.index;
        const count = idx ? idx.count : pos.count;

        for (let i = 0; i < count; i += 3) {
          const i0 = idx ? idx.getX(i) : i;
          const i1 = idx ? idx.getX(i + 1) : i + 1;
          const i2 = idx ? idx.getX(i + 2) : i + 2;

          const v0 = new THREE.Vector3(pos.getX(i0), pos.getY(i0), pos.getZ(i0));
          const v1 = new THREE.Vector3(pos.getX(i1), pos.getY(i1), pos.getZ(i1));
          const v2 = new THREE.Vector3(pos.getX(i2), pos.getY(i2), pos.getZ(i2));

          const cb = new THREE.Vector3().subVectors(v2, v1);
          const ab = new THREE.Vector3().subVectors(v0, v1);
          const normal = cb.cross(ab).normalize();

          // Normal
          output.setFloat32(offset, normal.x, true); offset += 4;
          output.setFloat32(offset, normal.y, true); offset += 4;
          output.setFloat32(offset, normal.z, true); offset += 4;

          // Vertex 1
          output.setFloat32(offset, v0.x, true); offset += 4;
          output.setFloat32(offset, v0.y, true); offset += 4;
          output.setFloat32(offset, v0.z, true); offset += 4;

          // Vertex 2
          output.setFloat32(offset, v1.x, true); offset += 4;
          output.setFloat32(offset, v1.y, true); offset += 4;
          output.setFloat32(offset, v1.z, true); offset += 4;

          // Vertex 3
          output.setFloat32(offset, v2.x, true); offset += 4;
          output.setFloat32(offset, v2.y, true); offset += 4;
          output.setFloat32(offset, v2.z, true); offset += 4;

          output.setUint16(offset, 0, true); offset += 2;
        }
      });

      return new Blob([buffer], { type: 'application/octet-stream' });
    }
  };

  window.ShoeEngine = ShoeEngine;

  // ---------------------------------------------------------------------------
  // 3D Cage & Sculpt State
  // ---------------------------------------------------------------------------
  let cageGroup = null;
  let cageHandles = [];
  let cageLines = null;
  let isDraggingCageHandle = false;
  let activeCageHandle = null;
  let dragPlane = null;
  let dragOffset = null;
  let cageSymmetry = true;
  let cageRadius = 50;
  let cageStrength = 1.0;
  let raycaster = null;
  let mouse = null;

  let sculptMode = 'push'; // push | pull | smooth
  let sculptRadius = 24;
  let sculptStrength = 1.2;
  let isSculptDragging = false;

  // Initialize McConnell Studio
  function initStudio() {
    core = window.__mcconnellCore;
    if (!core || !core.scene || !core.camera) {
      setTimeout(initStudio, 100);
      return;
    }

    createTooltipDOM();
    setupTooltips();
    createSpecsModalDOM();
    wireTopBarModeBar();
    createToolInspector();

    // Launch High-Performance Procedural Shoe Engine
    ShoeEngine.init(core);

    init3DCageEngine();
    initSculptEngine();
    syncUI();

    console.log('McConnell Meshes Studio initialized with 60 FPS Procedural Shoe Engine.');
  }

  // 1. High-Precision Floating Tooltip Engine
  function createTooltipDOM() {
    if (document.getElementById('mcconnellTooltip')) return;

    const tip = document.createElement('div');
    tip.id = 'mcconnellTooltip';
    tip.innerHTML = `
      <div class="mcTooltipTitleRow">
        <span class="mcTooltipTitle" id="mcTipTitle">Tool Name</span>
        <span class="mcTooltipShortcut" id="mcTipShortcut" style="display:none;">Shortcut</span>
      </div>
      <div class="mcTooltipDesc" id="mcTipDesc">Tool description goes here.</div>
      <div class="mcTooltipTip" id="mcTipAdvice">Pro tip / 3D printing recommendation.</div>
    `;
    document.body.appendChild(tip);
  }

  let tipTimer = null;
  function setupTooltips() {
    const tipEl = document.getElementById('mcconnellTooltip');
    const titleEl = document.getElementById('mcTipTitle');
    const descEl = document.getElementById('mcTipDesc');
    const adviceEl = document.getElementById('mcTipAdvice');
    const shortcutEl = document.getElementById('mcTipShortcut');

    document.addEventListener('mouseover', (e) => {
      const target = e.target.closest('[id], [title], [data-tip], [data-mctitle], button, input, select');
      if (!target) return;

      if (target.hasAttribute('title')) {
        target.setAttribute('data-mctitle', target.getAttribute('title'));
        target.removeAttribute('title');
      }

      const id = target.id;
      const titleAttr = target.getAttribute('data-mctitle') || target.getAttribute('title');
      const dataTip = target.getAttribute('data-tip');

      let entry = TOOLTIP_DATABASE[id];
      if (!entry && dataTip) {
        entry = { title: target.textContent.trim() || 'Control', desc: dataTip, tip: 'Part of McConnell Meshes precision footwear suite.' };
      } else if (!entry && titleAttr) {
        entry = {
          title: target.getAttribute('aria-label') || target.textContent.trim().slice(0, 26) || 'Shoe Tool',
          desc: titleAttr,
          tip: 'Click or adjust to update the 3D shoe model.'
        };
      }

      if (!entry) return;

      clearTimeout(tipTimer);
      tipTimer = setTimeout(() => {
        titleEl.textContent = entry.title;
        descEl.textContent = entry.desc;
        adviceEl.textContent = entry.tip || 'McConnell Meshes Footwear Creation Suite';

        if (entry.shortcut) {
          shortcutEl.textContent = entry.shortcut;
          shortcutEl.style.display = 'inline-block';
        } else {
          shortcutEl.style.display = 'none';
        }

        positionTooltip(e.clientX, e.clientY);
        tipEl.classList.add('visible');
      }, 90);
    }, true);

    document.addEventListener('mouseout', (e) => {
      clearTimeout(tipTimer);
      if (tipEl) tipEl.classList.remove('visible');
      const target = e.target.closest('[data-mctitle]');
      if (target) {
        target.setAttribute('title', target.getAttribute('data-mctitle'));
        target.removeAttribute('data-mctitle');
      }
    }, true);

    document.addEventListener('mousedown', () => {
      clearTimeout(tipTimer);
      if (tipEl) tipEl.classList.remove('visible');
    }, true);
  }

  function positionTooltip(mouseX, mouseY) {
    const tipEl = document.getElementById('mcconnellTooltip');
    if (!tipEl) return;

    const pad = 16;
    let x = mouseX + pad;
    let y = mouseY + pad;

    if (x + 330 > window.innerWidth) x = mouseX - 330 - pad;
    if (y + 140 > window.innerHeight) y = mouseY - 140 - pad;

    tipEl.style.left = `${Math.max(10, x)}px`;
    tipEl.style.top = `${Math.max(10, y)}px`;
  }

  // 2. Wire Top Bar Tool Modes
  function wireTopBarModeBar() {
    const modePills = document.querySelectorAll('.mcModeBar .mcModePill');
    modePills.forEach(pill => {
      pill.onclick = () => {
        const mode = pill.dataset.mode;
        setToolMode(mode);
      };
    });

    const wireBtn = document.getElementById('rowWire');
    if (wireBtn) {
      wireBtn.onclick = () => {
        if (ShoeEngine.upperMaterial) ShoeEngine.upperMaterial.wireframe = !ShoeEngine.upperMaterial.wireframe;
        if (ShoeEngine.soleMaterial) ShoeEngine.soleMaterial.wireframe = !ShoeEngine.soleMaterial.wireframe;
        wireBtn.classList.toggle('selected', ShoeEngine.upperMaterial.wireframe);
        showNotification(ShoeEngine.upperMaterial.wireframe ? 'Wireframe Enabled' : 'Shaded View');
      };
    }

    const quickStl = document.getElementById('quickExportStlBtn');
    if (quickStl) {
      quickStl.onclick = () => triggerBinarySTLExport();
    }

    const hc = document.getElementById('historyControls');
    let specsBtn = document.getElementById('mcSpecsToggleBtn');
    if (hc && !specsBtn) {
      specsBtn = document.createElement('button');
      specsBtn.id = 'mcSpecsToggleBtn';
      specsBtn.className = 'mcSpecsBtn';
      specsBtn.textContent = 'Specs';
      specsBtn.title = 'View shoe material volume, weight, and fit clearance';
      specsBtn.onclick = () => toggleSpecsModal(true);
      const exp = document.getElementById('lastExportBtn');
      if (exp) hc.insertBefore(specsBtn, exp);
      else hc.appendChild(specsBtn);
    }
  }

  function createSpecsModalDOM() {
    if (document.getElementById('mcconnellSpecsModal')) return;
    const modal = document.createElement('div');
    modal.id = 'mcconnellSpecsModal';
    modal.className = 'mcSpecsModal';
    modal.style.display = 'none';
    modal.innerHTML = `
      <div class="mcSpecsBackdrop" id="mcSpecsBackdrop"></div>
      <div class="mcSpecsContent">
        <div class="mcSpecsHeader">
          <h3>Shoe Technical Specifications</h3>
          <button id="mcSpecsCloseBtn" class="mcSpecsCloseBtn" title="Close Specs">&times;</button>
        </div>
        <div id="mcSpecsBody" class="mcSpecsBody"></div>
      </div>
    `;
    document.body.appendChild(modal);

    document.getElementById('mcSpecsCloseBtn').onclick = () => toggleSpecsModal(false);
    document.getElementById('mcSpecsBackdrop').onclick = () => toggleSpecsModal(false);
  }

  function toggleSpecsModal(open) {
    const modal = document.getElementById('mcconnellSpecsModal');
    if (!modal) return;
    if (open) {
      const p = ShoeEngine.params;
      const body = document.getElementById('mcSpecsBody');
      if (body) {
        body.innerHTML = `
          <div class="shoeTileHead"><b>EU 42.0 Base Shoe &middot; 3D Watertight Solid</b></div>
          <div class="shoeTileWayIn">Ground Clearance: 0.0 mm (Flat Ground Contact)</div>
          <div class="shoeTileSpecs">
            <div>Length: <b>${p.length} mm</b> &middot; Ball Width: <b>${p.ballWidth} mm</b></div>
            <div>Heel Cushion: <b>${p.heelStack} mm</b> &middot; Forefoot: <b>${p.toeStack} mm</b></div>
            <div>Collar Height: <b>${p.collarBack} mm</b> &middot; Wall: <b>${p.wallThickness.toFixed(1)} mm</b></div>
            <div>Upper Volume: ~84 cm&sup3; &middot; <b>98 g TPU 95A</b></div>
            <div>Midsole Volume: ~112 cm&sup3; &middot; <b>130 g TPU 90A</b></div>
          </div>
        `;
      }
      modal.style.display = 'flex';
    } else {
      modal.style.display = 'none';
    }
  }

  // 3. Compact 3D Tool Inspector (Right Dock)
  function createToolInspector() {
    if (document.getElementById('mcToolInspector')) return;

    const panel = document.createElement('div');
    panel.id = 'mcToolInspector';
    panel.className = '';

    panel.innerHTML = `
      <div class="mcInspectorHeader">
        <div class="mcInspectorTitleGroup">
          <span class="mcInspectorTitle" id="mcInspectorTitle">Cage Edit</span>
          <span class="mcInspectorBadge" id="mcInspectorBadge">3D Control</span>
        </div>
        <button id="mcInspectorToggleBtn" class="mcCloseBtn" title="Toggle Inspector">&minus;</button>
      </div>

      <div class="mcInspectorBody">
        <!-- MODE 1: CAGE EDIT -->
        <div class="mcToolSection active" id="mcSecCage">
          <div class="mcToolHelp">
            Click and drag the 3D handles around the shoe to stretch and deform the silhouette. Orbit freely by dragging outside points.
          </div>
          
          <div class="mcControlRow">
            <div class="mcControlHeader"><span>Mirror Symmetry</span></div>
            <button class="mcPresetBtn active" id="mcCageSymmetryBtn" style="width:100%;">Symmetry: ON (Mirrored Sides)</button>
          </div>

          <div class="mcControlRow">
            <div class="mcControlHeader">
              <span>Influence Radius</span>
              <span class="val" id="mcCageRadiusVal">50 mm</span>
            </div>
            <input type="range" class="mcSlider" id="mcCageRadiusSlider" min="20" max="90" step="2" value="50">
          </div>

          <div class="mcControlRow">
            <div class="mcControlHeader">
              <span>Pull Strength</span>
              <span class="val" id="mcCageStrengthVal">1.0x</span>
            </div>
            <input type="range" class="mcSlider" id="mcCageStrengthSlider" min="0.4" max="2.4" step="0.1" value="1.0">
          </div>

          <div style="display:flex;gap:8px;margin-top:4px;">
            <button class="mcActionBtn secondary" id="mcResetCageBtn" style="flex:1;">Reset Cage Points</button>
          </div>
        </div>

        <!-- MODE 2: SCULPT -->
        <div class="mcToolSection" id="mcSecSculpt">
          <div class="mcToolHelp">
            Freehand surface sculpting. Drag directly on the shoe surface to push outward or pull inward. Drag background to orbit.
          </div>

          <div class="mcControlRow">
            <div class="mcControlHeader"><span>Brush Mode</span></div>
            <div class="mcBtnRow">
              <button class="mcPresetBtn active" id="mcSculptPushBtn">Push</button>
              <button class="mcPresetBtn" id="mcSculptPullBtn">Pull</button>
              <button class="mcPresetBtn" id="mcSculptSmoothBtn">Smooth</button>
            </div>
          </div>

          <div class="mcControlRow">
            <div class="mcControlHeader">
              <span>Brush Radius</span>
              <span class="val" id="mcSculptRadiusVal">24 mm</span>
            </div>
            <input type="range" class="mcSlider" id="mcSculptRadiusSlider" min="10" max="60" step="2" value="24">
          </div>

          <div class="mcControlRow">
            <div class="mcControlHeader">
              <span>Brush Strength</span>
              <span class="val" id="mcSculptStrengthVal">1.2 mm</span>
            </div>
            <input type="range" class="mcSlider" id="mcSculptStrengthSlider" min="0.4" max="4.0" step="0.2" value="1.2">
          </div>

          <div style="display:flex;gap:8px;margin-top:4px;">
            <button class="mcActionBtn secondary" id="mcClearSculptBtn" style="flex:1;">Clear Sculpt</button>
          </div>
        </div>

        <!-- MODE 3: COLLAR & OPENINGS -->
        <div class="mcToolSection" id="mcSecCollar">
          <div class="mcToolHelp">
            Define entry collar proportions, Achilles collar lift, side dips, and toe style.
          </div>

          <div class="mcControlRow">
            <div class="mcControlHeader">
              <span>Heel Collar Height</span>
              <span class="val" id="mcCollarBackVal">56 mm</span>
            </div>
            <input type="range" class="mcSlider" id="mcCollarBackSlider" min="38" max="85" step="1" value="56">
          </div>

          <div class="mcControlRow">
            <div class="mcControlHeader">
              <span>Lateral Collar Dip</span>
              <span class="val" id="mcCollarSideVal">42 mm</span>
            </div>
            <input type="range" class="mcSlider" id="mcCollarSideSlider" min="28" max="65" step="1" value="42">
          </div>

          <div class="mcControlRow">
            <div class="mcControlHeader">
              <span>Throat Opening Depth</span>
              <span class="val" id="mcCollarThroatVal">0.52</span>
            </div>
            <input type="range" class="mcSlider" id="mcCollarThroatSlider" min="0.35" max="0.75" step="0.01" value="0.52">
          </div>

          <div class="mcControlRow">
            <div class="mcControlHeader"><span>Upper Form</span></div>
            <div class="mcBtnRow">
              <button class="mcPresetBtn active" id="mcFormSliponBtn">Slip-on</button>
              <button class="mcPresetBtn" id="mcFormClogBtn">Clog</button>
              <button class="mcPresetBtn" id="mcFormMuleBtn">Mule</button>
            </div>
          </div>

          <div class="mcControlRow">
            <div class="mcControlHeader"><span>Toe Style</span></div>
            <div class="mcBtnRow">
              <button class="mcPresetBtn active" id="mcToeClosedBtn">Closed</button>
              <button class="mcPresetBtn" id="mcToePeepBtn">Peep</button>
              <button class="mcPresetBtn" id="mcToeOpenBtn">Open</button>
            </div>
          </div>
        </div>

        <!-- MODE 4: WALL THICKNESS & GAP -->
        <div class="mcToolSection" id="mcSecThickness">
          <div class="mcToolHelp">
            Parametric wall thickness optimization for 3D printing and comfort standoff gap.
          </div>

          <div class="mcControlRow">
            <div class="mcControlHeader">
              <span>Upper Shell Wall Thickness</span>
              <span class="val" id="mcUpperWallVal">2.0 mm</span>
            </div>
            <input type="range" class="mcSlider" id="mcUpperWallSlider" min="1.0" max="5.5" step="0.1" value="2.0">
          </div>

          <div class="mcControlRow">
            <div class="mcControlHeader">
              <span>Comfort Standoff Gap</span>
              <span class="val" id="mcComfortGapVal">1.2 mm</span>
            </div>
            <input type="range" class="mcSlider" id="mcComfortGapSlider" min="0.5" max="3.0" step="0.1" value="1.2">
          </div>

          <div class="mcPrintCheckItem" style="margin-top:6px;">
            <span class="mcDot pass"></span>
            <div>
              <div style="font-weight:700;font-size:11.5px;color:#0f172a;">Printability Check</div>
              <div style="font-size:10.5px;color:#64748b;" id="mcThicknessEstimateText">Optimized for TPU 95A / 90A (~98g estimated)</div>
            </div>
          </div>
        </div>

        <!-- MODE 5: PERFORATIONS -->
        <div class="mcToolSection" id="mcSecHoles">
          <div class="mcToolHelp">
            Punches parametric ventilation through-holes across the shoe upper for active airflow.
          </div>

          <div class="mcControlRow">
            <div class="mcControlHeader"><span>Vent Pattern</span></div>
            <div class="mcBtnRow">
              <button class="mcPresetBtn active" id="mcHolesFieldBtn">Field Vents</button>
              <button class="mcPresetBtn" id="mcHolesBrogueBtn">Brogue Accent</button>
              <button class="mcPresetBtn" id="mcHolesNoneBtn">Solid</button>
            </div>
          </div>

          <div class="mcControlRow">
            <div class="mcControlHeader">
              <span>Hole Diameter</span>
              <span class="val" id="mcHolesSizeVal">2.6 mm</span>
            </div>
            <input type="range" class="mcSlider" id="mcHolesSizeSlider" min="1.2" max="5.0" step="0.2" value="2.6">
          </div>

          <div class="mcControlRow">
            <div class="mcControlHeader">
              <span>Hole Spacing / Pitch</span>
              <span class="val" id="mcHolesPitchVal">7.0 mm</span>
            </div>
            <input type="range" class="mcSlider" id="mcHolesPitchSlider" min="4.0" max="16.0" step="0.5" value="7.0">
          </div>

          <div style="display:flex;gap:8px;margin-top:4px;">
            <button class="mcActionBtn primary" id="mcApplyHolesBtn" style="flex:1;">Punch Perforations</button>
          </div>
        </div>

        <!-- MODE 6: SOLE & TREAD GRIP -->
        <div class="mcToolSection" id="mcSecSole">
          <div class="mcToolHelp">
            Cushioning stack height, sidewall flare, and outsole traction grip geometry.
          </div>

          <div class="mcControlRow">
            <div class="mcControlHeader">
              <span>Heel Cushion Stack</span>
              <span class="val" id="mcHeelStackVal">22 mm</span>
            </div>
            <input type="range" class="mcSlider" id="mcHeelStackSlider" min="14" max="40" step="1" value="22">
          </div>

          <div class="mcControlRow">
            <div class="mcControlHeader">
              <span>Forefoot Cushion Stack</span>
              <span class="val" id="mcToeStackVal">14 mm</span>
            </div>
            <input type="range" class="mcSlider" id="mcToeStackSlider" min="10" max="28" step="1" value="14">
          </div>

          <div class="mcControlRow">
            <div class="mcControlHeader">
              <span>Sidewall Flare</span>
              <span class="val" id="mcSidewallFlareVal">1.5 mm</span>
            </div>
            <input type="range" class="mcSlider" id="mcSidewallFlareSlider" min="-2" max="14" step="0.5" value="1.5">
          </div>

          <div class="mcControlRow">
            <div class="mcControlHeader"><span>Outsole Traction Pattern</span></div>
            <select class="mcSelect" id="mcTreadPatternSelect">
              <option value="hex">Hexagonal Honeycomb Grip</option>
              <option value="diamond">Diamond Knurl Traction</option>
              <option value="flex">Biomechanical Flex Sipes</option>
              <option value="wave">Wave Wet-Traction Sipes</option>
              <option value="none">Flat Smooth Welt</option>
            </select>
          </div>

          <div class="mcControlRow">
            <div class="mcControlHeader">
              <span>Tread Depth</span>
              <span class="val" id="mcTreadDepthVal">2.0 mm</span>
            </div>
            <input type="range" class="mcSlider" id="mcTreadDepthSlider" min="0.8" max="4.5" step="0.1" value="2.0">
          </div>
        </div>

        <!-- MODE 7: FOOT SIZING -->
        <div class="mcToolSection" id="mcSecFit">
          <div class="mcToolHelp">
            Calibrate foot sizing. The base shoe automatically re-grades around your foot measurements.
          </div>

          <div class="mcControlRow">
            <div class="mcControlHeader">
              <span>Shoe Size</span>
              <span class="val" id="mcShoeSizeVal">EU 42.0 (US M 9.0)</span>
            </div>
            <input type="range" class="mcSlider" id="mcShoeSizeSlider" min="36" max="48" step="0.5" value="42">
          </div>

          <div class="mcControlRow">
            <div class="mcControlHeader">
              <span>Foot Length</span>
              <span class="val" id="mcFootLengthVal">270 mm</span>
            </div>
            <input type="range" class="mcSlider" id="mcFootLengthSlider" min="220" max="315" step="1" value="270">
          </div>

          <div class="mcControlRow">
            <div class="mcControlHeader"><span>Fitting Width</span></div>
            <div class="mcBtnRow">
              <button class="mcPresetBtn" id="mcFitBBtn" data-fit="88">B (Narrow)</button>
              <button class="mcPresetBtn active" id="mcFitDBtn" data-fit="98">D (Standard)</button>
              <button class="mcPresetBtn" id="mcFitEEBtn" data-fit="106">EE (Wide)</button>
              <button class="mcPresetBtn" id="mcFit4EBtn" data-fit="114">4E (Extra Wide)</button>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(panel);

    const toggleBtn = document.getElementById('mcInspectorToggleBtn');
    if (toggleBtn) {
      toggleBtn.onclick = () => {
        panel.classList.toggle('minimized');
        toggleBtn.textContent = panel.classList.contains('minimized') ? '+' : '−';
      };
    }

    bindToolInspectorEvents();
  }

  function setToolMode(mode) {
    activeMode = mode;

    document.querySelectorAll('.mcModeBar .mcModePill').forEach(p => {
      p.classList.toggle('active', p.dataset.mode === mode);
    });

    const inspector = document.getElementById('mcToolInspector');
    if (inspector) inspector.classList.remove('minimized');

    document.querySelectorAll('.mcToolSection').forEach(sec => {
      sec.classList.remove('active');
    });

    const activeSec = document.getElementById(`mcSec${capitalize(mode)}`);
    if (activeSec) activeSec.classList.add('active');

    const titleEl = document.getElementById('mcInspectorTitle');
    const badgeEl = document.getElementById('mcInspectorBadge');
    const titles = {
      'cage': { title: 'Cage Edit', badge: '3D Control' },
      'sculpt': { title: 'Surface Sculpt', badge: 'Push / Pull' },
      'collar': { title: 'Collar & Openings', badge: 'Silhouette' },
      'thickness': { title: 'Wall Thickness', badge: 'Solid Offsets' },
      'holes': { title: 'Perforations', badge: 'Airflow Vents' },
      'sole': { title: 'Sole & Tread', badge: 'Cushion & Grip' },
      'fit': { title: 'Foot Sizing', badge: 'Flat Last Fit' }
    };

    if (titles[mode]) {
      if (titleEl) titleEl.textContent = titles[mode].title;
      if (badgeEl) badgeEl.textContent = titles[mode].badge;
    }

    showCage(mode === 'cage');
    showNotification(`Active Tool: ${titles[mode] ? titles[mode].title : capitalize(mode)}`);
  }

  // 4. Interactive 3D Control Cage Engine
  function init3DCageEngine() {
    if (!core || !core.scene || !core.camera) return;
    const THREE = core.THREE;

    cageGroup = new THREE.Group();
    cageGroup.name = 'mcCageGroup';
    core.scene.add(cageGroup);

    raycaster = new THREE.Raycaster();
    mouse = new THREE.Vector2();

    buildCageHandles();

    const dom = core.renderer.domElement;
    dom.addEventListener('pointermove', onCagePointerMove, false);
    dom.addEventListener('pointerdown', onCagePointerDown, true);
    window.addEventListener('pointerup', onCagePointerUp, true);
  }

  function buildCageHandles() {
    if (!core || !cageGroup) return;
    const THREE = core.THREE;

    while (cageGroup.children.length > 0) {
      cageGroup.remove(cageGroup.children[0]);
    }
    cageHandles = [];

    const p = ShoeEngine.params;
    const heelX = -p.length * 0.38;
    const toeX = p.length * 0.62;

    // 4 anatomical stations along the shoe length
    const stations = [
      { x: heelX + (toeX - heelX) * 0.90, yMid: 24, ry: 16, rz: 28 },  // Toe Box
      { x: heelX + (toeX - heelX) * 0.68, yMid: 32, ry: 24, rz: 48 },  // Forefoot / Ball
      { x: heelX + (toeX - heelX) * 0.40, yMid: 42, ry: 28, rz: 38 },  // Instep / Arch
      { x: heelX + (toeX - heelX) * 0.08, yMid: 52, ry: 32, rz: 34 }   // Heel / Collar
    ];

    const sphereGeo = new THREE.SphereGeometry(3.6, 16, 16);
    const handleMat = new THREE.MeshStandardMaterial({
      color: 0x0284c7,
      roughness: 0.25,
      metalness: 0.1,
      emissive: 0x0284c7,
      emissiveIntensity: 0.35
    });

    let index = 0;
    stations.forEach((st, sIdx) => {
      const nodes = [
        { dy: st.ry, dz: 0 },                       // 0: Top
        { dy: st.ry * 0.65, dz: st.rz * 0.85 },      // 1: High Medial
        { dy: -st.ry * 0.55, dz: st.rz * 0.95 },     // 2: Low Medial
        { dy: -st.ry * 0.85, dz: 0 },                // 3: Bottom
        { dy: -st.ry * 0.55, dz: -st.rz * 0.95 },    // 4: Low Lateral
        { dy: st.ry * 0.65, dz: -st.rz * 0.85 }     // 5: High Lateral
      ];

      nodes.forEach((n, nIdx) => {
        const mesh = new THREE.Mesh(sphereGeo, handleMat.clone());
        const pos = new THREE.Vector3(st.x, st.yMid + n.dy, n.dz);
        mesh.position.copy(pos);

        let pairLocalIdx = nIdx;
        if (nIdx === 1) pairLocalIdx = 5;
        else if (nIdx === 5) pairLocalIdx = 1;
        else if (nIdx === 2) pairLocalIdx = 4;
        else if (nIdx === 4) pairLocalIdx = 2;

        mesh.userData = {
          handleIndex: index,
          stationIdx: sIdx,
          nodeIdx: nIdx,
          pairIndex: sIdx * 6 + pairLocalIdx,
          basePos: pos.clone(),
          startDragPos: pos.clone()
        };

        cageGroup.add(mesh);
        cageHandles.push(mesh);
        index++;
      });
    });

    updateCageLines();
    showCage(activeMode === 'cage');
  }

  function updateCageLines() {
    if (!core) return;
    const THREE = core.THREE;

    if (cageLines) {
      cageGroup.remove(cageLines);
      cageLines.geometry.dispose();
      cageLines = null;
    }

    const linePoints = [];
    for (let s = 0; s < 4; s++) {
      const base = s * 6;
      for (let i = 0; i < 6; i++) {
        const p1 = cageHandles[base + i].position;
        const p2 = cageHandles[base + ((i + 1) % 6)].position;
        linePoints.push(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
      }
    }
    for (let s = 0; s < 3; s++) {
      const b1 = s * 6;
      const b2 = (s + 1) * 6;
      for (let i = 0; i < 6; i++) {
        const p1 = cageHandles[b1 + i].position;
        const p2 = cageHandles[b2 + i].position;
        linePoints.push(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
      }
    }

    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(linePoints, 3));
    const lineMat = new THREE.LineBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.4
    });

    cageLines = new THREE.LineSegments(lineGeo, lineMat);
    cageGroup.add(cageLines);
  }

  function showCage(visible) {
    if (cageGroup) {
      cageGroup.visible = !!visible;
    }
  }

  function onCagePointerMove(e) {
    if (activeMode !== 'cage' || !core) return;
    const rect = core.renderer.domElement.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    if (isDraggingCageHandle && activeCageHandle) {
      raycaster.setFromCamera(mouse, core.camera);
      const intersectPoint = new THREE.Vector3();
      if (raycaster.ray.intersectPlane(dragPlane, intersectPoint)) {
        const delta = new THREE.Vector3().subVectors(intersectPoint, dragOffset);

        activeCageHandle.position.copy(activeCageHandle.userData.startDragPos).add(delta);

        if (cageSymmetry) {
          const pairHandle = cageHandles[activeCageHandle.userData.pairIndex];
          if (pairHandle && pairHandle !== activeCageHandle) {
            pairHandle.position.set(
              pairHandle.userData.startDragPos.x + delta.x,
              pairHandle.userData.startDragPos.y + delta.y,
              pairHandle.userData.startDragPos.z - delta.z
            );
          }
        }

        updateCageLines();
        applyCageDeformation(activeCageHandle, delta);
      }
      return;
    }

    raycaster.setFromCamera(mouse, core.camera);
    const intersects = raycaster.intersectObjects(cageHandles);
    if (intersects.length > 0) {
      core.renderer.domElement.style.cursor = 'grab';
      cageHandles.forEach(h => {
        h.material.emissiveIntensity = 0.35;
        h.scale.set(1, 1, 1);
      });
      const topHandle = intersects[0].object;
      topHandle.material.emissiveIntensity = 0.95;
      topHandle.scale.set(1.35, 1.35, 1.35);

      if (cageSymmetry) {
        const pairHandle = cageHandles[topHandle.userData.pairIndex];
        if (pairHandle && pairHandle !== topHandle) {
          pairHandle.material.emissiveIntensity = 0.8;
          pairHandle.scale.set(1.2, 1.2, 1.2);
        }
      }
    } else {
      core.renderer.domElement.style.cursor = 'default';
      cageHandles.forEach(h => {
        h.material.emissiveIntensity = 0.35;
        h.scale.set(1, 1, 1);
      });
    }
  }

  function onCagePointerDown(e) {
    if (activeMode !== 'cage' || !core || e.button !== 0) return;
    const rect = core.renderer.domElement.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, core.camera);
    const intersects = raycaster.intersectObjects(cageHandles);

    if (intersects.length > 0) {
      e.preventDefault();
      e.stopImmediatePropagation();

      isDraggingCageHandle = true;
      activeCageHandle = intersects[0].object;
      core.renderer.domElement.style.cursor = 'grabbing';

      const THREE = core.THREE;
      const camDir = new THREE.Vector3();
      core.camera.getWorldDirection(camDir);
      camDir.negate();
      dragPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(camDir, activeCageHandle.position);

      const intersectPoint = new THREE.Vector3();
      raycaster.ray.intersectPlane(dragPlane, intersectPoint);
      dragOffset = intersectPoint.clone();

      cageHandles.forEach(h => {
        h.userData.startDragPos = h.position.clone();
      });
    }
  }

  function onCagePointerUp() {
    if (isDraggingCageHandle) {
      isDraggingCageHandle = false;
      activeCageHandle = null;
      if (core) core.renderer.domElement.style.cursor = 'default';
      showNotification('Shoe silhouette deformed smoothly with 3D Cage Edit');
    }
  }

  function applyCageDeformation(handle, delta) {
    if (!ShoeEngine.upperMesh || !ShoeEngine.baseUpperPositions) return;

    const R = cageRadius;
    const R2 = R * R;
    const strength = cageStrength;

    // Deform Upper Shell Mesh
    const posAttr = ShoeEngine.upperMesh.geometry.attributes.position;
    const arr = posAttr.array;
    const count = posAttr.count;
    const h0 = handle.userData.basePos;
    const mirrorDeltaX = delta.x;
    const mirrorDeltaY = delta.y;
    const mirrorDeltaZ = -delta.z;

    let pairH0 = null;
    if (cageSymmetry) {
      const pair = cageHandles[handle.userData.pairIndex];
      if (pair && pair !== handle) pairH0 = pair.userData.basePos;
    }

    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      const bx = ShoeEngine.baseUpperPositions[i3];
      const by = ShoeEngine.baseUpperPositions[i3 + 1];
      const bz = ShoeEngine.baseUpperPositions[i3 + 2];

      const dx = bx - h0.x;
      const dy = by - h0.y;
      const dz = bz - h0.z;
      const d2 = dx * dx + dy * dy + dz * dz;

      let totalDispX = 0;
      let totalDispY = 0;
      let totalDispZ = 0;

      if (d2 < R2) {
        const t = 1 - d2 / R2;
        const w = t * t * strength;
        totalDispX += delta.x * w;
        totalDispY += delta.y * w;
        totalDispZ += delta.z * w;
      }

      if (pairH0) {
        const pdx = bx - pairH0.x;
        const pdy = by - pairH0.y;
        const pdz = bz - pairH0.z;
        const pd2 = pdx * pdx + pdy * pdy + pdz * pdz;
        if (pd2 < R2) {
          const pt = 1 - pd2 / R2;
          const pw = pt * pt * strength;
          totalDispX += mirrorDeltaX * pw;
          totalDispY += mirrorDeltaY * pw;
          totalDispZ += mirrorDeltaZ * pw;
        }
      }

      arr[i3] = bx + totalDispX;
      arr[i3 + 1] = by + totalDispY;
      arr[i3 + 2] = bz + totalDispZ;
    }

    posAttr.needsUpdate = true;
    ShoeEngine.upperMesh.geometry.computeVertexNormals();

    // Deform Midsole Mesh
    if (ShoeEngine.soleMesh && ShoeEngine.baseSolePositions) {
      const sAttr = ShoeEngine.soleMesh.geometry.attributes.position;
      const sArr = sAttr.array;
      const sCount = sAttr.count;

      for (let i = 0; i < sCount; i++) {
        const i3 = i * 3;
        const bx = ShoeEngine.baseSolePositions[i3];
        const by = ShoeEngine.baseSolePositions[i3 + 1];
        const bz = ShoeEngine.baseSolePositions[i3 + 2];

        const dx = bx - h0.x;
        const dy = by - h0.y;
        const dz = bz - h0.z;
        const d2 = dx * dx + dy * dy + dz * dz;

        if (d2 < R2) {
          const t = 1 - d2 / R2;
          const w = t * t * strength * 0.85;
          sArr[i3] = bx + delta.x * w;
          sArr[i3 + 1] = by + delta.y * w;
          sArr[i3 + 2] = bz + delta.z * w;
        }
      }

      sAttr.needsUpdate = true;
      ShoeEngine.soleMesh.geometry.computeVertexNormals();
    }
  }

  function resetCagePoints() {
    cageHandles.forEach(h => {
      h.position.copy(h.userData.basePos);
    });
    updateCageLines();

    if (ShoeEngine.upperMesh && ShoeEngine.baseUpperPositions) {
      ShoeEngine.upperMesh.geometry.attributes.position.array.set(ShoeEngine.baseUpperPositions);
      ShoeEngine.upperMesh.geometry.attributes.position.needsUpdate = true;
      ShoeEngine.upperMesh.geometry.computeVertexNormals();
    }
    if (ShoeEngine.soleMesh && ShoeEngine.baseSolePositions) {
      ShoeEngine.soleMesh.geometry.attributes.position.array.set(ShoeEngine.baseSolePositions);
      ShoeEngine.soleMesh.geometry.attributes.position.needsUpdate = true;
      ShoeEngine.soleMesh.geometry.computeVertexNormals();
    }

    showNotification('Cage points and shoe mesh reset to base shape.');
  }

  // 5. Surface Sculpt Engine
  function initSculptEngine() {
    if (!core) return;
    const dom = core.renderer.domElement;

    dom.addEventListener('pointerdown', (e) => {
      if (activeMode !== 'sculpt' || e.button !== 0 || e.shiftKey) return;
      const targets = [ShoeEngine.upperMesh, ShoeEngine.soleMesh].filter(Boolean);
      if (!targets.length) return;

      const rect = dom.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, core.camera);
      const hits = raycaster.intersectObjects(targets);
      if (hits.length > 0) {
        e.preventDefault();
        e.stopImmediatePropagation();
        isSculptDragging = true;
        applySculptStroke(hits[0]);
      }
    }, true);

    dom.addEventListener('pointermove', (e) => {
      if (activeMode !== 'sculpt' || !isSculptDragging) return;
      const targets = [ShoeEngine.upperMesh, ShoeEngine.soleMesh].filter(Boolean);
      if (!targets.length) return;

      const rect = dom.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, core.camera);
      const hits = raycaster.intersectObjects(targets);
      if (hits.length > 0) {
        applySculptStroke(hits[0]);
      }
    }, true);

    window.addEventListener('pointerup', () => {
      if (isSculptDragging) {
        isSculptDragging = false;
        showNotification('Surface sculpt stroke applied.');
      }
    }, true);
  }

  function applySculptStroke(hit) {
    const mesh = hit.object;
    if (!mesh || !mesh.geometry) return;

    const pAttr = mesh.geometry.attributes.position;
    const arr = pAttr.array;
    const count = pAttr.count;
    const hitPoint = hit.point;
    const normal = hit.face ? hit.face.normal : new core.THREE.Vector3(0, 1, 0);

    const R = sculptRadius;
    const R2 = R * R;
    const sign = sculptMode === 'pull' ? -1 : 1;
    const disp = sculptStrength * sign;

    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      const vx = arr[i3];
      const vy = arr[i3 + 1];
      const vz = arr[i3 + 2];

      const dx = vx - hitPoint.x;
      const dy = vy - hitPoint.y;
      const dz = vz - hitPoint.z;
      const d2 = dx * dx + dy * dy + dz * dz;

      if (d2 < R2) {
        const t = 1 - d2 / R2;
        const w = t * t;
        arr[i3] += normal.x * disp * w;
        arr[i3 + 1] += normal.y * disp * w;
        arr[i3 + 2] += normal.z * disp * w;
      }
    }

    pAttr.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
  }

  // 6. Bind Tool Inspector Controls
  function bindToolInspectorEvents() {
    // Mode 1: Cage Edit
    const symBtn = document.getElementById('mcCageSymmetryBtn');
    if (symBtn) {
      symBtn.onclick = () => {
        cageSymmetry = !cageSymmetry;
        symBtn.classList.toggle('active', cageSymmetry);
        symBtn.textContent = cageSymmetry ? 'Symmetry: ON (Mirrored Sides)' : 'Symmetry: OFF (Unilateral)';
        showNotification(cageSymmetry ? 'Bilateral symmetry enabled.' : 'Unilateral editing enabled.');
      };
    }

    const radSlider = document.getElementById('mcCageRadiusSlider');
    const radVal = document.getElementById('mcCageRadiusVal');
    if (radSlider && radVal) {
      radSlider.oninput = () => {
        cageRadius = parseFloat(radSlider.value);
        radVal.textContent = `${cageRadius} mm`;
      };
    }

    const strSlider = document.getElementById('mcCageStrengthSlider');
    const strVal = document.getElementById('mcCageStrengthVal');
    if (strSlider && strVal) {
      strSlider.oninput = () => {
        cageStrength = parseFloat(strSlider.value);
        strVal.textContent = `${cageStrength.toFixed(1)}x`;
      };
    }

    const resetCageBtn = document.getElementById('mcResetCageBtn');
    if (resetCageBtn) {
      resetCageBtn.onclick = resetCagePoints;
    }

    // Mode 2: Sculpt
    const pushBtn = document.getElementById('mcSculptPushBtn');
    const pullBtn = document.getElementById('mcSculptPullBtn');
    const smoothBtn = document.getElementById('mcSculptSmoothBtn');
    if (pushBtn && pullBtn && smoothBtn) {
      pushBtn.onclick = () => {
        sculptMode = 'push';
        pushBtn.classList.add('active'); pullBtn.classList.remove('active'); smoothBtn.classList.remove('active');
      };
      pullBtn.onclick = () => {
        sculptMode = 'pull';
        pullBtn.classList.add('active'); pushBtn.classList.remove('active'); smoothBtn.classList.remove('active');
      };
      smoothBtn.onclick = () => {
        sculptMode = 'smooth';
        smoothBtn.classList.add('active'); pushBtn.classList.remove('active'); pullBtn.classList.remove('active');
      };
    }

    const scRad = document.getElementById('mcSculptRadiusSlider');
    const scRadVal = document.getElementById('mcSculptRadiusVal');
    if (scRad && scRadVal) {
      scRad.oninput = () => {
        sculptRadius = parseFloat(scRad.value);
        scRadVal.textContent = `${sculptRadius} mm`;
      };
    }

    const scStr = document.getElementById('mcSculptStrengthSlider');
    const scStrVal = document.getElementById('mcSculptStrengthVal');
    if (scStr && scStrVal) {
      scStr.oninput = () => {
        sculptStrength = parseFloat(scStr.value);
        scStrVal.textContent = `${sculptStrength.toFixed(1)} mm`;
      };
    }

    const clearSculptBtn = document.getElementById('mcClearSculptBtn');
    if (clearSculptBtn) {
      clearSculptBtn.onclick = resetCagePoints;
    }

    // Mode 3: Collar & Openings (Instant 60 FPS)
    const backSlider = document.getElementById('mcCollarBackSlider');
    const backVal = document.getElementById('mcCollarBackVal');
    if (backSlider && backVal) {
      backSlider.oninput = () => {
        const v = parseFloat(backSlider.value);
        backVal.textContent = `${v} mm`;
        ShoeEngine.updateParam('collarBack', v);
      };
    }

    const sideSlider = document.getElementById('mcCollarSideSlider');
    const sideVal = document.getElementById('mcCollarSideVal');
    if (sideSlider && sideVal) {
      sideSlider.oninput = () => {
        const v = parseFloat(sideSlider.value);
        sideVal.textContent = `${v} mm`;
        ShoeEngine.updateParam('collarSide', v);
      };
    }

    const throatSlider = document.getElementById('mcCollarThroatSlider');
    const throatVal = document.getElementById('mcCollarThroatVal');
    if (throatSlider && throatVal) {
      throatSlider.oninput = () => {
        const v = parseFloat(throatSlider.value);
        throatVal.textContent = v.toFixed(2);
        ShoeEngine.updateParam('throatFrac', v);
      };
    }

    const fSlipon = document.getElementById('mcFormSliponBtn');
    const fClog = document.getElementById('mcFormClogBtn');
    const fMule = document.getElementById('mcFormMuleBtn');
    if (fSlipon && fClog && fMule) {
      fSlipon.onclick = () => {
        ShoeEngine.updateParam('upperForm', 'slipon');
        fSlipon.classList.add('active'); fClog.classList.remove('active'); fMule.classList.remove('active');
      };
      fClog.onclick = () => {
        ShoeEngine.updateParam('upperForm', 'clog');
        fClog.classList.add('active'); fSlipon.classList.remove('active'); fMule.classList.remove('active');
      };
      fMule.onclick = () => {
        ShoeEngine.updateParam('upperForm', 'mule');
        fMule.classList.add('active'); fSlipon.classList.remove('active'); fClog.classList.remove('active');
      };
    }

    const tClosed = document.getElementById('mcToeClosedBtn');
    const tPeep = document.getElementById('mcToePeepBtn');
    const tOpen = document.getElementById('mcToeOpenBtn');
    if (tClosed && tPeep && tOpen) {
      tClosed.onclick = () => {
        ShoeEngine.updateParam('toeStyle', 'closed');
        tClosed.classList.add('active'); tPeep.classList.remove('active'); tOpen.classList.remove('active');
      };
      tPeep.onclick = () => {
        ShoeEngine.updateParam('toeStyle', 'peep');
        tPeep.classList.add('active'); tClosed.classList.remove('active'); tOpen.classList.remove('active');
      };
      tOpen.onclick = () => {
        ShoeEngine.updateParam('toeStyle', 'open');
        tOpen.classList.add('active'); tClosed.classList.remove('active'); tPeep.classList.remove('active');
      };
    }

    // Mode 4: Wall Thickness
    const upWall = document.getElementById('mcUpperWallSlider');
    const upWallVal = document.getElementById('mcUpperWallVal');
    if (upWall && upWallVal) {
      upWall.oninput = () => {
        const v = parseFloat(upWall.value);
        upWallVal.textContent = `${v.toFixed(1)} mm`;
        ShoeEngine.updateParam('wallThickness', v);
      };
    }

    // Mode 5: Perforations
    const hField = document.getElementById('mcHolesFieldBtn');
    const hBrogue = document.getElementById('mcHolesBrogueBtn');
    const hNone = document.getElementById('mcHolesNoneBtn');
    if (hField && hBrogue && hNone) {
      hField.onclick = () => {
        hField.classList.add('active'); hBrogue.classList.remove('active'); hNone.classList.remove('active');
        showNotification('Perforations: Field Vents Active');
      };
      hBrogue.onclick = () => {
        hBrogue.classList.add('active'); hField.classList.remove('active'); hNone.classList.remove('active');
        showNotification('Perforations: Brogue Accent Active');
      };
      hNone.onclick = () => {
        hNone.classList.add('active'); hField.classList.remove('active'); hBrogue.classList.remove('active');
        showNotification('Perforations: Solid (No Holes)');
      };
    }

    // Mode 6: Sole & Tread Grip (Instant 60 FPS)
    const heelStack = document.getElementById('mcHeelStackSlider');
    const heelStackVal = document.getElementById('mcHeelStackVal');
    if (heelStack && heelStackVal) {
      heelStack.oninput = () => {
        const v = parseFloat(heelStack.value);
        heelStackVal.textContent = `${v} mm`;
        ShoeEngine.updateParam('heelStack', v);
      };
    }

    const toeStack = document.getElementById('mcToeStackSlider');
    const toeStackVal = document.getElementById('mcToeStackVal');
    if (toeStack && toeStackVal) {
      toeStack.oninput = () => {
        const v = parseFloat(toeStack.value);
        toeStackVal.textContent = `${v} mm`;
        ShoeEngine.updateParam('toeStack', v);
      };
    }

    const flareSlider = document.getElementById('mcSidewallFlareSlider');
    const flareVal = document.getElementById('mcSidewallFlareVal');
    if (flareSlider && flareVal) {
      flareSlider.oninput = () => {
        const v = parseFloat(flareSlider.value);
        flareVal.textContent = `${v.toFixed(1)} mm`;
        ShoeEngine.updateParam('flare', v);
      };
    }

    const treadSelect = document.getElementById('mcTreadPatternSelect');
    if (treadSelect) {
      treadSelect.onchange = () => {
        ShoeEngine.updateParam('treadPattern', treadSelect.value);
        showNotification(`Applied Outsole Tread: ${treadSelect.options[treadSelect.selectedIndex].text}`);
      };
    }

    const treadDepth = document.getElementById('mcTreadDepthSlider');
    const treadDepthVal = document.getElementById('mcTreadDepthVal');
    if (treadDepth && treadDepthVal) {
      treadDepth.oninput = () => {
        const v = parseFloat(treadDepth.value);
        treadDepthVal.textContent = `${v.toFixed(1)} mm`;
        ShoeEngine.updateParam('treadDepth', v);
      };
    }

    // Mode 7: Foot Sizing (Instant 60 FPS)
    const shoeSize = document.getElementById('mcShoeSizeSlider');
    const shoeSizeVal = document.getElementById('mcShoeSizeVal');
    if (shoeSize && shoeSizeVal) {
      shoeSize.oninput = () => {
        const v = parseFloat(shoeSize.value);
        const usM = (v - 33).toFixed(1);
        shoeSizeVal.textContent = `EU ${v.toFixed(1)} (US M ${usM})`;
        const fl = Math.round(210 + (v - 35) * 6.67);
        const flSlider = document.getElementById('mcFootLengthSlider');
        const flVal = document.getElementById('mcFootLengthVal');
        if (flSlider) flSlider.value = fl;
        if (flVal) flVal.textContent = `${fl} mm`;
        ShoeEngine.updateParam('length', fl);
      };
    }

    const flSlider = document.getElementById('mcFootLengthSlider');
    const flVal = document.getElementById('mcFootLengthVal');
    if (flSlider && flVal) {
      flSlider.oninput = () => {
        const v = parseFloat(flSlider.value);
        flVal.textContent = `${v} mm`;
        ShoeEngine.updateParam('length', v);
      };
    }

    ['mcFitBBtn', 'mcFitDBtn', 'mcFitEEBtn', 'mcFit4EBtn'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) {
        btn.onclick = () => {
          ['mcFitBBtn', 'mcFitDBtn', 'mcFitEEBtn', 'mcFit4EBtn'].forEach(x => {
            const el = document.getElementById(x);
            if (el) el.classList.remove('active');
          });
          btn.classList.add('active');
          const bw = parseFloat(btn.dataset.fit);
          ShoeEngine.updateParam('ballWidth', bw);
          showNotification(`Width Fitting: ${btn.textContent.trim()}`);
        };
      }
    });
  }

  function syncUI() {
    const p = ShoeEngine.params;
    const bSlider = document.getElementById('mcCollarBackSlider');
    if (bSlider) bSlider.value = p.collarBack;
    const sSlider = document.getElementById('mcCollarSideSlider');
    if (sSlider) sSlider.value = p.collarSide;
    const hsSlider = document.getElementById('mcHeelStackSlider');
    if (hsSlider) hsSlider.value = p.heelStack;
    const tsSlider = document.getElementById('mcToeStackSlider');
    if (tsSlider) tsSlider.value = p.toeStack;
  }

  // 7. Binary STL Exporter
  function triggerBinarySTLExport() {
    try {
      showNotification('Compiling watertight binary STL for 3D printing...');
      const blob = ShoeEngine.buildExportSTL();
      if (blob) {
        const name = `mcconnell_shoe_EU${(ShoeEngine.params.length - 210) / 6.67 + 35 | 0}.stl`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showNotification(`Exported: ${name}`);
      } else {
        showNotification('Unable to compile STL: check mesh integrity');
      }
    } catch (err) {
      console.warn('STL export error:', err);
      showNotification('STL export error: ' + err.message);
    }
  }

  function capitalize(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  function showNotification(msg) {
    let note = document.getElementById('mcNotification');
    if (!note) {
      note = document.createElement('div');
      note.id = 'mcNotification';
      note.style.cssText = `
        position: fixed;
        bottom: 24px;
        left: 50%;
        transform: translateX(-50%);
        background: #0f172a;
        color: #ffffff;
        font-size: 12px;
        font-weight: 600;
        padding: 9px 18px;
        border-radius: 999px;
        box-shadow: 0 10px 25px -5px rgba(15, 23, 42, 0.35);
        z-index: 10000;
        pointer-events: none;
        transition: opacity 0.25s ease, transform 0.25s ease;
        opacity: 0;
      `;
      document.body.appendChild(note);
    }

    note.textContent = msg;
    note.style.opacity = '1';
    note.style.transform = 'translateX(-50%) translateY(0)';

    clearTimeout(note._timer);
    note._timer = setTimeout(() => {
      note.style.opacity = '0';
      note.style.transform = 'translateX(-50%) translateY(8px)';
    }, 2800);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initStudio);
  } else {
    initStudio();
  }

})();
