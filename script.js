// ===== CACHE DOM ELEMENTS =====
const DOM = {
  songList: document.getElementById("songList"),
  searchInput: document.getElementById("searchSong"),
  minLevel: document.getElementById("minLevel"),
  maxLevel: document.getElementById("maxLevel"),
  filterNewOld: document.getElementById("filterNewOld"),
  filterDifficultyInputs: document.querySelectorAll(
    ".filter-difficulty input[type='checkbox']",
  ),
  sortLevel: document.getElementById("sortLevel"),
  pageInfo: document.getElementById("pageInfo"),
  paginationButtons: document.getElementById("paginationButtons"),
  modal: document.getElementById("songDetailModal"),
  modalCard: document.getElementById("songDetailCard"),
  rouletteBox: document.getElementById("rouletteBox"),
  rouletteText: document.getElementById("rouletteText"),
  constantInput: document.getElementById("constant"),
  scoreInput: document.getElementById("score"),
  resultSpan: document.getElementById("result"),
  rankImg: document.getElementById("rank"),
  songNameInput: document.getElementById("songName"),
  difficultySelect: document.getElementById("difficulty"),
  suggestionsDiv: document.getElementById("suggestions"),
  calcResult: document.getElementById("calcResult"),
  songCover: document.getElementById("songCover"),
  songTitle: document.getElementById("songTitle"),
  songArtist: document.getElementById("songArtist"),
  songNotes: document.getElementById("songNotes"),
  songBPM: document.getElementById("songBPM"),
  songAlbum: document.getElementById("songAlbum"),
};

// ===== CONSTANTS =====
const API_URL = "https://api.prp.icel.site/api/v1/songs";
const COVER_BASE = "https://prp.icel.site/cover";
const DEFAULT_IMG = "./asset/no-image.jpg";
const ITEMS_PER_PAGE = 36;

let songData = [];
let currentPage = 1;
let selectedCover = null;
let selectedSongInfo = null;

// ===== HELPER: VERSION COMPARE (reusable) =====
const versionCompare = (v1, v2, ascending = true) => {
  const parts1 = (v1 || "0").split(".").map(Number);
  const parts2 = (v2 || "0").split(".").map(Number);
  const maxLen = Math.max(parts1.length, parts2.length);
  for (let i = 0; i < maxLen; i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 !== p2) return ascending ? p1 - p2 : p2 - p1;
  }
  return 0;
};

// ===== DEBOUNCE UTILITY =====
function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

// ===== FILTER & SORT (optimized) =====
function getFilteredSongs() {
  const searchTerm = DOM.searchInput.value.toLowerCase();
  const filterDiffs = Array.from(DOM.filterDifficultyInputs)
    .filter((checkbox) => checkbox.checked)
    .map((checkbox) => checkbox.value);
  const filterNewOld = DOM.filterNewOld.value;
  const sortType = DOM.sortLevel.value;
  const minLv = parseFloat(DOM.minLevel.value);
  const maxLv = parseFloat(DOM.maxLevel.value);

  let filtered = [...songData];

  // Search filter
  if (searchTerm) {
    filtered = filtered.filter(
      (s) =>
        s.title.toLowerCase().includes(searchTerm) ||
        s.artist.toLowerCase().includes(searchTerm),
    );
  }

  // Difficulty filter
  if (filterDiffs.length > 0) {
    filtered = filtered.filter((s) => filterDiffs.includes(s.difficulty));
  }

  // New/Old filter
  if (filterNewOld === "new") filtered = filtered.filter((s) => s.b15 === true);
  else if (filterNewOld === "old") filtered = filtered.filter((s) => !s.b15);

  // Level range filter
  if (!isNaN(minLv)) filtered = filtered.filter((s) => s.level >= minLv);
  if (!isNaN(maxLv)) filtered = filtered.filter((s) => s.level <= maxLv);

  // Sort
  switch (sortType) {
    case "level_asc":
      filtered.sort((a, b) => a.level - b.level);
      break;
    case "level_desc":
      filtered.sort((a, b) => b.level - a.level);
      break;
    case "notes_asc":
      filtered.sort((a, b) => (a.notes || 0) - (b.notes || 0));
      break;
    case "notes_desc":
      filtered.sort((a, b) => (b.notes || 0) - (a.notes || 0));
      break;
    case "version_asc":
      filtered.sort((a, b) => versionCompare(a.version, b.version, true));
      break;
    case "version_desc":
      filtered.sort((a, b) => versionCompare(a.version, b.version, false));
      break;
    default:
      break;
  }

  return filtered;
}

