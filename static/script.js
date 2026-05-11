/* ================================================================
   CogniAccess — Full Frontend Logic
   Real-time analysis, hover tracking, charts, PWA, dark mode
   ================================================================ */

// ── Cold-start detection ────────────────────────────────────────
(function coldStartCheck() {
  const banner = document.getElementById("coldStartBanner");
  if (!banner) return;
  const start = Date.now();
  fetch("/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "ping", session_id: "warmup" }) })
    .then(() => { banner.style.display = "none"; })
    .catch(() => {
      if (Date.now() - start > 2000) banner.style.display = "block";
    });
  setTimeout(() => {
    fetch("/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "ping", session_id: "warmup" }) })
      .then(() => { banner.style.display = "none"; })
      .catch(() => {});
  }, 3000);
})();

// ── Session & State ────────────────────────────────────────────
const SESSION_ID = (() => {
  let id = sessionStorage.getItem("ca_session");
  if (!id) { id = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2); sessionStorage.setItem("ca_session", id); }
  return id;
})();

let currentFontSize    = 20;
let currentLineSpacing = 1.5;
let currentDiffLevel   = "";

// Live behaviour counters
let totalHovers    = 0;
let totalHoverTime = 0;
let sessionEvents  = 0;
let mlDataPoints   = 0;

// Debounce timer
let analyzeTimer = null;

// Chart instances
let behaviorChartInst = null;
let diffChartInst     = null;
let hoverHistInst     = null;
const hoverData       = [];

// PWA install prompt
let deferredPrompt = null;

// Speech recognition (input)
let speechRecognition = null;
let isListening       = false;

// Text-to-speech (output)
let isSpeaking = false;

// Font options
const FONT_CLASSES = ["font-opendyslexic", "font-atkinson", "font-lexend", "font-comic"];

// ── DOM Ready ──────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  initCharCounter();
  initKeyboardShortcuts();
  initNavButtons();
  restoreDisplayPrefs();
  initSpeech();

  // Register service worker
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/static/sw.js").catch(() => {});
  }

  // Scroll-reveal: show elements as they come into view
  const observer = new IntersectionObserver(
    (entries) => entries.forEach(e => { if (e.isIntersecting) e.target.classList.add("visible"); }),
    { threshold: 0.1 }
  );
  document.querySelectorAll(".card").forEach(el => observer.observe(el));
});

// PWA install prompt
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const banner = document.getElementById("installBanner");
  if (banner) banner.classList.remove("hidden");
});
document.getElementById("installBtn")?.addEventListener("click", async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  deferredPrompt = null;
  if (outcome === "accepted") dismissInstall();
});

function dismissInstall() {
  document.getElementById("installBanner")?.classList.add("hidden");
}

// ── Theme ──────────────────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem("ca_theme") || "light";
  setTheme(saved, false);
}

function setTheme(theme, save = true) {
  document.documentElement.setAttribute("data-theme", theme);
  const icon  = document.getElementById("themeIcon");
  const label = document.getElementById("themeLabel");
  if (icon)  icon.className  = theme === "dark" ? "fas fa-sun" : "fas fa-moon";
  if (label) label.textContent = theme === "dark" ? "Light" : "Dark";
  if (save) localStorage.setItem("ca_theme", theme);
  // Sync pref-tab theme buttons
  document.getElementById("prefLight")?.classList.toggle("theme-opt-active", theme === "light");
  document.getElementById("prefDark")?.classList.toggle("theme-opt-active",  theme === "dark");
}

document.getElementById("themeBtn")?.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme");
  setTheme(current === "dark" ? "light" : "dark");
});

// ── Nav Buttons ────────────────────────────────────────────────
function initNavButtons() {
  document.getElementById("dashboardBtn")?.addEventListener("click", openDashboard);
  document.getElementById("accessibilityBtn")?.addEventListener("click", toggleAccessPanel);
}

