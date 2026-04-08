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
    let heatLayer = null;
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
            .then(function (points) {
                if (!points.length) {
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
                animateHeatmap(points);

                // Fetch damage stats
                var maxMmi = getMaxIntensity(points);
                fetchDamageStats(payload, maxMmi);
            })
            .catch(function (err) {
                setStatus("Error: " + err.message, true);
                simulateBtn.disabled = false;
                simulateBtn.textContent = "Simulate";
            });
    });

    // ---------------------------------------------------------------------------
    // Heatmap animation — concentric rings spreading outward
    // ---------------------------------------------------------------------------
    const heatGradient = {
        0.1: "#43a047",
        0.2: "#7cb342",
        0.3: "#c0ca33",
        0.4: "#fdd835",
        0.5: "#ffb300",
        0.6: "#fb8c00",
        0.7: "#f4511e",
        0.8: "#e53935",
        1.0: "#b71c1c",
    };

    // Convert 7km to pixels at current zoom for smooth blending
    function getHeatRadius() {
        var zoom = map.getZoom();
        var lat = epicenterLatLng ? epicenterLatLng.lat : 36.7;
        var metersPerPixel = (40075016.686 * Math.cos(lat * Math.PI / 180)) / Math.pow(2, zoom + 8);
        return Math.max(8, Math.min(80, 7000 / metersPerPixel));
    }

    // Update radius when user zooms
    map.on("zoomend", function () {
        if (heatLayer) {
            heatLayer.setOptions({ radius: getHeatRadius() });
            heatLayer.redraw();
        }
    });

    function animateHeatmap(points) {
        clearAnimation();

        // Normalize intensity to full 0-1 range based on actual min/max
        // so center (highest MMI) is always red and edges (lowest) are always green
        var maxMmi = points.reduce(function (m, p) { return Math.max(m, p.intensity); }, 0);
        var minMmi = points.reduce(function (m, p) { return Math.min(m, p.intensity); }, 99);
        var range = maxMmi - minMmi || 1;

        // Group points into 10km-wide distance rings
        var rings = {};
        points.forEach(function (p) {
            var ringIdx = Math.floor(p.distance / 10);
            if (!rings[ringIdx]) rings[ringIdx] = [];
            var normalized = (p.intensity - minMmi) / range;
            rings[ringIdx].push([p.lat, p.lng, normalized]);
        });

        var ringKeys = Object.keys(rings)
            .map(Number)
            .sort(function (a, b) { return a - b; });

        // Create heat layer — max:0.7 so peaks definitely hit red end of gradient
        heatLayer = L.heatLayer([], {
            radius: getHeatRadius(),
            blur: 20,
            max: 0.7,
            minOpacity: 0.05,
            gradient: heatGradient,
        }).addTo(map);

        var cumulativeData = [];

        ringKeys.forEach(function (key, i) {
            var timeout = setTimeout(function () {
                cumulativeData = cumulativeData.concat(rings[key]);
                heatLayer.setLatLngs(cumulativeData);

                // Re-enable button after last ring
                if (i === ringKeys.length - 1) {
                    simulateBtn.disabled = false;
                    simulateBtn.textContent = "Simulate";
                    setStatus(
                        "Simulation complete. " +
                        cumulativeData.length + " points rendered. " +
                        "Max intensity: " + getMaxIntensity(points).toFixed(1) + " MMI"
                    );
                }
            }, i * 80);

            animationTimeouts.push(timeout);
        });
    }

    function clearAnimation() {
        animationTimeouts.forEach(clearTimeout);
        animationTimeouts = [];
        if (heatLayer) {
            map.removeLayer(heatLayer);
            heatLayer = null;
        }
    }

    function getMaxIntensity(points) {
        var max = 0;
        points.forEach(function (p) {
            if (p.intensity > max) max = p.intensity;
        });
        return max;
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
})();