// ===== PAGINATION RENDER =====
function renderPagination(totalPages) {
  DOM.paginationButtons.innerHTML = "";
  if (totalPages <= 1) return;

  const pages = [];
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pages.push(i);
  } else if (currentPage <= 4) {
    pages.push(1, 2, 3, 4, 5, "...", totalPages);
  } else if (currentPage >= totalPages - 3) {
    pages.push(
      1,
      "...",
      totalPages - 4,
      totalPages - 3,
      totalPages - 2,
      totalPages - 1,
      totalPages,
    );
  } else {
    pages.push(
      1,
      "...",
      currentPage - 1,
      currentPage,
      currentPage + 1,
      "...",
      totalPages,
    );
  }

  pages.forEach((page) => {
    if (page === "...") {
      const span = document.createElement("span");
      span.className = "page-separator";
      span.textContent = "...";
      DOM.paginationButtons.appendChild(span);
      return;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = page;
    btn.className = page === currentPage ? "page-btn active" : "page-btn";
    btn.onclick = () => {
      if (currentPage !== page) {
        currentPage = page;
        renderSongs();
      }
    };
    DOM.paginationButtons.appendChild(btn);
  });
}

// ===== MARQUEE EFFECT (optimized) =====
function applyMarquee() {
  setTimeout(() => {
    document.querySelectorAll(".song-title").forEach((el) => {
      const container = el.parentElement;
      const innerSpan = el.querySelector("span");
      if (!innerSpan) return;

      const textWidth = innerSpan.scrollWidth;
      const containerWidth = container.clientWidth;
      const originalText = el.getAttribute("data-text");

      if (textWidth > containerWidth) {
        const duration = Math.max(
          6,
          Math.round((textWidth + containerWidth) / 70),
        );
        el.classList.add("marquee-animate");
        el.style.animationDuration = `${duration}s`;
        el.style.textAlign = "left";
        el.innerHTML = `<span style="display: inline-block; padding-right: 48px;">${originalText}</span><span style="display: inline-block;">${originalText}</span>`;
      } else {
        el.classList.remove("marquee-animate");
        el.style.animationDuration = "";
        el.style.transform = "";
        el.innerHTML = `<span>${originalText}</span>`;
        el.style.textAlign = "center";
      }
    });
  }, 150);
}

// ===== RENDER SONG LIST =====
function renderSongs() {
  const filtered = getFilteredSongs();
  const totalPages = Math.ceil(filtered.length / ITEMS_PER_PAGE);
  if (currentPage > totalPages) currentPage = totalPages || 1;

  const start = (currentPage - 1) * ITEMS_PER_PAGE;
  const pageData = filtered.slice(start, start + ITEMS_PER_PAGE);

  DOM.songList.innerHTML = "";
  pageData.forEach((song) => {
    const div = document.createElement("div");
    div.className = "song-item";
    const imgSrc = song.cover ? `${COVER_BASE}/${song.cover}` : DEFAULT_IMG;
    div.innerHTML = `
      ${song.b15 ? '<span class="badge new">NEW</span>' : ""}
      <img src="${imgSrc}" onerror="this.src='${DEFAULT_IMG}'" loading="lazy">
      <div class="song-title-container">
        <h4 class="song-title" data-text="${escapeHtml(song.title)}">
          <span>${escapeHtml(song.title)}</span>
        </h4>
      </div>
      <p style="margin: 0 0 12px 0; font-size: 12px; color: #666;">${escapeHtml(song.artist)}</p>
      <div class="song-level">
        <span class="badge ${song.difficulty.toLowerCase()}">${song.difficulty}</span>
        <span>Lv ${song.level}</span>
      </div>
    `;
    div.onclick = () => showSongDetail(song);
    DOM.songList.appendChild(div);
  });

  DOM.pageInfo.innerText = `Page ${currentPage} / ${totalPages}`;
  renderPagination(totalPages);
  applyMarquee();
}

// Helper to escape HTML
function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/[&<>]/g, function (m) {
    if (m === "&") return "&amp;";
    if (m === "<") return "&lt;";
    if (m === ">") return "&gt;";
    return m;
  });
}

