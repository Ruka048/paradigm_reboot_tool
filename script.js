// =============================================================================
// PARADIGM TOOL — script.js
// Architecture: Module pattern with clear separation of concerns
//   - Config        : constants & settings
//   - State         : single source of truth
//   - DOM           : cached element references
//   - Utils         : pure helpers (escape, debounce, version compare)
//   - ImageService  : cover URL resolution & fallback chain
//   - ApiService    : data fetching
//   - FilterService : filter + sort logic
//   - Renderer      : grid / table / pagination / modal rendering
//   - Calculator    : score calculation logic
//   - UI            : page navigation, view mode, suggestions, roulette
//   - Init          : wires everything together
// =============================================================================

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const Config = Object.freeze({
  // API_V1: "https://api.prp.icel.site/api/v1/songs",
  // API_V1: "http://localhost:8080/api/v1/songs",
  API_V1: "https://api.prp.icel.site/api/v2/songs",
  // COVER_V1: "http://localhost:8080/covers",
  // COVER_V1: "https://prp-web-v2-f4ty2hjgt-icelocke.vercel.app/cover",
  COVER_V1: "https://prp.icel.site/cover",
  DEFAULT_IMG: "./asset/no-image.jpg",
  PAGE_SIZE: 36,
  MAX_FALLBACKS: 3,
  SUGGESTIONS: 10,
});

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
const State = {
  songs: [], // all songs from API v1
  currentPage: 1,
  viewMode: "grid",
  selectedCover: null,
  selectedSong: null, // song picked for calculator
  renderPending: false, // for batched scheduleRender

  // API fetch guards
  v1Fetched: false,
  v2Promise: null,
  v2List: null,

  // Caches
  v2Cache: new Map(), // getSongKey → v2 song | null
  failedUrls: new Set(), // URLs confirmed broken
  triedV2Urls: new Set(), // original URLs already attempted v2 fallback
  // Level sync state
  levelsLinked: false,
  _updatingLinkedLevels: false,
};

// ─────────────────────────────────────────────
// DOM
// ─────────────────────────────────────────────
const DOM = (() => {
  const $ = (id) => document.getElementById(id);
  return {
    // Song list
    songList: $("songList"),
    songTable: $("songTable"),
    // Filters
    searchInput: $("searchSong"),
    minLevel: $("minLevel"),
    maxLevel: $("maxLevel"),
    filterNewOld: $("filterNewOld"),
    sortLevel: $("sortLevel"),
    diffCheckboxes: () =>
      document.querySelectorAll("#difficultyDropdown input[type='checkbox']"),
    filterAlbum: $("filterAlbum"),
    syncLevelsBtn: $("syncLevelsBtn"),
    // Pagination
    pageInfo: $("pageInfo"),
    paginationBtns: $("paginationButtons"),
    // Modal
    modal: $("songDetailModal"),
    modalCard: $("songDetailCard"),
    // Roulette
    rouletteBox: $("rouletteBox"),
    rouletteText: $("rouletteText"),
    // Calculator inputs
    constantInput: $("constant"),
    scoreInput: $("score"),
    songNameInput: $("songName"),
    difficultySelect: $("difficulty"),
    suggestionsDiv: $("suggestions"),
    // Calculator result
    calcResult: $("calcResult"),
    rankEl: $("rank"),
    resultEl: $("result"),
    songCover: $("songCover"),
    songTitle: $("songTitle"),
    songArtist: $("songArtist"),
    resultDifficulty: $("resultDifficulty"),
    resultLevel: $("resultLevel"),
    songNotes: $("songNotes"),
    songBPM: $("songBPM"),
    songAlbum: $("songAlbum"),
    playRatingBlock: $("playRatingBlock"),
    // Reverse-calc UI
    desiredResult: $("desiredResult"),
    requiredScore: $("requiredScore"),
    requiredScoreBlock: $("requiredScoreBlock"),
    // Calculator tabs
    tabCalcForward: $("tabCalcForward"),
    tabCalcReverse: $("tabCalcReverse"),
    calcForward: $("calcForward"),
    calcReverse: $("calcReverse"),
    // Pool Edit Modal
    poolEditModal: $("poolEditModal"),
    editPoolName: $("editPoolName"),
    editPoolCapacity: $("editPoolCapacity"),
  };
})();

// ─────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────
const Utils = {
  /** Escape HTML special chars including quotes */
  escapeHtml(str) {
    if (!str) return "";
    return String(str).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  },

  /** Debounce a function */
  debounce(fn, delay) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  },

  /** Compare semver strings */
  versionCompare(a, b, asc = true) {
    const toArr = (v) => (v || "0").split(".").map(Number);
    const pa = toArr(a),
      pb = toArr(b);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d !== 0) return asc ? d : -d;
    }
    return 0;
  },

  /** Normalise string for fuzzy matching */
  normalise(s) {
    return String(s || "")
      .toLowerCase()
      .trim();
  },
};

// ─────────────────────────────────────────────
// IMAGE SERVICE
// ─────────────────────────────────────────────
const ImageService = {
  /** Build cover URL from a song object */
  getCoverUrl(song) {
    if (!song?.cover) return Config.DEFAULT_IMG;
    const base = song._v2Applied ? Config.COVER_V2 : Config.COVER_V1;
    return `${base.replace(/\/$/, "")}/${song.cover.replace(/^\/+/, "")}`;
  },

  /** Build a v2 cover URL directly from filename */
  _v2Url(filename) {
    return `${Config.COVER_V2.replace(/\/$/, "")}/${filename.replace(/^\/+/, "")}`;
  },

  /** Attach onerror handler to an img element */
  attachFallback(imgEl, song) {
    if (!imgEl) return;
    imgEl.onerror = () => this.handleError(imgEl, song).catch(() => { });
  },

  /** Fallback: do not call external v2 APIs — only use v1 data. */
  async handleError(imgEl, song) {
    if (!imgEl || imgEl.dataset.fallbackDone) return;

    const attempts = Number(imgEl.dataset.fallbackAttempts || 0);
    if (attempts >= Config.MAX_FALLBACKS) {
      return this._setDefault(imgEl);
    }
    imgEl.dataset.fallbackAttempts = attempts + 1;

    // Record the failed URL and stop — do NOT attempt v2 lookups or network calls.
    State.failedUrls.add(imgEl.src);
    this._setDefault(imgEl);
  },

  _setSrc(imgEl, song, url) {
    imgEl.onerror = null;
    imgEl.src = url;
    imgEl.onerror = () => this.handleError(imgEl, song).catch(() => { });
  },

  _setDefault(imgEl) {
    imgEl.onerror = null;
    imgEl.src = Config.DEFAULT_IMG;
    imgEl.dataset.fallbackDone = "1";
  },
};

// ─────────────────────────────────────────────
// API SERVICE
// ─────────────────────────────────────────────
const ApiService = {
  /** Load all songs from v1. Idempotent — safe to call multiple times. */
  async loadSongs() {
    if (State.v1Fetched) return;
    State.v1Fetched = true;
    try {
      const res = await fetch(Config.API_V1);
      const data = await res.json();
      State.songs = data.data ?? data ?? [];
      State.currentPage = 1;
      UI.buildAlbumDropdown(); // populate album filter once data is ready
      Renderer.renderSongs();
    } catch (err) {
      console.error("[ApiService] Failed to load v1 songs:", err);
      State.v1Fetched = false; // allow retry
      DOM.songList.innerHTML =
        "<p class='error-msg'>Failed to load songs. Please try again later.</p>";
    }
  },

  /** Fetch v2 song list (disabled). */
  async _ensureV2List() {
    // v2 fetching is disabled — we only use the v1 API (localhost).
    if (State.v2List !== null) return;
    State.v2List = [];
    State.v2Promise = Promise.resolve();
    await State.v2Promise;
  },

  /** Find v2 match for a song object. Disabled: always returns null. */
  async fetchV2Song(/* song */) {
    // v2 is disabled — do not perform network calls to other APIs.
    return null;
  },
};

