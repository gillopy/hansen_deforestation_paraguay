(function () {
  var DATA_CSV = "data/paraguay_deforestacion.csv";
  var chartCanvas = document.getElementById("lossChart");

  function parseCsv(text) {
    var lines = text.trim().split(/\r?\n/);
    var headers = lines[0].split(",");
    var rows = [];

    for (var i = 1; i < lines.length; i += 1) {
      var parts = lines[i].split(",");
      if (parts.length !== headers.length) {
        continue;
      }
      var row = {};
      for (var j = 0; j < headers.length; j += 1) {
        row[headers[j]] = parts[j];
      }
      rows.push(row);
    }
    return rows;
  }

  function toNumber(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function formatHa(value) {
    return new Intl.NumberFormat("es-PY", {
      maximumFractionDigits: 0
    }).format(value) + " ha";
  }

  function formatPct(value) {
    return new Intl.NumberFormat("es-PY", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(value) + "%";
  }

  function buildModel(rows) {
    var departmentsBySlug = {};
    var annualNational = {};

    rows.forEach(function (row) {
      var slug = row.slug;
      var year = Number(row.anio);
      var loss = toNumber(row.perdida_ha);

      if (!departmentsBySlug[slug]) {
        departmentsBySlug[slug] = {
          name: row.departamento,
          slug: slug,
          cover2000: toNumber(row.cobertura_2000_ha),
          totalLoss: toNumber(row.perdida_total_ha),
          lossPct: toNumber(row.perdida_pct),
          byYear: []
        };
      }

      departmentsBySlug[slug].byYear.push({ year: year, loss: loss });
      annualNational[year] = (annualNational[year] || 0) + loss;
    });

    var departments = Object.keys(departmentsBySlug).map(function (slug) {
      var dept = departmentsBySlug[slug];
      dept.byYear.sort(function (a, b) {
        return a.year - b.year;
      });
      return dept;
    });

    departments.sort(function (a, b) {
      return b.lossPct - a.lossPct;
    });

    var annualSeries = Object.keys(annualNational)
      .map(function (year) {
        return { year: Number(year), loss: annualNational[year] };
      })
      .sort(function (a, b) {
        return a.year - b.year;
      });

    var coverTotal = departments.reduce(function (acc, dept) {
      return acc + dept.cover2000;
    }, 0);

    var lossTotal = departments.reduce(function (acc, dept) {
      return acc + dept.totalLoss;
    }, 0);

    var avgLoss = annualSeries.length ? lossTotal / annualSeries.length : 0;

    return {
      departments: departments,
      annualSeries: annualSeries,
      coverTotal: coverTotal,
      lossTotal: lossTotal,
      avgLoss: avgLoss
    };
  }

  function setText(id, value) {
    var el = document.getElementById(id);
    if (el) {
      el.textContent = value;
    }
  }

  function drawChart(series) {
    if (!chartCanvas || !series.length) {
      return;
    }

    var ctx = chartCanvas.getContext("2d");
    var width = chartCanvas.width;
    var height = chartCanvas.height;
    var pad = { top: 24, right: 20, bottom: 44, left: 68 };

    ctx.clearRect(0, 0, width, height);

    var maxLoss = series.reduce(function (m, item) {
      return Math.max(m, item.loss);
    }, 0);

    var chartW = width - pad.left - pad.right;
    var chartH = height - pad.top - pad.bottom;

    ctx.strokeStyle = "rgba(24,33,24,0.15)";
    ctx.lineWidth = 1;

    for (var g = 0; g <= 4; g += 1) {
      var gy = pad.top + chartH * (g / 4);
      ctx.beginPath();
      ctx.moveTo(pad.left, gy);
      ctx.lineTo(width - pad.right, gy);
      ctx.stroke();
    }

    var barWidth = chartW / series.length;

    series.forEach(function (item, idx) {
      var x = pad.left + idx * barWidth + 1;
      var ratio = maxLoss ? item.loss / maxLoss : 0;
      var barH = chartH * ratio;
      var y = pad.top + chartH - barH;

      var grad = ctx.createLinearGradient(0, y, 0, pad.top + chartH);
      grad.addColorStop(0, "#cf4b2c");
      grad.addColorStop(1, "#e7ab3c");

      ctx.fillStyle = grad;
      ctx.fillRect(x, y, Math.max(barWidth - 2, 2), barH);

      if (idx % 4 === 0) {
        ctx.fillStyle = "#4b5a4a";
        ctx.font = "12px Space Grotesk, sans-serif";
        ctx.fillText(String(item.year), x, height - 16);
      }
    });

    ctx.fillStyle = "#4b5a4a";
    ctx.font = "12px Space Grotesk, sans-serif";
    ctx.fillText("Pérdida anual total (ha)", 8, 14);
  }

  function renderRanking(departments) {
    var list = document.getElementById("rankingList");
    if (!list) {
      return;
    }

    list.innerHTML = "";
    departments.slice(0, 10).forEach(function (dept, idx) {
      var item = document.createElement("li");
      item.className = "rank-item";
      item.innerHTML =
        "<div><strong>" +
        (idx + 1) +
        ". " +
        dept.name +
        "</strong><div class=\"meta\">" +
        formatHa(dept.totalLoss) +
        " perdidas</div></div>" +
        "<div>" + formatPct(dept.lossPct) + "</div>";
      list.appendChild(item);
    });
  }

  function setupExplorer(model) {
    var deptSelect = document.getElementById("deptSelect");
    var layerSelect = document.getElementById("layerSelect");
    var image = document.getElementById("deptImage");
    var caption = document.getElementById("imageCaption");

    if (!deptSelect || !layerSelect || !image || !caption) {
      return;
    }

    model.departments.forEach(function (dept) {
      var option = document.createElement("option");
      option.value = dept.slug;
      option.textContent = dept.name;
      deptSelect.appendChild(option);
    });

    function updateView() {
      var slug = deptSelect.value;
      var layer = layerSelect.value;
      var dept = model.departments.find(function (entry) {
        return entry.slug === slug;
      });

      if (!dept) {
        return;
      }

      var src = "images/" + slug + "_" + layer + ".png";
      image.src = src;
      image.alt = "Mapa " + layer + " de " + dept.name;
      caption.textContent = dept.name + " - capa: " + layer;

      setText("deptName", dept.name);
      setText(
        "deptStats",
        "Cobertura 2000: " +
          formatHa(dept.cover2000) +
          " | Pérdida acumulada: " +
          formatHa(dept.totalLoss) +
          " (" +
          formatPct(dept.lossPct) +
          ")"
      );

      if (window.gsap) {
        gsap.fromTo(
          image,
          { opacity: 0.2, scale: 0.985 },
          { opacity: 1, scale: 1, duration: 0.45, ease: "power2.out" }
        );
      }
    }

    deptSelect.addEventListener("change", updateView);
    layerSelect.addEventListener("change", updateView);

    if (model.departments[0]) {
      deptSelect.value = model.departments[0].slug;
      updateView();
    }
  }

  function animateCounters(model) {
    if (!window.gsap) {
      setText("coverTotal", formatHa(model.coverTotal));
      setText("lossTotal", formatHa(model.lossTotal));
      setText("avgLoss", formatHa(model.avgLoss));
      return;
    }

    function tweenNumber(targetId, finalValue) {
      var state = { value: 0 };
      gsap.to(state, {
        value: finalValue,
        duration: 1.2,
        ease: "power2.out",
        onUpdate: function () {
          setText(targetId, formatHa(state.value));
        }
      });
    }

    tweenNumber("coverTotal", model.coverTotal);
    tweenNumber("lossTotal", model.lossTotal);
    tweenNumber("avgLoss", model.avgLoss);
  }

  function setupAnimation() {
    if (!window.gsap) {
      document.querySelectorAll("[data-reveal]").forEach(function (el) {
        el.style.opacity = "1";
        el.style.transform = "none";
      });
      return;
    }

    if (window.ScrollTrigger) {
      gsap.registerPlugin(ScrollTrigger);
    }

    gsap.to(".hero-mist", {
      scale: 1.08,
      xPercent: -4,
      duration: 8,
      repeat: -1,
      yoyo: true,
      ease: "sine.inOut"
    });

    var revealEls = document.querySelectorAll("[data-reveal]");
    revealEls.forEach(function (el, idx) {
      gsap.fromTo(
        el,
        { opacity: 0, y: 28 },
        {
          opacity: 1,
          y: 0,
          duration: 0.65,
          delay: idx * 0.03,
          ease: "power2.out",
          scrollTrigger: window.ScrollTrigger
            ? {
                trigger: el,
                start: "top 88%"
              }
            : undefined
        }
      );
    });
  }

  function boot(rows) {
    var model = buildModel(rows);
    setText("topDept", model.departments[0] ? model.departments[0].name : "--");
    animateCounters(model);
    drawChart(model.annualSeries);
    renderRanking(model.departments);
    setupExplorer(model);
    setupAnimation();
  }

  fetch(DATA_CSV)
    .then(function (res) {
      if (!res.ok) {
        throw new Error("No se pudo cargar el CSV de datos");
      }
      return res.text();
    })
    .then(function (text) {
      boot(parseCsv(text));
    })
    .catch(function (err) {
      console.error(err);
      setText("coverTotal", "Error de carga");
      setText("lossTotal", "Error de carga");
      setText("avgLoss", "Error de carga");
      setText("topDept", "Error de carga");
    });
})();