// ===== MODAL DETAILS =====
function showSongDetail(song) {
  const imgSrc = song.cover ? `${COVER_BASE}/${song.cover}` : DEFAULT_IMG;
  DOM.modalCard.innerHTML = `
    <div class="result-card">
      <img src="${imgSrc}"  onerror="this.src='${DEFAULT_IMG}'" loading="lazy">
      <h4 style="margin:5px 0 2px 0;">${escapeHtml(song.title)}</h4>
      <p style="margin: 0 0 12px 0; font-size: 12px; color: #666;">${escapeHtml(song.artist)}</p>
      <div class="song-level">
        <span class="badge ${song.difficulty.toLowerCase()}">${song.difficulty}</span>
        <span>Lv ${song.level}</span>
      </div>
      <div style="margin-top: 12px; font-size: 12px; color: #cbd5f5; text-align: left; width: 100%;">
        <div style="display: flex; justify-content: space-between; margin: 6px 0; gap: 12px;">
          <span><strong>Genre:</strong> ${escapeHtml(song.genre) || "N/A"}</span>
          <span><strong>BPM:</strong> ${escapeHtml(song.bpm) || "N/A"}</span>
        </div>
        <div style="display: flex; justify-content: space-between; margin: 6px 0; gap: 12px;">
          <span><strong>Notes:</strong> ${song.notes || "N/A"}</span>
          <span><strong>Album:</strong> ${escapeHtml(song.album) || "N/A"}</span>
        </div>
        <div style="margin: 6px 0;">
          <span><strong>Version:</strong> ${escapeHtml(song.version) || "N/A"}</span>
        </div>
      </div>
      <button style="margin-top: 10px;" onclick="pickThisSong()" class="btn btn-primary">Pick this song</button>
    </div>
  `;
  window.selectedSong = song;
  DOM.modal.classList.add("show");
}

function closeSongDetailModal() {
  DOM.modal.classList.remove("show");
}

function pickThisSong() {
  const song = window.selectedSong;
  if (!song) return;
  switchPage("calc");
  DOM.songNameInput.value = song.title;
  DOM.difficultySelect.value = song.difficulty;
  DOM.constantInput.value = song.level;
  selectedCover = song.cover ? `${COVER_BASE}/${song.cover}` : DEFAULT_IMG;
  selectedSongInfo = song;
  closeSongDetailModal();
}

// ===== PAGE NAVIGATION (fixed no global event) =====
function switchPage(pageId) {
  document
    .querySelectorAll(".page")
    .forEach((p) => p.classList.remove("active"));
  document.getElementById(pageId).classList.add("active");
}

function setActiveMenuButton(btn) {
  document
    .querySelectorAll(".menu button")
    .forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
}

// Attach to menu buttons manually in HTML or via JS
document.querySelectorAll(".menu button").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    const pageId = btn.getAttribute("data-page"); // need data-page="list" or "calc"
    if (pageId) switchPage(pageId);
    setActiveMenuButton(btn);
  });
});

// ===== RANDOM SONG (roulette) =====
async function randomSong() {
  const filtered = getFilteredSongs();
  if (!filtered.length) {
    alert("No songs match your criteria!");
    return;
  }

  DOM.rouletteBox.classList.add("show");
  let duration = 2000;
  let intervalTime = 50;
  let elapsed = 0;

  const interval = setInterval(() => {
    const rand = filtered[Math.floor(Math.random() * filtered.length)];
    DOM.rouletteText.innerText = `${rand.title} - ${rand.difficulty} Lv ${rand.level}`;
    elapsed += intervalTime;
    intervalTime += 15;
    if (elapsed >= duration) {
      clearInterval(interval);
      DOM.rouletteBox.classList.remove("show");
      const finalSong = filtered[Math.floor(Math.random() * filtered.length)];
      showSongDetail(finalSong);
    }
  }, intervalTime);
}

// ===== LOAD API =====
async function loadSongs() {
  try {
    const res = await fetch(API_URL);
    const data = await res.json();
    songData = data.data || data;
    currentPage = 1;
    renderSongs();
  } catch (err) {
    console.error("Failed to load songs", err);
    DOM.songList.innerHTML =
      "<p>Error loading songs. Please try again later.</p>";
  }
}

// ===== CALCULATOR FUNCTIONS (unchanged logic) =====
function getTrend(score) {
  if (score < 900000) return -9;
  if (score < 930000) return -6;
  if (score < 950000) return -5;
  if (score < 970000) return -4;
  if (score < 980000) return -3;
  if (score < 990000) return -2;
  if (score < 1000000) return -1;
  if (score < 1009000) return 0;
  return 1;
}

function getRank(score) {
  if (score < 800000) return "/asset/rank/rank_D.webp";
  if (score < 850000) return "/asset/rank/rank_C.webp";
  if (score < 900000) return "/asset/rank/rank_B.webp";
  if (score < 930000) return "/asset/rank/rank_A.webp";
  if (score < 950000) return "/asset/rank/rank_A+.webp";
  if (score < 970000) return "/asset/rank/rank_AA.webp";
  if (score < 980000) return "/asset/rank/rank_AA+.webp";
  if (score < 990000) return "/asset/rank/rank_AAA.webp";
  if (score < 1000000) return "/asset/rank/rank_AAA+.webp";
  if (score < 1009000) return "/asset/rank/rank_INF.webp";
  return "/asset/rank/rank_INF+.webp";
}