// ── Char Counter + Live Analysis ───────────────────────────────
function initCharCounter() {
  const ta = document.getElementById("inputText");
  if (!ta) return;
  ta.addEventListener("input", () => {
    const len = ta.value.length;
    const el  = document.getElementById("charCount");
    if (el) el.textContent = `${len.toLocaleString()} character${len !== 1 ? "s" : ""}`;

    // Live indicator
    const dot = document.getElementById("liveIndicator");
    if (dot && len > 30) dot.classList.remove("hidden");
    else if (dot) dot.classList.add("hidden");

    // Debounced auto-analysis (after 1.8s idle)
    clearTimeout(analyzeTimer);
    if (len > 50) {
      analyzeTimer = setTimeout(() => analyzeText(true), 1800);
    }
  });
}

function initKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      analyzeText();
    }
    if (e.key === "Escape") {
      closeDashboard();
      closeAccessPanel();
    }
  });
}

// ── ANALYZE ────────────────────────────────────────────────────
async function analyzeText(silent = false) {
  const text = document.getElementById("inputText")?.value.trim() ?? "";
  if (!text) {
    if (!silent) alert("Please enter some text to analyse.");
    return;
  }

  if (!silent) showLoading(true);
  stopSpeak();

  try {
    const res  = await fetch("/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, session_id: SESSION_ID }),
    });
    if (!res.ok) throw new Error(`Server ${res.status}`);
    const data = await res.json();
    renderResults(data);
    showResultSections();

    // Hide live indicator after analysis done
    document.getElementById("liveIndicator")?.classList.add("hidden");
  } catch (err) {
    if (!silent) alert("Analysis failed. The server may be starting up — please wait 30 seconds and try again.");
    console.error(err);
  } finally {
    if (!silent) showLoading(false);
  }
}

// ── RENDER RESULTS ─────────────────────────────────────────────
function renderResults(data) {
  currentDiffLevel = data.difficulty_level;

  // ── Stats bar
  document.getElementById("statDiff").textContent  = `${data.difficulty_level} (${data.difficulty_score})`;
  document.getElementById("statWords").textContent = `${data.word_count} words`;
  document.getElementById("statGrade").textContent = `Grade ${data.flesch_grade}`;

  // ── Difficulty circle
  const badge = document.getElementById("difficultyBadge");
  badge.textContent = data.difficulty_level;
  badge.className   = `badge badge-${data.difficulty_level.toLowerCase()}`;

  document.getElementById("difficultyScore").textContent = data.difficulty_score;
  document.getElementById("wordCount").textContent       = data.word_count;
  document.getElementById("sentenceCount").textContent   = data.sentence_count;
  document.getElementById("difficultCount").textContent  = data.difficult_word_count;
  document.getElementById("fleschGrade").textContent     = `${data.flesch_grade}`;

  // Animate SVG circle
  const maxScore = 20;
  const pct   = Math.min(data.difficulty_score / maxScore, 1);
  const circum = 201;
  const offset = circum - pct * circum;
  const circle = document.getElementById("diffCircle");
  if (circle) {
    circle.style.strokeDashoffset = offset;
    const clr = data.difficulty_level === "Easy" ? "#10B981" : data.difficulty_level === "Medium" ? "#F59E0B" : "#EF4444";
    circle.style.stroke = clr;
  }

  // ── ML recommendations
  mlDataPoints = data.data_points;
  document.getElementById("recFont").textContent    = data.recommended_font + "px";
  document.getElementById("recSpacing").textContent = data.recommended_spacing + "x";

  const fontPct    = ((data.recommended_font - 14) / 26) * 100;
  const spacingPct = ((data.recommended_spacing - 1.0) / 2.0) * 100;
  document.getElementById("fontProgressBar").style.width    = fontPct + "%";
  document.getElementById("spacingProgressBar").style.width = spacingPct + "%";

  const dot = document.getElementById("modelDot");
  const msg = document.getElementById("modelStatus");
  if (data.data_points >= 5) {
    dot?.classList.add("active");
    if (msg) msg.textContent = `Model active — ${data.data_points} data points`;
    applyRecommendedSettings(data.recommended_font, data.recommended_spacing);
  } else {
    if (msg) msg.textContent = `Need ${5 - data.data_points} more interactions to train model`;
  }

  document.getElementById("mlDataPoints").textContent = data.data_points;

  // ── Sources
  const sources = data.sources_used || [];
  const names = { custom: "Custom Dictionary", dataset: "Public Dataset", wordnet: "WordNet" };
  ["custom", "dataset", "wordnet"].forEach(s => {
    const el = document.getElementById(`src-${s}`);
    if (el) el.classList.toggle("active", sources.includes(s));
  });
  const note = document.getElementById("sourceNote");
  if (note) {
    note.textContent = sources.length
      ? `Active: ${sources.map(s => names[s]).join(", ")} — ${data.difficult_word_count} difficult word(s) found`
      : "No difficult words detected — text is straightforward!";
  }

  // ── Text panels
  document.getElementById("originalTextOutput").innerHTML  = data.highlighted_html;
  document.getElementById("simplifiedTextOutput").innerHTML = data.simplified_html;

  applyFontToOutputs();
  attachHoverTracking();
  updateBehaviourPanel();
}

