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
    // Reverse-calc UI
    desiredResult: $("desiredResult"),
    requiredScore: $("requiredScore"),
    requiredScoreBlock: $("requiredScoreBlock"),
    // Calculator tabs
    tabCalcForward: $("tabCalcForward"),
    tabCalcReverse: $("tabCalcReverse"),
    calcForward: $("calcForward"),
    calcReverse: $("calcReverse"),
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
    imgEl.onerror = () => this.handleError(imgEl, song).catch(() => {});
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
    imgEl.onerror = () => this.handleError(imgEl, song).catch(() => {});
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
    const card = document.createElement("div");
    card.className = "result-card";

    card.appendChild(this._buildImg(song, ""));

    const h4 = document.createElement("h4");
    h4.style.cssText = "margin: 5px 0 2px 0;";
    h4.innerHTML = Utils.escapeHtml(song.title);
    card.appendChild(h4);

    const artist = document.createElement("p");
    artist.style.cssText = "margin: 0 0 12px 0; font-size: 12px; color: #666;";
    artist.innerHTML = Utils.escapeHtml(song.artist);
    card.appendChild(artist);

    card.appendChild(this._buildLevelRow(song));

    // Info rows
    const info = document.createElement("div");
    info.style.cssText =
      "margin-top: 12px; font-size: 12px; color: #cbd5f5; text-align: left; width: 100%;";

    const rows = [
      [
        `<strong>Genre:</strong> ${Utils.escapeHtml(song.genre) || "N/A"}`,
        `<strong>BPM:</strong> ${Utils.escapeHtml(song.bpm) || "N/A"}`,
      ],
      [
        `<strong>Album:</strong> ${Utils.escapeHtml(song.album) || "N/A"}`,
        `<strong>Notes:</strong> ${song.notes || "N/A"}`,
      ],
      [`<strong>Version:</strong> ${Utils.escapeHtml(song.version) || "N/A"}`],
    ];

    for (const cols of rows) {
      const row = document.createElement("div");
      row.style.cssText =
        "display: flex; justify-content: space-between; margin: 6px 0; gap: 12px;";
      row.innerHTML = cols.map((c) => `<span>${c}</span>`).join("");
      info.appendChild(row);
    }
    card.appendChild(info);

    // YouTube search button (opens a new tab searching for chartview of this song)
    const youtubeBtn = document.createElement("button");
    youtubeBtn.type = "button";
    youtubeBtn.style.marginTop = "10px";
    youtubeBtn.style.marginRight = "8px";
    youtubeBtn.className = "btn btn-youtube";
    youtubeBtn.title = "Search chartview on YouTube";
    youtubeBtn.innerHTML =
      '<i class="fab fa-youtube fa-brands" aria-hidden="true" style="vertical-align:middle;margin-right:6px;color:#FF0000;font-size:15px"></i> YouTube';
    youtubeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const q =
        `Paradigm: Reboot ${song.title || ""} ${song.difficulty || ""} ${Math.trunc(song.level) || ""} chartview`.trim();
      const url =
        "https://www.youtube.com/results?search_query=" + encodeURIComponent(q);
      window.open(url, "_blank", "noopener,noreferrer");
    });
    card.appendChild(youtubeBtn);

    const btn = document.createElement("button");
    btn.style.marginTop = "10px";
    btn.className = "btn btn-primary";
    btn.textContent = "Pick this song";
    btn.addEventListener("click", () => UI.pickSong(song));
    card.appendChild(btn);

    DOM.modalCard.appendChild(card);
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
    DOM.rankEl.innerHTML = `Rank: <img src="${this.getRankImg(req)}" alt="Rank" style="height:25px;">`;
    DOM.resultEl.textContent = target;

    this._renderResultCard();
    DOM.calcResult.style.display = "flex";
  },

  /** Entry point — called from HTML onclick */
  calculate() {
    const constant = parseFloat(DOM.constantInput.value);
    const score = parseFloat(DOM.scoreInput.value);

    // hide any previous reverse-calculation block
    if (DOM.requiredScoreBlock) DOM.requiredScoreBlock.style.display = "none";

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
    }
  },

  // ── Pick song from modal → calc ───────────
  pickSong(song) {
    this.switchPage("calc");
    DOM.songNameInput.value = song.title;
    DOM.difficultySelect.value = song.difficulty;
    DOM.constantInput.value = song.level;
    State.selectedCover = song.cover
      ? ImageService.getCoverUrl(song)
      : Config.DEFAULT_IMG;
    State.selectedSong = song;
    Renderer.closeModal();
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
// INIT — wire everything together
// ─────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  // Load data
  ApiService.loadSongs();

  // Menu buttons
  document.querySelectorAll(".menu button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const pageId = btn.getAttribute("data-page");
      if (pageId) UI.switchPage(pageId);
      UI._setActiveMenuBtn(btn);
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
    switchPage: (id) => UI.switchPage(id),
    toggleViewMode: (m) => UI.setViewMode(m),
    toggleDifficultyDropdown: () => UI.toggleDiffDropdown(),
    nextPage: () => UI.nextPage(),
    prevPage: () => UI.prevPage(),
  });
});