function calculate() {
  const constant = parseFloat(DOM.constantInput.value);
  const score = parseFloat(DOM.scoreInput.value);

  if (isNaN(constant) || isNaN(score)) {
    alert("Please fill in all fields!");
    return;
  }

  if (score < 0 || score > 1010000) {
    alert("Score must be between 0 and 1,010,000!");
    return;
  }

  const trend = getTrend(score);
  let result;
  if (score >= 1009000) {
    result =
      constant * 10 + 6 + Math.pow((score - 1009000) / 1000, 1.35) * 3 + trend;
  } else if (score >= 1000000) {
    result = constant * 10 + ((score / 10000 - 100) * 20) / 3 + trend;
  } else {
    result = constant * 10 * Math.pow(score / 1000000, 1.5) + trend;
  }

  DOM.rankImg.innerHTML = `Rank: <img src="${getRank(score)}" alt="Rank" style="height: 25px;">`;
  DOM.resultSpan.innerText = "Result: " + result.toFixed(2);

  // Display cover and result
  if (selectedCover && selectedSongInfo) {
    DOM.songCover.src = selectedCover;
    DOM.songCover.style.display = "flex";
    DOM.songTitle.textContent = selectedSongInfo.title;
    DOM.songArtist.textContent = selectedSongInfo.artist;
    DOM.songNotes.textContent = selectedSongInfo.notes || "N/A";
    DOM.songBPM.textContent = selectedSongInfo.bpm || "N/A";
    DOM.songAlbum.textContent = selectedSongInfo.album || "N/A";
  } else {
    DOM.songCover.style.display = "none";
    DOM.songTitle.textContent = "";
    DOM.songArtist.textContent = "";
    DOM.songNotes.textContent = "";
    DOM.songBPM.textContent = "";
    DOM.songAlbum.textContent = "";
  }
  DOM.calcResult.style.display = "flex";
}

// ===== AUTO-SUGGEST FOR CALCULATOR =====
function fillConstant() {
  const name = DOM.songNameInput.value.toLowerCase();
  const diff = DOM.difficultySelect.value;
  const song = songData.find(
    (s) => s.title.toLowerCase() === name && s.difficulty === diff,
  );
  if (song) {
    DOM.constantInput.value = song.level;
    selectedCover = song.cover ? `${COVER_BASE}/${song.cover}` : DEFAULT_IMG;
    selectedSongInfo = song;
  }
}

function showSuggestions(list) {
  DOM.suggestionsDiv.innerHTML = "";
  const unique = [...new Map(list.map((s) => [s.title, s])).values()];
  unique.slice(0, 10).forEach((song) => {
    const div = document.createElement("div");
    div.textContent = song.title;
    div.onclick = () => {
      DOM.songNameInput.value = song.title;
      DOM.suggestionsDiv.style.display = "none";
      fillConstant();
    };
    DOM.suggestionsDiv.appendChild(div);
  });
  DOM.suggestionsDiv.style.display = "block";
}

const handleSearchInput = debounce(() => {
  const keyword = DOM.songNameInput.value.toLowerCase();
  if (!keyword) {
    DOM.suggestionsDiv.style.display = "none";
    return;
  }
  const results = songData.filter((s) =>
    s.title.toLowerCase().includes(keyword),
  );
  showSuggestions(results);
}, 300);

// ===== FILTER CHANGE HANDLERS (debounced for range inputs) =====
function refreshList() {
  currentPage = 1;
  renderSongs();
}

const debouncedRefresh = debounce(refreshList, 150);
DOM.searchInput.addEventListener("input", refreshList);
DOM.filterDifficultyInputs.forEach((checkbox) =>
  checkbox.addEventListener("change", refreshList),
);
DOM.filterNewOld.addEventListener("change", refreshList);
DOM.sortLevel.addEventListener("change", refreshList);
DOM.minLevel.addEventListener("input", debouncedRefresh);
DOM.maxLevel.addEventListener("input", debouncedRefresh);

// ===== PAGINATION CONTROLS =====
function nextPage() {
  const totalPages = Math.ceil(getFilteredSongs().length / ITEMS_PER_PAGE);
  if (currentPage < totalPages) {
    currentPage++;
    renderSongs();
  }
}

function prevPage() {
  if (currentPage > 1) {
    currentPage--;
    renderSongs();
  }
}

// ===== CLOSE MODAL ON OUTSIDE CLICK =====
DOM.modal.addEventListener("click", (e) => {
  if (e.target === DOM.modal) closeSongDetailModal();
});

// ===== INIT =====
document.addEventListener("DOMContentLoaded", () => {
  loadSongs();
  DOM.songNameInput.addEventListener("input", handleSearchInput);
  DOM.difficultySelect.addEventListener("change", fillConstant);
  // Expose necessary globals for HTML onclick
  window.nextPage = nextPage;
  window.prevPage = prevPage;
  window.randomSong = randomSong;
  window.calculate = calculate;
  window.pickThisSong = pickThisSong;
  window.closeSongDetailModal = closeSongDetailModal;
  window.switchPage = switchPage; // fallback if needed
});