// ── SHOW / HIDE ────────────────────────────────────────────────
function showResultSections() {
  ["statsBar", "resultsGrid", "textOutputArea", "behaviorPanel"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove("hidden");
  });
  document.getElementById("resultsGrid")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function showLoading(visible) {
  const overlay = document.getElementById("loadingOverlay");
  const btn     = document.getElementById("analyzeBtn");
  if (!overlay) return;
  overlay.style.display = visible ? "flex" : "none";
  if (btn) btn.disabled = visible;

  if (visible) animateLoadingSteps();
}

function animateLoadingSteps() {
  const steps = ["step1", "step2", "step3"];
  const delays = [0, 800, 1600];
  steps.forEach((id, i) => {
    const el = document.getElementById(id);
    if (el) { el.className = "step"; }
  });
  steps.forEach((id, i) => {
    setTimeout(() => {
      document.getElementById(id)?.classList.add("active");
    }, delays[i]);
  });
}

// ── HOVER TRACKING ─────────────────────────────────────────────
function attachHoverTracking() {
  document.querySelectorAll(".tooltip-word").forEach(span => {
    if (span.dataset.tracked) return;
    span.dataset.tracked = "1";
    let start = null;

    span.addEventListener("mouseenter", () => { start = Date.now(); });
    span.addEventListener("mouseleave", () => {
      if (!start) return;
      const t = (Date.now() - start) / 1000;
      start = null;
      if (t < 0.3) return;

      const wl = parseInt(span.dataset.wordLength || "0", 10);
      totalHovers++;
      totalHoverTime += t;
      sessionEvents++;
      hoverData.push(parseFloat(t.toFixed(2)));
      if (hoverData.length > 50) hoverData.shift();

      updateBehaviorChart();

      trackBehavior({
        word:          span.textContent.trim(),
        word_length:   wl,
        hover_time:    parseFloat(t.toFixed(3)),
        font_size:     currentFontSize,
        line_spacing:  currentLineSpacing,
        difficulty_level: currentDiffLevel,
        session_id:    SESSION_ID,
      });
    });
  });
}

async function trackBehavior(payload) {
  try {
    const res = await fetch("/track_behavior", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return;
    const data = await res.json();
    mlDataPoints = data.data_points;
    updateBehaviourPanel();   // refresh panel after server confirms data saved

    // Update ML recommendation if model improved
    if (data.updated_recommendation && data.data_points >= 5) {
      const rec = data.updated_recommendation;
      document.getElementById("recFont").textContent    = rec.font_size + "px";
      document.getElementById("recSpacing").textContent = rec.line_spacing + "x";
      const fp = ((rec.font_size - 14) / 26) * 100;
      const sp = ((rec.line_spacing - 1.0) / 2.0) * 100;
      document.getElementById("fontProgressBar").style.width    = fp + "%";
      document.getElementById("spacingProgressBar").style.width = sp + "%";
      document.getElementById("modelDot")?.classList.add("active");
      const ms = document.getElementById("modelStatus");
      if (ms) ms.textContent = `Model updated — ${mlDataPoints} data points`;
    }
  } catch (_) {}
}

// ── BEHAVIOUR PANEL ────────────────────────────────────────────
function updateBehaviourPanel() {
  document.getElementById("totalHovers").textContent  = totalHovers;
  const avg = totalHovers > 0 ? (totalHoverTime / totalHovers).toFixed(1) + "s" : "0.0s";
  document.getElementById("avgHoverTime").textContent = avg;
  document.getElementById("sessionEvents").textContent = sessionEvents;
  document.getElementById("mlDataPoints").textContent  = mlDataPoints;
}

function updateBehaviorChart() {
  const canvas = document.getElementById("behaviorChart");
  if (!canvas) return;

  const labels = hoverData.map((_, i) => i + 1);

  if (behaviorChartInst) {
    behaviorChartInst.data.labels = labels;
    behaviorChartInst.data.datasets[0].data = hoverData;
    behaviorChartInst.update("active");
    return;
  }

  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const gridClr = isDark ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.07)";
  const textClr = isDark ? "#94A3B8" : "#64748B";

  behaviorChartInst = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "Hover Time (s)",
        data: hoverData,
        borderColor: "#6366F1",
        backgroundColor: "rgba(99,102,241,0.12)",
        borderWidth: 2.5,
        pointRadius: 4,
        pointBackgroundColor: "#6366F1",
        fill: true,
        tension: 0.4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: gridClr }, ticks: { color: textClr, maxTicksLimit: 8, font: { size: 10 } } },
        y: { grid: { color: gridClr }, ticks: { color: textClr, font: { size: 10 } }, beginAtZero: true },
      },
    },
  });
}