// ─────────────────────────────────────────────
// FILTER SERVICE
// ─────────────────────────────────────────────
const FilterService = {
  /** Return filtered + sorted copy of State.songs */
  getFiltered() {
    const search = DOM.searchInput.value.toLowerCase();
    const diffs = Array.from(DOM.diffCheckboxes())
      .filter((cb) => cb.checked)
      .map((cb) => Utils.normalise(cb.value));
    const newOld = DOM.filterNewOld.value;
    const sort = DOM.sortLevel.value;
    const minLv = parseFloat(DOM.minLevel.value);
    const maxLv = parseFloat(DOM.maxLevel.value);
    const album = DOM.filterAlbum?.value || "";

    let list = [...State.songs];

    if (search)
      list = list.filter(
        (s) =>
          s.title.toLowerCase().includes(search) ||
          s.artist.toLowerCase().includes(search),
      );

    if (diffs.length)
      list = list.filter((s) => diffs.includes(Utils.normalise(s.difficulty)));

    if (newOld === "new") list = list.filter((s) => s.b15 === true);
    else if (newOld === "old") list = list.filter((s) => !s.b15);

    if (album)
      list = list.filter(
        (s) => Utils.normalise(s.album) === Utils.normalise(album),
      );

    if (!isNaN(minLv)) list = list.filter((s) => s.level >= minLv);
    if (!isNaN(maxLv)) list = list.filter((s) => s.level <= maxLv);

    switch (sort) {
      case "level_asc":
        list.sort((a, b) => a.level - b.level);
        break;
      case "level_desc":
        list.sort((a, b) => b.level - a.level);
        break;
      case "notes_asc":
        list.sort((a, b) => (a.notes || 0) - (b.notes || 0));
        break;
      case "notes_desc":
        list.sort((a, b) => (b.notes || 0) - (a.notes || 0));
        break;
      case "version_asc":
        list.sort((a, b) => Utils.versionCompare(a.version, b.version, true));
        break;
      case "version_desc":
        list.sort((a, b) => Utils.versionCompare(a.version, b.version, false));
        break;
    }

    return list;
  },
};

