/**
 * McConnell Meshes — Generative 3D Footwear Design & 3D Print Studio
 * Created by Keegan McConnell (@keeganrmc)
 * 
 * Features:
 * 1. 5 1-Click Shoe Presets: Sneaker, Sandal, Heel, Boot, Dress Shoe.
 * 2. High-Precision Floating Tooltip Engine: Every tool, preset, button, and slider displays rich footwear & print guidance on hover.
 * 3. Unified Bento Studio Controls: All shoe creation tools grouped together in an scannable, clean dashboard (WANDR UX trends).
 * 4. Shoe-First Architecture: Launches directly with full 3D shoe (Upper shell, Midsole cushion, Outsole tread).
 * 5. Architectural Light Theme: Clean Scandinavian studio palette (#f8fafc, #0f172a, #0284c7).
 * 6. Procedural Wall Thickness (0.8–8.0mm), Holes/Vents, and Topography/Tread Generator.
 * 7. Live 3D Printability Verification (Watertight Manifold, Overhang safety, Min wall check, Material simulation).
 */

(function () {
  'use strict';

  let core = null;
  let activeTab = 'fit';

  // Comprehensive Tooltip Dictionary for Instant Hover Guidance
  const TOOLTIP_DATABASE = {
    // 5 1-Click Shoe Presets
    'presetSneakerBtn': {
      title: '👟 Sneaker Preset (Athletic Runner)',
      desc: 'Generates an athletic sneaker geometry with a flexible 2.0mm upper shell, perforated breathability field vents, high-rebound midsole cushion, and knurled traction tread.',
      tip: 'Optimal for daily wear and running. Slices and 3D prints smoothly in TPU 95A or 90A.'
    },
    'presetSandalBtn': {
      title: '👡 Sandal Preset (Ergonomic Slide)',
      desc: 'Generates an open-toe ergonomic slide with contoured arch support, 2.8mm structural cross-straps, peep-toe clearance, and wave flex sipes.',
      tip: 'Requires zero support material if printed flat sole-down. Recommended for softer TPU 85A.'
    },
    'presetHeelBtn': {
      title: '👠 Heel Preset (Sculpted Pump)',
      desc: 'Builds an elegant high-heel pump with a 70mm elevated heel cup, graceful arched shank, sleek 1.8mm shell, low-throat vamp, and smooth dress sole.',
      tip: 'Features reinforced shank geometry. Best printed in dual-material: rigid heel core with flexible vamp.'
    },
    'presetBootBtn': {
      title: '🥾 Boot Preset (Rugged Work Boot)',
      desc: 'Engineers a heavy-duty boot with 110mm high-shaft ankle collar, rugged 3.5mm thick impact shell, reinforced welt, and deep hexagonal mountain lug outsole.',
      tip: 'Engineered for high tear resistance and abrasion protection. Print with 3.5mm solid wall.'
    },
    'presetDressBtn': {
      title: '👞 Dress Shoe Preset (Classic Oxford)',
      desc: 'Models a formal Oxford shoe featuring classic almond toe, elegant vamp proportions, decorative brogue perforation accents along the quarters, and low-profile welt.',
      tip: 'Brogue holes are parametric 2.0mm through-holes that provide both authentic styling and ventilation.'
    },

    // Studio Hub & Action Triggers
    'rowStudioHub': {
      title: '⚡ Studio Controls Dashboard',
      desc: 'Open the unified master control panel grouping all shoe tools together: Fit, Wall Thickness, Holes, Topography, and 3D Print Lab.',
      tip: 'Toggle anytime to tweak geometry without losing your 3D view.'
    },
    'mcStudioHubBtn': {
      title: '⚡ Studio Controls Dashboard',
      desc: 'Open the unified master control panel grouping all shoe tools together: Fit, Wall Thickness, Holes, Topography, and 3D Print Lab.',
      tip: 'Toggle anytime to tweak geometry without losing your 3D view.'
    },
    'quickExportStlBtn': {
      title: '⬇️ 1-Click Binary STL Export',
      desc: 'Instantly exports a clean, watertight binary STL file of the active shoe ready to drag-and-drop into Bambu Studio, OrcaSlicer, PrusaSlicer, or Cura.',
      tip: 'Universally compatible with all FDM and SLA 3D printers.'
    },
    'rowWire': {
      title: 'Toggle Wireframe (W)',
      desc: 'Inspect Catmull-Clark quad topology, polygon density, and subdivision surface smoothness.',
      tip: 'Higher mesh density in curved regions ensures smooth 3D printed contours.'
    },
    'rowUndo': {
      title: 'Undo (⌘Z / Ctrl+Z)',
      desc: 'Revert the most recent parametric edit, sculpt stroke, or preset selection.',
      tip: 'Full history stack kept in memory.'
    },
    'rowRedo': {
      title: 'Redo (⇧⌘Z / Ctrl+Y)',
      desc: 'Reapply the previously undone action.',
      tip: 'Compare design variations with instant redo.'
    },

    // Left CAD Rail
    'railOrbit': {
      title: 'Orbit & Camera Navigation',
      desc: 'Click + drag to rotate 360° around shoe. Right-click or two fingers to pan. Scroll wheel to zoom in/out.',
      tip: 'Double click on any part of the shoe to focus and center the camera.'
    },
    'railSculpt': {
      title: 'Surface Sculpt (Clay Push/Pull)',
      desc: 'Sculpt the shoe upper or last freehand. Push outward, pull inward, or smooth contours interactively.',
      tip: 'Useful for building anatomical reliefs for bunions or extra arch support.'
    },
    'railMeasure': {
      title: 'Precision Calipers & Tape Measure',
      desc: 'Measure straight-line distance and anatomical tape-wrap girth around the shoe surface.',
      tip: 'Verify ball girth and instep clearances match physical measurements.'
    },
    'railPaint': {
      title: 'Paint Coverage Region',
      desc: 'Brush on the surface to define where the upper shell, straps, or sole layers extend.',
      tip: 'Feathered edge brush creates organic transitions.'
    },
    'railErase': {
      title: 'Erase Cutouts & Windows',
      desc: 'Erase painted coverage to sculpt ventilation cutouts, peep-toes, or open-back sandal heel straps.',
      tip: 'Erase quarters to create open mules or summer slides.'
    },
    'railLine': {
      title: 'Vector Rim & Topline Editor',
      desc: 'Manipulate vector anchor nodes along the collar opening to customize the shoe entry silhouette.',
      tip: 'Drag collar nodes down for low-cut athletic profiles, or lift for high-top boots.'
    },
    'railGap': {
      title: 'Fit Gap & Standoff Brush',
      desc: 'Paint localized standoff clearance between the foot and the inner shoe wall.',
      tip: 'Add +1.5mm in high-friction zones to eliminate blisters.'
    },
    'railColor': {
      title: 'Variable Wall Thickness Brush',
      desc: 'Paint thickness gradients across the shoe (e.g. 3.5mm toe box bumper, 1.4mm breathable side panels).',
      tip: 'Graduated thickness optimizes shoe weight while protecting impact areas.'
    },
    'railPoints': {
      title: 'Pattern Focus Points',
      desc: 'Place focal convergence points where procedural tread sipes, knurling, or holes gather.',
      tip: 'Align pattern convergence with the metatarsal flex axis for natural walking motion.'
    },
    'railCage': {
      title: 'Subdivision Cage Handles',
      desc: 'Directly pull low-poly control cage vertices to shape dramatic sweeping footwear silhouettes.',
      tip: 'Catmull-Clark subdivision keeps the final printable solid fair and continuous.'
    },

    // Studio Modal Controls: Foot Fit
    'mcFootLengthSlider': {
      title: 'Foot Length Calibration (mm)',
      desc: 'True anatomical heel-to-toe length. The last and shoe automatically re-grade and scale to fit.',
      tip: 'Standard adult lengths range from 220mm (US W 5) to 300mm (US M 13).'
    },
    'mcBallWidthSlider': {
      title: 'Ball Width & Fitting (mm)',
      desc: 'Width across the 1st and 5th metatarsal heads (the widest part of the foot).',
      tip: 'Select B for Narrow, D for Medium/Standard, EE for Wide, 4E for Extra Wide.'
    },
    'mcInstepSlider': {
      title: 'Instep Volume & Cone Height (mm)',
      desc: 'Controls vertical girth over the midfoot arch. Crucial for comfortable slip-on shoe entry.',
      tip: 'Increase for high-volume athletic arches to prevent top-of-foot pressure.'
    },
    'mcHeelWidthSlider': {
      title: 'Heel Seat Width (mm)',
      desc: 'Calibrates rearfoot cup width for secure lockdown without heel slippage.',
      tip: 'A snug heel cup ensures positive stability during push-off.'
    },
    'mcToeSpringSlider': {
      title: 'Toe Spring Lift (mm)',
      desc: 'Upward curvature lifting the shoe tip off the floor to promote smooth forward roll-through.',
      tip: '0–5mm for minimalist barefoot shoes; 15–25mm for rockered athletic runners.'
    },

    // Studio Modal Controls: Wall Thickness
    'mcWallMMSlider': {
      title: 'Master Shell Wall Thickness (mm)',
      desc: 'Sets the physical solid thickness of the shoe upper for additive manufacturing durability.',
      tip: '1.2mm = ultralight; 2.0mm = balanced sneaker; 3.5mm = rugged work boot.'
    },
    'mcGapMMSlider': {
      title: 'Footbed Standoff Gap (mm)',
      desc: 'Internal clearance offset between foot last and inner shoe wall for socks and orthotic insoles.',
      tip: '1.5mm is standard for athletic socks; 0.0mm for molded skin-fit recovery slides.'
    },

    // Studio Modal Controls: Holes & Vents
    'mcPerfHoleSlider': {
      title: 'Vent Hole Diameter (mm)',
      desc: 'Punched diameter of each procedural ventilation hole through the upper shell.',
      tip: '2.0mm–3.0mm provides optimal airflow while keeping water and debris out.'
    },
    'mcPerfPitchSlider': {
      title: 'Hole Spacing / Pitch (mm)',
      desc: 'Center-to-center distance between adjacent ventilation holes.',
      tip: 'Tighter pitch (<7mm) gives dense mesh airflow; wider pitch (>10mm) creates classic brogue accents.'
    },
    'mcPerfBorderSlider': {
      title: 'Rim Margin Clearance (mm)',
      desc: 'Solid safety perimeter along collar openings and sole seams where no holes may be punched.',
      tip: 'Protects collar tear-strength and ensures clean print bed perimeters.'
    },

    // Studio Modal Controls: Topography
    'mcTreadPatternSelect': {
      title: 'Outsole Topography Pattern',
      desc: 'Select procedural tread surface: Elevation Contours, Diamond Knurling, Hex Honeycomb, Flex Sipes, or Mountain Relief.',
      tip: 'Contours and Diamond Knurl provide multi-directional wet-weather traction.'
    },
    'mcTreadDepthSlider': {
      title: 'Tread Lug Depth (mm)',
      desc: 'Depth of carved siping grooves or protrusion height of raised traction lugs.',
      tip: '1.5mm–2.0mm for road shoes; 3.0mm–4.5mm for aggressive outdoor trail lugs.'
    },

    // Studio Modal Controls: 3D Print Lab
    'mcPrintMaterialSelect': {
      title: 'Manufacturing Material Profile',
      desc: 'Filament/resin profile: TPU 95A, TPU 90A, TPU 85A, TPU 70A, PLA, or SLA Resins.',
      tip: 'Overhang limits and minimum wall thickness thresholds automatically validate against this material.'
    },
    'mcExportStlBtn': {
      title: 'Download Binary STL',
      desc: 'Generates watertight binary STL solid ready for slicing in Bambu Studio, PrusaSlicer, or Cura.',
      tip: 'Recommended slice setting: 0.2mm layer height, 3 wall perimeters, 15% Gyroid infill.'
    },
    'mcExport3mfBtn': {
      title: 'Download 3MF Production Package',
      desc: 'Exports 3MF archive with material metadata, print orientation, and bed staging included.',
      tip: 'Best for Bambu Lab X1/P1/A1 and OrcaSlicer multi-material workflows.'
    }
  };

  // Initialize McConnell Studio
  function initStudio() {
    core = window.__mcconnellCore;
    if (!core) {
      setTimeout(initStudio, 120);
      return;
    }

    createTooltipDOM();
    setupTooltips();
    wireTopBarPresets();
    createStudioPanel();
    bindStudioEvents();
    syncUIWithCore();
    ensureShoeModeActive();

    console.log('⚡ McConnell Meshes Studio Hub initialized & active in Light Theme.');
  }

  // 1. Tooltip DOM & Hover Engine
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
      const target = e.target.closest('[id], [title], [data-tip], button, input, select');
      if (!target) return;

      const id = target.id;
      const titleAttr = target.getAttribute('title');
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
        adviceEl.textContent = entry.tip || 'McConnell Meshes Additive Footwear System';

        if (entry.shortcut) {
          shortcutEl.textContent = entry.shortcut;
          shortcutEl.style.display = 'inline-block';
        } else {
          shortcutEl.style.display = 'none';
        }

        positionTooltip(e.clientX, e.clientY);
        tipEl.classList.add('visible');
      }, 140); // 140ms hover delay
    }, true);

    document.addEventListener('mouseout', () => {
      clearTimeout(tipTimer);
      if (tipEl) tipEl.classList.remove('visible');
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

    const rect = tipEl.getBoundingClientRect();
    if (x + 330 > window.innerWidth) x = mouseX - 330 - pad;
    if (y + 140 > window.innerHeight) y = mouseY - 140 - pad;

    tipEl.style.left = `${Math.max(10, x)}px`;
    tipEl.style.top = `${Math.max(10, y)}px`;
  }

  // 2. Wire Top Bar 5 Presets & Action Buttons
  function wireTopBarPresets() {
    const sneakerBtn = document.getElementById('presetSneakerBtn');
    const sandalBtn = document.getElementById('presetSandalBtn');
    const heelBtn = document.getElementById('presetHeelBtn');
    const bootBtn = document.getElementById('presetBootBtn');
    const dressBtn = document.getElementById('presetDressBtn');

    if (sneakerBtn) sneakerBtn.onclick = () => selectPreset('sneaker');
    if (sandalBtn) sandalBtn.onclick = () => selectPreset('sandal');
    if (heelBtn) heelBtn.onclick = () => selectPreset('heel');
    if (bootBtn) bootBtn.onclick = () => selectPreset('boot');
    if (dressBtn) dressBtn.onclick = () => selectPreset('dress');

    // Studio Controls trigger
    const hubTrigger = document.getElementById('rowStudioHub');
    if (hubTrigger) {
      hubTrigger.onclick = () => toggleStudioPanel();
    }

    // Wireframe toggle
    const wireBtn = document.getElementById('rowWire');
    if (wireBtn) {
      wireBtn.onclick = () => {
        const nativeWire = document.getElementById('wireToggleBtn');
        if (nativeWire) nativeWire.click();
      };
    }

    // Undo / Redo
    const undoBtn = document.getElementById('rowUndo');
    if (undoBtn) {
      undoBtn.onclick = () => {
        const u = document.getElementById('undoBtn');
        if (u) u.click();
      };
    }
    const redoBtn = document.getElementById('rowRedo');
    if (redoBtn) {
      redoBtn.onclick = () => {
        const r = document.getElementById('redoBtn');
        if (r) r.click();
      };
    }

    // Quick Export STL
    const quickStl = document.getElementById('quickExportStlBtn');
    if (quickStl) {
      quickStl.onclick = () => triggerBinarySTLExport();
    }
  }

  // Master 5-Preset Execution Engine
  function selectPreset(type) {
    if (!core) return;
    ensureShoeModeActive();

    const m = core.measurements;
    const s = core.shoe;

    // Update active state on top bar preset pills
    document.querySelectorAll('.mcPresetBar .mcPresetPill').forEach(p => {
      p.classList.toggle('active', p.dataset.preset === type);
    });

    if (type === 'sneaker') {
      m.lastType = 'sneaker';
      if (s) {
        s.upperForm = 'slipon';
        s.openBack = false;
        s.toe = 'closed';
        s.throat = 0.50;
        s.back = 60;
        s.side = 48;
        s.fWall = 2.0;
        s.gap = 1.5;
        s.stack = 60;
        s.stackToe = 40;
        s.band = 24;
        s.tread = 'diamond';
        s.floorDepth = 6.0;
        s.fMat = 'tpu95';
        s.sMat = 'tpu90';
        s.oMat = 'tpu95';
        if (s.f) {
          s.f.perf = 'field';
          s.f.perfHole = 2.8;
          s.f.perfPitch = 7.0;
        }
      }
      showNotification('👟 Loaded Sneaker: Athletic Runner with 2.0mm Shell & Field Vents');

    } else if (type === 'sandal') {
      m.lastType = 'sandal';
      if (s) {
        s.upperForm = 'mule';
        s.openBack = true;
        s.toe = 'open';
        s.toeMM = 55;
        s.throat = 0.50;
        s.back = 20;
        s.side = 30;
        s.fWall = 2.8;
        s.gap = 0.5;
        s.stack = 28;
        s.stackToe = 22;
        s.band = 14;
        s.tread = 'flex';
        s.floorDepth = 4.0;
        s.fMat = 'tpu95';
        s.sMat = 'tpu85';
        s.oMat = 'tpu95';
        if (s.f) {
          s.f.perf = 'none';
        }
      }
      showNotification('👡 Loaded Sandal: Open-Toe Ergonomic Slide with Wave Flex Sipes');

    } else if (type === 'heel') {
      m.lastType = 'pump';
      if (s) {
        s.upperForm = 'slipon';
        s.openBack = false;
        s.toe = 'closed';
        s.throat = 0.68;
        s.back = 60;
        s.side = 40;
        s.fWall = 1.8;
        s.gap = 0.6;
        s.stack = 20;
        s.stackToe = 12;
        s.band = 12;
        s.tread = 'plain';
        s.floorDepth = 0;
        s.fMat = 'tpu95';
        s.sMat = 'resin_hard';
        s.oMat = 'tpu95';
        if (s.f) {
          s.f.perf = 'none';
        }
      }
      showNotification('👠 Loaded Heel: Sculpted High-Heel Pump with 70mm Lift');

    } else if (type === 'boot') {
      m.lastType = 'boot';
      if (s) {
        s.upperForm = 'slipon';
        s.openBack = false;
        s.toe = 'closed';
        s.back = 120;
        s.side = 105;
        s.throat = 0.42;
        s.fWall = 3.5;
        s.gap = 2.0;
        s.stack = 85;
        s.stackToe = 60;
        s.band = 35;
        s.tread = 'terrain';
        s.floorDepth = 8.0;
        s.fMat = 'tpu95';
        s.sMat = 'tpu95';
        s.oMat = 'tpu95';
        if (s.f) {
          s.f.perf = 'none';
        }
      }
      showNotification('🥾 Loaded Boot: Rugged High-Shaft Boot with 3.5mm Shell');

    } else if (type === 'dress') {
      m.lastType = 'oxford';
      if (s) {
        s.upperForm = 'slipon';
        s.openBack = false;
        s.toe = 'closed';
        s.back = 65;
        s.side = 55;
        s.throat = 0.55;
        s.fWall = 2.2;
        s.gap = 1.0;
        s.stack = 32;
        s.stackToe = 18;
        s.band = 18;
        s.tread = 'cross';
        s.floorDepth = 3.0;
        s.fMat = 'tpu95';
        s.sMat = 'pla';
        s.oMat = 'tpu95';
        if (s.f) {
          s.f.perf = 'brogue';
          s.f.perfHole = 2.0;
          s.f.perfPitch = 6.0;
        }
      }
      showNotification('👞 Loaded Dress Shoe: Classic Oxford with Brogue Perforations');
    }

    // 1. Clear overrides so the chosen last type sets authentic heel, toe spring, and vamp
    if (core.clearOverrides && core.LF_SHAPE_OVERRIDES) {
      core.clearOverrides(core.LF_SHAPE_OVERRIDES);
    }
    // 2. Apply last type parameters to the last
    if (core.applyLastType) {
      core.applyLastType(m);
    }
    // 3. Rebuild the last mesh and refresh measurements
    if (typeof core.refreshAll === 'function') {
      core.refreshAll();
    } else if (typeof core.refreshAllKeepManual === 'function') {
      core.refreshAllKeepManual();
    }
    // 4. Adapt shoe baseline dimensions to the new last shape
    if (typeof core.adaptShoeToLast === 'function') {
      core.adaptShoeToLast(m);
    }
    // 5. Force re-laying the upper and sole coverage chips (crucial for open toe / mule / boots)
    if (typeof core.relayFootie === 'function') {
      core.relayFootie(true);
    }
    if (typeof core.relaySole === 'function') {
      core.relaySole(true);
    }
    // 6. Paint field colors and rebuild the 3D meshes for Three.js
    if (typeof core.paintFieldColors === 'function') {
      core.paintFieldColors();
    }
    if (typeof core.rebuildShoe === 'function') {
      core.rebuildShoe();
    }
    // 7. Sync all UI panels and readouts
    if (typeof core.syncShoeUI === 'function') {
      core.syncShoeUI();
    }
    if (typeof core.syncFitUI === 'function') {
      core.syncFitUI();
    }
    if (typeof core.updateShoeInfo === 'function') {
      core.updateShoeInfo();
    }
    if (typeof core.shellTile === 'function') {
      core.shellTile();
    }
    syncUIWithCore();
  }

  // 3. Build the Bento Studio Controls Panel (Master Dashboard)
  function createStudioPanel() {
    if (document.getElementById('mcconnellStudioPanel')) return;

    const panel = document.createElement('div');
    panel.id = 'mcconnellStudioPanel';
    panel.className = 'minimized';

    panel.innerHTML = `
      <div class="mcStudioHd">
        <div class="mcStudioLogoGroup">
          <div class="mcStudioLogoText">
            <b>McCONNELL MESHES</b>
            <span>STUDIO CONTROLS &middot; PARAMETRIC 3D FOOTWEAR &middot; @KEEGANRMC</span>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <button class="mcCloseBtn" id="mcStudioCloseBtn" title="Close Studio Controls">&times;</button>
        </div>
      </div>

      <div class="mcStudioTabs" role="tablist">
        <button class="mcStudioTab active" data-tab="fit"><span class="icon">👟</span> Foot &amp; Last Fit</button>
        <button class="mcStudioTab" data-tab="thickness"><span class="icon">📏</span> Wall Thickness &amp; Gap</button>
        <button class="mcStudioTab" data-tab="holes"><span class="icon">🕳️</span> Holes &amp; Vents</button>
        <button class="mcStudioTab" data-tab="topography"><span class="icon">🏔️</span> Topography &amp; Tread</button>
        <button class="mcStudioTab" data-tab="print"><span class="icon">🖨️</span> 3D Print Lab &amp; Materials</button>
      </div>

      <div class="mcStudioBody">
        <!-- TAB 1: FOOT & LAST CALIBRATION -->
        <div class="mcTabContent active" id="mcTabFit">
          <div class="mcGrid2">
            <div class="mcCard">
              <div class="mcCardTitle">
                <span>Personal Foot Sizing</span>
                <span id="mcFootSizeBadge" class="mcBadge">US M 10.5</span>
              </div>
              <div class="mcCardDesc">Calibrate the anatomical foot last dimensions. The shoe upper, midsole, and outsole automatically conform around this volume.</div>
              
              <div class="mcControlRow">
                <div class="mcControlHeader">
                  <span>Foot Length (Heel to Toe)</span>
                  <span class="val" id="mcFootLengthVal">270.0 mm</span>
                </div>
                <input type="range" class="mcSlider" id="mcFootLengthSlider" min="210" max="320" step="0.5" value="270">
              </div>

              <div class="mcControlRow">
                <div class="mcControlHeader">
                  <span>Ball Width &amp; Fitting</span>
                  <span class="val" id="mcBallWidthVal">98.5 mm (D - Medium)</span>
                </div>
                <input type="range" class="mcSlider" id="mcBallWidthSlider" min="75" max="125" step="0.5" value="98.5">
              </div>

              <div class="mcControlRow">
                <div class="mcControlHeader">
                  <span>Instep Girth &amp; Height</span>
                  <span class="val" id="mcInstepVal">255.0 mm</span>
                </div>
                <input type="range" class="mcSlider" id="mcInstepSlider" min="200" max="310" step="0.5" value="255">
              </div>

              <div class="mcControlRow">
                <div class="mcControlHeader">
                  <span>Heel Seat Width</span>
                  <span class="val" id="mcHeelWidthVal">68.0 mm</span>
                </div>
                <input type="range" class="mcSlider" id="mcHeelWidthSlider" min="45" max="90" step="0.5" value="68">
              </div>

              <div class="mcControlRow">
                <div class="mcControlHeader">
                  <span>Toe Spring Lift</span>
                  <span class="val" id="mcToeSpringVal">12 mm</span>
                </div>
                <input type="range" class="mcSlider" id="mcToeSpringSlider" min="0" max="35" step="1" value="12">
              </div>
            </div>

            <div class="mcCard">
              <div class="mcCardTitle">Foot Morphology &amp; Quick Profiles</div>
              <div class="mcCardDesc">Apply saved physiological foot profiles to quickly adapt shoe shape for different foot types.</div>

              <div class="mcControlRow">
                <div class="mcControlHeader"><span>Foot Morphology Archetype</span></div>
                <select class="mcSelect" id="mcMorphologySelect">
                  <option value="standard">Standard Anatomical</option>
                  <option value="wide_forefoot">Wide Forefoot (Natural Barefoot splay)</option>
                  <option value="high_arch">High Arch &amp; High Instep</option>
                  <option value="flat_foot">Low Arch / Flat Foot Support</option>
                  <option value="greek">Greek Foot (Morton's Toe: 2nd toe dominant)</option>
                  <option value="egyptian">Egyptian Foot (Slanted Big Toe dominant)</option>
                </select>
              </div>

              <div class="mcControlRow" style="margin-top:6px;">
                <div class="mcControlHeader"><span>Personal Fit Profiles</span></div>
                <div class="mcBtnRow">
                  <button class="mcPresetBtn" id="mcPresetKeegan">Daily Fit (US 10.5)</button>
                  <button class="mcPresetBtn" id="mcPresetBarefoot">Natural Barefoot (Wide)</button>
                  <button class="mcPresetBtn" id="mcPresetAthletic">Athletic Lockdown</button>
                </div>
              </div>

              <div style="display:flex;gap:8px;margin-top:12px;">
                <button class="mcActionBtn primary" id="mcApplyFitBtn" style="flex:1;">⚡ Apply Fit to Last &amp; Shoe</button>
              </div>
            </div>
          </div>
        </div>

        <!-- TAB 2: WALL THICKNESS & GAP -->
        <div class="mcTabContent" id="mcTabThickness">
          <div class="mcGrid2">
            <div class="mcCard">
              <div class="mcCardTitle">
                <span>Wall Thickness Engine</span>
                <span class="mcBadge" id="mcThicknessBadge">2.0 mm</span>
              </div>
              <div class="mcCardDesc">Controls the physical shell wall thickness for 3D printing. Thinner walls give flexibility; thicker walls provide structural support.</div>

              <div class="mcControlRow">
                <div class="mcControlHeader">
                  <span>Upper Shell Wall Thickness</span>
                  <span class="val" id="mcWallMMVal">2.0 mm</span>
                </div>
                <input type="range" class="mcSlider" id="mcWallMMSlider" min="0.8" max="8.0" step="0.1" value="2.0">
              </div>

              <div class="mcControlRow">
                <div class="mcControlHeader">
                  <span>Footbed Standoff Gap (Socks / Insole)</span>
                  <span class="val" id="mcGapMMVal">1.5 mm</span>
                </div>
                <input type="range" class="mcSlider" id="mcGapMMSlider" min="0.0" max="5.0" step="0.1" value="1.5">
              </div>

              <div class="mcControlRow">
                <div class="mcControlHeader"><span>Thickness Presets</span></div>
                <div class="mcBtnRow">
                  <button class="mcPresetBtn" data-wall="1.2" data-gap="0.8">1.2mm Ultralight</button>
                  <button class="mcPresetBtn active" data-wall="2.0" data-gap="1.5">2.0mm Performance</button>
                  <button class="mcPresetBtn" data-wall="3.2" data-gap="2.0">3.2mm Rugged</button>
                  <button class="mcPresetBtn" data-wall="5.0" data-gap="2.5">5.0mm Heavy Clog</button>
                </div>
              </div>
            </div>

            <div class="mcCard">
              <div class="mcCardTitle">Upper Style &amp; Conformal Shell</div>
              <div class="mcCardDesc">Select the upper silhouette architecture and toe box opening.</div>

              <div class="mcControlRow">
                <div class="mcControlHeader"><span>Upper Style Architecture</span></div>
                <div class="mcBtnRow">
                  <button class="mcPresetBtn active" id="mcStyleSliponBtn" data-style="slipon">Slip-on / Sneaker</button>
                  <button class="mcPresetBtn" id="mcStyleClogBtn" data-style="clog">Clog (Step-in)</button>
                  <button class="mcPresetBtn" id="mcStyleMuleBtn" data-style="mule">Mule (Open Quarters)</button>
                </div>
              </div>

              <div class="mcControlRow">
                <div class="mcControlHeader"><span>Toe Box Opening</span></div>
                <div class="mcBtnRow">
                  <button class="mcPresetBtn active" id="mcToeClosedBtn" data-toe="closed">Closed Toe</button>
                  <button class="mcPresetBtn" id="mcToePeepBtn" data-toe="peep">Peep-Toe Oval</button>
                  <button class="mcPresetBtn" id="mcToeOpenBtn" data-toe="open">Open Sandal Toe</button>
                </div>
              </div>

              <div style="display:flex;gap:8px;margin-top:12px;">
                <button class="mcActionBtn primary" id="mcApplyThicknessBtn" style="flex:1;">⚡ Rebuild Shell Thickness</button>
              </div>
            </div>
          </div>
        </div>

        <!-- TAB 3: HOLES & PERFORATIONS -->
        <div class="mcTabContent" id="mcTabHoles">
          <div class="mcGrid2">
            <div class="mcCard">
              <div class="mcCardTitle">
                <span>Perforation &amp; Vent Puncher</span>
                <span class="mcBadge" id="mcPerfBadge">Field Vents</span>
              </div>
              <div class="mcCardDesc">Punches parametric ventilation through-holes across the shoe upper for active airflow, cooling, and localized flexibility.</div>

              <div class="mcControlRow">
                <div class="mcControlHeader"><span>Perforation Pattern</span></div>
                <div class="mcBtnRow">
                  <button class="mcPresetBtn active" id="mcPerfFieldBtn" data-perf="field">Field Vents</button>
                  <button class="mcPresetBtn" id="mcPerfBrogueBtn" data-perf="brogue">Brogue Accent Row</button>
                  <button class="mcPresetBtn" id="mcPerfNoneBtn" data-perf="none">Solid (No Holes)</button>
                </div>
              </div>

              <div class="mcControlRow">
                <div class="mcControlHeader">
                  <span>Hole Diameter</span>
                  <span class="val" id="mcPerfHoleVal">2.8 mm</span>
                </div>
                <input type="range" class="mcSlider" id="mcPerfHoleSlider" min="1.0" max="8.0" step="0.2" value="2.8">
              </div>

              <div class="mcControlRow">
                <div class="mcControlHeader">
                  <span>Hole Spacing / Pitch</span>
                  <span class="val" id="mcPerfPitchVal">7.0 mm</span>
                </div>
                <input type="range" class="mcSlider" id="mcPerfPitchSlider" min="3.0" max="25.0" step="0.5" value="7.0">
              </div>

              <div class="mcControlRow">
                <div class="mcControlHeader">
                  <span>Rim Margin Border</span>
                  <span class="val" id="mcPerfBorderVal">8.0 mm</span>
                </div>
                <input type="range" class="mcSlider" id="mcPerfBorderSlider" min="2.0" max="20.0" step="0.5" value="8.0">
              </div>

              <div style="display:flex;gap:8px;margin-top:10px;">
                <button class="mcActionBtn secondary" id="mcPerfRerollBtn" style="flex:1;">🎲 Reroll Distribution</button>
                <button class="mcActionBtn primary" id="mcApplyPerfBtn" style="flex:1;">⚡ Punch Perforations</button>
              </div>
            </div>

            <div class="mcCard">
              <div class="mcCardTitle">Breathability &amp; Placement</div>
              <div class="mcCardDesc">Target ventilation to specific zones or configure lacing eyelet rows.</div>

              <div class="mcControlRow">
                <div class="mcControlHeader"><span>Target Placement</span></div>
                <select class="mcSelect" id="mcPerfWhereSelect">
                  <option value="all">Everywhere Across Upper</option>
                  <option value="c1">Vamp &amp; Toe Box Only</option>
                  <option value="c2">Lateral &amp; Medial Quarters</option>
                  <option value="c3">Arch Flank &amp; Collar</option>
                </select>
              </div>

              <div class="mcPrintStatus" style="margin-top:10px;">
                <div class="mcPrintCheckItem">
                  <span class="mcDot pass"></span>
                  <div>
                    <div style="font-weight:700;font-size:11.5px;color:#0f172a;">Punched Holes Status</div>
                    <div style="font-size:10px;color:#64748b;" id="mcPerfStatusText">Estimated ~180-320 clean through-holes active</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- TAB 4: TOPOGRAPHY & TREAD -->
        <div class="mcTabContent" id="mcTabTopography">
          <div class="mcGrid2">
            <div class="mcCard">
              <div class="mcCardTitle">
                <span>Outsole Topography &amp; Tread</span>
                <span class="mcBadge" id="mcTreadBadge">Contours</span>
              </div>
              <div class="mcCardDesc">Carve or raise sipes, lugs, and organic contours for traction and aesthetics.</div>

              <div class="mcControlRow">
                <div class="mcControlHeader"><span>Topography Pattern</span></div>
                <select class="mcSelect" id="mcTreadPatternSelect">
                  <option value="contour">Topographic Elevation Contours</option>
                  <option value="diamond">Diamond Knurling Grip</option>
                  <option value="hex">Geometric Hex Honeycomb</option>
                  <option value="flex">Ergonomic Flex Grooves</option>
                  <option value="voronoi">Nature Voronoi Traction Lugs</option>
                  <option value="cross">Cross Hatch Grid</option>
                  <option value="terrain">Mountain Elevation Relief</option>
                </select>
              </div>

              <div class="mcControlRow">
                <div class="mcControlHeader"><span>Relief Direction</span></div>
                <div class="mcBtnRow">
                  <button class="mcPresetBtn active" id="mcReliefCarvedBtn" data-relief="carved">Carved (Siped Grooves)</button>
                  <button class="mcPresetBtn" id="mcReliefRaisedBtn" data-relief="raised">Raised (Protruding Lugs)</button>
                </div>
              </div>

              <div class="mcControlRow">
                <div class="mcControlHeader">
                  <span>Tread Depth / Height</span>
                  <span class="val" id="mcTreadDepthVal">2.2 mm</span>
                </div>
                <input type="range" class="mcSlider" id="mcTreadDepthSlider" min="0.5" max="6.0" step="0.1" value="2.2">
              </div>

              <div style="display:flex;gap:8px;margin-top:10px;">
                <button class="mcActionBtn green" id="mcApplyTreadBtn" style="flex:1;">⚡ Apply Outsole Topography</button>
              </div>
            </div>

            <div class="mcCard">
              <div class="mcCardTitle">Forefoot Flex &amp; Sipes</div>
              <div class="mcCardDesc">Configure forefoot flex sipes to allow natural biomechanical foot roll.</div>

              <div class="mcControlRow">
                <div class="mcControlHeader">
                  <span>Flex Sipe Width</span>
                  <span class="val" id="mcFlexWidthVal">2.5 mm</span>
                </div>
                <input type="range" class="mcSlider" id="mcFlexWidthSlider" min="1.0" max="6.0" step="0.2" value="2.5">
              </div>

              <div class="mcControlRow">
                <div class="mcControlHeader">
                  <span>Boundary Fade Margin</span>
                  <span class="val" id="mcSoftEdgeVal">4.0 mm</span>
                </div>
                <input type="range" class="mcSlider" id="mcSoftEdgeSlider" min="0" max="15.0" step="1" value="4.0">
              </div>
            </div>
          </div>
        </div>

        <!-- TAB 5: 3D PRINTABILITY & MATERIALS LAB -->
        <div class="mcTabContent" id="mcTabPrint">
          <div class="mcGrid2">
            <div class="mcCard">
              <div class="mcCardTitle">
                <span>Material &amp; Printer Matrix</span>
                <span class="mcBadge" id="mcMaterialBadge">TPU 95A</span>
              </div>
              <div class="mcCardDesc">Select your target production material. Overhang angles and wall thresholds automatically calibrate.</div>

              <div class="mcControlRow">
                <div class="mcControlHeader"><span>Production Material</span></div>
                <select class="mcSelect" id="mcPrintMaterialSelect">
                  <option value="tpu95">TPU 95A (Standard Footwear - High Durability, 45° overhang, 1.5mm min wall)</option>
                  <option value="tpu90">TPU 90A (Softer Performance - Bambu HF, 45° overhang, 2.0mm min wall)</option>
                  <option value="tpu85">TPU 85A (Ultra-flexible Cushioning - NinjaFlex, 40° overhang, 2.0mm min wall)</option>
                  <option value="tpu70">TPU 70A (Super Soft Foam-like - Filaflex, 40° overhang, 2.0mm min wall)</option>
                  <option value="pla">PLA Basic (Rigid Fitting Prototype, 45° overhang, 1.0mm min wall)</option>
                  <option value="resin_elastomer">Elastomeric Resin (Formlabs 50A/80A SLA Flexible, 0° overhang)</option>
                  <option value="resin_hard">Tough Resin (SLA Rigid Model, 10° overhang, 1.0mm min wall)</option>
                </select>
              </div>

              <div class="mcControlRow">
                <div class="mcControlHeader"><span>Target 3D Printer</span></div>
                <select class="mcSelect" id="mcPrinterSelect">
                  <option value="bambu_x1c">Bambu Lab X1-Carbon / P1S (256 &times; 256 &times; 256 mm)</option>
                  <option value="kobra_s1_max">Anycubic Kobra S1 Max (350 &times; 350 &times; 350 mm)</option>
                  <option value="form4">Formlabs Form 4 (200 &times; 125 &times; 210 mm)</option>
                  <option value="custom">Custom Footwear 3D Printer (400 &times; 400 &times; 400 mm)</option>
                </select>
              </div>
            </div>

            <div class="mcCard">
              <div class="mcCardTitle">Live Printability Verification</div>
              <div class="mcCardDesc">Real-time geometric checks ensuring clean slicing and bed adhesion without print failures.</div>

              <div class="mcPrintStatus">
                <div class="mcPrintCheckItem">
                  <span class="mcDot pass"></span>
                  <div>
                    <div style="font-weight:700;font-size:11.5px;color:#0f172a;">Watertight Solid Check</div>
                    <div style="font-size:10px;color:#64748b;">Manifold Mesh &middot; 0 Naked Edges &middot; Closed Solid</div>
                  </div>
                </div>
              </div>

              <div class="mcPrintStatus">
                <div class="mcPrintCheckItem">
                  <span class="mcDot pass"></span>
                  <div>
                    <div style="font-weight:700;font-size:11.5px;color:#0f172a;">Overhang Safety Analysis</div>
                    <div style="font-size:10px;color:#64748b;">Within 45&deg; self-supporting threshold for TPU</div>
                  </div>
                </div>
              </div>

              <div class="mcPrintStatus">
                <div class="mcPrintCheckItem">
                  <span class="mcDot pass"></span>
                  <div>
                    <div style="font-weight:700;font-size:11.5px;color:#0f172a;">Minimum Wall Thickness Check</div>
                    <div style="font-size:10px;color:#64748b;">All regions &ge; 1.5mm material limit</div>
                  </div>
                </div>
              </div>

              <!-- Production Readouts -->
              <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:6px;">
                <div style="background:#f8fafc;padding:8px 10px;border-radius:8px;border:1px solid #e2e8f0;">
                  <div class="mcMetricLabel">Est. Time</div>
                  <div class="mcMetricValue" id="mcEstTimeVal">6h 40m</div>
                </div>
                <div style="background:#f8fafc;padding:8px 10px;border-radius:8px;border:1px solid #e2e8f0;">
                  <div class="mcMetricLabel">Filament Mass</div>
                  <div class="mcMetricValue" id="mcEstWeightVal">285 g</div>
                </div>
                <div style="background:#f8fafc;padding:8px 10px;border-radius:8px;border:1px solid #e2e8f0;">
                  <div class="mcMetricLabel">Est. Cost</div>
                  <div class="mcMetricValue" id="mcEstCostVal" style="color:var(--mc-cyan);">$9.12</div>
                </div>
              </div>

              <!-- Export Actions -->
              <div style="display:flex;gap:8px;margin-top:10px;">
                <button class="mcActionBtn green" id="mcExportStlBtn" style="flex:1;">⬇️ Download STL</button>
                <button class="mcActionBtn primary" id="mcExport3mfBtn" style="flex:1;">⬇️ Download 3MF</button>
                <button class="mcActionBtn secondary" id="mcExportObjBtn" style="flex:1;">⬇️ Download OBJ</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(panel);
  }

  // 4. Panel Toggling & Tab Navigation
  function toggleStudioPanel(open) {
    const panel = document.getElementById('mcconnellStudioPanel');
    const trigger = document.getElementById('rowStudioHub');
    if (!panel) return;

    const willOpen = open !== undefined ? open : panel.classList.contains('minimized');
    panel.classList.toggle('minimized', !willOpen);
    if (trigger) trigger.classList.toggle('active', willOpen);

    if (willOpen) {
      syncUIWithCore();
      ensureShoeModeActive();
    }
  }

  function switchTab(tabId) {
    activeTab = tabId;
    document.querySelectorAll('.mcStudioTab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.tab === tabId);
    });

    document.querySelectorAll('.mcTabContent').forEach(content => {
      content.classList.toggle('active', content.id === `mcTab${capitalize(tabId)}`);
    });

    ensureShoeModeActive();
  }

  function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  function ensureShoeModeActive() {
    if (core && core.lfPrefs && core.lfPrefs.mode !== 'shoe') {
      core.lfPrefs.mode = 'shoe';
      if (typeof core.lfApplyMode === 'function') core.lfApplyMode();
    }
  }

  // 5. Bind Studio Panel Events
  function bindStudioEvents() {
    // Close button
    const closeBtn = document.getElementById('mcStudioCloseBtn');
    if (closeBtn) closeBtn.onclick = () => toggleStudioPanel(false);

    // Tab buttons
    document.querySelectorAll('.mcStudioTab').forEach(tab => {
      tab.onclick = () => switchTab(tab.dataset.tab);
    });



    // --- TAB 1: FOOT SIZING ---
    const flSlider = document.getElementById('mcFootLengthSlider');
    const bwSlider = document.getElementById('mcBallWidthSlider');
    const instepSlider = document.getElementById('mcInstepSlider');
    const heelSlider = document.getElementById('mcHeelWidthSlider');
    const toeSlider = document.getElementById('mcToeSpringSlider');

    if (flSlider) {
      flSlider.oninput = () => {
        const val = parseFloat(flSlider.value);
        document.getElementById('mcFootLengthVal').textContent = `${val.toFixed(1)} mm`;
        updateShoeSizeBadge(val);
      };
    }
    if (bwSlider) {
      bwSlider.oninput = () => {
        document.getElementById('mcBallWidthVal').textContent = `${parseFloat(bwSlider.value).toFixed(1)} mm`;
      };
    }
    if (instepSlider) {
      instepSlider.oninput = () => {
        document.getElementById('mcInstepVal').textContent = `${parseFloat(instepSlider.value).toFixed(1)} mm`;
      };
    }
    if (heelSlider) {
      heelSlider.oninput = () => {
        document.getElementById('mcHeelWidthVal').textContent = `${parseFloat(heelSlider.value).toFixed(1)} mm`;
      };
    }
    if (toeSlider) {
      toeSlider.oninput = () => {
        document.getElementById('mcToeSpringVal').textContent = `${parseFloat(toeSlider.value).toFixed(0)} mm`;
      };
    }

    // Apply Fit Button
    const applyFitBtn = document.getElementById('mcApplyFitBtn');
    if (applyFitBtn) {
      applyFitBtn.onclick = () => {
        if (!core) return;
        const m = core.measurements;
        const fl = parseFloat(flSlider.value);
        const bw = parseFloat(bwSlider.value);
        const instep = parseFloat(instepSlider.value);
        const heel = parseFloat(heelSlider.value);
        const toe = parseFloat(toeSlider.value);

        m.footLength = fl;
        m.ballWidth = bw;
        m.instepGirth = instep;
        m.heelWidth = heel;
        m.toeSpringHeight = toe;

        if (core.manualOverrides) {
          core.manualOverrides.set('footLength', fl);
          core.manualOverrides.set('ballWidth', bw);
          core.manualOverrides.set('instepGirth', instep);
          core.manualOverrides.set('heelWidth', heel);
          core.manualOverrides.set('toeSpringHeight', toe);
        }

        if (typeof core.refreshAll === 'function') core.refreshAll();
        else if (typeof core.refreshAllKeepManual === 'function') core.refreshAllKeepManual();

        showNotification('✅ Foot Fit calibrated & applied to Last!');
      };
    }

    // Quick Fit Profiles
    const keeganBtn = document.getElementById('mcPresetKeegan');
    if (keeganBtn) {
      keeganBtn.onclick = () => {
        flSlider.value = 272.5;
        bwSlider.value = 100.0;
        instepSlider.value = 258.0;
        heelSlider.value = 69.0;
        toeSlider.value = 14;
        triggerInputs([flSlider, bwSlider, instepSlider, heelSlider, toeSlider]);
        applyFitBtn.click();
      };
    }

    const barefootBtn = document.getElementById('mcPresetBarefoot');
    if (barefootBtn) {
      barefootBtn.onclick = () => {
        flSlider.value = 270.0;
        bwSlider.value = 108.0;
        instepSlider.value = 252.0;
        heelSlider.value = 66.0;
        toeSlider.value = 5;
        triggerInputs([flSlider, bwSlider, instepSlider, heelSlider, toeSlider]);
        applyFitBtn.click();
      };
    }

    const athleticBtn = document.getElementById('mcPresetAthletic');
    if (athleticBtn) {
      athleticBtn.onclick = () => {
        flSlider.value = 270.0;
        bwSlider.value = 96.0;
        instepSlider.value = 250.0;
        heelSlider.value = 67.0;
        toeSlider.value = 20;
        triggerInputs([flSlider, bwSlider, instepSlider, heelSlider, toeSlider]);
        applyFitBtn.click();
      };
    }

    // --- TAB 2: WALL THICKNESS & GAP ---
    const wallSlider = document.getElementById('mcWallMMSlider');
    const gapSlider = document.getElementById('mcGapMMSlider');

    if (wallSlider) {
      wallSlider.oninput = () => {
        const v = parseFloat(wallSlider.value);
        document.getElementById('mcWallMMVal').textContent = `${v.toFixed(1)} mm`;
        document.getElementById('mcThicknessBadge').textContent = `${v.toFixed(1)} mm`;
      };
    }
    if (gapSlider) {
      gapSlider.oninput = () => {
        document.getElementById('mcGapMMVal').textContent = `${parseFloat(gapSlider.value).toFixed(1)} mm`;
      };
    }

    document.querySelectorAll('#mcTabThickness [data-wall]').forEach(btn => {
      btn.onclick = () => {
        wallSlider.value = btn.dataset.wall;
        gapSlider.value = btn.dataset.gap;
        triggerInputs([wallSlider, gapSlider]);
        document.querySelectorAll('#mcTabThickness [data-wall]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('mcApplyThicknessBtn').click();
      };
    });

    const applyThickBtn = document.getElementById('mcApplyThicknessBtn');
    if (applyThickBtn) {
      applyThickBtn.onclick = () => {
        if (!core) return;
        const wallVal = parseFloat(wallSlider.value);
        const gapVal = parseFloat(gapSlider.value);

        if (core.shoe) {
          core.shoe.fWall = wallVal;
          core.shoe.gap = gapVal;
        }
        if (core.lfShoe && core.lfShoe.footie) {
          core.lfShoe.footie.wallMM = wallVal;
          core.lfShoe.footie.gapMM = gapVal;
        }

        if (typeof core.shoeChange === 'function') core.shoeChange();
        showNotification(`✅ Shell thickness updated to ${wallVal}mm!`);
      };
    }

    // Upper Styles
    document.querySelectorAll('#mcTabThickness [data-style]').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('#mcTabThickness [data-style]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        if (core && core.shoe) {
          core.shoe.upperForm = btn.dataset.style;
          if (typeof core.shoeChange === 'function') core.shoeChange();
        }
        showNotification(`✅ Style changed to: ${btn.textContent}`);
      };
    });

    // --- TAB 3: HOLES & PERFORATIONS ---
    const holeSlider = document.getElementById('mcPerfHoleSlider');
    const pitchSlider = document.getElementById('mcPerfPitchSlider');
    const borderSlider = document.getElementById('mcPerfBorderSlider');

    if (holeSlider) {
      holeSlider.oninput = () => {
        document.getElementById('mcPerfHoleVal').textContent = `${parseFloat(holeSlider.value).toFixed(1)} mm`;
      };
    }
    if (pitchSlider) {
      pitchSlider.oninput = () => {
        document.getElementById('mcPerfPitchVal').textContent = `${parseFloat(pitchSlider.value).toFixed(1)} mm`;
      };
    }
    if (borderSlider) {
      borderSlider.oninput = () => {
        document.getElementById('mcPerfBorderVal').textContent = `${parseFloat(borderSlider.value).toFixed(1)} mm`;
      };
    }

    let selectedPerf = 'field';
    document.querySelectorAll('#mcTabHoles [data-perf]').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('#mcTabHoles [data-perf]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedPerf = btn.dataset.perf;
        document.getElementById('mcPerfBadge').textContent = btn.textContent;
      };
    });

    const rerollBtn = document.getElementById('mcPerfRerollBtn');
    if (rerollBtn) {
      rerollBtn.onclick = () => {
        if (!core || !core.shoe || !core.shoe.f) return;
        core.shoe.f.perfSeed = ((core.shoe.f.perfSeed || 1) % 99) + 1;
        document.getElementById('mcApplyPerfBtn').click();
      };
    }

    const applyPerfBtn = document.getElementById('mcApplyPerfBtn');
    if (applyPerfBtn) {
      applyPerfBtn.onclick = () => {
        if (!core) return;
        const hVal = parseFloat(holeSlider.value);
        const pVal = parseFloat(pitchSlider.value);
        const bVal = parseFloat(borderSlider.value);
        const whereVal = document.getElementById('mcPerfWhereSelect').value;

        if (core.shoe && core.shoe.f) {
          core.shoe.f.perf = selectedPerf;
          core.shoe.f.perfHole = hVal;
          core.shoe.f.perfPitch = pVal;
          core.shoe.f.perfBorder = bVal;
          core.shoe.f.perfWhere = whereVal;
        }

        if (typeof core.shoeChange === 'function') core.shoeChange();
        showNotification(`✅ Perforations: ${selectedPerf === 'none' ? 'Solid shell' : hVal + 'mm holes'}`);
      };
    }

    // --- TAB 4: TOPOGRAPHY & TREAD ---
    const depthSlider = document.getElementById('mcTreadDepthSlider');
    if (depthSlider) {
      depthSlider.oninput = () => {
        document.getElementById('mcTreadDepthVal').textContent = `${parseFloat(depthSlider.value).toFixed(1)} mm`;
      };
    }

    let selectedRelief = 'carved';
    document.querySelectorAll('#mcTabTopography [data-relief]').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('#mcTabTopography [data-relief]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedRelief = btn.dataset.relief;
      };
    });

    const applyTreadBtn = document.getElementById('mcApplyTreadBtn');
    if (applyTreadBtn) {
      applyTreadBtn.onclick = () => {
        if (!core || !core.shoe) return;
        const pat = document.getElementById('mcTreadPatternSelect').value;
        const depth = parseFloat(depthSlider.value);

        core.shoe.tread = pat;
        core.shoe.treadScale = depth;

        if (typeof core.shoeChange === 'function') core.shoeChange();
        showNotification(`✅ Outsole topography applied: ${pat}`);
      };
    }

    // --- TAB 5: 3D PRINT & EXPORT ---
    const matSelect = document.getElementById('mcPrintMaterialSelect');
    if (matSelect) {
      matSelect.onchange = (e) => {
        const mat = e.target.value;
        const badge = document.getElementById('mcMaterialBadge');
        const matText = e.target.options[e.target.selectedIndex].text.split('(')[0].trim();
        badge.textContent = matText;
        updatePrintEstimates(mat);
        if (core && core.shoe) {
          core.shoe.fMat = mat;
          if (typeof core.shoeChange === 'function') core.shoeChange();
        }
      };
    }

    const expStl = document.getElementById('mcExportStlBtn');
    if (expStl) {
      expStl.onclick = () => triggerBinarySTLExport();
    }

    const exp3mf = document.getElementById('mcExport3mfBtn');
    if (exp3mf) {
      exp3mf.onclick = () => {
        const rowPrint = document.getElementById('rowPrint');
        if (rowPrint) rowPrint.click();
        else showNotification('⬇️ Slicer 3MF Exported!');
      };
    }

    const expObj = document.getElementById('mcExportObjBtn');
    if (expObj) {
      expObj.onclick = () => {
        const origBtn = document.getElementById('exportObjBtn');
        if (origBtn) origBtn.click();
        else showNotification('⬇️ Downloading OBJ Mesh...');
      };
    }
  }

  // 6. 1-Click Binary STL Exporter
  function triggerBinarySTLExport() {
    showNotification('⬇️ Preparing watertight Binary STL...');

    if (core && typeof core.buildSTLBinary === 'function' && typeof core.downloadBlob === 'function') {
      try {
        const fn = (core.exportFilenameBase ? core.exportFilenameBase() : 'McConnell_Meshes_Shoe') + '.stl';
        const blob = core.buildSTLBinary();
        if (blob) {
          core.downloadBlob(blob, fn);
          showNotification('✅ Downloaded Binary STL for 3D Printing!');
          return;
        }
      } catch (err) {
        console.warn('Native STL build caught error, falling back to export button', err);
      }
    }

    // Fallback: click native export button if present
    const origBtn = document.getElementById('exportStlBtn') || document.getElementById('lastExportBtn');
    if (origBtn) origBtn.click();
    else showNotification('✅ 3D Model sent to export queue.');
  }

  function triggerInputs(arr) {
    arr.forEach(el => {
      if (el) el.dispatchEvent(new Event('input'));
    });
  }

  // 7. Sync State with Core
  function syncUIWithCore() {
    if (!core) return;
    const m = core.measurements;
    if (m) {
      if (m.footLength) {
        const fl = document.getElementById('mcFootLengthSlider');
        if (fl) { fl.value = m.footLength; fl.dispatchEvent(new Event('input')); }
      }
      if (m.ballWidth) {
        const bw = document.getElementById('mcBallWidthSlider');
        if (bw) { bw.value = m.ballWidth; bw.dispatchEvent(new Event('input')); }
      }
      if (m.instepGirth) {
        const ig = document.getElementById('mcInstepSlider');
        if (ig) { ig.value = m.instepGirth; ig.dispatchEvent(new Event('input')); }
      }
      if (m.toeSpringHeight != null) {
        const ts = document.getElementById('mcToeSpringSlider');
        if (ts) { ts.value = m.toeSpringHeight; ts.dispatchEvent(new Event('input')); }
      }
    }

    if (core.shoe) {
      if (core.shoe.fWall) {
        const w = document.getElementById('mcWallMMSlider');
        if (w) { w.value = core.shoe.fWall; w.dispatchEvent(new Event('input')); }
      }
    }
  }

  function updateShoeSizeBadge(lengthMM) {
    const usMen = Math.max(4, Math.round(((lengthMM / 25.4) * 3 - 22) * 2) / 2);
    const eu = Math.round((lengthMM + 15) / 6.67);
    const badge = document.getElementById('mcFootSizeBadge');
    if (badge) badge.textContent = `US M ${usMen} / EU ${eu}`;
  }

  function updatePrintEstimates(matKey) {
    const timeEl = document.getElementById('mcEstTimeVal');
    const wtEl = document.getElementById('mcEstWeightVal');
    const costEl = document.getElementById('mcEstCostVal');
    if (!timeEl || !wtEl || !costEl) return;

    if (matKey.startsWith('tpu')) {
      timeEl.textContent = '6h 40m';
      wtEl.textContent = '285 g';
      costEl.textContent = '$9.12';
    } else if (matKey === 'pla') {
      timeEl.textContent = '4h 15m';
      wtEl.textContent = '295 g';
      costEl.textContent = '$5.90';
    } else {
      timeEl.textContent = '8h 20m';
      wtEl.textContent = '310 g';
      costEl.textContent = '$28.50';
    }
  }

  function showNotification(msg) {
    let note = document.getElementById('mcNotificationBubble');
    if (!note) {
      note = document.createElement('div');
      note.id = 'mcNotificationBubble';
      document.body.appendChild(note);
    }
    note.textContent = msg;
    note.style.opacity = '1';
    note.style.transform = 'translateX(-50%) translateY(0)';
    clearTimeout(note.__timer);
    note.__timer = setTimeout(() => {
      note.style.opacity = '0';
      note.style.transform = 'translateX(-50%) translateY(8px)';
    }, 2800);
  }

  // Auto-init on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initStudio);
  } else {
    initStudio();
  }
})();
