// QuakeSpread — Leaflet Map Logic + Animation

(function () {
    "use strict";

    // ---------------------------------------------------------------------------
    // Map initialization
    // ---------------------------------------------------------------------------
    const map = L.map("map").setView([36.7, -119.8], 6);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 18,
    }).addTo(map);

    // ---------------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------------
    let epicenterMarker = null;
    let epicenterLatLng = null;
    let simLayer = null;
    let animationTimeouts = [];
    let recentLayer = null;
    let recentLoaded = false;
    let faultLayer = null;
    let faultLoaded = false;
    let damageChart = null;

    // Tsunami state
    let tsunamiLayer = null;
    let tsunamiMarkers = [];
    let dartMarkers = [];
    let tsunamiAnimTimeouts = [];
    let tsunamiEnabled = false;
    let lastTsunamiData = null;

    // DOM elements
    const magSlider = document.getElementById("magnitude");
    const depthSlider = document.getElementById("depth");
    const magValue = document.getElementById("mag-value");
    const depthValue = document.getElementById("depth-value");
    const simulateBtn = document.getElementById("simulate-btn");
    const recentToggle = document.getElementById("recent-toggle");
    const statusDiv = document.getElementById("status");

    // ---------------------------------------------------------------------------
    // Slider live updates
    // ---------------------------------------------------------------------------
    magSlider.addEventListener("input", function () {
        magValue.textContent = this.value;
    });

    depthSlider.addEventListener("input", function () {
        depthValue.textContent = this.value;
    });

    // ---------------------------------------------------------------------------
    // Epicenter selection
    // ---------------------------------------------------------------------------
    const epicenterIcon = L.divIcon({
        className: "epicenter-icon",
        html: '<div style="width:20px;height:20px;border:3px solid #f38ba8;border-radius:50%;background:rgba(243,139,168,0.3);position:relative;"><div style="position:absolute;top:50%;left:50%;width:8px;height:8px;background:#f38ba8;border-radius:50%;transform:translate(-50%,-50%);"></div></div>',
        iconSize: [20, 20],
        iconAnchor: [10, 10],
    });

    map.on("click", function (e) {
        epicenterLatLng = e.latlng.wrap();

        if (epicenterMarker) {
            epicenterMarker.setLatLng(e.latlng);
        } else {
            epicenterMarker = L.marker(e.latlng, { icon: epicenterIcon }).addTo(map);
        }

        simulateBtn.disabled = false;
        simulateBtn.textContent = "Simulate";
        setStatus(
            "Epicenter set at " +
            e.latlng.lat.toFixed(4) + ", " +
            e.latlng.lng.toFixed(4)
        );

        // Check if epicenter is in the ocean → show/hide Tsunami Mode toggle
        checkOceanEpicenter(epicenterLatLng.lat, epicenterLatLng.lng);
    });

    // ---------------------------------------------------------------------------
    // Simulate
    // ---------------------------------------------------------------------------
    simulateBtn.addEventListener("click", function () {
        if (!epicenterLatLng) return;

        simulateBtn.disabled = true;
        simulateBtn.textContent = "Simulating...";
        setStatus("Running simulation...");
        clearAnimation();

        const payload = {
            lat: epicenterLatLng.lat,
            lng: epicenterLatLng.lng,
            magnitude: parseFloat(magSlider.value),
            depth: parseFloat(depthSlider.value),
        };

        fetch("/simulate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        })
            .then(function (resp) {
                if (!resp.ok) {
                    return resp.json().then(function (d) {
                        throw new Error(d.error || "Simulation failed");
                    });
                }
                return resp.json();
            })
            .then(function (resp) {
                var points = resp.points;
                var faultInfo = resp.fault_info;
                if (resp.step_km) cellSizeKm = resp.step_km;

                // Show fault proximity info
                if (faultInfo) {
                    var faultMsg = "Nearest fault: " + faultInfo.nearest_fault +
                        " (" + faultInfo.distance_km + " km) — Max realistic M" +
                        faultInfo.max_realistic_magnitude;
                    setFaultInfo(faultMsg, faultInfo.warning);
                } else {
                    setFaultInfo("Enable fault lines layer for proximity check.", null);
                }

                if (!points || !points.length) {
                    setStatus("No significant shaking predicted at this magnitude/depth.");
                    simulateBtn.disabled = false;
                    simulateBtn.textContent = "Simulate";
                    return;
                }
                setStatus(points.length + " grid points received. Animating...");
                // Fit map to show the full simulation area
                var lats = points.map(function (p) { return p.lat; });
                var lngs = points.map(function (p) { return p.lng; });
                map.fitBounds([
                    [Math.min.apply(null, lats), Math.min.apply(null, lngs)],
                    [Math.max.apply(null, lats), Math.max.apply(null, lngs)],
                ], { padding: [40, 40] });
                animateChoropleth(points);

                // Fetch damage stats — pass grid points so backend can compute real area
                fetchDamageStats(payload, points);

                // If tsunami mode is active, also run tsunami simulation
                if (tsunamiEnabled) {
                    runTsunamiSimulation(payload);
                }
            })
            .catch(function (err) {
                setStatus("Error: " + err.message, true);
                simulateBtn.disabled = false;
                simulateBtn.textContent = "Simulate";
            });
    });

    // ---------------------------------------------------------------------------
    // Choropleth simulation — colored polygon tiles, one per grid cell
    // ---------------------------------------------------------------------------

    // Map MMI 2–10 to color using same stops as the legend
    var mmiStops = [
        [2,  [67,  160, 71 ]],
        [3,  [124, 179, 66 ]],
        [4,  [192, 202, 51 ]],
        [5,  [253, 216, 53 ]],
        [6,  [255, 179, 0  ]],
        [7,  [251, 140, 0  ]],
        [8,  [244, 81,  30 ]],
        [9,  [229, 57,  53 ]],
        [10, [183, 28,  28 ]],
    ];

    function mmiToColor(mmi) {
        mmi = Math.max(2, Math.min(10, mmi));
        for (var i = 0; i < mmiStops.length - 1; i++) {
            if (mmi <= mmiStops[i + 1][0]) {
                var t = (mmi - mmiStops[i][0]) / (mmiStops[i + 1][0] - mmiStops[i][0]);
                var a = mmiStops[i][1], b = mmiStops[i + 1][1];
                return "rgb(" +
                    Math.round(a[0] + t * (b[0] - a[0])) + "," +
                    Math.round(a[1] + t * (b[1] - a[1])) + "," +
                    Math.round(a[2] + t * (b[2] - a[2])) + ")";
            }
        }
        return "rgb(183,28,28)";
    }

    // Build a GeoJSON polygon tile for a grid point, sized to match server grid spacing
    var cellSizeKm = 3;  // default, updated from server response
    function makeCell(p) {
        var latHalf = (cellSizeKm / 111.0) / 2;
        var lonHalf = (cellSizeKm / (111.0 * Math.cos(p.lat * Math.PI / 180))) / 2;
        return {
            type: "Feature",
            geometry: {
                type: "Polygon",
                coordinates: [[
                    [p.lng - lonHalf, p.lat - latHalf],
                    [p.lng + lonHalf, p.lat - latHalf],
                    [p.lng + lonHalf, p.lat + latHalf],
                    [p.lng - lonHalf, p.lat + latHalf],
                    [p.lng - lonHalf, p.lat - latHalf],
                ]],
            },
            properties: { mmi: p.intensity },
        };
    }

    var simRenderer = L.canvas({ padding: 0.5 });

    function animateChoropleth(points) {
        clearAnimation();

        simLayer = L.geoJSON(null, {
            style: function (feature) {
                return {
                    fillColor: mmiToColor(feature.properties.mmi),
                    fillOpacity: 0.78,
                    stroke: false,
                    renderer: simRenderer,
                };
            },
        }).addTo(map);

        // Group into 10km-wide rings, sorted center-outward
        var rings = {};
        points.forEach(function (p) {
            var key = Math.floor(p.distance / 10);
            if (!rings[key]) rings[key] = [];
            rings[key].push(p);
        });

        var ringKeys = Object.keys(rings).map(Number).sort(function (a, b) { return a - b; });

        ringKeys.forEach(function (key, i) {
            var timeout = setTimeout(function () {
                simLayer.addData({
                    type: "FeatureCollection",
                    features: rings[key].map(makeCell),
                });

                if (i === ringKeys.length - 1) {
                    simulateBtn.disabled = false;
                    simulateBtn.textContent = "Simulate";
                    var maxMmi = points.reduce(function (m, p) { return Math.max(m, p.intensity); }, 0);
                    setStatus("Simulation complete. Max MMI: " + maxMmi.toFixed(1));
                }
            }, i * 80);

            animationTimeouts.push(timeout);
        });
    }

    function clearAnimation() {
        animationTimeouts.forEach(clearTimeout);
        animationTimeouts = [];
        if (simLayer) {
            map.removeLayer(simLayer);
            simLayer = null;
        }
    }

    // ---------------------------------------------------------------------------
    // Recent earthquakes layer
    // ---------------------------------------------------------------------------
    recentToggle.addEventListener("change", function () {
        if (this.checked) {
            if (!recentLoaded) {
                loadRecentEarthquakes();
            } else if (recentLayer) {
                map.addLayer(recentLayer);
            }
        } else {
            if (recentLayer) {
                map.removeLayer(recentLayer);
            }
        }
    });

    function loadRecentEarthquakes() {
        setStatus("Loading recent earthquakes...");

        fetch("/recent")
            .then(function (resp) {
                if (!resp.ok) throw new Error("Failed to load recent earthquakes");
                return resp.json();
            })
            .then(function (geojson) {
                recentLayer = L.layerGroup();

                (geojson.features || []).forEach(function (feat) {
                    var coords = feat.geometry.coordinates;
                    var props = feat.properties;
                    var mag = props.mag || 0;
                    var lat = coords[1];
                    var lng = coords[0];
                    var depth = coords[2];

                    var radius = Math.min(Math.pow(2, mag) * 0.5, 30);

                    var marker = L.circleMarker([lat, lng], {
                        radius: radius,
                        fillColor: "#ff6600",
                        color: "#333",
                        weight: 1,
                        fillOpacity: 0.6,
                    });

                    var date = new Date(props.time).toLocaleString();
                    marker.bindPopup(
                        "<strong>M" + mag.toFixed(1) + "</strong><br>" +
                        (props.place || "Unknown location") + "<br>" +
                        "Depth: " + (depth ? depth.toFixed(1) : "?") + " km<br>" +
                        date + "<br><br>" +
                        "<em>Click to simulate this earthquake</em>"
                    );

                    // Click recent earthquake → auto-simulate with its real params
                    (function (eLat, eLng, eMag, eDepth) {
                        marker.on("click", function () {
                            // Set epicenter
                            epicenterLatLng = L.latLng(eLat, eLng);
                            if (epicenterMarker) {
                                epicenterMarker.setLatLng(epicenterLatLng);
                            } else {
                                epicenterMarker = L.marker(epicenterLatLng, { icon: epicenterIcon }).addTo(map);
                            }

                            // Clamp to slider ranges and update UI
                            var clampedMag = Math.max(3.0, Math.min(9.0, eMag));
                            var clampedDepth = Math.max(0, Math.min(700, eDepth || 10));
                            magSlider.value = clampedMag.toFixed(1);
                            depthSlider.value = Math.round(clampedDepth);
                            magValue.textContent = clampedMag.toFixed(1);
                            depthValue.textContent = Math.round(clampedDepth);

                            // Trigger simulation
                            simulateBtn.disabled = false;
                            simulateBtn.click();
                        });
                    })(lat, lng, mag, depth);

                    recentLayer.addLayer(marker);
                });

                recentLayer.addTo(map);
                recentLoaded = true;
                setStatus(
                    geojson.features.length + " recent earthquakes loaded (M3.0+ last 30 days)."
                );
            })
            .catch(function (err) {
                setStatus("Error loading recent earthquakes: " + err.message, true);
                recentToggle.checked = false;
            });
    }

    // ---------------------------------------------------------------------------
    // Fault lines layer (GEM Global Active Faults)
    // ---------------------------------------------------------------------------
    var faultToggle = document.getElementById("fault-toggle");

    faultToggle.addEventListener("change", function () {
        if (this.checked) {
            if (!faultLoaded) {
                loadFaultLines();
            } else if (faultLayer) {
                map.addLayer(faultLayer);
            }
        } else {
            if (faultLayer) {
                map.removeLayer(faultLayer);
            }
        }
    });

    var mapEl = document.getElementById("map");
    var faultUpdateTimer = null;

    function updateFaultLabelVisibility() {
        if (map.getZoom() >= 8) {
            mapEl.classList.add("show-fault-labels");
        } else {
            mapEl.classList.remove("show-fault-labels");
        }
    }

    function refreshFaults() {
        if (!faultToggle.checked) return;

        // Debounce — wait for zoom/pan to settle
        clearTimeout(faultUpdateTimer);
        faultUpdateTimer = setTimeout(function () {
            var bounds = map.getBounds();
            var zoom = map.getZoom();
            var params = new URLSearchParams({
                zoom: zoom,
                min_lat: bounds.getSouth(),
                max_lat: bounds.getNorth(),
                min_lng: bounds.getWest(),
                max_lng: bounds.getEast(),
            });

            fetch("/faults?" + params)
                .then(function (resp) {
                    if (!resp.ok) throw new Error("Fault fetch failed");
                    return resp.json();
                })
                .then(function (geojson) {
                    if (faultLayer) map.removeLayer(faultLayer);

                    faultLayer = L.geoJSON(geojson, {
                        style: { color: "#ff4444", weight: 1.2, opacity: 0.7 },
                        onEachFeature: function (feature, layer) {
                            var props = feature.properties || {};
                            var name = props.name || props.fault_name || "Unnamed fault";
                            var slip = props.slip_type || "";
                            layer.bindTooltip(name, {
                                permanent: true,
                                direction: "center",
                                className: "fault-label",
                            });
                            layer.bindPopup(
                                "<strong>" + name + "</strong>" +
                                (slip ? "<br>Slip type: " + slip : "")
                            );
                        },
                    }).addTo(map);

                    faultLoaded = true;
                    updateFaultLabelVisibility();
                })
                .catch(function (err) {
                    setStatus("Fault lines error: " + err.message, true);
                });
        }, 400);
    }

    map.on("zoomend moveend", function () {
        updateFaultLabelVisibility();
        refreshFaults();
    });

    // ---------------------------------------------------------------------------
    // MMI Legend
    // ---------------------------------------------------------------------------
    var legend = L.control({ position: "bottomleft" });

    legend.onAdd = function () {
        var div = L.DomUtil.create("div", "mmi-legend");
        div.innerHTML =
            '<div class="title">MMI Intensity Scale</div>' +
            '<div class="gradient-bar"></div>' +
            '<div class="ticks">' +
            "<span>2</span><span>3</span><span>4</span><span>5</span>" +
            "<span>6</span><span>7</span><span>8</span><span>9</span><span>10</span>" +
            "</div>";
        return div;
    };

    legend.addTo(map);

    // Auto-load fault lines on startup
    faultToggle.checked = true;
    refreshFaults();

    // ---------------------------------------------------------------------------
    // Damage stats — fetch + render
    // ---------------------------------------------------------------------------
    var damagePanel = document.getElementById("damage-panel");
    var sourceBadge = document.getElementById("source-badge");

    function fetchDamageStats(payload, points) {
        fetch("/damage", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                lat: payload.lat,
                lng: payload.lng,
                magnitude: payload.magnitude,
                depth: payload.depth,
                points: points,
                step_km: cellSizeKm,
            }),
        })
            .then(function (resp) {
                if (!resp.ok) return resp.json().then(function (d) { throw new Error(d.error); });
                return resp.json();
            })
            .then(function (data) {
                renderDamageStats(data);
            })
            .catch(function (err) {
                console.error("Damage fetch error:", err);
                damagePanel.classList.remove("visible");
            });
    }

    function renderDamageStats(data) {
        damagePanel.classList.add("visible");

        // Source badge
        if (data.source === "real") {
            sourceBadge.textContent = "Real USGS Data";
            sourceBadge.className = "source-badge real";
        } else {
            sourceBadge.textContent = "Estimated";
            sourceBadge.className = "source-badge estimated";
        }

        // Stat cards
        document.getElementById("stat-population").textContent = formatNumber(data.population || 0);
        document.getElementById("stat-injuries").textContent = formatNumber(data.injuries || 0);
        document.getElementById("stat-fatalities").textContent = formatNumber(data.fatalities || 0);
        document.getElementById("stat-economic").textContent = formatUSD(data.economic_loss_usd || 0);

        // Donut chart — building damage breakdown
        var collapse = data.collapse_pct || 0;
        var heavy = data.heavy_pct || 0;
        var moderate = Math.min(heavy * 1.5, 100 - collapse - heavy);
        var slight = Math.min(moderate * 1.2, 100 - collapse - heavy - moderate);
        var none = Math.max(0, 100 - collapse - heavy - moderate - slight);

        renderDamageChart(collapse, heavy, moderate, slight, none);
    }

    function renderDamageChart(collapse, heavy, moderate, slight, none) {
        var ctx = document.getElementById("damage-chart").getContext("2d");

        if (damageChart) {
            damageChart.destroy();
        }

        damageChart = new Chart(ctx, {
            type: "doughnut",
            data: {
                labels: ["Collapsed", "Heavy Damage", "Moderate", "Slight", "None"],
                datasets: [{
                    data: [collapse, heavy, moderate, slight, none],
                    backgroundColor: ["#e53935", "#fb8c00", "#fdd835", "#7cb342", "#585b70"],
                    borderWidth: 0,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                cutout: "55%",
                plugins: {
                    legend: {
                        position: "bottom",
                        labels: {
                            color: "#a6adc8",
                            font: { size: 10 },
                            padding: 8,
                            boxWidth: 12,
                        },
                    },
                    title: {
                        display: true,
                        text: "Building Damage Breakdown",
                        color: "#cdd6f4",
                        font: { size: 13, weight: "600" },
                        padding: { bottom: 8 },
                    },
                },
            },
        });
    }

    function formatNumber(n) {
        if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
        if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
        return n.toLocaleString();
    }

    function formatUSD(n) {
        if (n >= 1e9) return "$" + (n / 1e9).toFixed(1) + "B";
        if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
        if (n >= 1e3) return "$" + (n / 1e3).toFixed(0) + "K";
        return "$" + n.toFixed(0);
    }

    // ---------------------------------------------------------------------------
    // Status helper
    // ---------------------------------------------------------------------------
    function setStatus(msg, isError) {
        statusDiv.textContent = msg;
        statusDiv.className = isError ? "error" : "";
    }

    function setFaultInfo(info, warning) {
        var infoEl = document.getElementById("fault-info");
        var warnEl = document.getElementById("fault-warning");
        infoEl.textContent = info || "";
        if (warning) {
            warnEl.textContent = "⚠ " + warning;
            warnEl.style.display = "block";
        } else {
            warnEl.textContent = "";
            warnEl.style.display = "none";
        }
    }

    // ===========================================================================
    // Tsunami Simulator
    // ===========================================================================

    var tsunamiSection  = document.getElementById("tsunami-section");
    var tsunamiToggle   = document.getElementById("tsunami-toggle");
    var tsunamiPanel    = document.getElementById("tsunami-panel");
    var tsunamiRenderer = L.canvas({ padding: 0.5 });

    // Wave-height colour scale: blue → yellow → orange → red
    var waveStops = [
        [0.1,  [79,  195, 247]],   // light blue  (minimal)
        [0.5,  [3,   155, 229]],   // blue        (low)
        [1.5,  [0,   96,  100]],   // dark teal   (moderate-low)
        [3.0,  [255, 238, 88 ]],   // yellow      (moderate)
        [6.0,  [255, 167, 38 ]],   // orange      (significant)
        [12.0, [239, 83,  80 ]],   // red         (major)
        [30.0, [183, 28,  28 ]],   // dark red    (catastrophic)
    ];

    function waveHeightToColor(h) {
        h = Math.max(0.1, h);
        for (var i = 0; i < waveStops.length - 1; i++) {
            if (h <= waveStops[i + 1][0]) {
                var t = (h - waveStops[i][0]) / (waveStops[i + 1][0] - waveStops[i][0]);
                var a = waveStops[i][1], b = waveStops[i + 1][1];
                return "rgba(" +
                    Math.round(a[0] + t * (b[0] - a[0])) + "," +
                    Math.round(a[1] + t * (b[1] - a[1])) + "," +
                    Math.round(a[2] + t * (b[2] - a[2])) + ",0.80)";
            }
        }
        return "rgba(183,28,28,0.80)";
    }

    function makeTsunamiCell(cell, stepKm) {
        var s = (stepKm || 80);
        var latH = (s / 111.0) / 2;
        var lonH = (s / (111.0 * Math.cos(cell.lat * Math.PI / 180))) / 2;
        return {
            type: "Feature",
            geometry: {
                type: "Polygon",
                coordinates: [[
                    [cell.lng - lonH, cell.lat - latH],
                    [cell.lng + lonH, cell.lat - latH],
                    [cell.lng + lonH, cell.lat + latH],
                    [cell.lng - lonH, cell.lat + latH],
                    [cell.lng - lonH, cell.lat - latH],
                ]],
            },
            properties: { height_m: cell.height_m },
        };
    }

    // Check whether epicenter is in the ocean; show/hide Tsunami Mode toggle
    function checkOceanEpicenter(lat, lng) {
        fetch("/ocean-check?lat=" + lat + "&lng=" + lng)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d.is_ocean) {
                    tsunamiSection.style.display = "block";
                } else {
                    tsunamiSection.style.display = "none";
                    // Turn off tsunami mode if we move to land
                    tsunamiToggle.checked = false;
                    tsunamiEnabled = false;
                    tsunamiPanel.classList.remove("visible");
                    clearTsunamiAnimation();
                }
            })
            .catch(function () {
                tsunamiSection.style.display = "none";
            });
    }

    // Toggle handler — controls panel visibility, legend, and animation
    tsunamiToggle.addEventListener("change", function () {
        tsunamiEnabled = this.checked;
        var legendCtrl = document.getElementById("wave-legend-ctrl");
        if (tsunamiEnabled) {
            tsunamiPanel.classList.add("visible");
            if (legendCtrl) legendCtrl.style.display = "block";
            // If we already have a simulation result, replay tsunami immediately
            if (lastTsunamiData) {
                animateTsunamiWaves(lastTsunamiData);
            }
        } else {
            tsunamiPanel.classList.remove("visible");
            if (legendCtrl) legendCtrl.style.display = "none";
            clearTsunamiAnimation();
            hideTsunamiCoastalSection();
        }
    });

    function clearTsunamiAnimation() {
        tsunamiAnimTimeouts.forEach(clearTimeout);
        tsunamiAnimTimeouts = [];
        if (tsunamiLayer) { map.removeLayer(tsunamiLayer); tsunamiLayer = null; }
        tsunamiMarkers.forEach(function (m) { map.removeLayer(m); });
        tsunamiMarkers = [];
        dartMarkers.forEach(function (m) { map.removeLayer(m); });
        dartMarkers = [];
    }

    function hideTsunamiCoastalSection() {
        document.getElementById("tsunami-coastal-section").classList.remove("visible");
    }

    // Main tsunami simulation call
    function runTsunamiSimulation(payload) {
        setStatus("Running tsunami simulation... (fetching bathymetry)");

        fetch("/tsunami", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        })
            .then(function (r) {
                if (!r.ok) return r.json().then(function (d) { throw new Error(d.error || "Tsunami failed"); });
                return r.json();
            })
            .then(function (data) {
                lastTsunamiData = data;
                if (tsunamiEnabled) {
                    animateTsunamiWaves(data);
                }
            })
            .catch(function (err) {
                console.error("Tsunami simulation error:", err.message);
                setStatus("Tsunami simulation: " + err.message, true);
            });
    }

    // Animate tsunami wave rings on the map
    function animateTsunamiWaves(data) {
        clearTsunamiAnimation();

        var rings     = data.animation_rings || [];
        var impacts   = data.coastline_impacts || [];
        var stepKm    = data.grid_step_km || 80;
        var noaaSource = data.noaa_source || "simulated";
        var dartBuoys = data.dart_buoys || [];

        if (!rings.length) {
            setStatus("Tsunami simulation produced no ocean cells in range.", true);
            return;
        }

        // Render DART buoy markers immediately
        var dartIcon = L.divIcon({
            className: "",
            html: '<div style="width:12px;height:12px;border:2px solid #89dceb;border-radius:50%;background:rgba(137,220,235,0.3)"></div>',
            iconSize: [12, 12],
            iconAnchor: [6, 6],
        });
        dartBuoys.forEach(function (b) {
            var m = L.marker([b.lat, b.lng], { icon: dartIcon })
                .bindPopup(
                    "<strong>" + b.name + "</strong><br>" +
                    "Distance: " + b.distance_km + " km<br>" +
                    (b.status && b.status.wc_height_m !== undefined
                        ? "Water column: " + b.status.wc_height_m + " m"
                        : "Status: " + (b.status && b.status.online ? "Online" : "N/A"))
                )
                .addTo(map);
            dartMarkers.push(m);
        });

        // Update sidebar: source badge + DART buoy list
        var badge = document.getElementById("tsunami-source-badge");
        if (noaaSource === "real") {
            badge.textContent = "Real NOAA Data";
            badge.className = "tsunami-source-badge real";
            if (data.noaa_event) {
                badge.title = data.noaa_event.year + " — " + data.noaa_event.location;
            }
        } else {
            badge.textContent = "Simulated";
            badge.className = "tsunami-source-badge simulated";
        }

        renderDartBuoyList(dartBuoys);

        // GeoJSON layer for all wave cells
        tsunamiLayer = L.geoJSON(null, {
            style: function (feat) {
                return {
                    fillColor: waveHeightToColor(feat.properties.height_m),
                    fillOpacity: 0.82,
                    stroke: false,
                    renderer: tsunamiRenderer,
                };
            },
        }).addTo(map);

        // Animate rings — scale delays so total ≈ 12s
        var totalBands = rings.length;
        var perBandMs  = Math.max(200, Math.min(800, Math.round(12000 / Math.max(1, totalBands))));

        // Build a lookup from travel_minutes → coastline impacts
        var impactByBand = {};
        impacts.forEach(function (imp) {
            var b = Math.floor(imp.travel_minutes / 4);
            impactByBand[b] = impactByBand[b] || [];
            impactByBand[b].push(imp);
        });

        var coastlineIcon = L.divIcon({
            className: "",
            html: '<div style="width:0;height:0;border-left:8px solid transparent;border-right:8px solid transparent;border-bottom:16px solid #f38ba8;filter:drop-shadow(0 0 3px #f38ba8)"></div>',
            iconSize: [16, 16],
            iconAnchor: [8, 16],
        });

        rings.forEach(function (ring, idx) {
            var t = setTimeout(function () {
                // Add ocean cells for this time band
                if (ring.cells && ring.cells.length) {
                    tsunamiLayer.addData({
                        type: "FeatureCollection",
                        features: ring.cells.map(function (c) { return makeTsunamiCell(c, stepKm); }),
                    });
                }

                // Place coastline markers for this time band
                var bandKey = Math.floor(ring.travel_minutes / 4);
                (impactByBand[bandKey] || []).forEach(function (imp) {
                    var mk = L.marker([imp.lat, imp.lng], { icon: coastlineIcon })
                        .bindPopup(
                            "<strong>Coastal Impact</strong><br>" +
                            "Arrival: <b>" + formatArrivalTime(imp.travel_minutes) + "</b><br>" +
                            "Est. wave height: <b>" + imp.height_m.toFixed(1) + " m</b>"
                        )
                        .addTo(map);
                    tsunamiMarkers.push(mk);
                });

                // On last ring: update status + sidebar coastal section
                if (idx === rings.length - 1) {
                    setStatus("Earthquake + Tsunami simulation complete.");
                    renderArrivalTimes(impacts.slice(0, 10));
                    renderCoastalImpactSection(impacts);
                }
            }, idx * perBandMs);

            tsunamiAnimTimeouts.push(t);
        });
    }

    function renderArrivalTimes(impacts) {
        var list = document.getElementById("arrival-list");
        if (!impacts || !impacts.length) {
            list.innerHTML = '<div style="font-size:11px;color:#6c7086">No coastal impacts detected in range</div>';
            return;
        }

        list.innerHTML = impacts.map(function (imp) {
            var h = imp.height_m;
            var hClass = h < 1 ? "low" : h < 3 ? "medium" : h < 8 ? "high" : "major";
            return (
                '<div class="arrival-item">' +
                    '<span style="flex:1;color:#cdd6f4;font-size:10px">' +
                        imp.lat.toFixed(2) + "°, " + imp.lng.toFixed(2) + "°" +
                    "</span>" +
                    '<span class="arrival-time">' + formatArrivalTime(imp.travel_minutes) + "</span>" +
                    '<span class="arrival-height ' + hClass + '">' + h.toFixed(1) + "m</span>" +
                "</div>"
            );
        }).join("");
    }

    function renderDartBuoyList(buoys) {
        var list = document.getElementById("dart-buoy-list");
        if (!buoys || !buoys.length) {
            list.innerHTML = '<div style="font-size:11px;color:#6c7086">No DART buoys in range</div>';
            return;
        }

        list.innerHTML = buoys.map(function (b) {
            var statusText = "";
            if (b.status && b.status.wc_height_m !== undefined) {
                statusText = " · " + b.status.wc_height_m + "m";
            } else if (b.status && b.status.online) {
                statusText = " · Online";
            }
            return (
                '<div class="dart-buoy-item">' +
                    '<div class="dart-dot"></div>' +
                    '<span>' + b.name + statusText + "</span>" +
                    '<span class="dart-dist">' + b.distance_km + " km</span>" +
                "</div>"
            );
        }).join("");
    }

    function renderCoastalImpactSection(impacts) {
        var section = document.getElementById("tsunami-coastal-section");
        if (!impacts || !impacts.length) return;

        var maxWave = impacts.reduce(function (mx, x) { return Math.max(mx, x.height_m); }, 0);
        var firstArrival = impacts[0].travel_minutes;

        document.getElementById("stat-max-wave").textContent = maxWave.toFixed(1) + " m";
        document.getElementById("stat-first-arrival").textContent = formatArrivalTime(firstArrival);
        section.classList.add("visible");
    }

    function formatArrivalTime(minutes) {
        if (minutes < 60) {
            return Math.round(minutes) + " min";
        }
        var h = Math.floor(minutes / 60);
        var m = Math.round(minutes % 60);
        return h + "h " + (m > 0 ? m + "m" : "");
    }

    // Tsunami wave legend (shown on map when tsunami mode is active)
    var waveLegend = L.control({ position: "bottomright" });
    waveLegend.onAdd = function () {
        var div = L.DomUtil.create("div", "wave-legend");
        div.id = "wave-legend-ctrl";
        div.style.display = "none";
        div.innerHTML =
            '<div class="title">🌊 Wave Height</div>' +
            '<div class="gradient-bar"></div>' +
            '<div class="ticks">' +
            "<span>0.1m</span><span>1m</span><span>3m</span>" +
            "<span>6m</span><span>12m</span><span>30m+</span>" +
            "</div>";
        return div;
    };
    waveLegend.addTo(map);

})();