// ── DISPLAY CONTROLS ───────────────────────────────────────────
function applyDisplaySettings() {
  const fs = parseInt(document.getElementById("fontSlider")?.value || 20, 10);
  const ls = parseFloat(document.getElementById("spacingSlider")?.value || 1.5);
  currentFontSize    = fs;
  currentLineSpacing = ls;
  document.getElementById("fontValue").textContent    = fs + "px";
  document.getElementById("spacingValue").textContent  = ls.toFixed(1);
  applyFontToOutputs();
  saveDisplayPrefs();
}

function applyRecommendedSettings(fs, ls) {
  currentFontSize    = fs;
  currentLineSpacing = ls;
  const fontSlider    = document.getElementById("fontSlider");
  const spacingSlider = document.getElementById("spacingSlider");
  if (fontSlider)    fontSlider.value    = fs;
  if (spacingSlider) spacingSlider.value = ls;
  document.getElementById("fontValue").textContent    = fs + "px";
  document.getElementById("spacingValue").textContent  = parseFloat(ls).toFixed(1);
  applyFontToOutputs();
}

function applyFontToOutputs() {
  ["originalTextOutput", "simplifiedTextOutput"].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.style.fontSize   = currentFontSize + "px";
      el.style.lineHeight = currentLineSpacing;
    }
  });
}

function saveDisplayPrefs() {
  localStorage.setItem("ca_font",    currentFontSize);
  localStorage.setItem("ca_spacing", currentLineSpacing);
}

function restoreDisplayPrefs() {
  const fs = localStorage.getItem("ca_font");
  const ls = localStorage.getItem("ca_spacing");
  if (fs) {
    currentFontSize = parseFloat(fs);
    const sl = document.getElementById("fontSlider");
    const fv = document.getElementById("fontValue");
    if (sl) sl.value = fs;
    if (fv) fv.textContent = fs + "px";
  }
  if (ls) {
    currentLineSpacing = parseFloat(ls);
    const sl = document.getElementById("spacingSlider");
    const sv = document.getElementById("spacingValue");
    if (sl) sl.value = ls;
    if (sv) sv.textContent = parseFloat(ls).toFixed(1);
  }
  // Restore font face (new key, with backward compat for old dyslexic toggle)
  const ff = localStorage.getItem("ca_font_face");
  if (ff) {
    changeFont(ff);
  } else if (localStorage.getItem("ca_dyslexic") === "1") {
    changeFont("opendyslexic");
  }
}

// ── ACCESSIBILITY TOGGLES ──────────────────────────────────────
function changeFont(value) {
  FONT_CLASSES.forEach(c => document.body.classList.remove(c));
  if (value && value !== "inter") {
    document.body.classList.add(`font-${value}`);
  }
  // Sync both selectors
  const main  = document.getElementById("fontSelect");
  const panel = document.getElementById("fontSelectPanel");
  if (main)  main.value  = value || "inter";
  if (panel) panel.value = value || "inter";
  localStorage.setItem("ca_font_face", value || "inter");
}

