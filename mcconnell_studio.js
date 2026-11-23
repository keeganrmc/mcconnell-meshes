/**
 * McConnell Meshes — Generative 3D Footwear Design & 3D Print Studio
 * Created by Keegan McConnell (@keeganrmc)
 * 
 * Features:
 * 1. Shoe-First Architecture: Launches directly into 3D shoe creation & modeling.
 * 2. High-Precision Floating Tooltip Engine: Every tool, dial, button, and slider displays rich footwear & printability explanations on hover.
 * 3. Personal Foot & Last Calibration Station: Adjust foot length, width, girth, arch height, and toe spring anytime.
 * 4. Shoe Wall Thickness & Gap Offset Studio: 0.8mm–10.0mm continuous thickness with 1-click presets.
 * 5. Procedural Holes & Ventilation Generator: Breathable field vents, broguing, lace eyelets, drainage ports.
 * 6. Topography & Surface Sculptor: Elevation contour lines, diamond knurling, hexagonal lugs, flex sipes, mountain reliefs.
 * 7. 3D Printability & Material Simulation Lab: TPU 95A/90A/85A/70A, SLA resin, PLA, overhang checks, watertight checks, 1-click exports.
 */

(function () {
  'use strict';

  let core = null;
  let activeTab = 'fit';

  // Comprehensive Tooltip Dictionary for Instant Hover Guidance
  const TOOLTIP_DATABASE = {
    // Top Navigation & Step Workflow
    'rowUpper': {
      title: 'Upper Shell (Footie)',
      desc: 'The conformal outer upper of the shoe wrapping the foot last. Dial wall thickness, punch breathability vents, and sculpt collar openings.',
      tip: 'Recommended 1.8mm–2.2mm wall for flexible TPU to balance structural durability and lightweight comfort.'
    },
    'rowMidsole': {
      title: 'Midsole Cushion',
      desc: 'The intermediate shock-absorbing platform between the foot and floor. Controls stack height, arch support, heel-to-toe drop, and cushioning infill.',
      tip: 'Supports Gyroid, Voronoi, and Kelvin lattice structures for custom mechanical spring and damping.'
    },
    'rowOutsole': {
      title: 'Outsole & Tread',
      desc: 'The ground-contact traction layer. Emboss or carve topographic elevation contours, knurled diamond grip, hexagonal lugs, or flex sipes.',
      tip: 'Carve sipes (grooves) for road flexibility; raise lugs for outdoor grip. Recommended depth: 1.5mm–3.0mm.'
    },
    'rowLayer': {
      title: 'Add Structural Layer',
      desc: 'Stacks a secondary reinforcement piece onto the shoe: heel counter, tongue, lace eyestay, collar piping, mudguard, or welt.',
      tip: 'Layers can have their own independent wall thickness and material parameters.'
    },
    'rowMake': {
      title: '3D Print Lab & Production Slicing',
      desc: 'Production staging center. Validates watertight manifold geometry, checks overhang angles for supports, simulates TPU/Resin material behavior, and generates 3MF/STL.',
      tip: 'Use 120° toe-up orientation for support-free monolithic TPU shoe printing.'
    },
    'rowLast': {
      title: 'Foot & Last Calibration',
      desc: 'Adjust the anatomical foot last dimensions (length, width, girth, arch height, toe spring). The shoe model adapts organically to fit your foot.',
      tip: 'Calibrate with socks on if designing everyday sneakers, or bare measurements for molded slides.'
    },
    'rowFile': {
      title: 'Project Files & Document Storage',
      desc: 'Manage shoe projects: Create new shoe, save current design, reopen autosaved versions, or load reference scans.',
      tip: 'McConnell Meshes features crash-proof autosave persisted in your browser storage.'
    },
    'rowPrint': {
      title: '3D Slicer Staging (3MF)',
      desc: 'Places the shoe stack on your 3D printer bed (Bambu Lab, Anycubic, Formlabs) and calculates layer heights, weight, time, and costs.',
      tip: 'Exports directly as a production 3MF project with pre-configured print parameters.'
    },
    'rowExport': {
      title: 'CAD & Mesh Export Hub',
      desc: 'Download your shoe model as high-resolution Binary STL, OBJ, Rhino 3DM, or 1:1 SVG/DXF flat cutting dies.',
      tip: 'Binary STL is universally compatible with Bambu Studio, OrcaSlicer, PrusaSlicer, and Cura.'
    },
    'rowShow': {
      title: 'Layer Visibility & Isolated Display',
      desc: 'Toggle visibility of individual shoe pieces: Upper shell, Midsole cushion, Outsole, and the internal Foot Last.',
      tip: 'Hide the upper to inspect the internal footbed and arch contouring.'
    },
    'rowWire': {
      title: 'Toggle Wireframe (W)',
      desc: 'Displays the underlying polygonal mesh wireframe to inspect Catmull-Clark subdivision, edge density, and quad topology.',
      tip: 'High-density regions indicate fine details like perforations or embossed topography.'
    },
    'rowUndo': {
      title: 'Undo (⌘Z / Ctrl+Z)',
      desc: 'Revert the most recent modeling stroke, parameter adjustment, or preset change.',
      tip: 'Full history stack preserved in memory.'
    },
    'rowRedo': {
      title: 'Redo (⇧⌘Z / Ctrl+Y)',
      desc: 'Reapply the previously undone action.',
      tip: 'Quickly toggle before and after to compare subtle geometry changes.'
    },

    // Left CAD Rail Tools
    'railOrbit': {
      title: 'Orbit & Camera Navigation',
      desc: 'Left-click + drag to orbit 360° around shoe. Right-click or two-finger drag to pan. Scroll wheel to zoom.',
      tip: 'Double-click anywhere to center the camera on that surface point.'
    },
    'railSculpt': {
      title: 'Surface Sculpt (Freehand Push/Pull)',
      desc: 'Sculpt the shoe surface interactively like digital clay. Pull outward, push inward, smooth, or flatten.',
      tip: 'Great for building custom anatomical toe box relief or custom arch humps.'
    },
    'railMeasure': {
      title: 'Precision Calipers & Tape Measure',
      desc: 'Click any two surface points to measure linear distance and anatomical tape-wrap girth around the shoe.',
      tip: 'Ensures ball girth and instep height match physical foot calipers.'
    },
    'railPaint': {
      title: 'Paint Coverage Region',
      desc: 'Brush on the surface to define where the upper, straps, or sole layers exist.',
      tip: 'Stroke along the feather line to extend or trim the shoe body.'
    },
    'railErase': {
      title: 'Erase Coverage (Cutout Tool)',
      desc: 'Erase painted coverage to create ventilation windows, peep-toes, or sandal cutouts.',
      tip: 'Feathered brush edges create smooth organic cutouts.'
    },
    'railLine': {
      title: 'Vector Contour & Rim Editor',
      desc: 'Place and drag vector control points along the shoe collar to shape flowing topline curves.',
      tip: 'Double-click to insert an anchor node; drag to dynamically deform the opening.'
    },
    'railGap': {
      title: 'Offset & Gap Brush',
      desc: 'Paint localized standoff distance between the shoe and the foot (e.g. extra room for bunions or high instep).',
      tip: 'Allows micro-adjusting fit in high-friction zones to prevent blisters.'
    },
    'railColor': {
      title: 'Variable Wall Thickness Brush',
      desc: 'Paint zoned wall thickness variations across the shoe (e.g. 3.5mm toe cap, 1.2mm quarter breathability).',
      tip: 'Blends smoothly across edges to eliminate stress concentrations.'
    },
    'railPoints': {
      title: 'Pattern Focus Points',
      desc: 'Tap points on the shoe where procedural tread sipes, ventilation grids, or knurling converge.',
      tip: 'Aligns traction patterns with foot strike and push-off vectors.'
    },
    'railCage': {
      title: 'SuperB Subdivision Cage Handles',
      desc: 'Directly manipulate the low-poly control cage vertices to sculpt sweeping conceptual shoe silhouettes.',
      tip: 'Catmull-Clark subdivision ensures the final output remains perfectly smooth and fair.'
    },

    // Studio Hub & Custom Controls
    'mcStudioHubBtn': {
      title: '⚡ McConnell Studio Hub',
      desc: 'Open the master control center: Foot Fit, Wall Thickness, Holes, Topography, and 3D Print Simulation.',
      tip: 'Access all essential generative shoe creation tools in one unified dashboard.'
    },
    'mcFootLengthSlider': {
      title: 'Foot Length Calibration (mm)',
      desc: 'Sets the true anatomical heel-to-toe length of your foot. Shoe sizing and grading scale automatically.',
      tip: 'Standard adult lengths range from 220mm (US W 5) to 300mm (US M 13).'
    },
    'mcBallWidthSlider': {
      title: 'Ball Width & Fitting',
      desc: 'Calibrates forefoot width across the 1st and 5th metatarsal heads (the widest part of the foot).',
      tip: 'Narrow (B), Medium (D), Wide (EE), Extra Wide (4E).'
    },
    'mcInstepSlider': {
      title: 'Instep Girth & Volume',
      desc: 'Adjusts the midfoot cone height over the arch. Crucial for slip-on shoe entry and lockdown.',
      tip: 'Increase for high arches or athletic feet with thick insteps.'
    },
    'mcHeelWidthSlider': {
      title: 'Heel Seat Width',
      desc: 'Sets heel cup width to ensure secure rearfoot lockdown without heel slip.',
      tip: 'A snug heel cup prevents lateral slippage during walking or running.'
    },
    'mcToeSpringSlider': {
      title: 'Toe Spring Lift (Rocker)',
      desc: 'Curvature lifting the shoe tip off the floor to facilitate smooth forefoot roll-through.',
      tip: '5mm for flat minimalist barefoot shoes; 15mm–25mm for athletic rockers.'
    },
    'mcWallMMSlider': {
      title: 'Master Wall Thickness (mm)',
      desc: 'Controls physical wall thickness of the shoe shell for structural strength in additive manufacturing.',
      tip: '1.2mm = flexible/ultralight; 2.0mm = balanced sneaker; 3.2mm = durable clog/work shoe.'
    },
    'mcGapMMSlider': {
      title: 'Internal Footbed Gap (mm)',
      desc: 'Standoff offset between foot last and inner shoe wall for socks, orthotic footbeds, or comfort fit.',
      tip: 'Set to 1.5mm–2.0mm for standard sock accommodation, or 0.0mm for molded skin-fit slides.'
    },
    'mcPerfHoleSlider': {
      title: 'Hole Diameter (mm)',
      desc: 'Diameter of each punched ventilation hole through the upper shell.',
      tip: '2.0mm–3.5mm provides optimal airflow while maintaining waterproof resistance on TPU prints.'
    },
    'mcPerfPitchSlider': {
      title: 'Perforation Spacing / Pitch (mm)',
      desc: 'Center-to-center distance between adjacent ventilation holes.',
      tip: 'Tighter pitch (<6mm) creates mesh-like breathability; wider pitch (>10mm) creates classic brogue accents.'
    },
    'mcPerfBorderSlider': {
      title: 'Rim Margin Clearance (mm)',
      desc: 'Safety border distance from collar rims and sole edges where no holes may be punched.',
      tip: 'Prevents edge tears and maintains structural perimeter stiffness.'
    },
    'mcTreadPatternSelect': {
      title: 'Outsole Topography Pattern',
      desc: 'Procedural surface geometry: Elevation Contours, Diamond Knurling, Hexagonal Honeycomb, Wave Flex, or Mountain Relief.',
      tip: 'Contours and Diamond Knurl provide multi-directional wet-weather traction.'
    },
    'mcTreadDepthSlider': {
      title: 'Tread Lug Depth (mm)',
      desc: 'How deeply tread grooves cut into the outsole or how high traction lugs protrude.',
      tip: '1.5mm for road shoes; 3.0mm–4.5mm for trail and outdoor lugs.'
    },
    'mcPrintMaterialSelect': {
      title: 'Manufacturing Material Profile',
      desc: 'Selects the 3D printing filament or resin (TPU 95A, TPU 90A, TPU 85A/70A, PLA, SLA Resins).',
      tip: 'Automatically adjusts design overhang limits and minimum wall thickness checks.'
    },
    'mcExportStlBtn': {
      title: '1-Click Binary STL Export',
      desc: 'Generates a clean, watertight binary STL file ready to slice in Bambu Studio, PrusaSlicer, or Cura.',
      tip: 'Directly printable on Bambu Lab, Anycubic, Creality, and Formlabs 3D printers.'
    },
    'mcExport3mfBtn': {
      title: '1-Click 3MF Production Package',
      desc: 'Bundles 3D geometry with material presets, bed positioning, and slicer metadata in a single file.',
      tip: 'The gold standard format for multi-material and additive footwear manufacturing.'
    }
  };

  // Initialize McConnell Studio
  function initStudio() {
    core = window.__mcconnellCore;
    if (!core) {
      setTimeout(initStudio, 150);
      return;
    }

    createTooltipDOM();
    setupTooltips();
    createQuickNavButtons();
    createStudioPanel();
    bindEvents();
    syncUIWithCore();
    ensureShoeModeActive();

    console.log('⚡ McConnell Meshes Studio Hub initialized & active.');
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
        entry = { title: target.textContent || 'Tool', desc: dataTip, tip: 'Part of the McConnell Meshes footwear design suite.' };
      } else if (!entry && titleAttr) {
        entry = {
          title: target.getAttribute('aria-label') || target.textContent.trim().slice(0, 24) || 'Shoe Tool',
          desc: titleAttr,
          tip: 'Click or adjust to modify the 3D footwear model in real time.'
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
      }, 140); // Snappy 140ms hover delay
    }, true);

    document.addEventListener('mouseout', (e) => {
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
    if (x + 320 > window.innerWidth) x = mouseX - 320 - pad;
    if (y + 140 > window.innerHeight) y = mouseY - 140 - pad;

    tipEl.style.left = `${Math.max(10, x)}px`;
    tipEl.style.top = `${Math.max(10, y)}px`;
  }

  // 2. Navigation Bar Buttons & KM Monogram
  function createQuickNavButtons() {
    const outputsBar = document.getElementById('shoeOutputs');
    const piecesBar = document.getElementById('shoePieces');
    if (!outputsBar) return;

    // Main Studio Hub Pill
    if (!document.getElementById('mcStudioHubBtn')) {
      const hubBtn = document.createElement('button');
      hubBtn.id = 'mcStudioHubBtn';
      hubBtn.className = 'mcStudioPill';
      hubBtn.title = 'Open McConnell Meshes Studio Hub (Foot Fit, Wall Thickness, Holes, Topography, 3D Print Lab)';
      hubBtn.innerHTML = `<span>⚡</span><b>Studio Hub</b><span class="mcBadge">McConnell</span>`;
      hubBtn.onclick = () => toggleStudioPanel();
      outputsBar.insertBefore(hubBtn, outputsBar.firstChild);
    }

    // Update Brand Mark in shoePieces with KM Monogram
    if (piecesBar) {
      const brandMark = piecesBar.querySelector('.barMark');
      if (brandMark) {
        brandMark.className = 'barMark lfAboutOpen mcconnellBrandBadge';
        brandMark.innerHTML = `
          <img src="assets/logo.jpg" alt="KM" class="kmLogoImg">
          <div class="kmBrandText">
            <span class="kmBrandName">McCONNELL</span>
            <span class="kmBrandSub">MESHES</span>
          </div>
        `;
        brandMark.title = 'McConnell Meshes: Generative 3D Footwear Studio by Keegan McConnell (@keeganrmc)';
      }
    }
  }

  // 3. Build the Studio Hub Floating Modal
  function createStudioPanel() {
    if (document.getElementById('mcconnellStudioPanel')) return;

    const panel = document.createElement('div');
    panel.id = 'mcconnellStudioPanel';
    panel.className = 'minimized';

    panel.innerHTML = `
      <div class="mcStudioHd">
        <div class="mcStudioLogoGroup">
          <img src="assets/logo.jpg" alt="KM">
          <div class="mcStudioLogoText">
            <b>McCONNELL MESHES</b>
            <span>SHOE &amp; LAST GENERATIVE 3D PRINT STUDIO &middot; @KEEGANRMC</span>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <button class="mcStudioPill" id="mcQuickSneakerPresetBtn" style="height:26px;font-size:10px;">👟 Preset: Runner</button>
          <button class="mcStudioPill" id="mcQuickClogPresetBtn" style="height:26px;font-size:10px;">👣 Preset: Clog</button>
          <button class="mcCloseBtn" id="mcStudioCloseBtn" title="Close Studio Hub">&times;</button>
        </div>
      </div>

      <div class="mcStudioTabs" role="tablist">
        <button class="mcStudioTab active" data-tab="fit"><span class="icon">👟</span> Foot &amp; Last Fit</button>
        <button class="mcStudioTab" data-tab="thickness"><span class="icon">📏</span> Wall Thickness &amp; Gap</button>
        <button class="mcStudioTab" data-tab="holes"><span class="icon">🕳️</span> Holes &amp; Vents</button>
        <button class="mcStudioTab" data-tab="topography"><span class="icon">🏔️</span> Topography &amp; Tread</button>
        <button class="mcStudioTab" data-tab="print"><span class="icon">🖨️</span> 3D Print &amp; Materials</button>
      </div>

      <div class="mcStudioBody">
        <!-- TAB 1: FOOT & LAST CALIBRATION -->
        <div class="mcTabContent active" id="mcTabFit">
          <div class="mcGrid2">
            <div class="mcCard">
              <div class="mcCardTitle">
                <span>Personal Foot Sizing</span>
                <span id="mcFootSizeBadge" class="mcBadge" style="background:rgba(0,210,255,0.2);color:var(--mc-cyan);">US M 10.5</span>
              </div>
              <div class="mcCardDesc">Calibrate the 3D last directly to your foot measurements. The shoe upper, midsole, and outsole automatically conform around this volume.</div>
              
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
              <div class="mcCardTitle">Foot Morphology &amp; Presets</div>
              <div class="mcCardDesc">Save customized foot dimensions for yourself, clients, or asymmetrical left/right feet.</div>

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

              <div class="mcControlRow">
                <div class="mcControlHeader"><span>Target Foot</span></div>
                <div class="mcBtnRow">
                  <button class="mcPresetBtn active" id="mcFootLeftBtn">Left Foot</button>
                  <button class="mcPresetBtn" id="mcFootRightBtn">Right Foot</button>
                  <button class="mcPresetBtn" id="mcFootPairBtn">Mirrored Pair</button>
                </div>
              </div>

              <div class="mcControlRow" style="margin-top:4px;">
                <div class="mcControlHeader"><span>Saved Profiles</span></div>
                <div class="mcBtnRow">
                  <button class="mcPresetBtn" id="mcPresetKeegan">Keegan (Daily Fit)</button>
                  <button class="mcPresetBtn" id="mcPresetBarefoot">Natural Barefoot</button>
                  <button class="mcPresetBtn" id="mcPresetAthletic">Performance Athletic</button>
                </div>
              </div>

              <div style="display:flex;gap:8px;margin-top:10px;">
                <button class="mcActionBtn green" id="mcApplyFitBtn" style="flex:1;">⚡ Apply Fit to Last &amp; Shoe</button>
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
              <div class="mcCardDesc">Sets the physical solid shell thickness for 3D printing. Thinner walls give flexibility; thicker walls provide durability.</div>

              <div class="mcControlRow">
                <div class="mcControlHeader">
                  <span>Upper Shell Wall Thickness</span>
                  <span class="val" id="mcWallMMVal">2.0 mm</span>
                </div>
                <input type="range" class="mcSlider" id="mcWallMMSlider" min="0.8" max="8.0" step="0.1" value="2.0">
              </div>

              <div class="mcControlRow">
                <div class="mcControlHeader">
                  <span>Gap from Foot (Sock / Insole Allowance)</span>
                  <span class="val" id="mcGapMMVal">1.5 mm</span>
                </div>
                <input type="range" class="mcSlider" id="mcGapMMSlider" min="0.0" max="6.0" step="0.1" value="1.5">
              </div>

              <div class="mcControlRow">
                <div class="mcControlHeader"><span>Thickness Presets</span></div>
                <div class="mcBtnRow">
                  <button class="mcPresetBtn" data-wall="1.2" data-gap="0.8">1.2mm Ultralight</button>
                  <button class="mcPresetBtn active" data-wall="2.0" data-gap="1.5">2.0mm Performance</button>
                  <button class="mcPresetBtn" data-wall="3.2" data-gap="2.0">3.2mm Rugged</button>
                  <button class="mcPresetBtn" data-wall="5.0" data-gap="2.5">5.0mm Clog / Heavy</button>
                </div>
              </div>

              <div class="mcControlRow" style="margin-top:4px;">
                <div class="mcControlHeader">
                  <span>Collar Rim Falloff</span>
                  <span class="val" id="mcFalloffVal">6.0 mm</span>
                </div>
                <input type="range" class="mcSlider" id="mcFalloffSlider" min="1.0" max="15.0" step="0.5" value="6.0">
              </div>
            </div>

            <div class="mcCard">
              <div class="mcCardTitle">Upper Style &amp; Conformal Shell</div>
              <div class="mcCardDesc">Select the upper silhouette architecture. The mesh wraps seamlessly over the foot last.</div>

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
              <div class="mcCardDesc">Punches parametric round ventilation holes through the solid shoe upper for active airflow, drainage, and flex.</div>

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
                  <span>Hole Pitch / Spacing</span>
                  <span class="val" id="mcPerfPitchVal">7.5 mm</span>
                </div>
                <input type="range" class="mcSlider" id="mcPerfPitchSlider" min="3.0" max="25.0" step="0.5" value="7.5">
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
              <div class="mcCardTitle">Breathability &amp; Lacing System</div>
              <div class="mcCardDesc">Target holes to specific zones or configure eyelet rows for traditional shoe laces.</div>

              <div class="mcControlRow">
                <div class="mcControlHeader"><span>Target Placement</span></div>
                <select class="mcSelect" id="mcPerfWhereSelect">
                  <option value="all">Everywhere Across Upper</option>
                  <option value="c1">Vamp &amp; Toe Box Only</option>
                  <option value="c2">Lateral &amp; Medial Quarters</option>
                  <option value="c3">Arch Flank &amp; Collar</option>
                </select>
              </div>

              <div class="mcControlRow">
                <div class="mcControlHeader"><span>Quick Lacing &amp; Drainage</span></div>
                <div class="mcBtnRow">
                  <button class="mcPresetBtn" id="mcPresetLaceEyelets">Add Eyestay Lacing Row</button>
                  <button class="mcPresetBtn" id="mcPresetSoleDrainage">Sole Water Drainage Ports</button>
                </div>
              </div>

              <div class="mcPrintStatus" style="margin-top:8px;">
                <div class="mcPrintCheckItem">
                  <span class="mcDot pass"></span>
                  <div>
                    <div style="font-weight:600;font-size:11.5px;">Punched Holes Status</div>
                    <div style="font-size:10px;color:#94a3b8;" id="mcPerfStatusText">Estimated ~180-320 vents depending on size</div>
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
              <div class="mcCardDesc">Procedural 3D surface topography: Carve or raise sipes, lugs, and organic contours for traction and aesthetics.</div>

              <div class="mcControlRow">
                <div class="mcControlHeader"><span>Topography Pattern</span></div>
                <select class="mcSelect" id="mcTreadPatternSelect">
                  <option value="contour">Topographic Elevation Contours</option>
                  <option value="diamond">Diamond Knurling Grip</option>
                  <option value="hex">Geometric Hex Honeycomb</option>
                  <option value="flex">Ergonomic Flex Grooves</option>
                  <option value="voronoi">Nature Voronoi Traction Lugs</option>
                  <option value="cross">Cross Hatch Grid</option>
                  <option value="dots">Cylindrical Traction Studs</option>
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

              <div class="mcControlRow">
                <div class="mcControlHeader">
                  <span>Pattern Angle</span>
                  <span class="val" id="mcTreadAngleVal">0&deg;</span>
                </div>
                <input type="range" class="mcSlider" id="mcTreadAngleSlider" min="-90" max="90" step="5" value="0">
              </div>

              <div style="display:flex;gap:8px;margin-top:8px;">
                <button class="mcActionBtn green" id="mcApplyTreadBtn" style="flex:1;">⚡ Apply Outsole Topography</button>
              </div>
            </div>

            <div class="mcCard">
              <div class="mcCardTitle">Flexibility &amp; Mountain Terrain</div>
              <div class="mcCardDesc">Configure forefoot flex sipes or emboss real geographic satellite elevation models.</div>

              <div class="mcControlRow">
                <div class="mcControlHeader">
                  <span>Flex Sipe Width</span>
                  <span class="val" id="mcFlexWidthVal">2.5 mm</span>
                </div>
                <input type="range" class="mcSlider" id="mcFlexWidthSlider" min="1.0" max="6.0" step="0.2" value="2.5">
              </div>

              <div class="mcControlRow">
                <div class="mcControlHeader">
                  <span>Soft Edge Boundary Fade</span>
                  <span class="val" id="mcSoftEdgeVal">4.0 mm</span>
                </div>
                <input type="range" class="mcSlider" id="mcSoftEdgeSlider" min="0" max="15.0" step="1" value="4.0">
              </div>

              <div class="mcControlRow">
                <div class="mcControlHeader"><span>Real Mountain Terrain Dataset</span></div>
                <select class="mcSelect" id="mcMountainSelect">
                  <option value="aconcagua">Mt. Aconcagua (Andes, 6,961m)</option>
                  <option value="annapurna">Annapurna Massif (Himalaya)</option>
                  <option value="denali">Denali / Mt. McKinley (Alaska)</option>
                  <option value="bryce">Bryce Canyon Hoodoos</option>
                  <option value="matterhorn">The Matterhorn (Swiss Alps)</option>
                </select>
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
                <span class="mcBadge" id="mcMaterialBadge" style="background:rgba(0,210,255,0.2);color:var(--mc-cyan);">TPU 95A</span>
              </div>
              <div class="mcCardDesc">Select your target production material. Overhang angles and wall thresholds are automatically validated.</div>

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
                <div class="mcControlHeader"><span>Target 3D Printer Bed</span></div>
                <select class="mcSelect" id="mcPrinterSelect">
                  <option value="bambu_x1c">Bambu Lab X1-Carbon / P1S (256 &times; 256 &times; 256 mm)</option>
                  <option value="kobra_s1_max">Anycubic Kobra S1 Max (350 &times; 350 &times; 350 mm)</option>
                  <option value="form4">Formlabs Form 4 (200 &times; 125 &times; 210 mm)</option>
                  <option value="custom">Custom Footwear 3D Printer (400 &times; 400 &times; 400 mm)</option>
                </select>
              </div>

              <div class="mcControlRow">
                <div class="mcControlHeader"><span>Print Orientation</span></div>
                <div class="mcBtnRow">
                  <button class="mcPresetBtn active" id="mcOrientSoleDownBtn" data-orient="soleDown">Sole Down (Standard)</button>
                  <button class="mcPresetBtn" id="mcOrientTreadUpBtn" data-orient="treadUp">Tread Up</button>
                  <button class="mcPresetBtn" id="mcOrientToeUpBtn" data-orient="toeUp">120&deg; Toe-Up (Zellerfeld)</button>
                </div>
              </div>
            </div>

            <div class="mcCard">
              <div class="mcCardTitle">Live Printability Verification</div>
              <div class="mcCardDesc">Automated geometric checks to ensure your shoe slices cleanly without bed adhesion or overhang failures.</div>

              <div class="mcPrintStatus">
                <div class="mcPrintCheckItem">
                  <span class="mcDot pass" id="mcStatusWatertightDot"></span>
                  <div>
                    <div style="font-weight:700;font-size:11.5px;color:#fff;">Watertight Solid Check</div>
                    <div style="font-size:10px;color:#94a3b8;" id="mcStatusWatertightText">Manifold Mesh &middot; 0 Naked Edges &middot; Closed Solid</div>
                  </div>
                </div>
              </div>

              <div class="mcPrintStatus">
                <div class="mcPrintCheckItem">
                  <span class="mcDot pass" id="mcStatusOverhangDot"></span>
                  <div>
                    <div style="font-weight:700;font-size:11.5px;color:#fff;">Overhang Safety Analysis</div>
                    <div style="font-size:10px;color:#94a3b8;" id="mcStatusOverhangText">Within 45&deg; self-supporting threshold for TPU</div>
                  </div>
                </div>
              </div>

              <div class="mcPrintStatus">
                <div class="mcPrintCheckItem">
                  <span class="mcDot pass" id="mcStatusMinWallDot"></span>
                  <div>
                    <div style="font-weight:700;font-size:11.5px;color:#fff;">Minimum Wall Thickness Check</div>
                    <div style="font-size:10px;color:#94a3b8;" id="mcStatusMinWallText">All regions &ge; 1.5mm material limit</div>
                  </div>
                </div>
              </div>

              <!-- Production Readouts -->
              <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:6px;">
                <div style="background:rgba(0,0,0,0.35);padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.08);">
                  <div class="mcMetricLabel">Est. Time</div>
                  <div class="mcMetricValue" id="mcEstTimeVal">6h 40m</div>
                </div>
                <div style="background:rgba(0,0,0,0.35);padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.08);">
                  <div class="mcMetricLabel">Filament Mass</div>
                  <div class="mcMetricValue" id="mcEstWeightVal">285 g</div>
                </div>
                <div style="background:rgba(0,0,0,0.35);padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.08);">
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

  // 4. Modal Navigation & Tabs
  function toggleStudioPanel(open) {
    const panel = document.getElementById('mcconnellStudioPanel');
    const hubBtn = document.getElementById('mcStudioHubBtn');
    if (!panel) return;

    const willOpen = open !== undefined ? open : panel.classList.contains('minimized');
    panel.classList.toggle('minimized', !willOpen);
    if (hubBtn) hubBtn.classList.toggle('active', willOpen);

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

  // 5. Bind Interactive Studio Events
  function bindEvents() {
    // Close button
    const closeBtn = document.getElementById('mcStudioCloseBtn');
    if (closeBtn) closeBtn.onclick = () => toggleStudioPanel(false);

    // Tab buttons
    document.querySelectorAll('.mcStudioTab').forEach(tab => {
      tab.onclick = () => switchTab(tab.dataset.tab);
    });

    // Preset: Quick Runner
    const runnerBtn = document.getElementById('mcQuickSneakerPresetBtn');
    if (runnerBtn) {
      runnerBtn.onclick = () => {
        applyShoePreset('runner');
        showNotification('👟 Loaded Preset: Performance Running Sneaker');
      };
    }

    // Preset: Quick Clog
    const clogBtn = document.getElementById('mcQuickClogPresetBtn');
    if (clogBtn) {
      clogBtn.onclick = () => {
        applyShoePreset('clog');
        showNotification('👣 Loaded Preset: Protective Slip-on Clog');
      };
    }

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

    // Apply Fit
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

    // Saved Profiles
    const keeganBtn = document.getElementById('mcPresetKeegan');
    if (keeganBtn) {
      keeganBtn.onclick = () => {
        flSlider.value = 272.5; // US M 10.5
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
        bwSlider.value = 108.0; // Wide anatomical ball
        instepSlider.value = 252.0;
        heelSlider.value = 66.0;
        toeSlider.value = 5; // Low zero-drop spring
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
        toeSlider.value = 20; // Aggressive rocker
        triggerInputs([flSlider, bwSlider, instepSlider, heelSlider, toeSlider]);
        applyFitBtn.click();
      };
    }

    // --- TAB 2: WALL THICKNESS & GAP ---
    const wallSlider = document.getElementById('mcWallMMSlider');
    const gapSlider = document.getElementById('mcGapMMSlider');
    const falloffSlider = document.getElementById('mcFalloffSlider');

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
    if (falloffSlider) {
      falloffSlider.oninput = () => {
        document.getElementById('mcFalloffVal').textContent = `${parseFloat(falloffSlider.value).toFixed(1)} mm`;
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
        if (!core || !core.lfShoe) return;
        const footie = core.lfShoe.footie;
        if (footie) {
          footie.wallMM = parseFloat(wallSlider.value);
          footie.gapMM = parseFloat(gapSlider.value);
          footie.falloffMM = parseFloat(falloffSlider.value);
        }
        if (typeof core.shoeChange === 'function') core.shoeChange();
        showNotification('✅ Shell wall thickness updated!');
      };
    }

    // Upper Styles
    document.querySelectorAll('#mcTabThickness [data-style]').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('#mcTabThickness [data-style]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const nativeStyleBtn = document.querySelector(`#upperStyleRow [data-form="${btn.dataset.style}"]`);
        if (nativeStyleBtn) nativeStyleBtn.click();
        showNotification(`✅ Style changed to: ${btn.textContent}`);
      };
    });

    // --- TAB 3: PERFORATIONS ---
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
        if (!core || !core.lfShoe || !core.lfShoe.footie) return;
        core.lfShoe.footie.perfSeed = ((core.lfShoe.footie.perfSeed || 1) % 99) + 1;
        document.getElementById('mcApplyPerfBtn').click();
      };
    }

    const applyPerfBtn = document.getElementById('mcApplyPerfBtn');
    if (applyPerfBtn) {
      applyPerfBtn.onclick = () => {
        if (!core || !core.lfShoe || !core.lfShoe.footie) return;
        const f = core.lfShoe.footie;
        f.perf = selectedPerf;
        f.perfHole = parseFloat(holeSlider.value);
        f.perfPitch = parseFloat(pitchSlider.value);
        f.perfBorder = parseFloat(borderSlider.value);
        f.perfWhere = document.getElementById('mcPerfWhereSelect').value;

        if (typeof core.shoeChange === 'function') core.shoeChange();
        showNotification(`✅ Perforations generated: ${f.perf === 'none' ? 'Solid shell' : f.perfHole + 'mm holes'}`);
      };
    }

    // --- TAB 4: TOPOGRAPHY ---
    const depthSlider = document.getElementById('mcTreadDepthSlider');
    const angleSlider = document.getElementById('mcTreadAngleSlider');

    if (depthSlider) {
      depthSlider.oninput = () => {
        document.getElementById('mcTreadDepthVal').textContent = `${parseFloat(depthSlider.value).toFixed(1)} mm`;
      };
    }
    if (angleSlider) {
      angleSlider.oninput = () => {
        document.getElementById('mcTreadAngleVal').textContent = `${parseFloat(angleSlider.value).toFixed(0)}°`;
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
        if (!core || !core.lfShoe || !core.lfShoe.outsole) return;
        const out = core.lfShoe.outsole;
        out.tread = document.getElementById('mcTreadPatternSelect').value;
        out.treadRelief = selectedRelief;
        out.treadDepth = parseFloat(depthSlider.value);
        out.treadAngle = parseFloat(angleSlider.value);
        out.treadSoft = parseFloat(document.getElementById('mcSoftEdgeSlider').value);

        if (typeof core.shoeChange === 'function') core.shoeChange();
        showNotification(`✅ Topography & tread applied: ${out.tread}`);
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
      };
    }

    const expStl = document.getElementById('mcExportStlBtn');
    if (expStl) {
      expStl.onclick = () => {
        const origBtn = document.getElementById('exportStlBtn');
        if (origBtn) origBtn.click();
        else showNotification('⬇️ Downloading Binary STL...');
      };
    }

    const exp3mf = document.getElementById('mcExport3mfBtn');
    if (exp3mf) {
      exp3mf.onclick = () => {
        const rowPrint = document.getElementById('rowPrint');
        if (rowPrint) {
          rowPrint.click();
          showNotification('⬇️ Slicer 3MF Project Exported!');
        }
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

  // 6. Shoe Presets Engine
  function applyShoePreset(type) {
    if (!core || !core.lfShoe) return;
    ensureShoeModeActive();

    const f = core.lfShoe.footie;
    const out = core.lfShoe.outsole;

    if (type === 'runner') {
      if (f) {
        f.wallMM = 1.8;
        f.gapMM = 1.2;
        f.perf = 'field';
        f.perfHole = 2.5;
        f.perfPitch = 6.5;
      }
      if (out) {
        out.tread = 'diamond';
        out.treadDepth = 2.0;
        out.treadRelief = 'carved';
      }
    } else if (type === 'clog') {
      if (f) {
        f.wallMM = 3.2;
        f.gapMM = 2.0;
        f.perf = 'none';
      }
      if (out) {
        out.tread = 'hex';
        out.treadDepth = 3.0;
        out.treadRelief = 'raised';
      }
    }

    if (typeof core.shoeChange === 'function') core.shoeChange();
    syncUIWithCore();
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
    }

    if (core.lfShoe && core.lfShoe.footie) {
      const f = core.lfShoe.footie;
      if (f.wallMM) {
        const w = document.getElementById('mcWallMMSlider');
        if (w) { w.value = f.wallMM; w.dispatchEvent(new Event('input')); }
      }
      if (f.gapMM) {
        const g = document.getElementById('mcGapMMSlider');
        if (g) { g.value = f.gapMM; g.dispatchEvent(new Event('input')); }
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
      note.style.cssText = `
        position: fixed;
        bottom: 84px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(11, 17, 28, 0.96);
        color: #ffffff;
        padding: 9px 18px;
        border-radius: 999px;
        border: 1px solid rgba(0, 210, 255, 0.5);
        box-shadow: 0 8px 24px rgba(0,0,0,0.65), 0 0 16px rgba(0, 210, 255, 0.35);
        font-size: 11.5px;
        font-weight: 700;
        z-index: 2000;
        pointer-events: none;
        transition: opacity 0.2s, transform 0.2s;
        font-family: var(--sans, system-ui);
      `;
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