// ─────────────────────────────────────────────
// RENDERER
// ─────────────────────────────────────────────
const Renderer = {
  /** Batched render — collapses multiple calls in same frame */
  scheduleRender() {
    if (State.renderPending) return;
    State.renderPending = true;
    requestAnimationFrame(() => {
      State.renderPending = false;
      this.renderSongs();
    });
  },

  renderSongs() {
    if (State.viewMode === "table") this._renderTable();
    else this._renderGrid();
  },

  // ── Grid ──────────────────────────────────
  _renderGrid() {
    const { pageData, totalPages } = this._paginate();

    DOM.songList.innerHTML = "";
    DOM.songTable.style.display = "none";
    DOM.songList.style.display = "grid";

    for (const song of pageData) {
      DOM.songList.appendChild(this._buildGridCard(song));
    }

    this._updatePaginationInfo(totalPages);
    this._applyMarquee();
  },

  _buildGridCard(song) {
    const div = document.createElement("div");
    div.className = "song-item";
    div.onclick = () => this.showModal(song);

    // Dynamic Background based on difficulty
    const diff = (song.difficulty || "reboot").toLowerCase();
    const bgColors = {
      reboot: "rgba(255, 165, 0, 0.2)",
      massive: "rgba(128, 0, 128, 0.25)",
      invaded: "rgba(245, 108, 108, 0.2)",
      detected: "rgba(64, 158, 255, 0.2)"
    };
    div.style.backgroundColor = bgColors[diff] || "var(--bg-card)";

    if (song.b15) {
      const badge = document.createElement("span");
      badge.className = "badge new";
      badge.textContent = "NEW";
      div.appendChild(badge);
    }

    const img = this._buildImg(song, "");
    div.appendChild(img);

    // Title
    const titleWrap = document.createElement("div");
    titleWrap.className = "song-title-container";
    titleWrap.appendChild(this._buildMarqueeEl("h4", "song-title", song.title));
    div.appendChild(titleWrap);

    // Artist
    const artistEl = this._buildMarqueeEl(
      "p",
      "marquee-text artist-text",
      song.artist,
    );
    div.appendChild(artistEl);

    // Level row
    div.appendChild(this._buildLevelRow(song));

    return div;
  },

  // ── Table ─────────────────────────────────
  _renderTable() {
    const { pageData, totalPages } = this._paginate();

    DOM.songList.style.display = "none";
    DOM.songTable.style.display = "table";

    const tbody = DOM.songTable.querySelector("tbody");
    tbody.innerHTML = "";

    for (const song of pageData) {
      tbody.appendChild(this._buildTableRow(song));
    }

    this._updatePaginationInfo(totalPages);
    this._applyMarquee();
  },

  _buildTableRow(song) {
    const row = document.createElement("tr");
    row.style.cursor = "pointer";
    row.onclick = () => this.showModal(song);

    const cells = [
      (() => {
        const td = document.createElement("td");
        td.appendChild(this._buildImg(song, "table-cover"));
        return td;
      })(),
      this._td(Utils.escapeHtml(song.title), true),
      this._td(Utils.escapeHtml(song.artist), true),
      (() => {
        const td = document.createElement("td");
        td.innerHTML = `<span class="badge ${(song.difficulty || "").toLowerCase()}">${Utils.escapeHtml(song.difficulty || "N/A")}</span>`;
        return td;
      })(),
      this._td(`Lv ${song.level}`),
      this._td(song.notes || "N/A"),
      this._td(song.bpm || "N/A"),
      this._td(Utils.escapeHtml(song.version) || "N/A", true),
    ];

    cells.forEach((td) => row.appendChild(td));
    return row;
  },

  _td(content, isHtml = false) {
    const td = document.createElement("td");
    if (isHtml) td.innerHTML = content;
    else td.textContent = content;
    return td;
  },

  // ── Modal ─────────────────────────────────
  showModal(song) {
    DOM.modalCard.innerHTML = "";

    const genre = Utils.escapeHtml(song.genre) || "N/A";
    const bpm = Utils.escapeHtml(song.bpm) || "N/A";
    const album = Utils.escapeHtml(song.album) || "N/A";
    const notes = song.notes || "N/A";
    const version = Utils.escapeHtml(song.version) || "N/A";
    const title = Utils.escapeHtml(song.title);
    const artist = Utils.escapeHtml(song.artist);
    const coverUrl = song.cover ? ImageService.getCoverUrl(song) : Config.DEFAULT_IMG;

    const html = `
      <div class="song-detail-container">
        <div class="detail-cover-box">
          <img src="${coverUrl}" alt="${title}" onerror="this.src='${Config.DEFAULT_IMG}'">
        </div>
        
        <div class="detail-header-info">
          <div class="detail-title">${title}</div>
          <div class="detail-artist">${artist}</div>
        </div>

        <div class="song-level" style="justify-content: center; margin-bottom: 24px; gap: 12px;">
          <span class="badge ${song.difficulty.toLowerCase()}" style="text-transform: capitalize; padding: 6px 14px; font-size: 0.85rem;">${song.difficulty}</span>
          <span class="badge" style="background: rgba(255,255,255,0.1); color: white; padding: 6px 14px; font-size: 0.85rem;">Lv ${song.level}</span>
        </div>

        <div class="detail-grid">
          <div class="detail-grid-item">
            <span class="label">Genre</span>
            <span class="val">${genre}</span>
          </div>
          <div class="detail-grid-item">
            <span class="label">BPM</span>
            <span class="val">${bpm}</span>
          </div>
          <div class="detail-grid-item">
            <span class="label">Album</span>
            <span class="val" title="${album}">${album}</span>
          </div>
          <div class="detail-grid-item">
            <span class="label">Notes</span>
            <span class="val">${notes}</span>
          </div>
          <div class="detail-grid-item" style="grid-column: span 2;">
            <span class="label">Version</span>
            <span class="val">${version}</span>
          </div>
        </div>

        <div class="detail-action-group">
          <button class="btn-premium btn-premium-primary" id="modalPickBtn">
            <i class="fas fa-calculator"></i> Pick for Calculator
          </button>
          <button class="btn-premium btn-premium-outline btn-premium-yt" id="modalYtBtn">
            <i class="fab fa-youtube"></i> YouTube Chartview
          </button>
        </div>
      </div>
    `;

    DOM.modalCard.innerHTML = html;

    // Attach events
    document.getElementById("modalPickBtn").onclick = () => UI.pickSong(song);
    document.getElementById("modalYtBtn").onclick = () => {
      const q = `Paradigm: Reboot ${song.title} ${song.difficulty} Lv ${song.level} chartview`.trim();
      const url = "https://www.youtube.com/results?search_query=" + encodeURIComponent(q);
      window.open(url, "_blank", "noopener,noreferrer");
    };

    window.selectedSong = song;
    DOM.modal.classList.add("show");
  },

  closeModal() {
    DOM.modal.classList.remove("show");
  },

  // ── Pagination ────────────────────────────
  _paginate() {
    const filtered = FilterService.getFiltered();
    const totalPages = Math.max(
      1,
      Math.ceil(filtered.length / Config.PAGE_SIZE),
    );
    if (State.currentPage > totalPages) State.currentPage = totalPages;

    const start = (State.currentPage - 1) * Config.PAGE_SIZE;
    const pageData = filtered.slice(start, start + Config.PAGE_SIZE);
    return { pageData, totalPages, total: filtered.length };
  },

  _updatePaginationInfo(totalPages) {
    DOM.pageInfo.textContent = `Page ${State.currentPage} / ${totalPages}`;
    this._renderPaginationButtons(totalPages);
  },

  _renderPaginationButtons(totalPages) {
    DOM.paginationBtns.innerHTML = "";
    if (totalPages <= 1) return;

    const cp = State.currentPage;
    let pages = [];

    if (totalPages <= 7) {
      pages = Array.from({ length: totalPages }, (_, i) => i + 1);
    } else if (cp <= 4) {
      pages = [1, 2, 3, 4, 5, "…", totalPages];
    } else if (cp >= totalPages - 3) {
      pages = [
        1,
        "…",
        totalPages - 4,
        totalPages - 3,
        totalPages - 2,
        totalPages - 1,
        totalPages,
      ];
    } else {
      pages = [1, "…", cp - 1, cp, cp + 1, "…", totalPages];
    }

    for (const p of pages) {
      if (p === "…") {
        const sep = document.createElement("span");
        sep.className = "page-separator";
        sep.textContent = "…";
        DOM.paginationBtns.appendChild(sep);
        continue;
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = p;
      btn.className = p === cp ? "page-btn active" : "page-btn";
      btn.onclick = () => {
        if (State.currentPage !== p) {
          State.currentPage = p;
          this.renderSongs();
        }
      };
      DOM.paginationBtns.appendChild(btn);
    }
  },

  // ── Shared helpers ─────────────────────────
  _buildImg(song, className) {
    const img = document.createElement("img");
    img.loading = "lazy";
    if (className) img.className = className;
    img.src = song.cover ? ImageService.getCoverUrl(song) : Config.DEFAULT_IMG;
    ImageService.attachFallback(img, song);
    return img;
  },

  _buildLevelRow(song) {
    const row = document.createElement("div");
    row.className = "song-level";

    const diff = document.createElement("span");
    diff.className = `badge ${(song.difficulty || "").toLowerCase()}`;
    diff.style.textTransform = "capitalize";
    diff.textContent = song.difficulty || "N/A";
    row.appendChild(diff);

    const lv = document.createElement("span");
    lv.textContent = `Lv ${song.level}`;
    row.appendChild(lv);

    return row;
  },

  _buildMarqueeEl(tag, className, text) {
    const el = document.createElement(tag);
    el.className = className;
    el.setAttribute("data-text", Utils.escapeHtml(text));
    const span = document.createElement("span");
    span.innerHTML = Utils.escapeHtml(text);
    el.appendChild(span);
    return el;
  },

  // ── Marquee ───────────────────────────────
  _applyMarquee() {
    setTimeout(() => {
      document.querySelectorAll(".song-title, .marquee-text").forEach((el) => {
        const container = el.parentElement;
        const inner = el.querySelector("span");
        if (!inner) return;

        const textW = inner.scrollWidth;
        const contW = container.clientWidth;
        const raw = el.getAttribute("data-text") || "";

        if (textW > contW) {
          const dur = Math.max(6, Math.round((textW + contW) / 70));
          el.classList.add("marquee-animate");
          el.style.animationDuration = `${dur}s`;
          el.style.textAlign = "left";
          el.innerHTML = `<span style="display:inline-block;padding-right:48px;">${raw}</span><span style="display:inline-block;">${raw}</span>`;
        } else {
          el.classList.remove("marquee-animate");
          el.style.animationDuration = "";
          el.style.transform = "";
          el.innerHTML = `<span>${raw}</span>`;
          el.style.textAlign = "center";
        }
      });
    }, 150);
  },
};

// ─────────────────────────────────────────────
// CALCULATOR
// ─────────────────────────────────────────────
const Calculator = {
  /** Map score → rank image path */
  getRankImg(score) {
    const ranks = [
      [800000, "rank_D"],
      [850000, "rank_C"],
      [900000, "rank_B"],
      [930000, "rank_A"],
      [950000, "rank_A+"],
      [970000, "rank_AA"],
      [980000, "rank_AA+"],
      [990000, "rank_AAA"],
      [1000000, "rank_AAA+"],
      [1009000, "rank_INF"],
    ];
    const match = ranks.find(([threshold]) => score < threshold);
    const name = match ? match[1] : "rank_INF+";
    return `./asset/rank/${name}.webp`;
  },

  /** Trend offset for score — game logic, do not modify */
  getTrend(score) {
    if (score < 900000) return -9;
    if (score < 930000) return -6;
    if (score < 950000) return -5;
    if (score < 970000) return -4;
    if (score < 980000) return -3;
    if (score < 990000) return -2;
    if (score < 1000000) return -1;
    if (score < 1009000) return 0;
    return 1;
  },

  /** Compute final rating point */
  compute(constant, score) {
    const trend = this.getTrend(score);
    if (score >= 1009000)
      return (
        constant * 10 + 6 + Math.pow((score - 1009000) / 1000, 1.35) * 3 + trend
      );
    if (score >= 1000000)
      return constant * 10 + ((score / 10000 - 100) * 20) / 3 + trend;
    return constant * 10 * Math.pow(score / 1000000, 1.5) + trend;
  },

  /**
   * Find minimal integer score required to reach target points for a given constant.
   * Returns null when target is not achievable within score bounds.
   */
  requiredScoreFor(constant, target) {
    const MIN = 0;
    const MAX = 1010000;
    if (isNaN(constant) || isNaN(target)) return null;
    // Quick bounds check
    if (this.compute(constant, MAX) < target) return null;
    if (this.compute(constant, MIN) >= target) return MIN;

    let low = MIN;
    let high = MAX;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const val = this.compute(constant, mid);
      if (val >= target) high = mid;
      else low = mid + 1;
    }
    return low;
  },

  /** UI handler: read constant + desired target, compute required score, and render */
  findRequiredScoreUI() {
    const constant = parseFloat(DOM.constantInput.value);
    const target = parseFloat(DOM.desiredResult?.value);
    if (isNaN(constant) || isNaN(target)) {
      alert("Please select a song (to set level) and enter desired points.");
      return;
    }

    const req = this.requiredScoreFor(constant, target);
    if (req === null) {
      alert("Target points are not achievable for this song/level.");
      return;
    }

    // Update UI: show required score, rank for that score, and keep target points visible
    if (DOM.requiredScore) DOM.requiredScore.textContent = req.toString();
    if (DOM.requiredScoreBlock) DOM.requiredScoreBlock.style.display = "block";
    if (DOM.playRatingBlock) DOM.playRatingBlock.style.display = "none";
    DOM.rankEl.innerHTML = `Rank: <img src="${this.getRankImg(req)}" alt="Rank" style="height:25px;">`;

    this._renderResultCard();
    DOM.calcResult.style.display = "flex";
  },

  /** Entry point — called from HTML onclick */
  calculate() {
    const constant = parseFloat(DOM.constantInput.value);
    const score = parseFloat(DOM.scoreInput.value);

    // hide any previous reverse-calculation block and restore play rating block
    if (DOM.requiredScoreBlock) DOM.requiredScoreBlock.style.display = "none";
    if (DOM.playRatingBlock) DOM.playRatingBlock.style.display = "block";

    if (isNaN(constant) || isNaN(score)) {
      alert("Please fill in all fields!");
      return;
    }
    if (score < 0 || score > 1010000) {
      alert("Score must be between 0 and 1,010,000!");
      return;
    }

    const result = Math.floor(this.compute(constant, score) * 10000) / 10000; // round to 4 decimals

    DOM.rankEl.innerHTML = `Rank: <img src="${this.getRankImg(score)}" alt="Rank" style="height:25px;">`;
    DOM.resultEl.textContent = "Result: " + result;

    this._renderResultCard();
    DOM.calcResult.style.display = "flex";
  },

  _renderResultCard() {
    const song = State.selectedSong;
    if (!song || !State.selectedCover) {
      this._clearResultCard();
      return;
    }

    ImageService.attachFallback(DOM.songCover, song);
    DOM.songCover.src = State.selectedCover;
    DOM.songCover.style.display = "flex";

    DOM.songTitle.setAttribute("data-text", Utils.escapeHtml(song.title));
    DOM.songTitle.innerHTML = `<span>${Utils.escapeHtml(song.title)}</span>`;
    DOM.songArtist.textContent = song.artist || "";

    DOM.resultDifficulty.textContent = song.difficulty || "N/A";
    DOM.resultDifficulty.className = `badge ${(song.difficulty || "").toLowerCase()}`;
    DOM.resultDifficulty.style.textTransform = "capitalize";
    DOM.resultLevel.textContent = `Lv ${song.level}`;

    DOM.songNotes.textContent = song.notes || "N/A";
    DOM.songBPM.textContent = song.bpm || "N/A";

    const album = Utils.escapeHtml(song.album || "N/A");
    DOM.songAlbum.setAttribute("data-text", album);
    DOM.songAlbum.innerHTML = `<span>${album}</span>`;

    Renderer._applyMarquee();
  },

  _clearResultCard() {
    DOM.songCover.style.display = "none";
    DOM.songTitle.textContent = "";
    DOM.songArtist.textContent = "";
    DOM.resultDifficulty.textContent = "";
    DOM.resultDifficulty.className = "badge";
    DOM.resultLevel.textContent = "";
    DOM.songNotes.textContent = "";
    DOM.songBPM.textContent = "";
    DOM.songAlbum.textContent = "";
  },
};