function toggleHighContrast() {
  const on = document.getElementById("highContrast")?.checked;
  document.body.classList.toggle("high-contrast", on);
}

function toggleReduceMotion() {
  const on = document.getElementById("reduceMotion")?.checked;
  document.body.classList.toggle("reduce-motion", on);
}

function toggleLargeCursor() {
  const on = document.getElementById("largeCursor")?.checked;
  document.body.classList.toggle("large-cursor", on);
}

// ── DASHBOARD ──────────────────────────────────────────────────
async function openDashboard() {
  document.getElementById("dashboardModal").style.display = "flex";
  document.body.style.overflow = "hidden";

  try {
    const res  = await fetch("/dashboard_stats");
    const data = await res.json();
    renderDashboard(data);
  } catch (err) {
    console.error("Dashboard load failed:", err);
  }
}

function closeDashboard() {
  document.getElementById("dashboardModal").style.display = "none";
  document.body.style.overflow = "";
}

function renderDashboard(data) {
  document.getElementById("dashTotal").textContent     = data.total_analyses;
  document.getElementById("dashBehaviors").textContent = data.total_behaviors;
  document.getElementById("dashSessions").textContent  = data.sessions;
  document.getElementById("dashAvgDiff").textContent   = data.avg_difficulty;

  // Difficulty pie
  renderDiffChart(data.difficulty_distribution);

  // Hover histogram
  renderHoverHist(data.hover_data);

  // Recent table
  const tbody = document.getElementById("recentTableBody");
  if (tbody) {
    tbody.innerHTML = (data.recent_analyses || []).map(r => {
      const cls = r.level.toLowerCase();
      return `<tr>
        <td>${r.time}</td>
        <td><span class="badge badge-${cls}">${r.level}</span></td>
        <td>${r.score}</td>
        <td>${r.words}</td>
      </tr>`;
    }).join("");
  }
}

function renderDiffChart(dist) {
  const canvas = document.getElementById("diffChart");
  if (!canvas) return;

  if (diffChartInst) { diffChartInst.destroy(); }

  diffChartInst = new Chart(canvas, {
    type: "doughnut",
    data: {
      labels: ["Easy", "Medium", "Hard"],
      datasets: [{
        data: [dist.Easy || 0, dist.Medium || 0, dist.Hard || 0],
        backgroundColor: ["#10B981", "#F59E0B", "#EF4444"],
        borderWidth: 2,
        borderColor: "transparent",
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { position: "bottom", labels: { font: { size: 11 }, padding: 12 } },
      },
      cutout: "68%",
    },
  });
}

function renderHoverHist(hovers) {
  const canvas = document.getElementById("hoverHistChart");
  if (!canvas || !hovers?.length) return;

  if (hoverHistInst) { hoverHistInst.destroy(); }

  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const gridClr = isDark ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.07)";
  const textClr = isDark ? "#94A3B8" : "#64748B";

  hoverHistInst = new Chart(canvas, {
    type: "bar",
    data: {
      labels: hovers.map((_, i) => i + 1),
      datasets: [{
        label: "Hover Time (s)",
        data: hovers,
        backgroundColor: "rgba(99,102,241,0.65)",
        borderColor: "#6366F1",
        borderWidth: 1.5,
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: gridClr }, ticks: { color: textClr, font: { size: 10 }, maxTicksLimit: 10 } },
        y: { grid: { color: gridClr }, ticks: { color: textClr, font: { size: 10 } }, beginAtZero: true },
      },
    },
  });
}

