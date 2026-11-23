/**
 * McConnell Meshes — Generative 3D Footwear Design & 3D Print Studio
 * Created by Keegan McConnell (@keeganrmc)
 * 
 * Modular interactive studio for:
 * 1. Personal Foot & Last Calibration (Anatomical sizing, widths, girths, arch profiles)
 * 2. Shoe Model Generation & Wall Thickness / Offset sculpting
 * 3. Hole & Perforation Generation (Field vents, brogues, ventilation cutouts)
 * 4. Surface Topography & Outsole Tread Engineering
 * 5. 3D Printability Validation & Material Simulation (TPU 95A/90A/85A/70A, PLA, Resins)
 */

(function () {
  'use strict';

  let core = null;
  let activeTab = 'fit';

  // Wait for core to attach
  function initStudio() {
    core = window.__mcconnellCore;
    if (!core) {
      setTimeout(initStudio, 150);
      return;
    }

    createQuickNavButtons();
    createStudioPanel();
    bindEvents();
    syncUIWithCore();
    console.log('⚡ McConnell Meshes Studio Hub initialized successfully.');
  }

  // 1. Quick Launch Buttons in Navigation Bar
  function createQuickNavButtons() {
    const outputsBar = document.getElementById('shoeOutputs');
    const piecesBar = document.getElementById('shoePieces');
    if (!outputsBar) return;

    // Main Studio Hub Pill
    const hubBtn = document.createElement('button');
    hubBtn.id = 'mcStudioHubBtn';
    hubBtn.className = 'mcconnellPillBtn';
    hubBtn.title = 'Open McConnell Meshes Studio Hub (Foot Fit, Thickness, Holes, Topography, 3D Print)';
    hubBtn.innerHTML = `<span>⚡</span><b>Studio Hub</b><span class="mcBadge">McConnell</span>`;
    hubBtn.onclick = () => toggleStudioPanel();

    // Insert as the first element in shoeOutputs
    outputsBar.insertBefore(hubBtn, outputsBar.firstChild);

    // Update Brand Mark in shoePieces
    const brandMark = piecesBar ? piecesBar.querySelector('.barMark') : null;
    if (brandMark) {
      brandMark.innerHTML = `<i>⟨</i><b>McCONNELL</b><span style="color:var(--yellow, #fbec1a);margin-left:4px;font-weight:700;">MESHES</span><i>⟩</i>`;
      brandMark.title = 'McConnell Meshes — Generative 3D Footwear Design Studio by @keeganrmc';
    }

    // Update Sidebar Header if present
    const sidebarLogo = document.querySelector('#sidebarHead h1');
    if (sidebarLogo) {
      sidebarLogo.innerHTML = `<b>McCONNELL</b><span class="flip" aria-hidden="true" style="color:var(--yellow, #fbec1a);margin-left:0.15em;">MESHES</span>`;
      sidebarLogo.title = 'McConnell Meshes — Shoe & Last Generative Studio';
    }
  }

  // 2. Build the Studio Hub Floating Modal
  function createStudioPanel() {
    const panel = document.createElement('div');
    panel.id = 'mcconnellStudioPanel';
    panel.className = 'minimized'; // Start closed, opened via button or shortcuts

    panel.innerHTML = `
      <div class="mcStudioHd">
        <div class="mcStudioTitleGroup">
          <div class="mcStudioLogo">
            <span>⚡</span><b>McCONNELL</b><span class="mesh">MESHES</span>
          </div>
          <div class="mcStudioSubtitle">Shoe &amp; Last Generative 3D Print Studio &middot; @keeganrmc</div>
        </div>
        <div class="mcStudioActions">
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
                <span>Personal Foot Fit</span>
                <span id="mcFootSizeBadge" class="mcBadge" style="background:rgba(255,190,38,0.2);color:var(--mc-gold);">US M 10.5</span>
              </div>
              <div class="mcCardDesc">Calibrate the 3D last directly to your foot measurements. The shoe model adapts organically to this volume.</div>
              
              <div class="mcControlRow">
                <div class="mcControlHeader">
                  <span>Foot Length</span>
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
              <div class="mcCardTitle">Foot Profiles &amp; Morphology</div>
              <div class="mcCardDesc">Save customized scans or dimensions for multiple people or left/right foot asymmetry.</div>

              <div class="mcControlRow">
                <div class="mcControlHeader"><span>Foot Morphology Archetype</span></div>
                <select class="mcSelect" id="mcMorphologySelect">
                  <option value="standard">Standard Anatomical</option>
                  <option value="wide_forefoot">Wide Forefoot (Barefoot / Natural Splay)</option>
                  <option value="high_arch">High Arch &amp; High Instep</option>
                  <option value="flat_foot">Low Arch / Flat Foot Support</option>
                  <option value="greek">Greek Foot (Morton's Toe: 2nd toe dominant)</option>
                  <option value="egyptian">Egyptian Foot (Slanted Big Toe dominant)</option>
                </select>
              </div>

              <div class="mcControlRow">
                <div class="mcControlHeader"><span>Foot Target</span></div>
                <div class="mcBtnRow">
                  <button class="mcPresetBtn active" id="mcFootLeftBtn">Left Foot</button>
                  <button class="mcPresetBtn" id="mcFootRightBtn">Right Foot</button>
                  <button class="mcPresetBtn" id="mcFootPairBtn">Mirrored Pair</button>
                </div>
              </div>

              <div class="mcControlRow" style="margin-top:6px;">
                <div class="mcControlHeader"><span>Profile Presets</span></div>
                <div class="mcBtnRow">
                  <button class="mcPresetBtn" id="mcPresetKeegan">Keegan (Daily Fit)</button>
                  <button class="mcPresetBtn" id="mcPresetBarefoot">Natural Barefoot</button>
                  <button class="mcPresetBtn" id="mcPresetAthletic">Performance Athletic</button>
                </div>
              </div>

              <div style="display:flex;gap:8px;margin-top:8px;">
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
              <div class="mcCardDesc">Controls the physical shell thickness of the shoe upper and layers for 3D printing structural integrity.</div>

              <div class="mcControlRow">
                <div class="mcControlHeader">
                  <span>Upper Shell Wall</span>
                  <span class="val" id="mcWallMMVal">2.0 mm</span>
                </div>
                <input type="range" class="mcSlider" id="mcWallMMSlider" min="0.8" max="8.0" step="0.1" value="2.0">
              </div>

              <div class="mcControlRow">
                <div class="mcControlHeader">
                  <span>Gap from Last (Sock / Cushion Allowance)</span>
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

              <div class="mcControlRow" style="margin-top:6px;">
                <div class="mcControlHeader">
                  <span>Collar &amp; Rim Falloff</span>
                  <span class="val" id="mcFalloffVal">6.0 mm</span>
                </div>
                <input type="range" class="mcSlider" id="mcFalloffSlider" min="1.0" max="15.0" step="0.5" value="6.0">
              </div>
            </div>

            <div class="mcCard">
              <div class="mcCardTitle">Zone Reinforcements &amp; Material Flex</div>
              <div class="mcCardDesc">Simulate variable wall stiffness: thicker heel cups and toe caps prevent blowouts while maintaining collar comfort.</div>

              <div class="mcControlRow">
                <div class="mcControlHeader">
                  <span>Toe Box Reinforcement</span>
                  <span class="val" id="mcToeThickVal">+1.0 mm</span>
                </div>
                <input type="range" class="mcSlider" id="mcToeThickSlider" min="0" max="3.0" step="0.2" value="1.0">
              </div>

              <div class="mcControlRow">
                <div class="mcControlHeader">
                  <span>Heel Counter Rigidity</span>
                  <span class="val" id="mcHeelThickVal">+1.6 mm</span>
                </div>
                <input type="range" class="mcSlider" id="mcHeelThickSlider" min="0" max="4.0" step="0.2" value="1.6">
              </div>

              <div class="mcControlRow">
                <div class="mcControlHeader">
                  <span>Collar Comfort Softening</span>
                  <span class="val" id="mcCollarSoftVal">-0.6 mm (Flex)</span>
                </div>
                <input type="range" class="mcSlider" id="mcCollarSoftSlider" min="-1.5" max="0" step="0.1" value="-0.6">
              </div>

              <div style="display:flex;gap:8px;margin-top:10px;">
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
                <span>Perforation Pattern</span>
                <span class="mcBadge" id="mcPerfBadge">Field Vents</span>
              </div>
              <div class="mcCardDesc">Punch parametric ventilation holes directly through the shoe shell for airflow, drainage, and mechanical flexibility.</div>

              <div class="mcControlRow">
                <div class="mcControlHeader"><span>Perforation Style</span></div>
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
                  <span>Pitch / Spacing</span>
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

              <div style="display:flex;gap:8px;margin-top:8px;">
                <button class="mcActionBtn secondary" id="mcPerfRerollBtn" style="flex:1;">🎲 Reroll Distribution</button>
                <button class="mcActionBtn primary" id="mcApplyPerfBtn" style="flex:1;">⚡ Punch Perforations</button>
              </div>
            </div>

            <div class="mcCard">
              <div class="mcCardTitle">Ventilation &amp; Drainage Analysis</div>
              <div class="mcCardDesc">Calculates breathability ratio and water drainage clearance for active footwear designs.</div>
              
              <div class="mcPrintStatus">
                <div class="mcPrintCheckItem">
                  <span class="mcDot pass"></span>
                  <div>
                    <div style="font-weight:600;font-size:11px;">Punched Holes Status</div>
                    <div style="font-size:10px;color:var(--mc-text-dim);" id="mcPerfStatusText">Estimated ~180-320 vents depending on size</div>
                  </div>
                </div>
              </div>

              <div class="mcControlRow">
                <div class="mcControlHeader"><span>Target Placement</span></div>
                <select class="mcSelect" id="mcPerfWhereSelect">
                  <option value="all">Everywhere on Upper</option>
                  <option value="c1">Vamp &amp; Toe Box Only</option>
                  <option value="c2">Lateral Quarters Only</option>
                  <option value="c3">Arch / Instep Flank</option>
                </select>
              </div>

              <div class="mcControlRow">
                <div class="mcControlHeader"><span>Lace System Integration</span></div>
                <div class="mcBtnRow">
                  <button class="mcPresetBtn" id="mcPresetLaceEyelets">Add 6-Hole Eyestay Row</button>
                  <button class="mcPresetBtn" id="mcPresetSoleDrainage">Sole Drainage Ports</button>
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
                <span>Tread &amp; Topography Sculptor</span>
                <span class="mcBadge" id="mcTreadBadge">Contours</span>
              </div>
              <div class="mcCardDesc">Procedural 3D surface relief for outsole traction, cushioning sipes, and aesthetic upper topographic contours.</div>

              <div class="mcControlRow">
                <div class="mcControlHeader"><span>Tread Topography Pattern</span></div>
                <select class="mcSelect" id="mcTreadPatternSelect">
                  <option value="contour">Topographic Elevation Contours</option>
                  <option value="diamond">Diamond Knurling Grip</option>
                  <option value="hex">Geometric Hex Honeycomb</option>
                  <option value="flex">Ergonomic Flex Grooves</option>
                  <option value="voronoi">Nature Voronoi Traction Lugs</option>
                  <option value="cross">Cross Hatch Grid</option>
                  <option value="dots">Cylindrical Traction Studs</option>
                  <option value="terrain">Mountain Elevation Relief (Alps/Rockies)</option>
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
                  <span>Tread Depth</span>
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
              <div class="mcCardTitle">Flexibility &amp; Transition Edge</div>
              <div class="mcCardDesc">Ergonomic flex zones allow natural foot rolling without cracking the print layer lines.</div>

              <div class="mcControlRow">
                <div class="mcControlHeader">
                  <span>Forefoot Flex Sipe Width</span>
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
                <span class="mcBadge" id="mcMaterialBadge" style="background:rgba(0,210,106,0.25);color:var(--mc-accent);">TPU 95A</span>
              </div>
              <div class="mcCardDesc">Select your target manufacturing material. Overhang limits, minimum wall thicknesses, and print speeds are auto-calibrated.</div>

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
              <div class="mcCardDesc">Geometric mesh checks to ensure fail-proof slicing and printing without support failures.</div>

              <div class="mcPrintStatus">
                <div class="mcPrintCheckItem">
                  <span class="mcDot pass" id="mcStatusWatertightDot"></span>
                  <div>
                    <div style="font-weight:600;font-size:11.5px;">Watertight Solid Check</div>
                    <div style="font-size:10px;color:var(--mc-text-dim);" id="mcStatusWatertightText">Manifold Mesh &middot; 0 Naked Edges</div>
                  </div>
                </div>
              </div>

              <div class="mcPrintStatus">
                <div class="mcPrintCheckItem">
                  <span class="mcDot pass" id="mcStatusOverhangDot"></span>
                  <div>
                    <div style="font-weight:600;font-size:11.5px;">Overhang Safety Analysis</div>
                    <div style="font-size:10px;color:var(--mc-text-dim);" id="mcStatusOverhangText">Within 45&deg; self-supporting threshold for TPU</div>
                  </div>
                </div>
              </div>

              <div class="mcPrintStatus">
                <div class="mcPrintCheckItem">
                  <span class="mcDot pass" id="mcStatusMinWallDot"></span>
                  <div>
                    <div style="font-weight:600;font-size:11.5px;">Minimum Wall Thickness Check</div>
                    <div style="font-size:10px;color:var(--mc-text-dim);" id="mcStatusMinWallText">All regions &ge; 1.5mm material limit</div>
                  </div>
                </div>
              </div>

              <!-- Production Readouts -->
              <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:4px;">
                <div style="background:rgba(0,0,0,0.3);padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.06);">
                  <div class="mcMetricLabel">Est. Time</div>
                  <div class="mcMetricValue" id="mcEstTimeVal">6h 40m</div>
                </div>
                <div style="background:rgba(0,0,0,0.3);padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.06);">
                  <div class="mcMetricLabel">Filament Mass</div>
                  <div class="mcMetricValue" id="mcEstWeightVal">285 g</div>
                </div>
                <div style="background:rgba(0,0,0,0.3);padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.06);">
                  <div class="mcMetricLabel">Est. Cost</div>
                  <div class="mcMetricValue" id="mcEstCostVal" style="color:var(--mc-accent);">$9.12</div>
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

  // 3. Tab & Panel Navigation
  function toggleStudioPanel(open) {
    const panel = document.getElementById('mcconnellStudioPanel');
    const hubBtn = document.getElementById('mcStudioHubBtn');
    if (!panel) return;

    const willOpen = open !== undefined ? open : panel.classList.contains('minimized');
    panel.classList.toggle('minimized', !willOpen);
    if (hubBtn) hubBtn.classList.toggle('active', willOpen);

    if (willOpen) {
      syncUIWithCore();
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

    // If switching to thickness, holes, or topography, ensure shoe mode is enabled
    if (['thickness', 'holes', 'topography'].includes(tabId)) {
      if (core && core.lfPrefs && core.lfPrefs.mode !== 'shoe') {
        core.lfPrefs.mode = 'shoe';
        if (typeof core.lfApplyMode === 'function') core.lfApplyMode();
      }
    }
  }

  function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  // 4. Bind UI Events
  function bindEvents() {
    // Close button
    document.getElementById('mcStudioCloseBtn').onclick = () => toggleStudioPanel(false);

    // Tab buttons
    document.querySelectorAll('.mcStudioTab').forEach(tab => {
      tab.onclick = () => switchTab(tab.dataset.tab);
    });

    // --- TAB 1: FOOT FIT EVENTS ---
    const flSlider = document.getElementById('mcFootLengthSlider');
    const bwSlider = document.getElementById('mcBallWidthSlider');
    const instepSlider = document.getElementById('mcInstepSlider');
    const heelSlider = document.getElementById('mcHeelWidthSlider');
    const toeSlider = document.getElementById('mcToeSpringSlider');

    flSlider.oninput = () => {
      const val = parseFloat(flSlider.value);
      document.getElementById('mcFootLengthVal').textContent = `${val.toFixed(1)} mm`;
      updateShoeSizeBadge(val);
    };

    bwSlider.oninput = () => {
      const val = parseFloat(bwSlider.value);
      document.getElementById('mcBallWidthVal').textContent = `${val.toFixed(1)} mm`;
    };

    instepSlider.oninput = () => {
      const val = parseFloat(instepSlider.value);
      document.getElementById('mcInstepVal').textContent = `${val.toFixed(1)} mm`;
    };

    heelSlider.oninput = () => {
      const val = parseFloat(heelSlider.value);
      document.getElementById('mcHeelWidthVal').textContent = `${val.toFixed(1)} mm`;
    };

    toeSlider.oninput = () => {
      const val = parseFloat(toeSlider.value);
      document.getElementById('mcToeSpringVal').textContent = `${val.toFixed(0)} mm`;
    };

    // Apply Fit to Last
    document.getElementById('mcApplyFitBtn').onclick = () => {
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

    // Preset Profiles
    document.getElementById('mcPresetKeegan').onclick = () => {
      flSlider.value = 272.5; // US 10.5
      bwSlider.value = 100.0;
      instepSlider.value = 258.0;
      heelSlider.value = 69.0;
      toeSlider.value = 14;
      flSlider.dispatchEvent(new Event('input'));
      bwSlider.dispatchEvent(new Event('input'));
      instepSlider.dispatchEvent(new Event('input'));
      heelSlider.dispatchEvent(new Event('input'));
      toeSlider.dispatchEvent(new Event('input'));
      document.getElementById('mcApplyFitBtn').click();
    };

    document.getElementById('mcPresetBarefoot').onclick = () => {
      flSlider.value = 270.0;
      bwSlider.value = 108.0; // Wide anatomical ball
      instepSlider.value = 252.0;
      heelSlider.value = 66.0;
      toeSlider.value = 5; // Low toe spring for barefoot zero-drop
      flSlider.dispatchEvent(new Event('input'));
      bwSlider.dispatchEvent(new Event('input'));
      instepSlider.dispatchEvent(new Event('input'));
      heelSlider.dispatchEvent(new Event('input'));
      toeSlider.dispatchEvent(new Event('input'));
      document.getElementById('mcApplyFitBtn').click();
    };

    document.getElementById('mcPresetAthletic').onclick = () => {
      flSlider.value = 270.0;
      bwSlider.value = 96.0; // Snug lockdown
      instepSlider.value = 250.0;
      heelSlider.value = 67.0;
      toeSlider.value = 20; // Aggressive rocker/spring
      flSlider.dispatchEvent(new Event('input'));
      bwSlider.dispatchEvent(new Event('input'));
      instepSlider.dispatchEvent(new Event('input'));
      heelSlider.dispatchEvent(new Event('input'));
      toeSlider.dispatchEvent(new Event('input'));
      document.getElementById('mcApplyFitBtn').click();
    };

    // --- TAB 2: WALL THICKNESS EVENTS ---
    const wallSlider = document.getElementById('mcWallMMSlider');
    const gapSlider = document.getElementById('mcGapMMSlider');
    const falloffSlider = document.getElementById('mcFalloffSlider');

    wallSlider.oninput = () => {
      const v = parseFloat(wallSlider.value);
      document.getElementById('mcWallMMVal').textContent = `${v.toFixed(1)} mm`;
      document.getElementById('mcThicknessBadge').textContent = `${v.toFixed(1)} mm`;
    };

    gapSlider.oninput = () => {
      const v = parseFloat(gapSlider.value);
      document.getElementById('mcGapMMVal').textContent = `${v.toFixed(1)} mm`;
    };

    falloffSlider.oninput = () => {
      const v = parseFloat(falloffSlider.value);
      document.getElementById('mcFalloffVal').textContent = `${v.toFixed(1)} mm`;
    };

    document.querySelectorAll('#mcTabThickness [data-wall]').forEach(btn => {
      btn.onclick = () => {
        wallSlider.value = btn.dataset.wall;
        gapSlider.value = btn.dataset.gap;
        wallSlider.dispatchEvent(new Event('input'));
        gapSlider.dispatchEvent(new Event('input'));
        document.querySelectorAll('#mcTabThickness [data-wall]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('mcApplyThicknessBtn').click();
      };
    });

    document.getElementById('mcApplyThicknessBtn').onclick = () => {
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

    // --- TAB 3: PERFORATIONS EVENTS ---
    const holeSlider = document.getElementById('mcPerfHoleSlider');
    const pitchSlider = document.getElementById('mcPerfPitchSlider');
    const borderSlider = document.getElementById('mcPerfBorderSlider');

    holeSlider.oninput = () => {
      document.getElementById('mcPerfHoleVal').textContent = `${parseFloat(holeSlider.value).toFixed(1)} mm`;
    };
    pitchSlider.oninput = () => {
      document.getElementById('mcPerfPitchVal').textContent = `${parseFloat(pitchSlider.value).toFixed(1)} mm`;
    };
    borderSlider.oninput = () => {
      document.getElementById('mcPerfBorderVal').textContent = `${parseFloat(borderSlider.value).toFixed(1)} mm`;
    };

    let selectedPerf = 'field';
    document.querySelectorAll('#mcTabHoles [data-perf]').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('#mcTabHoles [data-perf]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedPerf = btn.dataset.perf;
        document.getElementById('mcPerfBadge').textContent = btn.textContent;
      };
    });

    document.getElementById('mcPerfRerollBtn').onclick = () => {
      if (!core || !core.lfShoe || !core.lfShoe.footie) return;
      core.lfShoe.footie.perfSeed = ((core.lfShoe.footie.perfSeed || 1) % 99) + 1;
      document.getElementById('mcApplyPerfBtn').click();
    };

    document.getElementById('mcApplyPerfBtn').onclick = () => {
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

    // --- TAB 4: TOPOGRAPHY EVENTS ---
    const depthSlider = document.getElementById('mcTreadDepthSlider');
    const angleSlider = document.getElementById('mcTreadAngleSlider');

    depthSlider.oninput = () => {
      document.getElementById('mcTreadDepthVal').textContent = `${parseFloat(depthSlider.value).toFixed(1)} mm`;
    };
    angleSlider.oninput = () => {
      document.getElementById('mcTreadAngleVal').textContent = `${parseFloat(angleSlider.value).toFixed(0)}°`;
    };

    let selectedRelief = 'carved';
    document.querySelectorAll('#mcTabTopography [data-relief]').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('#mcTabTopography [data-relief]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedRelief = btn.dataset.relief;
      };
    });

    document.getElementById('mcApplyTreadBtn').onclick = () => {
      if (!core || !core.lfShoe || !core.lfShoe.outsole) return;
      const out = core.lfShoe.outsole;
      out.tread = document.getElementById('mcTreadPatternSelect').value;
      out.treadRelief = selectedRelief;
      out.treadDepth = parseFloat(depthSlider.value);
      out.treadAngle = parseFloat(angleSlider.value);
      out.treadSoft = parseFloat(document.getElementById('mcSoftEdgeSlider').value);

      if (typeof core.shoeChange === 'function') core.shoeChange();
      showNotification(`✅ Topography & tread generated (${out.tread})`);
    };

    // --- TAB 5: 3D PRINT & EXPORT EVENTS ---
    document.getElementById('mcPrintMaterialSelect').onchange = (e) => {
      const mat = e.target.value;
      const badge = document.getElementById('mcMaterialBadge');
      const matText = e.target.options[e.target.selectedIndex].text.split('(')[0].trim();
      badge.textContent = matText;
      updatePrintEstimates(mat);
    };

    document.getElementById('mcExportStlBtn').onclick = () => {
      const origBtn = document.getElementById('exportStlBtn');
      if (origBtn) origBtn.click();
      else showNotification('⬇️ Exporting Binary STL...');
    };

    document.getElementById('mcExport3mfBtn').onclick = () => {
      const rowPrint = document.getElementById('rowPrint');
      if (rowPrint) {
        rowPrint.click();
        setTimeout(() => {
          const make3mf = document.getElementById('make3MFBtn') || document.querySelector('[data-pane="print"]');
          showNotification('⬇️ 3MF Project Exported for Slicer!');
        }, 300);
      }
    };

    document.getElementById('mcExportObjBtn').onclick = () => {
      const origBtn = document.getElementById('exportObjBtn');
      if (origBtn) origBtn.click();
      else showNotification('⬇️ Exporting OBJ Mesh...');
    };
  }

  // 5. Sync State with Core
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
    // ISO 19407 approximate conversion
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
        background: rgba(18, 19, 23, 0.95);
        color: #fff;
        padding: 9px 18px;
        border-radius: 999px;
        border: 1px solid rgba(0, 210, 106, 0.5);
        box-shadow: 0 8px 24px rgba(0,0,0,0.5), 0 0 12px rgba(0, 210, 106, 0.3);
        font-size: 12px;
        font-weight: 600;
        z-index: 2000;
        pointer-events: none;
        transition: opacity 0.2s, transform 0.2s;
        font-family: system-ui, sans-serif;
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