// ─────────────────────────────────────────────
// UI — navigation, suggestions, roulette, etc.
// ─────────────────────────────────────────────
const UI = {
  // ── Page navigation ───────────────────────
  switchPage(pageId) {
    document
      .querySelectorAll(".page")
      .forEach((p) => p.classList.remove("active"));
    document.getElementById(pageId)?.classList.add("active");
  },

  _setActiveMenuBtn(btn) {
    document
      .querySelectorAll(".menu button")
      .forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
  },

  // ── View mode ─────────────────────────────
  setViewMode(mode) {
    State.viewMode = mode;
    State.currentPage = 1;
    document
      .querySelectorAll(".view-mode-btn")
      .forEach((b) => b.classList.remove("active"));
    document.querySelector(`[data-view="${mode}"]`)?.classList.add("active");
    Renderer.renderSongs();
  },

  // ── Filters ───────────────────────────────
  resetPageAndRender() {
    State.currentPage = 1;
    Renderer.renderSongs();
  },

  // ── Pagination helpers ────────────────────
  nextPage() {
    const total = Math.ceil(
      FilterService.getFiltered().length / Config.PAGE_SIZE,
    );
    if (State.currentPage < total) {
      State.currentPage++;
      Renderer.renderSongs();
    }
  },

  prevPage() {
    if (State.currentPage > 1) {
      State.currentPage--;
      Renderer.renderSongs();
    }
  },

  // ── Difficulty dropdown ───────────────────
  toggleDiffDropdown() {
    const dd = document.getElementById("difficultyDropdown");
    if (dd) dd.style.display = dd.style.display === "block" ? "none" : "block";
  },

  // ── Album dropdown ────────────────────────
  /**
   * Populate #filterAlbum <select> with sorted unique album names from State.songs.
   * Called once after songs are loaded, and again if songs change.
   */
  buildAlbumDropdown() {
    const select = DOM.filterAlbum;
    if (!select) return;

    const current = select.value; // preserve selection across rebuilds

    // Collect unique, non-empty album names
    const albums = [
      ...new Set(
        State.songs.map((s) => (s.album || "").trim()).filter(Boolean),
      ),
    ].sort((a, b) => a.localeCompare(b));

    select.innerHTML = '<option value="">All Albums</option>';
    for (const album of albums) {
      const opt = document.createElement("option");
      opt.value = album;
      opt.textContent = album;
      if (album === current) opt.selected = true;
      select.appendChild(opt);
    }
  },

  // ── Calculator suggestions ────────────────
  showSuggestions(list) {
    DOM.suggestionsDiv.innerHTML = "";
    // dedupe by title
    const unique = [...new Map(list.map((s) => [s.title, s])).values()].slice(
      0,
      Config.SUGGESTIONS,
    );

    for (const song of unique) {
      const item = document.createElement("div");
      item.textContent = song.title;
      item.onclick = () => {
        DOM.songNameInput.value = song.title;
        DOM.suggestionsDiv.style.display = "none";
        this._fillConstant();
      };
      DOM.suggestionsDiv.appendChild(item);
    }
    DOM.suggestionsDiv.style.display = unique.length ? "block" : "none";
  },

  _fillConstant() {
    const name = DOM.songNameInput.value.toLowerCase();
    const diff = DOM.difficultySelect.value;
    const song = State.songs.find(
      (s) =>
        s.title.toLowerCase() === name &&
        s.difficulty.toLowerCase() === diff.toLowerCase(),
    );
    if (song) {
      DOM.constantInput.value = song.level;
      State.selectedCover = song.cover
        ? ImageService.getCoverUrl(song)
        : Config.DEFAULT_IMG;
      State.selectedSong = song;

      // Clear fields to prepare for calculation
      if (DOM.scoreInput) DOM.scoreInput.value = "";
      if (DOM.desiredResult) DOM.desiredResult.value = "";
      DOM.rankEl.innerHTML = "";
      DOM.resultEl.textContent = "";
      if (DOM.requiredScoreBlock) DOM.requiredScoreBlock.style.display = "none";
      DOM.calcResult.style.display = "none";
    }
  },

  // ── Pick song from modal → calc ───────────
  pickSong(song) {
    this.switchPage("calc");
    DOM.songNameInput.value = song.title;

    // Auto fill difficulty robustly (case-insensitive)
    const diffMatch = (song.difficulty || "").toLowerCase();
    Array.from(DOM.difficultySelect.options).forEach(opt => {
      if (opt.value.toLowerCase() === diffMatch || opt.text.toLowerCase() === diffMatch) {
        DOM.difficultySelect.value = opt.value;
      }
    });
    DOM.constantInput.value = song.level;
    State.selectedCover = song.cover
      ? ImageService.getCoverUrl(song)
      : Config.DEFAULT_IMG;
    State.selectedSong = song;

    // Clear fields to prepare for calculation
    if (DOM.scoreInput) DOM.scoreInput.value = "";
    if (DOM.desiredResult) DOM.desiredResult.value = "";
    DOM.rankEl.innerHTML = "";
    DOM.resultEl.textContent = "";
    if (DOM.requiredScoreBlock) DOM.requiredScoreBlock.style.display = "none";
    DOM.calcResult.style.display = "none";

    Renderer.closeModal();
  },

  closePoolEditModal() {
    if (DOM.poolEditModal) DOM.poolEditModal.classList.remove("show");
  },

  // ── Roulette ──────────────────────────────
  async randomSong() {
    const list = FilterService.getFiltered();
    if (!list.length) {
      alert("No songs match your criteria!");
      return;
    }

    DOM.rouletteBox.classList.add("show");

    let elapsed = 0;
    let intervalTime = 50;
    const duration = 2000;

    const tick = setInterval(() => {
      const rand = list[Math.floor(Math.random() * list.length)];
      DOM.rouletteText.textContent = `${rand.title} - ${rand.difficulty} Lv ${rand.level}`;
      elapsed += intervalTime;
      intervalTime += 15;

      if (elapsed >= duration) {
        clearInterval(tick);
        DOM.rouletteBox.classList.remove("show");
        Renderer.showModal(list[Math.floor(Math.random() * list.length)]);
      }
    }, intervalTime);
  },
};

