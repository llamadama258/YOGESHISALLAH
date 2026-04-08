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
        epicenterLatLng = e.latlng;

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

                // Fetch damage stats
                var maxMmi = Math.max.apply(null, points.map(function(p) { return p.intensity; }));
                fetchDamageStats(payload, maxMmi);
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

    // Build a 3km × 3km GeoJSON polygon tile for a grid point
    function makeCell(p) {
        var latHalf = (3 / 111.0) / 2;
        var lonHalf = (3 / (111.0 * Math.cos(p.lat * Math.PI / 180))) / 2;
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
                        date
                    );

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

    function fetchDamageStats(payload, avgMmi) {
        fetch("/damage", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                lat: payload.lat,
                lng: payload.lng,
                magnitude: payload.magnitude,
                depth: payload.depth,
                avg_mmi: avgMmi,
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
})();