// ── SPEECH TO TEXT ─────────────────────────────────────────────
function initSpeech() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    const btn = document.getElementById("micBtn");
    if (btn) btn.style.display = "none";
    return;
  }

  speechRecognition = new SpeechRecognition();
  speechRecognition.continuous     = false;  // false prevents double-transcription at session restarts
  speechRecognition.interimResults = true;
  speechRecognition.lang           = "en-US";

  speechRecognition.onresult = (e) => {
    const ta = document.getElementById("inputText");
    let finalText = "";
    let interimText = "";

    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        // Only accept results with reasonable confidence (filters background noise)
        if (e.results[i][0].confidence > 0.4) {
          finalText += e.results[i][0].transcript + " ";
        }
      } else {
        interimText += e.results[i][0].transcript;
      }
    }

    if (finalText) {
      ta.value += finalText;
      ta.dispatchEvent(new Event("input"));
    }
    const interim = document.getElementById("micInterim");
    if (interim) interim.textContent = interimText;
  };

  speechRecognition.onend = () => {
    const interim = document.getElementById("micInterim");
    if (interim) interim.textContent = "";
    // Small delay before restarting to prevent audio buffer overlap
    if (isListening) setTimeout(() => { try { speechRecognition.start(); } catch (_) {} }, 150);
  };

  speechRecognition.onerror = (e) => {
    if (e.error !== "no-speech") stopListening();
  };
}

function toggleMic() {
  isListening ? stopListening() : startListening();
}

function startListening() {
  if (!speechRecognition) return;
  isListening = true;
  try { speechRecognition.start(); } catch (_) {}

  const btn = document.getElementById("micBtn");
  btn?.classList.add("mic-active");
  const icon  = document.getElementById("micIcon");
  const label = document.getElementById("micLabel");
  if (icon)  icon.className      = "fas fa-stop";
  if (label) label.textContent   = "Stop";
  document.getElementById("micStatus")?.classList.remove("hidden");
}

function stopListening() {
  isListening = false;
  speechRecognition?.stop();

  const btn = document.getElementById("micBtn");
  btn?.classList.remove("mic-active");
  const icon  = document.getElementById("micIcon");
  const label = document.getElementById("micLabel");
  if (icon)  icon.className      = "fas fa-microphone";
  if (label) label.textContent   = "Speak";
  document.getElementById("micStatus")?.classList.add("hidden");
  const interim = document.getElementById("micInterim");
  if (interim) interim.textContent = "";
}

// ── TEXT TO SPEECH ─────────────────────────────────────────────
function toggleSpeak() {
  isSpeaking ? stopSpeak() : startSpeak();
}

function startSpeak() {
  if (!window.speechSynthesis) {
    alert("Text-to-speech is not supported in this browser. Please use Chrome or Edge.");
    return;
  }
  const el = document.getElementById("simplifiedTextOutput");
  const text = el ? el.textContent.trim() : "";
  if (!text) {
    alert("Please analyse some text first, then click Listen to hear the simplified version.");
    return;
  }

  window.speechSynthesis.cancel();

  const utt = new SpeechSynthesisUtterance(text);
  utt.rate  = 0.88;
  utt.pitch = 1.0;
  utt.lang  = "en-US";

  utt.onstart = () => {
    isSpeaking = true;
    const btn   = document.getElementById("listenBtn");
    const icon  = document.getElementById("listenIcon");
    const label = document.getElementById("listenLabel");
    btn?.classList.add("listen-active");
    if (icon)  icon.className    = "fas fa-stop";
    if (label) label.textContent = "Stop";
  };

  utt.onend = utt.onerror = () => stopSpeak();

  window.speechSynthesis.speak(utt);
}

function stopSpeak() {
  isSpeaking = false;
  window.speechSynthesis?.cancel();
  const btn   = document.getElementById("listenBtn");
  const icon  = document.getElementById("listenIcon");
  const label = document.getElementById("listenLabel");
  btn?.classList.remove("listen-active");
  if (icon)  icon.className    = "fas fa-volume-high";
  if (label) label.textContent = "Listen";
}

// ── ACCESSIBILITY PANEL ────────────────────────────────────────
function toggleAccessPanel() {
  const panel = document.getElementById("accessPanel");
  if (!panel) return;
  panel.style.display = panel.style.display === "none" ? "flex" : "none";
}
function closeAccessPanel() {
  const panel = document.getElementById("accessPanel");
  if (panel) panel.style.display = "none";
}

// ── SETTINGS MODAL ─────────────────────────────────────────────
function openSettings() {
  const modal = document.getElementById("settingsModal");
  if (!modal) return;
  modal.style.display = "flex";
  document.body.style.overflow = "hidden";
  switchSettingsTab("profile");
  loadProfileData();
  syncPrefSliders();
}