// ─────────────────────────────────────────────
// TOAST — lightweight notification system
// ─────────────────────────────────────────────
const Toast = {
  _icons: {
    success: "fas fa-check-circle",
    error: "fas fa-times-circle",
    info: "fas fa-info-circle",
  },

  show(message, type = "info", duration = 2800) {
    const container = document.getElementById("toastContainer");
    if (!container) return;

    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `<i class="${this._icons[type] || this._icons.info}"></i><span>${message}</span>`;

    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add("toast-out");
      setTimeout(() => toast.remove(), 320);
    }, duration);
  },
};

// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// CUSTOM POOL — persistent pools stored in localStorage
// ─────────────────────────────────────────────
const CustomPool = {
  STORAGE_KEY_OLD: "paradigm_custom_pool",
  STORAGE_KEY: "paradigm_custom_pools_v2",
  _pools: [], // array of { id, name, songs }
  _activePoolId: null,
  _viewMode: "grid",
  _searchQuery: "",

  // ── Persistence ───────────────────────────
  load() {
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        this._pools = data.pools || [];
        this._activePoolId = data.activeId;
      } else {
        // Migration from v1
        const oldRaw = localStorage.getItem(this.STORAGE_KEY_OLD);
        const oldPool = oldRaw ? JSON.parse(oldRaw) : [];
        const defaultId = Date.now().toString();
        this._pools = [
          { id: defaultId, name: "Default Pool", songs: oldPool }
        ];
        this._activePoolId = defaultId;
      }
    } catch {
      const defaultId = Date.now().toString();
      this._pools = [{ id: defaultId, name: "Default Pool", songs: [] }];
      this._activePoolId = defaultId;
    }

    // Ensure at least one pool exists
    if (!this._pools.length) {
      const defaultId = Date.now().toString();
      this._pools.push({ id: defaultId, name: "Default Pool", songs: [] });
      this._activePoolId = defaultId;
    }

    // Validate active pool
    if (!this._pools.find(p => p.id === this._activePoolId)) {
      this._activePoolId = this._pools[0].id;
    }

    this._updatePoolSelector();
    this._updateBadge();
  },

  _save() {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify({
        pools: this._pools,
        activeId: this._activePoolId
      }));
    } catch {
      /* quota exceeded — ignore */
    }
    this._updateBadge();
  },

  // ── Pool Management ───────────────────────
  switchPool(id) {
    if (this._pools.find(p => p.id === id)) {
      this._activePoolId = id;
      this._save();
      this.render();
    }
  },

  createNewPool() {
    const name = prompt("Enter new pool name:");
    if (!name || !name.trim()) return;

    const id = Date.now().toString();
    this._pools.push({ id, name: name.trim(), songs: [] });
    this._activePoolId = id;
    this._save();

    this._updatePoolSelector();
    this.render();
    Toast.show(`Created pool "${name.trim()}"`, "success");
  },

  editCurrentPool() {
    const pool = this._getActivePool();
    if (!pool) return;

    DOM.editPoolName.value = pool.name;
    DOM.editPoolCapacity.value = pool.maxCapacity || 0;

    DOM.poolEditModal.classList.add("show");
  },

  savePoolEdit() {
    const pool = this._getActivePool();
    if (!pool) return;

    const newName = DOM.editPoolName.value.trim();
    if (!newName) {
      Toast.show("Pool name cannot be empty.", "error");
      return;
    }

    const newCap = parseInt(DOM.editPoolCapacity.value, 10);
    if (isNaN(newCap) || newCap < 0) {
      Toast.show("Invalid capacity.", "error");
      return;
    }

    pool.name = newName;
    pool.maxCapacity = newCap;

    this._save();
    this._updatePoolSelector();
    this._updateBadge();
    this.render();

    Toast.show(`Pool updated!`, "success");
    UI.closePoolEditModal();
  },

  deleteCurrentPool() {
    const pool = this._getActivePool();
    if (!pool) return;

    if (this._pools.length <= 1) {
      alert("Cannot delete the last remaining pool. You can clear it instead.");
      return;
    }

    if (!confirm(`Are you sure you want to delete the pool "${pool.name}"?`)) return;

    this._pools = this._pools.filter(p => p.id !== pool.id);
    this._activePoolId = this._pools[0].id;
    this._save();

    this._updatePoolSelector();
    this.render();
    Toast.show(`Pool deleted.`, "info");
  },

  // ── Song operations ───────────────────────
  _getActivePool() {
    return this._pools.find(p => p.id === this._activePoolId);
  },

  _getSongKey(song) {
    return `${song.title}||${song.difficulty}`;
  },

  poolHasSong(poolId, song) {
    const pool = this._pools.find(p => p.id === poolId);
    if (!pool) return false;
    const key = this._getSongKey(song);
    return pool.songs.some(s => this._getSongKey(s) === key);
  },

  addToPool(poolId, song) {
    const pool = this._pools.find(p => p.id === poolId);
    if (!pool) return;

    if (pool.maxCapacity > 0 && pool.songs.length >= pool.maxCapacity) {
      Toast.show(`Cannot add: "${pool.name}" has reached its max capacity of ${pool.maxCapacity}.`, "error");
      return;
    }

    if (this.poolHasSong(poolId, song)) {
      Toast.show(`"${song.title}" is already in ${pool.name}.`, "info");
      return;
    }
    pool.songs.push(song);
    this._save();
    Toast.show(`Added "${song.title}" to ${pool.name}!`, "success");
    if (this._activePoolId === poolId) this._bumpBadge();
  },

  removeFromPool(poolId, song) {
    const pool = this._pools.find(p => p.id === poolId);
    if (!pool) return;

    const key = this._getSongKey(song);
    const before = pool.songs.length;
    pool.songs = pool.songs.filter((s) => this._getSongKey(s) !== key);

    if (pool.songs.length !== before) {
      this._save();
      Toast.show(`Removed "${song.title}" from ${pool.name}.`, "error");
      if (this._activePoolId === poolId) this.render();
    }
  },

  remove(song) {
    // Legacy wrapper, removes from active pool
    this.removeFromPool(this._activePoolId, song);
  },

  toggleStatus(song, status) {
    const pool = this._getActivePool();
    if (!pool) return;

    const key = this._getSongKey(song);
    const poolSong = pool.songs.find((s) => this._getSongKey(s) === key);
    if (poolSong) {
      if (poolSong._poolStatus === status) {
        poolSong._poolStatus = null;
      } else {
        poolSong._poolStatus = status;
      }
      this._save();
      this.render();
    }
  },

  clear() {
    const pool = this._getActivePool();
    if (!pool || !pool.songs.length) return;
    if (!confirm(`Clear all songs from "${pool.name}"?`)) return;

    pool.songs = [];
    this._save();
    Toast.show(`${pool.name} cleared.`, "info");
    this.render();
  },

  addAllFiltered() {
    const list = FilterService.getFiltered();
    if (!list.length) {
      alert("No songs match the current filter criteria!");
      return;
    }
    const pool = this._getActivePool();
    if (!pool) {
      alert("No active Custom Pool selected!");
      return;
    }

    if (!confirm(`Add ${list.length} song(s) to "${pool.name}"?`)) return;

    let addedCount = 0;
    for (const song of list) {
      if (pool.maxCapacity > 0 && pool.songs.length >= pool.maxCapacity) {
        Toast.show(`Capacity reached! Stopped adding at ${pool.maxCapacity} songs.`, "error");
        break;
      }
      if (!this.poolHasSong(pool.id, song)) {
        pool.songs.push(song);
        addedCount++;
      }
    }

    if (addedCount > 0) {
      this._save();
      Toast.show(`Added ${addedCount} song(s) to ${pool.name}!`, "success");

      // If we are currently viewing the pool page, refresh the layout
      if (document.getElementById("pool").classList.contains("active")) {
        this.render();
      }
    } else {
      Toast.show(`All these songs are already in ${pool.name}.`, "info");
    }
  },

  randomFill() {
    const list = FilterService.getFiltered();
    if (!list.length) {
      alert("No songs match the current filter criteria!");
      return;
    }
    const pool = this._getActivePool();
    if (!pool) {
      alert("No active Custom Pool selected!");
      return;
    }

    if (!pool.maxCapacity || pool.maxCapacity <= 0) {
      alert(`The pool "${pool.name}" has no Max Capacity set. Random Fill only works for pools with a limit.`);
      return;
    }

    let limit = pool.maxCapacity;

    const availableSlots = limit - pool.songs.length;
    if (availableSlots <= 0) {
      alert(`Pool is already full! (Capacity: ${pool.maxCapacity})`);
      return;
    }

    // Get songs from list that are NOT in pool
    const candidates = list.filter(song => !this.poolHasSong(pool.id, song));
    if (!candidates.length) {
      alert("All songs in the filtered list are already in the pool!");
      return;
    }

    const countToPick = Math.min(availableSlots, candidates.length);
    if (!confirm(`Randomly add ${countToPick} song(s) from current list to "${pool.name}"?`)) return;

    // Shuffle candidates
    const shuffled = [...candidates].sort(() => Math.random() - 0.5);
    const toAdd = shuffled.slice(0, countToPick);

    for (const song of toAdd) {
      pool.songs.push(song);
    }

    if (toAdd.length > 0) {
      this._save();
      Toast.show(`Added ${toAdd.length} random song(s) to ${pool.name}!`, "success");
      if (document.getElementById("pool").classList.contains("active")) {
        this.render();
      }
    }
  },

  randomSong() {
    const active = this._getActivePool();
    if (!active) return;

    // exclude banned and picked
    const available = active.songs.filter(s => s._poolStatus !== "ban" && s._poolStatus !== "pick");

    if (!available.length) {
      alert("No available songs to choose from! (All are banned or picked, or pool is empty)");
      return;
    }

    DOM.rouletteBox.classList.add("show");

    let elapsed = 0;
    let intervalTime = 50;
    const duration = 2000;

    const tick = setInterval(() => {
      const rand = available[Math.floor(Math.random() * available.length)];
      DOM.rouletteText.textContent = `${rand.title} - ${rand.difficulty} Lv ${rand.level}`;
      elapsed += intervalTime;
      intervalTime += 15;

      if (elapsed >= duration) {
        clearInterval(tick);
        DOM.rouletteBox.classList.remove("show");
        const finalSong = available[Math.floor(Math.random() * available.length)];

        // Automatically mark the randomized result as "picked"
        finalSong._poolStatus = "pick";
        // Need to use an arrow function because `this` isn't bound down here, oh wait, it's an arrow function `setInterval(() => {` so `this` is correct!
        this._save();
        this.render();

        Renderer.showModal(finalSong);
      }
    }, intervalTime);
  },

  // ── UI Updates ─────────────────────────────────
  _updatePoolSelector() {
    const selector = document.getElementById("poolSelector");
    if (!selector) return;
    selector.innerHTML = "";

    for (const pool of this._pools) {
      const opt = document.createElement("option");
      opt.value = pool.id;
      const capText = pool.maxCapacity > 0 ? `/${pool.maxCapacity}` : '';
      opt.textContent = `${pool.name} (${pool.songs.length}${capText})`;
      if (pool.id === this._activePoolId) opt.selected = true;
      selector.appendChild(opt);
    }

    // Attach event listener if not already there
    selector.onchange = (e) => this.switchPool(e.target.value);
  },

  _updateBadge() {
    const badge = document.getElementById("poolCount");
    if (!badge) return;
    const active = this._getActivePool();
    badge.textContent = active ? active.songs.length : 0;

    // Also update selector counts
    const selector = document.getElementById("poolSelector");
    if (selector) {
      Array.from(selector.options).forEach(opt => {
        const pool = this._pools.find(p => p.id === opt.value);
        if (pool) {
          const capText = pool.maxCapacity > 0 ? `/${pool.maxCapacity}` : '';
          opt.textContent = `${pool.name} (${pool.songs.length}${capText})`;
        }
      });
    }
  },

  _bumpBadge() {
    const badge = document.getElementById("poolCount");
    if (!badge) return;
    badge.classList.remove("bump");
    void badge.offsetWidth; // reflow to restart animation
    badge.classList.add("bump");
    setTimeout(() => badge.classList.remove("bump"), 250);
  },

  // ── Filtered list ─────────────────────────
  _getFiltered() {
    const active = this._getActivePool();
    if (!active) return [];
    const q = this._searchQuery.toLowerCase();
    if (!q) return [...active.songs];

    return active.songs.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.artist.toLowerCase().includes(q),
    );
  },

  // ── Render ────────────────────────────────
  render() {
    const listEl = document.getElementById("poolList");
    const tableEl = document.getElementById("poolTable");
    const emptyEl = document.getElementById("poolEmpty");
    if (!listEl || !tableEl || !emptyEl) return;

    this._updatePoolSelector();

    const activeInfo = this._getActivePool();
    const songs = this._getFiltered();

    if (!activeInfo || !activeInfo.songs.length) {
      emptyEl.style.display = "flex";
      listEl.style.display = "none";
      tableEl.style.display = "none";
      return;
    }

    emptyEl.style.display = "none";

    if (this._viewMode === "table") {
      listEl.style.display = "none";
      tableEl.style.display = "table";
      this._renderTable(songs, tableEl);
    } else {
      tableEl.style.display = "none";
      listEl.style.display = "grid";
      this._renderGrid(songs, listEl);
    }
  },

  _renderGrid(songs, container) {
    container.innerHTML = "";
    for (const song of songs) {
      const card = Renderer._buildGridCard(song);
      card.classList.add("pool-song-item");
      if (song._poolStatus === "pick") card.classList.add("pick-status");
      if (song._poolStatus === "ban") card.classList.add("ban-status");

      // Pick button
      const pickBtn = document.createElement("button");
      pickBtn.className = "pool-pick-btn";
      pickBtn.title = (song._poolStatus === "pick") ? "Unpick" : "Pick";
      pickBtn.innerHTML = '<i class="fas fa-check"></i>';
      pickBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.toggleStatus(song, "pick");
      });
      card.appendChild(pickBtn);

      // Ban button
      const banBtn = document.createElement("button");
      banBtn.className = "pool-ban-btn";
      banBtn.title = (song._poolStatus === "ban") ? "Unban" : "Ban";
      banBtn.innerHTML = '<i class="fas fa-ban"></i>';
      banBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.toggleStatus(song, "ban");
      });
      card.appendChild(banBtn);

      // Remove button (×)
      const removeBtn = document.createElement("button");
      removeBtn.className = "pool-remove-btn";
      removeBtn.title = "Remove from pool";
      removeBtn.innerHTML = '<i class="fas fa-times"></i>';
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.remove(song);
      });
      card.appendChild(removeBtn);

      container.appendChild(card);
    }
    Renderer._applyMarquee();
  },

  _renderTable(songs, tableEl) {
    const tbody = tableEl.querySelector("tbody");
    tbody.innerHTML = "";

    for (const song of songs) {
      const row = Renderer._buildTableRow(song);
      if (song._poolStatus === "pick") row.classList.add("pick-status");
      if (song._poolStatus === "ban") row.classList.add("ban-status");

      // Action cell
      const td = document.createElement("td");
      td.style.display = "flex";
      td.style.gap = "4px";

      const pickBtn = document.createElement("button");
      pickBtn.className = "btn";
      pickBtn.style.cssText = "padding:4px 8px;font-size:12px;background:linear-gradient(135deg, #10b981, #059669);border:none;";
      pickBtn.title = "Pick";
      pickBtn.innerHTML = '<i class="fas fa-check"></i>';
      pickBtn.addEventListener("click", (e) => { e.stopPropagation(); this.toggleStatus(song, "pick"); });

      const banBtn = document.createElement("button");
      banBtn.className = "btn";
      banBtn.style.cssText = "padding:4px 8px;font-size:12px;background:linear-gradient(135deg, #f59e0b, #d97706);border:none;";
      banBtn.title = "Ban";
      banBtn.innerHTML = '<i class="fas fa-ban"></i>';
      banBtn.addEventListener("click", (e) => { e.stopPropagation(); this.toggleStatus(song, "ban"); });

      const removeBtn = document.createElement("button");
      removeBtn.className = "btn";
      removeBtn.style.cssText =
        "padding:4px 8px;font-size:12px;background:linear-gradient(135deg,#7f1d1d,#dc2626);border:none;";
      removeBtn.title = "Remove";
      removeBtn.innerHTML = '<i class="fas fa-times"></i>';
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.remove(song);
      });

      td.appendChild(pickBtn);
      td.appendChild(banBtn);
      td.appendChild(removeBtn);
      row.appendChild(td);

      tbody.appendChild(row);
    }
  },

  // ── view mode ─────────────────────────────
  setViewMode(mode) {
    this._viewMode = mode;
    document.querySelectorAll(".pool-view-btn").forEach((b) => {
      b.classList.toggle("active", b.getAttribute("data-pool-view") === mode);
    });
    this.render();
  },
};

