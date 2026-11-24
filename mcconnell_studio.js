/**
 * McConnell Meshes — Generative 3D Footwear Design & 3D Print Studio
 * Created by Keegan McConnell (@keeganrmc)
 * 
 * Features:
 * 1. 3D Shoe Modeling Architecture: Launches directly with full 3D shoe over a flat standing last.
 * 2. 3D Interactive Cage Edit: Real-time 24-point control cage with bilateral symmetry for direct silhouette shaping.
 * 3. Tactile Surface Sculpt: Push, pull, and smooth 3D surface modeling brushes.
 * 4. Modular Shoe Form Tools: Collar & Openings, Wall Thickness & Gap, Perforations, Sole & Tread Grip, Foot Sizing.
 * 5. Scandinavian Architectural Light Theme: Clean, high-contrast, zero-emoji UI.
 * 6. High-Precision Floating Tooltips: Rich footwear and 3D printing guidance on hover.
 * 7. 1-Click Binary STL Export: Instant export for Bambu Studio, OrcaSlicer, PrusaSlicer, and Cura.
 */

(function () {
  'use strict';

  let core = null;
  let activeMode = 'cage';

  // Comprehensive Tooltip Database (Zero emojis, pure precision guidance)
  const TOOLTIP_DATABASE = {
    // Top Bar Modeling Tool Modes
    'toolCageBtn': {
      title: 'Cage Edit (Move Points)',
      desc: 'Interactive 3D control handles around the shoe. Click and drag the glowing points to pull, push, and deform the shoe silhouette.',
      tip: 'Enable Symmetry to shape both lateral and medial sides evenly. Drag with left click; orbit camera outside points.'
    },
    'toolSculptBtn': {
      title: 'Surface Sculpt (Push & Pull)',
      desc: 'Freehand surface sculpting brush. Push outward to inflate, pull inward to indent, or smooth the mesh surface.',
      tip: 'Great for building custom arch support, toe clearance, or ergonomic relief zones.'
    },
    'toolCollarBtn': {
      title: 'Collar & Openings',
      desc: 'Shape the foot opening topline: heel collar height, ankle dip, throat opening depth, and open-back or peep-toe styles.',
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

    // Action Triggers & Navigation
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
    },

    // Inspector Controls: Cage Edit
    'mcCageSymmetryBtn': {
      title: 'Bilateral Symmetry Toggle',
      desc: 'When enabled, moving a point on the lateral side mirrors identically to the medial side across the shoe centerline.',
      tip: 'Turn off for asymmetrical athletic or custom orthopedic designs.'
    },
    'mcCageRadiusSlider': {
      title: 'Deformation Influence Radius (mm)',
      desc: 'Sets how wide the soft radial falloff extends around the dragged cage point.',
      tip: 'Larger radius yields broad aerodynamic curves; smaller radius yields sharp localized changes.'
    },
    'mcCageStrengthSlider': {
      title: 'Pull Strength Multiplier',
      desc: 'Controls how aggressively the underlying shoe mesh vertices follow the control point.',
      tip: 'Default 1.0x provides a 1:1 proportional drag response.'
    },
    'mcResetCageBtn': {
      title: 'Reset Cage Points',
      desc: 'Restores all control points and deformed vertices back to the baseline shoe shape.',
      tip: 'Non-destructive: allows you to start shaping from a clean slate.'
    },

    // Inspector Controls: Sculpt
    'mcSculptPushBtn': {
      title: 'Push Mode (Inflate)',
      desc: 'Pushes shoe surface outward along local vertex normals to create volume and bumps.',
      tip: 'Ideal for widening toe room or building custom arch domes.'
    },
    'mcSculptPullBtn': {
      title: 'Pull Mode (Indent)',
      desc: 'Pulls shoe surface inward to create aerodynamic channels, recesses, or cut lines.',
      tip: 'Use to carve out flex notches or sleek side recesses.'
    },
    'mcSculptSmoothBtn': {
      title: 'Smooth Mode',
      desc: 'Relaxes and evens out surface bumps and irregularities.',
      tip: 'Smooths transitions after aggressive push or pull strokes.'
    },
    'mcSculptRadiusSlider': {
      title: 'Sculpt Brush Radius (mm)',
      desc: 'Diameter of the circular sculpting brush on the shoe surface.',
      tip: 'Use larger sizes for overall volume, smaller for precision details.'
    },
    'mcSculptStrengthSlider': {
      title: 'Sculpt Brush Strength',
      desc: 'Displacement applied to the surface per stroke.',
      tip: 'Lower values give subtle, organic control.'
    },

    // Inspector Controls: Collar
    'mcCollarBackSlider': {
      title: 'Heel Collar Height (mm)',
      desc: 'Elevation of the rear Achilles collar above the sole line.',
      tip: 'Range: 45mm for low-cut athletic sneakers to 80mm for mid-top support.'
    },
    'mcCollarSideSlider': {
      title: 'Lateral Ankle Dip (mm)',
      desc: 'Height of the collar under the ankle bones (malleoli).',
      tip: 'A deeper dip prevents collar rubbing against the lateral ankle bone.'
    },
    'mcCollarThroatSlider': {
      title: 'Throat Depth & Opening',
      desc: 'Controls how far forward the entry opening extends along the shoe instep.',
      tip: 'A deeper throat makes the shoe easier to slip on and off.'
    },

    // Inspector Controls: Thickness
    'mcUpperWallSlider': {
      title: 'Upper Shell Wall Thickness (mm)',
      desc: 'Solid shell thickness of the printable shoe upper.',
      tip: '2.0mm in TPU 95A provides optimal flex, tear resistance, and breathability.'
    },
    'mcMidsoleWallSlider': {
      title: 'Midsole Wall Thickness (mm)',
      desc: 'Outer boundary wall thickness for the midsole cushion.',
      tip: '2.0mm to 2.5mm ensures strong sidewall durability.'
    },
    'mcComfortGapSlider': {
      title: 'Foot Comfort Standoff Gap (mm)',
      desc: 'Radial air clearance between the foot last and the inner shoe wall.',
      tip: '1.2mm ensures a snug, blister-free fit with standard athletic socks.'
    },

    // Inspector Controls: Sole & Tread
    'mcHeelStackSlider': {
      title: 'Heel Cushion Stack (mm)',
      desc: 'Total cushioning height under the heel.',
      tip: 'Standard athletic range: 18mm to 30mm.'
    },
    'mcToeStackSlider': {
      title: 'Forefoot Cushion Stack (mm)',
      desc: 'Total cushioning height under the ball of the foot.',
      tip: 'Maintains a natural, healthy foot stance when balanced with heel stack.'
    },
    'mcSidewallFlareSlider': {
      title: 'Sidewall Flare (mm)',
      desc: 'Outward widening of the sole base for lateral stability.',
      tip: 'Flaring the base prevents ankle rollover during lateral cuts.'
    },
    'mcTreadPatternSelect': {
      title: 'Outsole Traction Pattern',
      desc: 'Geometric tread design carved or extruded onto the bottom ground-contact surface.',
      tip: 'Hexagonal honeycomb offers multidirectional traction; sipes provide wet flex grip.'
    },
    'mcTreadDepthSlider': {
      title: 'Tread Lug Depth (mm)',
      desc: 'Depth of the traction sipes or protruding lugs.',
      tip: '2.0mm to 3.0mm gives long-lasting road grip without unnecessary weight.'
    }
  };

  // 3D Cage State
  let cageGroup = null;
  let cageHandles = [];
  let cageLines = null;
  let isDraggingCageHandle = false;
  let activeCageHandle = null;
  let dragPlane = null;
  let dragOffset = null;
  let cageSymmetry = true;
  let cageRadius = 50; // mm influence
  let cageStrength = 1.0;
  let baseUpperPositions = null;
  let baseSolePositions = null;
  let raycaster = null;
  let mouse = null;
  let isOrbitTemporarilyLocked = false;

  // 3D Sculpt State
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
    init3DCageEngine();
    initSculptEngine();
    syncUIWithCore();
    ensureShoeAndLastVisible();

    console.log('McConnell Meshes 3D Modeling Studio initialized successfully.');
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

      // Park native title into data-mctitle to completely suppress native browser OS tooltip
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

  // 2. Wire Top Bar Tool Modes & Action Buttons
  function wireTopBarModeBar() {
    const modePills = document.querySelectorAll('.mcModeBar .mcModePill');
    modePills.forEach(pill => {
      pill.onclick = () => {
        const mode = pill.dataset.mode;
        setToolMode(mode);
      };
    });

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

    // Quick STL Export
    const quickStl = document.getElementById('quickExportStlBtn');
    if (quickStl) {
      quickStl.onclick = () => triggerBinarySTLExport();
    }

    // Technical Specs Button in Top Bar
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

  // 3. Technical Specs Modal (Kept tucked away on demand)
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
      const tile = document.getElementById('shoeTile');
      const body = document.getElementById('mcSpecsBody');
      if (body) {
        body.innerHTML = (tile && tile.innerHTML) ? tile.innerHTML : '<div class="shoeTileHead">Calculating shoe specifications...</div>';
      }
      modal.style.display = 'flex';
    } else {
      modal.style.display = 'none';
    }
  }

  // 4. Compact 3D Tool Inspector (Right Dock)
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
              <span class="val" id="mcCollarBackVal">58 mm</span>
            </div>
            <input type="range" class="mcSlider" id="mcCollarBackSlider" min="40" max="85" step="1" value="58">
          </div>

          <div class="mcControlRow">
            <div class="mcControlHeader">
              <span>Lateral Collar Dip</span>
              <span class="val" id="mcCollarSideVal">46 mm</span>
            </div>
            <input type="range" class="mcSlider" id="mcCollarSideSlider" min="30" max="65" step="1" value="46">
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
              <span>Upper Wall Thickness</span>
              <span class="val" id="mcUpperWallVal">2.0 mm</span>
            </div>
            <input type="range" class="mcSlider" id="mcUpperWallSlider" min="1.0" max="5.5" step="0.1" value="2.0">
          </div>

          <div class="mcControlRow">
            <div class="mcControlHeader">
              <span>Midsole Wall Thickness</span>
              <span class="val" id="mcMidsoleWallVal">2.0 mm</span>
            </div>
            <input type="range" class="mcSlider" id="mcMidsoleWallSlider" min="1.5" max="5.0" step="0.1" value="2.0">
          </div>

          <div class="mcControlRow">
            <div class="mcControlHeader">
              <span>Foot Comfort Standoff Gap</span>
              <span class="val" id="mcComfortGapVal">1.2 mm</span>
            </div>
            <input type="range" class="mcSlider" id="mcComfortGapSlider" min="0.5" max="3.0" step="0.1" value="1.2">
          </div>

          <div class="mcPrintCheckItem" style="margin-top:6px;">
            <span class="mcDot pass"></span>
            <div>
              <div style="font-weight:700;font-size:11.5px;color:#0f172a;">Printability Check</div>
              <div style="font-size:10.5px;color:#64748b;" id="mcThicknessEstimateText">Optimized for TPU 95A / 90A (~95g estimated)</div>
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
              <span class="val" id="mcToeStackVal">16 mm</span>
            </div>
            <input type="range" class="mcSlider" id="mcToeStackSlider" min="10" max="28" step="1" value="16">
          </div>

          <div class="mcControlRow">
            <div class="mcControlHeader">
              <span>Sidewall Flare</span>
              <span class="val" id="mcSidewallFlareVal">1.0 mm</span>
            </div>
            <input type="range" class="mcSlider" id="mcSidewallFlareSlider" min="-3" max="16" step="0.5" value="1.0">
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
            Anatomical last calibration. The base shoe automatically re-grades around your foot measurements.
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
              <span class="val" id="mcFootLengthVal">267 mm</span>
            </div>
            <input type="range" class="mcSlider" id="mcFootLengthSlider" min="220" max="310" step="1" value="267">
          </div>

          <div class="mcControlRow">
            <div class="mcControlHeader"><span>Fitting Width</span></div>
            <div class="mcBtnRow">
              <button class="mcPresetBtn" id="mcFitBBtn" data-fit="1">B (Narrow)</button>
              <button class="mcPresetBtn active" id="mcFitDBtn" data-fit="3">D (Standard)</button>
              <button class="mcPresetBtn" id="mcFitEEBtn" data-fit="5">EE (Wide)</button>
              <button class="mcPresetBtn" id="mcFit4EBtn" data-fit="6">4E (Extra Wide)</button>
            </div>
          </div>

          <div class="mcControlRow">
            <div class="mcControlHeader">
              <span>Instep Girth</span>
              <span class="val" id="mcInstepGirthVal">257 mm</span>
            </div>
            <input type="range" class="mcSlider" id="mcInstepGirthSlider" min="210" max="310" step="1" value="257">
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(panel);

    // Inspector toggle minimize button
    const toggleBtn = document.getElementById('mcInspectorToggleBtn');
    if (toggleBtn) {
      toggleBtn.onclick = () => {
        panel.classList.toggle('minimized');
        toggleBtn.textContent = panel.classList.contains('minimized') ? '+' : '−';
      };
    }

    bindToolInspectorEvents();
  }

  // 5. Tool Mode Switching Logic
  function setToolMode(mode) {
    activeMode = mode;

    // Update active top bar mode pill
    document.querySelectorAll('.mcModeBar .mcModePill').forEach(p => {
      p.classList.toggle('active', p.dataset.mode === mode);
    });

    // Make sure inspector is visible
    const inspector = document.getElementById('mcToolInspector');
    if (inspector) inspector.classList.remove('minimized');

    // Update inspector sections
    document.querySelectorAll('.mcToolSection').forEach(sec => {
      sec.classList.remove('active');
    });

    const activeSec = document.getElementById(`mcSec${capitalize(mode)}`);
    if (activeSec) activeSec.classList.add('active');

    // Update inspector title & badge
    const titleEl = document.getElementById('mcInspectorTitle');
    const badgeEl = document.getElementById('mcInspectorBadge');
    const titles = {
      'cage': { title: 'Cage Edit', badge: '3D Points Active' },
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

    // Toggle 3D Cage visibility
    showCage(mode === 'cage');

    showNotification(`Active Tool: ${titles[mode] ? titles[mode].title : capitalize(mode)}`);
  }

  // 6. Interactive 3D Control Cage Engine
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
    if (!core) return;
    const THREE = core.THREE;

    // Clear existing handles
    while (cageGroup.children.length > 0) {
      cageGroup.remove(cageGroup.children[0]);
    }
    cageHandles = [];

    // Base coordinate reference for EU42 base shoe:
    // Length (X): ~ -105mm (Heel) to +110mm (Toe)
    // Height (Y): ~ 10mm (Ground/Sole interface) to 75mm (Collar/Instep)
    // Width (Z): ~ -44mm (Lateral) to +44mm (Medial)
    const stations = [
      { x: 92,  yMid: 24, rx: 18, ry: 15, rz: 32 },  // Toe Box
      { x: 38,  yMid: 32, rx: 24, ry: 22, rz: 46 },  // Forefoot / Ball
      { x: -28, yMid: 42, rx: 28, ry: 26, rz: 40 },  // Instep / Arch
      { x: -94, yMid: 48, rx: 28, ry: 30, rz: 36 }   // Heel / Collar
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
      // 6 radial control nodes per station:
      // 0: Top, 1: High Medial, 2: Low Medial, 3: Bottom Sole, 4: Low Lateral, 5: High Lateral
      const nodes = [
        { dy: st.ry, dz: 0 },                        // 0: Top Dorsum (Z=0)
        { dy: st.ry * 0.65, dz: st.rz * 0.85 },       // 1: High Medial
        { dy: -st.ry * 0.5, dz: st.rz * 0.95 },      // 2: Low Medial
        { dy: -st.ry * 0.85, dz: 0 },                 // 3: Bottom Sole (Z=0)
        { dy: -st.ry * 0.5, dz: -st.rz * 0.95 },     // 4: Low Lateral
        { dy: st.ry * 0.65, dz: -st.rz * 0.85 }      // 5: High Lateral
      ];

      nodes.forEach((n, nIdx) => {
        const mesh = new THREE.Mesh(sphereGeo, handleMat.clone());
        const pos = new THREE.Vector3(st.x, st.yMid + n.dy, n.dz);
        mesh.position.copy(pos);

        // Determine symmetry pairing:
        // 0 pairs with 0, 3 pairs with 3
        // 1 pairs with 5, 2 pairs with 4
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

    // Connect rings at each station
    for (let s = 0; s < 4; s++) {
      const base = s * 6;
      for (let i = 0; i < 6; i++) {
        const p1 = cageHandles[base + i].position;
        const p2 = cageHandles[base + ((i + 1) % 6)].position;
        linePoints.push(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
      }
    }

    // Connect stations longitudinally
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
      // Dragging active handle in 3D
      raycaster.setFromCamera(mouse, core.camera);
      const intersectPoint = new THREE.Vector3();
      if (raycaster.ray.intersectPlane(dragPlane, intersectPoint)) {
        const delta = new THREE.Vector3().subVectors(intersectPoint, dragOffset);

        activeCageHandle.position.copy(activeCageHandle.userData.startDragPos).add(delta);

        // Apply symmetry if enabled
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

    // Hover state over handles
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

      // Capture base vertex positions for smooth deformation delta
      captureBaseMeshPositions();

      // Setup drag plane perpendicular to camera ray
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
      showNotification('Shoe mesh deformed smoothly with 3D Cage Edit');
    }
  }

  function captureBaseMeshPositions() {
    if (!core) return;
    if (core.footieMesh && core.footieMesh.geometry && !baseUpperPositions) {
      baseUpperPositions = core.footieMesh.geometry.attributes.position.array.slice();
    }
    if (core.soleMesh && core.soleMesh.geometry && !baseSolePositions) {
      baseSolePositions = core.soleMesh.geometry.attributes.position.array.slice();
    }
  }

  function applyCageDeformation(handle, delta) {
    if (!core || !baseUpperPositions) return;

    const R = cageRadius;
    const R2 = R * R;
    const strength = cageStrength;

    // Deform Upper Shell Mesh
    if (core.footieMesh && core.footieMesh.geometry) {
      const posAttr = core.footieMesh.geometry.attributes.position;
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
        const bx = baseUpperPositions[i3];
        const by = baseUpperPositions[i3 + 1];
        const bz = baseUpperPositions[i3 + 2];

        // Primary handle influence
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

        // Symmetrical handle influence
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
      core.footieMesh.geometry.computeVertexNormals();
    }

    // Deform Midsole Mesh if present
    if (core.soleMesh && core.soleMesh.geometry && baseSolePositions) {
      const posAttr = core.soleMesh.geometry.attributes.position;
      const arr = posAttr.array;
      const count = posAttr.count;
      const h0 = handle.userData.basePos;

      for (let i = 0; i < count; i++) {
        const i3 = i * 3;
        const bx = baseSolePositions[i3];
        const by = baseSolePositions[i3 + 1];
        const bz = baseSolePositions[i3 + 2];

        const dx = bx - h0.x;
        const dy = by - h0.y;
        const dz = bz - h0.z;
        const d2 = dx * dx + dy * dy + dz * dz;

        if (d2 < R2) {
          const t = 1 - d2 / R2;
          const w = t * t * strength * 0.85;
          arr[i3] = bx + delta.x * w;
          arr[i3 + 1] = by + delta.y * w;
          arr[i3 + 2] = bz + delta.z * w;
        }
      }

      posAttr.needsUpdate = true;
      core.soleMesh.geometry.computeVertexNormals();
    }
  }

  function resetCagePoints() {
    cageHandles.forEach(h => {
      h.position.copy(h.userData.basePos);
    });
    updateCageLines();

    // Restore base vertex positions
    if (core && core.footieMesh && core.footieMesh.geometry && baseUpperPositions) {
      core.footieMesh.geometry.attributes.position.array.set(baseUpperPositions);
      core.footieMesh.geometry.attributes.position.needsUpdate = true;
      core.footieMesh.geometry.computeVertexNormals();
    }
    if (core && core.soleMesh && core.soleMesh.geometry && baseSolePositions) {
      core.soleMesh.geometry.attributes.position.array.set(baseSolePositions);
      core.soleMesh.geometry.attributes.position.needsUpdate = true;
      core.soleMesh.geometry.computeVertexNormals();
    }

    baseUpperPositions = null;
    baseSolePositions = null;
    showNotification('Cage points and shoe mesh reset to base shape.');
  }

  // 7. Surface Sculpt Engine
  function initSculptEngine() {
    if (!core) return;
    const dom = core.renderer.domElement;

    dom.addEventListener('pointerdown', (e) => {
      if (activeMode !== 'sculpt' || e.button !== 0 || e.shiftKey) return;
      const targetMesh = core.footieMesh || core.soleMesh;
      if (!targetMesh) return;

      const rect = dom.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, core.camera);
      const hits = raycaster.intersectObject(targetMesh);
      if (hits.length > 0) {
        e.preventDefault();
        e.stopImmediatePropagation();
        isSculptDragging = true;
        applySculptStroke(hits[0]);
      }
    }, true);

    dom.addEventListener('pointermove', (e) => {
      if (activeMode !== 'sculpt' || !isSculptDragging) return;
      const targetMesh = core.footieMesh || core.soleMesh;
      if (!targetMesh) return;

      const rect = dom.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, core.camera);
      const hits = raycaster.intersectObject(targetMesh);
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

    captureBaseMeshPositions();

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

  // 8. Bind Tool Inspector Controls & Parameter Inputs
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

    // Mode 3: Collar & Openings
    const backSlider = document.getElementById('mcCollarBackSlider');
    const backVal = document.getElementById('mcCollarBackVal');
    if (backSlider && backVal) {
      backSlider.oninput = () => {
        const v = parseFloat(backSlider.value);
        backVal.textContent = `${v} mm`;
        if (core && core.shoe) {
          core.shoe.back = v;
          core.shoe.backShare = v / 281.8;
          triggerShoeChange();
        }
      };
    }

    const sideSlider = document.getElementById('mcCollarSideSlider');
    const sideVal = document.getElementById('mcCollarSideVal');
    if (sideSlider && sideVal) {
      sideSlider.oninput = () => {
        const v = parseFloat(sideSlider.value);
        sideVal.textContent = `${v} mm`;
        if (core && core.shoe) {
          core.shoe.side = v;
          core.shoe.sideShare = v / 281.8;
          triggerShoeChange();
        }
      };
    }

    const throatSlider = document.getElementById('mcCollarThroatSlider');
    const throatVal = document.getElementById('mcCollarThroatVal');
    if (throatSlider && throatVal) {
      throatSlider.oninput = () => {
        const v = parseFloat(throatSlider.value);
        throatVal.textContent = v.toFixed(2);
        if (core && core.shoe) {
          core.shoe.throat = v;
          triggerShoeChange();
        }
      };
    }

    const fSlipon = document.getElementById('mcFormSliponBtn');
    const fClog = document.getElementById('mcFormClogBtn');
    const fMule = document.getElementById('mcFormMuleBtn');
    if (fSlipon && fClog && fMule) {
      fSlipon.onclick = () => {
        setUpperForm('slipon', false);
        fSlipon.classList.add('active'); fClog.classList.remove('active'); fMule.classList.remove('active');
      };
      fClog.onclick = () => {
        setUpperForm('clog', true);
        fClog.classList.add('active'); fSlipon.classList.remove('active'); fMule.classList.remove('active');
      };
      fMule.onclick = () => {
        setUpperForm('mule', true);
        fMule.classList.add('active'); fSlipon.classList.remove('active'); fClog.classList.remove('active');
      };
    }

    const tClosed = document.getElementById('mcToeClosedBtn');
    const tPeep = document.getElementById('mcToePeepBtn');
    const tOpen = document.getElementById('mcToeOpenBtn');
    if (tClosed && tPeep && tOpen) {
      tClosed.onclick = () => {
        setToeStyle('closed', 50);
        tClosed.classList.add('active'); tPeep.classList.remove('active'); tOpen.classList.remove('active');
      };
      tPeep.onclick = () => {
        setToeStyle('peep', 35);
        tPeep.classList.add('active'); tClosed.classList.remove('active'); tOpen.classList.remove('active');
      };
      tOpen.onclick = () => {
        setToeStyle('open', 65);
        tOpen.classList.add('active'); tClosed.classList.remove('active'); tPeep.classList.remove('active');
      };
    }

    // Mode 4: Wall Thickness & Gap
    const upWall = document.getElementById('mcUpperWallSlider');
    const upWallVal = document.getElementById('mcUpperWallVal');
    if (upWall && upWallVal) {
      upWall.oninput = () => {
        const v = parseFloat(upWall.value);
        upWallVal.textContent = `${v.toFixed(1)} mm`;
        if (core && core.shoe) {
          core.shoe.fWall = v;
          triggerShoeChange();
        }
      };
    }

    const midWall = document.getElementById('mcMidsoleWallSlider');
    const midWallVal = document.getElementById('mcMidsoleWallVal');
    if (midWall && midWallVal) {
      midWall.oninput = () => {
        const v = parseFloat(midWall.value);
        midWallVal.textContent = `${v.toFixed(1)} mm`;
        if (core && core.shoe) {
          core.shoe.sWall = v;
          triggerShoeChange();
        }
      };
    }

    const gapSlider = document.getElementById('mcComfortGapSlider');
    const gapVal = document.getElementById('mcComfortGapVal');
    if (gapSlider && gapVal) {
      gapSlider.oninput = () => {
        const v = parseFloat(gapSlider.value);
        gapVal.textContent = `${v.toFixed(1)} mm`;
        if (core && core.shoe) {
          core.shoe.gap = v;
          triggerShoeChange();
        }
      };
    }

    // Mode 5: Perforations
    const hField = document.getElementById('mcHolesFieldBtn');
    const hBrogue = document.getElementById('mcHolesBrogueBtn');
    const hNone = document.getElementById('mcHolesNoneBtn');
    if (hField && hBrogue && hNone) {
      hField.onclick = () => {
        setHolesPattern('flow');
        hField.classList.add('active'); hBrogue.classList.remove('active'); hNone.classList.remove('active');
      };
      hBrogue.onclick = () => {
        setHolesPattern('accent');
        hBrogue.classList.add('active'); hField.classList.remove('active'); hNone.classList.remove('active');
      };
      hNone.onclick = () => {
        setHolesPattern('none');
        hNone.classList.add('active'); hField.classList.remove('active'); hBrogue.classList.remove('active');
      };
    }

    const hSize = document.getElementById('mcHolesSizeSlider');
    const hSizeVal = document.getElementById('mcHolesSizeVal');
    if (hSize && hSizeVal) {
      hSize.oninput = () => {
        const v = parseFloat(hSize.value);
        hSizeVal.textContent = `${v.toFixed(1)} mm`;
        if (core && core.shoe && core.shoe.f) {
          core.shoe.f.openCell = v * 5;
          core.shoe.f.perfHole = v;
          triggerShoeChange();
        }
      };
    }

    const hPitch = document.getElementById('mcHolesPitchSlider');
    const hPitchVal = document.getElementById('mcHolesPitchVal');
    if (hPitch && hPitchVal) {
      hPitch.oninput = () => {
        const v = parseFloat(hPitch.value);
        hPitchVal.textContent = `${v.toFixed(1)} mm`;
        if (core && core.shoe && core.shoe.f) {
          core.shoe.f.openStrap = v;
          core.shoe.f.perfPitch = v;
          triggerShoeChange();
        }
      };
    }

    const applyHolesBtn = document.getElementById('mcApplyHolesBtn');
    if (applyHolesBtn) {
      applyHolesBtn.onclick = () => {
        triggerShoeChange();
        showNotification('Perforations punched across upper.');
      };
    }

    // Mode 6: Sole & Tread Grip
    const heelStack = document.getElementById('mcHeelStackSlider');
    const heelStackVal = document.getElementById('mcHeelStackVal');
    if (heelStack && heelStackVal) {
      heelStack.oninput = () => {
        const v = parseFloat(heelStack.value);
        heelStackVal.textContent = `${v} mm`;
        if (core && core.shoe) {
          core.shoe.stack = v;
          core.shoe.stackShare = v / 281.8;
          triggerShoeChange();
        }
      };
    }

    const toeStack = document.getElementById('mcToeStackSlider');
    const toeStackVal = document.getElementById('mcToeStackVal');
    if (toeStack && toeStackVal) {
      toeStack.oninput = () => {
        const v = parseFloat(toeStack.value);
        toeStackVal.textContent = `${v} mm`;
        if (core && core.shoe) {
          core.shoe.stackToe = v;
          core.shoe.stackToeShare = v / 281.8;
          triggerShoeChange();
        }
      };
    }

    const flareSlider = document.getElementById('mcSidewallFlareSlider');
    const flareVal = document.getElementById('mcSidewallFlareVal');
    if (flareSlider && flareVal) {
      flareSlider.oninput = () => {
        const v = parseFloat(flareSlider.value);
        flareVal.textContent = `${v.toFixed(1)} mm`;
        if (core && core.shoe) {
          core.shoe.flare = v;
          core.shoe.flareShare = v / 98.5;
          triggerShoeChange();
        }
      };
    }

    const treadSelect = document.getElementById('mcTreadPatternSelect');
    if (treadSelect) {
      treadSelect.onchange = () => {
        if (core && core.shoe) {
          core.shoe.tread = treadSelect.value;
          core.shoe.terrain = 'none';
          core.shoe.relief = 0;
          triggerShoeChange();
          showNotification(`Applied Outsole Tread: ${treadSelect.options[treadSelect.selectedIndex].text}`);
        }
      };
    }

    const treadDepth = document.getElementById('mcTreadDepthSlider');
    const treadDepthVal = document.getElementById('mcTreadDepthVal');
    if (treadDepth && treadDepthVal) {
      treadDepth.oninput = () => {
        const v = parseFloat(treadDepth.value);
        treadDepthVal.textContent = `${v.toFixed(1)} mm`;
        if (core && core.shoe) {
          core.shoe.floorDepth = v * 5;
          triggerShoeChange();
        }
      };
    }

    // Mode 7: Foot Sizing
    const shoeSize = document.getElementById('mcShoeSizeSlider');
    const shoeSizeVal = document.getElementById('mcShoeSizeVal');
    if (shoeSize && shoeSizeVal) {
      shoeSize.oninput = () => {
        const v = parseFloat(shoeSize.value);
        const usM = (v - 33).toFixed(1);
        shoeSizeVal.textContent = `EU ${v.toFixed(1)} (US M ${usM})`;
        if (core && core.measurements) {
          core.measurements.shoeSize = v;
          const fl = 210 + (v - 35) * 6.67;
          core.measurements.footLength = Math.round(fl);
          const flSlider = document.getElementById('mcFootLengthSlider');
          const flVal = document.getElementById('mcFootLengthVal');
          if (flSlider) flSlider.value = Math.round(fl);
          if (flVal) flVal.textContent = `${Math.round(fl)} mm`;
          triggerMeasurementChange();
        }
      };
    }

    const flSlider = document.getElementById('mcFootLengthSlider');
    const flVal = document.getElementById('mcFootLengthVal');
    if (flSlider && flVal) {
      flSlider.oninput = () => {
        const v = parseFloat(flSlider.value);
        flVal.textContent = `${v} mm`;
        if (core && core.measurements) {
          core.measurements.footLength = v;
          triggerMeasurementChange();
        }
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
          if (core && core.measurements) {
            core.measurements.fitting = parseInt(btn.dataset.fit);
            triggerMeasurementChange();
          }
        };
      }
    });

    const instepSlider = document.getElementById('mcInstepGirthSlider');
    const instepVal = document.getElementById('mcInstepGirthVal');
    if (instepSlider && instepVal) {
      instepSlider.oninput = () => {
        const v = parseFloat(instepSlider.value);
        instepVal.textContent = `${v} mm`;
        if (core && core.measurements) {
          core.measurements.instepGirth = v;
          triggerMeasurementChange();
        }
      };
    }
  }

  function setUpperForm(form, openBack) {
    if (!core || !core.shoe) return;
    core.shoe.upperForm = form;
    core.shoe.openBack = !!openBack;
    triggerShoeChange();
  }

  function setToeStyle(style, toeMM) {
    if (!core || !core.shoe) return;
    core.shoe.toe = style;
    core.shoe.toeMM = toeMM;
    triggerShoeChange();
  }

  function setHolesPattern(pat) {
    if (!core || !core.shoe) return;
    if (!core.shoe.f) core.shoe.f = {};
    core.shoe.f.open = pat;
    triggerShoeChange();
  }

  function triggerShoeChange() {
    if (core && typeof core.shoeChange === 'function') {
      core.shoeChange();
    }
  }

  function triggerMeasurementChange() {
    if (core) {
      if (typeof core.refreshAll === 'function') core.refreshAll();
      else if (typeof core.rebuildMeshObject === 'function') core.rebuildMeshObject();
    }
  }

  // 9. Sync UI with Core State
  function syncUIWithCore() {
    if (!core) return;
    const s = core.shoe;
    const m = core.measurements;

    if (s) {
      const bSlider = document.getElementById('mcCollarBackSlider');
      const bVal = document.getElementById('mcCollarBackVal');
      if (bSlider) bSlider.value = s.back;
      if (bVal) bVal.textContent = `${s.back} mm`;

      const sSlider = document.getElementById('mcCollarSideSlider');
      const sVal = document.getElementById('mcCollarSideVal');
      if (sSlider) sSlider.value = s.side;
      if (sVal) sVal.textContent = `${s.side} mm`;

      const thSlider = document.getElementById('mcCollarThroatSlider');
      const thVal = document.getElementById('mcCollarThroatVal');
      if (thSlider) thSlider.value = s.throat;
      if (thVal) thVal.textContent = s.throat.toFixed(2);

      const wSlider = document.getElementById('mcUpperWallSlider');
      const wVal = document.getElementById('mcUpperWallVal');
      if (wSlider) wSlider.value = s.fWall;
      if (wVal) wVal.textContent = `${s.fWall.toFixed(1)} mm`;

      const hsSlider = document.getElementById('mcHeelStackSlider');
      const hsVal = document.getElementById('mcHeelStackVal');
      if (hsSlider) hsSlider.value = s.stack;
      if (hsVal) hsVal.textContent = `${s.stack} mm`;

      const tsSlider = document.getElementById('mcToeStackSlider');
      const tsVal = document.getElementById('mcToeStackVal');
      if (tsSlider) tsSlider.value = s.stackToe;
      if (tsVal) tsVal.textContent = `${s.stackToe} mm`;
    }

    if (m) {
      const szSlider = document.getElementById('mcShoeSizeSlider');
      const szVal = document.getElementById('mcShoeSizeVal');
      if (szSlider) szSlider.value = m.shoeSize;
      if (szVal) {
        const usM = (m.shoeSize - 33).toFixed(1);
        szVal.textContent = `EU ${m.shoeSize.toFixed(1)} (US M ${usM})`;
      }

      const flSlider = document.getElementById('mcFootLengthSlider');
      const flVal = document.getElementById('mcFootLengthVal');
      if (flSlider) flSlider.value = m.footLength;
      if (flVal) flVal.textContent = `${m.footLength} mm`;
    }
  }

  function ensureShoeAndLastVisible() {
    if (window.__lfShow) {
      window.__lfShow.set('last', true);
      window.__lfShow.set('footie', true);
      window.__lfShow.set('sole', true);
      window.__lfShow.set('outsole', true);
    }
    if (core) {
      if (core.shoe) {
        core.shoe.footieOn = true;
        core.shoe.soleOn = true;
        core.shoe.outsoleOn = true;
      }
      if (core.lfLaid) {
        core.lfLaid.add('footie');
        core.lfLaid.add('sole');
      }
      if (typeof core.relayFootie === 'function') core.relayFootie(true);
      if (typeof core.relaySole === 'function') core.relaySole(true);
      if (typeof core.lfApplyShow === 'function') core.lfApplyShow();
      if (typeof core.rebuildShoe === 'function') core.rebuildShoe();
      if (typeof core.updateShoeInfo === 'function') core.updateShoeInfo();
    }
  }

  // 10. Binary STL Exporter
  function triggerBinarySTLExport() {
    if (!core) return;
    try {
      showNotification('Compiling watertight binary STL for 3D printing...');
      let blob = null;
      if (typeof core.buildSTLBinary === 'function') {
        blob = core.buildSTLBinary();
      } else if (typeof core.exportFootMesh === 'function') {
        blob = core.exportFootMesh('stl');
      }

      if (blob && typeof core.downloadBlob === 'function') {
        const name = (typeof core.exportFilenameBase === 'function') ? `${core.exportFilenameBase()}.stl` : 'mcconnell_shoe.stl';
        core.downloadBlob(blob, name);
        showNotification(`Exported: ${name}`);
      } else {
        const exportBtn = document.getElementById('lastExportBtn');
        if (exportBtn) exportBtn.click();
      }
    } catch (err) {
      console.warn('Direct STL export fallback:', err);
      const exportBtn = document.getElementById('lastExportBtn');
      if (exportBtn) exportBtn.click();
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