function closeSettings() {
  const modal = document.getElementById("settingsModal");
  if (modal) modal.style.display = "none";
  document.body.style.overflow = "";
}

function switchSettingsTab(tab) {
  ["profile", "prefs", "privacy"].forEach(t => {
    const sec = document.getElementById(`stab-${t}`);
    const btn = document.getElementById(`stab-btn-${t}`);
    if (sec) sec.style.display = t === tab ? "block" : "none";
    if (btn) {
      btn.classList.toggle("stab-active", t === tab);
      btn.setAttribute("aria-selected", t === tab ? "true" : "false");
    }
  });
  if (tab === "privacy") loadPrivacyStats();
}

async function loadProfileData() {
  try {
    const res  = await fetch("/api/profile");
    const data = await res.json();
    const el = (id) => document.getElementById(id);
    if (el("profileNameDisplay"))  el("profileNameDisplay").textContent  = data.name;
    if (el("profileEmailDisplay")) el("profileEmailDisplay").textContent = data.email;
    if (el("profileJoined"))       el("profileJoined").textContent       = `Member since ${data.created_at}`;
    if (el("settingsName"))        el("settingsName").value              = data.name;
    if (el("settingsAvatar"))      el("settingsAvatar").textContent      = data.name.charAt(0).toUpperCase();
  } catch (_) {}
}

async function saveProfileName() {
  const name = document.getElementById("settingsName")?.value.trim();
  const msg  = document.getElementById("nameMsg");
  if (!name) { setSettingsMsg(msg, "Name cannot be empty.", false); return; }
  try {
    const res  = await fetch("/api/update_name", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (data.error) { setSettingsMsg(msg, data.error, false); return; }
    setSettingsMsg(msg, "Name updated!", true);
    document.getElementById("profileNameDisplay").textContent = data.name;
    document.getElementById("settingsAvatar").textContent     = data.name.charAt(0).toUpperCase();
    const navName   = document.getElementById("navUsername");
    const navAvatar = document.getElementById("navAvatar");
    if (navName)   navName.textContent   = data.name;
    if (navAvatar) navAvatar.textContent = data.name.charAt(0).toUpperCase();
  } catch (_) { setSettingsMsg(msg, "Failed to update. Please try again.", false); }
}

async function savePassword() {
  const curr  = document.getElementById("settingsCurrPw")?.value;
  const newPw = document.getElementById("settingsNewPw")?.value;
  const conf  = document.getElementById("settingsConfPw")?.value;
  const msg   = document.getElementById("pwMsg");
  if (!curr || !newPw) { setSettingsMsg(msg, "All fields are required.", false); return; }
  if (newPw !== conf)  { setSettingsMsg(msg, "Passwords do not match.", false);   return; }
  try {
    const res  = await fetch("/api/change_password", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current_password: curr, new_password: newPw }),
    });
    const data = await res.json();
    if (data.error) { setSettingsMsg(msg, data.error, false); return; }
    setSettingsMsg(msg, "Password updated successfully!", true);
    ["settingsCurrPw", "settingsNewPw", "settingsConfPw"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });
  } catch (_) { setSettingsMsg(msg, "Failed to update password.", false); }
}

async function loadPrivacyStats() {
  try {
    const res  = await fetch("/api/profile");
    const data = await res.json();
    const pa = document.getElementById("privAnalyses");
    const pb = document.getElementById("privBehaviors");
    if (pa) pa.textContent = data.analysis_count;
    if (pb) pb.textContent = data.behavior_count;
  } catch (_) {}
}

async function confirmClearData() {
  if (!confirm("This will delete all hover tracking data and reset the ML model. Are you sure?")) return;
  const msg = document.getElementById("privacyMsg");
  try {
    const res  = await fetch("/api/clear_behavior_data", { method: "POST" });
    const data = await res.json();
    if (data.ok) {
      setSettingsMsg(msg, "Behaviour data cleared.", true);
      loadPrivacyStats();
      totalHovers = 0; totalHoverTime = 0; sessionEvents = 0; mlDataPoints = 0;
      updateBehaviourPanel();
    }
  } catch (_) { setSettingsMsg(msg, "Failed to clear data.", false); }
}