// ─────────────────────────────────────────────
// CONTEXT MENU — right-click + long-press
// ─────────────────────────────────────────────
const ContextMenu = {
  _menu: null,
  _currentSong: null,
  _longPressTimer: null,
  _longPressDuration: 500, // ms

  init() {
    this._menu = document.getElementById("songContextMenu");
    if (!this._menu) return;

    document.getElementById("ctxPickSong")?.addEventListener("click", () => {
      if (this._currentSong) {
        UI.pickSong(this._currentSong);
        // switch to calc page and set menu active
        document.querySelectorAll(".menu button").forEach((b) => b.classList.remove("active"));
        document.querySelector('[data-page="calc"]')?.classList.add("active");
      }
      this.hide();
    });

    // Hide on outside click / scroll / Escape
    document.addEventListener("click", (e) => {
      if (!this._menu.contains(e.target)) this.hide();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.hide();
    });
    document.addEventListener("scroll", () => this.hide(), true);
  },

  show(song, x, y) {
    if (!this._menu) return;
    this._currentSong = song;

    // Update header
    const header = document.getElementById("contextMenuTitle");
    if (header) header.textContent = song.title;

    // Render pool items dynamically
    const container = document.getElementById("ctxPoolListContainer");
    if (container) {
      container.innerHTML = "";
      for (const pool of CustomPool._pools) {
        const inPool = CustomPool.poolHasSong(pool.id, song);
        const btn = document.createElement("button");
        btn.className = "context-menu-item";
        btn.innerHTML = inPool
          ? `<i class="fas fa-minus-circle" style="color: #f87171;"></i> Remove from ${Utils.escapeHtml(pool.name)}`
          : `<i class="fas fa-plus-circle" style="color: #22c55e;"></i> Add to ${Utils.escapeHtml(pool.name)}`;

        btn.onclick = () => {
          if (inPool) CustomPool.removeFromPool(pool.id, song);
          else CustomPool.addToPool(pool.id, song);
          // If viewing pool page, force render
          if (document.getElementById("pool").classList.contains("active")) {
            CustomPool.render();
          }
          this.hide();
        };
        container.appendChild(btn);
      }
    }

    // Position — keep within viewport
    this._menu.style.display = "block";
    const mw = this._menu.offsetWidth;
    const mh = this._menu.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    this._menu.style.left = `${Math.min(x, vw - mw - 8)}px`;
    this._menu.style.top = `${Math.min(y, vh - mh - 8)}px`;
  },

  hide() {
    if (this._menu) this._menu.style.display = "none";
    this._currentSong = null;
  },

  // ── Attach to a song element ───────────────
  attachToEl(el, song) {
    // Right-click (PC)
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.show(song, e.clientX, e.clientY);
    });

    // Long-press (mobile)
    el.addEventListener("touchstart", (e) => {
      // Single-finger long press only
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      this._longPressTimer = setTimeout(() => {
        this.show(song, touch.clientX, touch.clientY);
        // Prevent click from firing after long press
        el.addEventListener("touchend", (te) => te.preventDefault(), { once: true });
      }, this._longPressDuration);
    }, { passive: true });

    el.addEventListener("touchend", () => {
      clearTimeout(this._longPressTimer);
    });
    el.addEventListener("touchmove", () => {
      clearTimeout(this._longPressTimer);
    }, { passive: true });
  },
};

// ─────────────────────────────────────────────
// Patch Renderer._buildGridCard to attach context menu
// ─────────────────────────────────────────────
const _origBuildGridCard = Renderer._buildGridCard.bind(Renderer);
Renderer._buildGridCard = function (song) {
  const div = _origBuildGridCard(song);
  ContextMenu.attachToEl(div, song);
  return div;
};

const _origBuildTableRow = Renderer._buildTableRow.bind(Renderer);
Renderer._buildTableRow = function (song) {
  const row = _origBuildTableRow(song);
  ContextMenu.attachToEl(row, song);
  return row;
};

// ─────────────────────────────────────────────
// INIT — wire everything together
// ─────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  // Load data
  ApiService.loadSongs();

  // Load pool from localStorage
  CustomPool.load();

  // Init context menu
  ContextMenu.init();

  // Menu buttons
  document.querySelectorAll(".menu button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const pageId = btn.getAttribute("data-page");
      if (pageId) UI.switchPage(pageId);
      UI._setActiveMenuBtn(btn);
      // Render pool when switching to pool tab
      if (pageId === "pool") CustomPool.render();
    });
  });

  // Filter listeners
  const debouncedRefresh = Utils.debounce(() => UI.resetPageAndRender(), 150);
  DOM.searchInput.addEventListener("input", () => UI.resetPageAndRender());
  DOM.filterNewOld.addEventListener("change", () => UI.resetPageAndRender());
  DOM.sortLevel.addEventListener("change", () => UI.resetPageAndRender());

  // Level inputs: support optional sync (link) between min and max
  DOM.minLevel.addEventListener("input", (e) => {
    if (State.levelsLinked && !State._updatingLinkedLevels) {
      State._updatingLinkedLevels = true;
      DOM.maxLevel.value = DOM.minLevel.value;
      State._updatingLinkedLevels = false;
    }
    debouncedRefresh();
  });

  DOM.maxLevel.addEventListener("input", (e) => {
    if (State.levelsLinked && !State._updatingLinkedLevels) {
      State._updatingLinkedLevels = true;
      DOM.minLevel.value = DOM.maxLevel.value;
      State._updatingLinkedLevels = false;
    }
    debouncedRefresh();
  });

  DOM.diffCheckboxes().forEach((cb) =>
    cb.addEventListener("change", () => UI.resetPageAndRender()),
  );

  // Sync button: toggle link between min/max
  if (DOM.syncLevelsBtn) {
    DOM.syncLevelsBtn.addEventListener("click", () => {
      State.levelsLinked = !State.levelsLinked;
      DOM.syncLevelsBtn.classList.toggle("active", State.levelsLinked);
      // when enabling, align both inputs to a sensible value (prefer min)
      if (State.levelsLinked) {
        const minVal = DOM.minLevel.value;
        const maxVal = DOM.maxLevel.value;
        const valToUse = minVal !== "" ? minVal : maxVal;
        if (valToUse !== "") {
          State._updatingLinkedLevels = true;
          DOM.minLevel.value = valToUse;
          DOM.maxLevel.value = valToUse;
          State._updatingLinkedLevels = false;
        }
      }
      UI.resetPageAndRender();
    });
  }

  // Album filter
  if (DOM.filterAlbum) {
    DOM.filterAlbum.addEventListener("change", () => UI.resetPageAndRender());
  }

  // Pool search
  const poolSearchInput = document.getElementById("searchPool");
  if (poolSearchInput) {
    poolSearchInput.addEventListener("input", () => {
      CustomPool._searchQuery = poolSearchInput.value;
      CustomPool.render();
    });
  }

  // Calculator autocomplete
  const debouncedSuggest = Utils.debounce(() => {
    const kw = DOM.songNameInput.value.toLowerCase();
    if (!kw) {
      DOM.suggestionsDiv.style.display = "none";
      return;
    }
    UI.showSuggestions(
      State.songs.filter((s) => s.title.toLowerCase().includes(kw)),
    );
  }, 300);

  DOM.songNameInput.addEventListener("input", debouncedSuggest);
  DOM.difficultySelect.addEventListener("change", () => UI._fillConstant());

  // Calculator tabs: switch between forward and reverse calculators
  const setCalcTab = (tab) => {
    if (
      !DOM.calcForward ||
      !DOM.calcReverse ||
      !DOM.tabCalcForward ||
      !DOM.tabCalcReverse
    )
      return;
    const forward = tab === "forward";
    DOM.tabCalcForward.classList.toggle("active", forward);
    DOM.tabCalcReverse.classList.toggle("active", !forward);
    DOM.calcForward.classList.toggle("active", forward);
    DOM.calcReverse.classList.toggle("active", !forward);
    // hide any reverse-result block when switching
    if (DOM.requiredScoreBlock) DOM.requiredScoreBlock.style.display = "none";
  };

  if (DOM.tabCalcForward)
    DOM.tabCalcForward.addEventListener("click", () => setCalcTab("forward"));
  if (DOM.tabCalcReverse)
    DOM.tabCalcReverse.addEventListener("click", () => setCalcTab("reverse"));
  // default
  setCalcTab("forward");

  // Close modal on outside click
  DOM.modal.addEventListener("click", (e) => {
    if (e.target === DOM.modal) Renderer.closeModal();
  });
  DOM.poolEditModal.addEventListener("click", (e) => {
    if (e.target === DOM.poolEditModal) UI.closePoolEditModal();
  });

  // Close difficulty dropdown on outside click
  document.addEventListener("click", (e) => {
    const dd = document.getElementById("difficultyDropdown");
    const btn = document.querySelector(".select-button");
    if (!dd || !btn) return;
    if (!btn.contains(e.target) && !dd.contains(e.target)) {
      dd.style.display = "none";
    }
  });

  // ── Expose globals for HTML onclick attributes ──
  Object.assign(window, {
    calculate: () => Calculator.calculate(),
    findRequiredScore: () => Calculator.findRequiredScoreUI(),
    randomSong: () => UI.randomSong(),
    pickThisSong: () => UI.pickSong(window.selectedSong),
    closeSongDetailModal: () => Renderer.closeModal(),
    closePoolEditModal: () => UI.closePoolEditModal(),
    switchPage: (id) => UI.switchPage(id),
    toggleViewMode: (m) => UI.setViewMode(m),
    toggleDifficultyDropdown: () => UI.toggleDiffDropdown(),
    nextPage: () => UI.nextPage(),
    prevPage: () => UI.prevPage(),
    // Pool globals
    clearPool: () => CustomPool.clear(),
    togglePoolViewMode: (m) => CustomPool.setViewMode(m),
    addAllFilteredToPool: () => CustomPool.addAllFiltered(),
    randomPoolSong: () => CustomPool.randomSong(),
    randomFillPool: () => CustomPool.randomFill(),
  });
});