function showDeleteConfirm() {
  const box = document.getElementById("deleteConfirmBox");
  if (box) box.style.display = "block";
}
function hideDeleteConfirm() {
  const box = document.getElementById("deleteConfirmBox");
  if (box) box.style.display = "none";
  const pw  = document.getElementById("deleteConfirmPw");
  const msg = document.getElementById("deleteMsg");
  if (pw)  pw.value = "";
  if (msg) msg.textContent = "";
}

async function deleteAccount() {
  const pw  = document.getElementById("deleteConfirmPw")?.value;
  const msg = document.getElementById("deleteMsg");
  if (!pw) { setSettingsMsg(msg, "Enter your password.", false); return; }
  try {
    const res  = await fetch("/api/delete_account", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw }),
    });
    const data = await res.json();
    if (data.error) { setSettingsMsg(msg, data.error, false); return; }
    window.location.href = "/login";
  } catch (_) { setSettingsMsg(msg, "Failed. Please try again.", false); }
}

function syncPrefSliders() {
  const fs = document.getElementById("prefFontSize");
  const fv = document.getElementById("prefFontSizeVal");
  if (fs) fs.value = currentFontSize;
  if (fv) fv.textContent = currentFontSize + "px";

  const ls = document.getElementById("prefLineSpacing");
  const lv = document.getElementById("prefLineSpacingVal");
  if (ls) ls.value = currentLineSpacing;
  if (lv) lv.textContent = parseFloat(currentLineSpacing).toFixed(1);

  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  document.getElementById("prefLight")?.classList.toggle("theme-opt-active", !isDark);
  document.getElementById("prefDark")?.classList.toggle("theme-opt-active",   isDark);

  const ff = localStorage.getItem("ca_font_face") || "inter";
  const pfSel = document.getElementById("prefFontFace");
  if (pfSel) pfSel.value = ff;

  const hcEl = document.getElementById("prefHighContrast");
  const rmEl = document.getElementById("prefReduceMotion");
  const lcEl = document.getElementById("prefLargeCursor");
  if (hcEl) hcEl.checked = document.body.classList.contains("high-contrast");
  if (rmEl) rmEl.checked = document.body.classList.contains("reduce-motion");
  if (lcEl) lcEl.checked = document.body.classList.contains("large-cursor");
}

function prefSyncFontSize() {
  const val = document.getElementById("prefFontSize")?.value;
  if (!val) return;
  document.getElementById("prefFontSizeVal").textContent = val + "px";
  const sl = document.getElementById("fontSlider");
  if (sl) sl.value = val;
  currentFontSize = parseInt(val, 10);
  document.getElementById("fontValue").textContent = val + "px";
  applyFontToOutputs();
  saveDisplayPrefs();
}

function prefSyncLineSpacing() {
  const val = document.getElementById("prefLineSpacing")?.value;
  if (!val) return;
  document.getElementById("prefLineSpacingVal").textContent = parseFloat(val).toFixed(1);
  const sl = document.getElementById("spacingSlider");
  if (sl) sl.value = val;
  currentLineSpacing = parseFloat(val);
  document.getElementById("spacingValue").textContent = parseFloat(val).toFixed(1);
  applyFontToOutputs();
  saveDisplayPrefs();
}

function syncPrefHighContrast() {
  const on = document.getElementById("prefHighContrast")?.checked;
  document.body.classList.toggle("high-contrast", on);
  const main = document.getElementById("highContrast");
  if (main) main.checked = on;
}
function syncPrefReduceMotion() {
  const on = document.getElementById("prefReduceMotion")?.checked;
  document.body.classList.toggle("reduce-motion", on);
  const main = document.getElementById("reduceMotion");
  if (main) main.checked = on;
}
function syncPrefLargeCursor() {
  const on = document.getElementById("prefLargeCursor")?.checked;
  document.body.classList.toggle("large-cursor", on);
  const main = document.getElementById("largeCursor");
  if (main) main.checked = on;
}

function setSettingsMsg(el, text, ok) {
  if (!el) return;
  el.textContent  = text;
  el.className    = ok ? "settings-msg settings-msg-ok" : "settings-msg settings-msg-err";
  if (ok) setTimeout(() => { el.textContent = ""; el.className = "settings-msg"; }, 3500);
}
