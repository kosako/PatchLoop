const STORAGE_KEY = "patchloop.local.v1";

const seedState = {
  activeView: "portal",
  selectedDemoId: "demo-1",
  selectedFeedbackId: null,
  statusFilter: "all",
  demos: [
    {
      id: "demo-1",
      title: "Revenue Ops Cockpit",
      description: "営業・CS・経営が同じ画面を見て、パイプラインと更新リスクにコメントするための業務画面デモ。",
      owner: "Kosako",
      previewUrl: "http://localhost:3000/previews/revenue-ops",
      repo: "kosako/revenue-ops-demo",
      branch: "demo/revenue-cockpit",
      gitSha: "8f42c9a",
      status: "active",
      dataClassification: "internal_dummy",
      expiresAt: "2026-06-15",
      createdAt: "2026-05-16T04:30:00.000Z"
    },
    {
      id: "demo-2",
      title: "Customer Risk Board",
      description: "CS チーム向けに、解約リスクの検知と次アクションをレビューする試作。",
      owner: "Product",
      previewUrl: "http://localhost:3000/previews/customer-risk",
      repo: "kosako/customer-risk-demo",
      branch: "demo/risk-board",
      gitSha: "c10a7db",
      status: "active",
      dataClassification: "public_dummy",
      expiresAt: "2026-06-01",
      createdAt: "2026-05-16T04:30:00.000Z"
    }
  ],
  feedback: [
    {
      id: "fb-1",
      demoId: "demo-1",
      comment: "Expansion pipeline の増減理由を見られる導線がほしいです。",
      author: "Kosako",
      x: 42,
      y: 56,
      selector: ".sample-panel.wide",
      pageUrl: "http://localhost:3000/previews/revenue-ops",
      browser: "Local browser",
      viewport: "1440x900",
      status: "new",
      issueUrl: "https://github.com/kosako/revenue-ops-demo/issues/new?title=PatchLoop%20feedback",
      pullRequestUrl: "",
      consoleLogs: ["info: preview loaded", "warn: using mock revenue data"],
      networkErrors: [],
      screenshot: "",
      createdAt: "2026-05-16T04:35:00.000Z"
    }
  ]
};

let state = loadState();
let feedbackMode = false;
let pendingPoint = null;

const viewTitles = {
  portal: "Demo Portal",
  preview: "Preview Feedback",
  dashboard: "Feedback Dashboard"
};

const statuses = ["all", "new", "triaged", "ai-fix-candidate", "in-progress", "fixed", "rejected"];

const $ = (selector) => document.querySelector(selector);

function loadState() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return structuredClone(seedState);
    return { ...structuredClone(seedState), ...JSON.parse(stored) };
  } catch {
    return structuredClone(seedState);
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function render() {
  renderNavigation();
  renderMetrics();
  renderDemos();
  renderDemoSelect();
  renderPins();
  renderStatusFilters();
  renderFeedbackList();
  renderDetail();
  updatePreviewDemo();
  saveState();
}

function renderNavigation() {
  $("#viewTitle").textContent = viewTitles[state.activeView];
  document.querySelectorAll(".view").forEach((view) => view.classList.remove("active"));
  $(`#${state.activeView}View`).classList.add("active");
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.view === state.activeView);
  });
}

function renderMetrics() {
  const feedback = state.feedback;
  $("#demoCount").textContent = state.demos.length;
  $("#feedbackCount").textContent = feedback.length;
  $("#candidateCount").textContent = feedback.filter((item) => item.status === "ai-fix-candidate").length;
  $("#fixedCount").textContent = feedback.filter((item) => item.status === "fixed").length;
}

function renderDemos() {
  $("#demoList").innerHTML = state.demos
    .map((demo) => {
      const count = state.feedback.filter((item) => item.demoId === demo.id).length;
      return `
        <article class="demo-card">
          <div>
            <h4>${escapeHtml(demo.title)}</h4>
            <p>${escapeHtml(demo.description)}</p>
          </div>
          <div class="demo-meta">
            <span class="pill">${escapeHtml(demo.owner)}</span>
            <span class="pill">${escapeHtml(demo.dataClassification)}</span>
            <span class="pill">${count} feedback</span>
            <span class="pill">expires ${escapeHtml(demo.expiresAt)}</span>
          </div>
          <button class="secondary-button" data-open-demo="${demo.id}">Preview</button>
        </article>
      `;
    })
    .join("");
}

function renderDemoSelect() {
  $("#demoSelect").innerHTML = state.demos
    .map((demo) => `<option value="${demo.id}">${escapeHtml(demo.title)}</option>`)
    .join("");
  $("#demoSelect").value = state.selectedDemoId;
}

function renderPins() {
  const pins = state.feedback.filter((item) => item.demoId === state.selectedDemoId);
  $("#pinsLayer").innerHTML = pins
    .map((item, index) => `<div class="pin" style="left:${item.x}%; top:${item.y}%">${index + 1}</div>`)
    .join("");
}

function renderStatusFilters() {
  $("#statusFilters").innerHTML = statuses
    .map((status) => `<button class="status-button ${state.statusFilter === status ? "active" : ""}" data-status="${status}">${status}</button>`)
    .join("");
}

function renderFeedbackList() {
  const items = filteredFeedback();
  $("#feedbackList").innerHTML = items.length
    ? items
        .map((item) => {
          const demo = findDemo(item.demoId);
          return `
            <button class="feedback-item ${state.selectedFeedbackId === item.id ? "selected" : ""}" data-feedback="${item.id}">
              <h4>${escapeHtml(item.comment)}</h4>
              <div class="feedback-meta">
                <span class="pill">${escapeHtml(item.status)}</span>
                <span class="pill">${escapeHtml(demo?.title || "Unknown demo")}</span>
                <span class="pill">${formatDate(item.createdAt)}</span>
              </div>
            </button>
          `;
        })
        .join("")
    : `<p class="empty-state">まだフィードバックはありません。</p>`;
}

function renderDetail() {
  const item = state.feedback.find((feedback) => feedback.id === state.selectedFeedbackId) || filteredFeedback()[0];
  if (!item) {
    $("#detailPane").innerHTML = `<p class="empty-state">フィードバックを選ぶと、Issue 化に必要な文脈が表示されます。</p>`;
    return;
  }

  state.selectedFeedbackId = item.id;
  const demo = findDemo(item.demoId);
  const issueBody = buildIssueBody(item, demo);
  $("#detailPane").innerHTML = `
    <h3>${escapeHtml(item.comment)}</h3>
    <img class="snapshot" src="${item.screenshot || createSnapshot(item, demo)}" alt="Local visual snapshot" />
    <div class="detail-list">
      ${detailRow("Status", statusSelect(item))}
      ${detailRow("Demo", demo?.title || "Unknown")}
      ${detailRow("Author", item.author)}
      ${detailRow("URL", item.pageUrl)}
      ${detailRow("Position", `${item.x.toFixed(1)}%, ${item.y.toFixed(1)}%`)}
      ${detailRow("Selector", item.selector)}
      ${detailRow("Viewport", item.viewport)}
      ${detailRow("Git", `${demo?.branch || ""} @ ${demo?.gitSha || ""}`)}
      ${detailRow("Issue", `<a href="${item.issueUrl}" target="_blank" rel="noreferrer">mock issue link</a>`)}
    </div>
    <p class="panel-label">AI / GitHub Issue payload</p>
    <div class="issue-box">${escapeHtml(issueBody)}</div>
  `;
}

function detailRow(label, value) {
  return `<div class="detail-row"><span>${escapeHtml(label)}</span><span>${value}</span></div>`;
}

function statusSelect(item) {
  return `
    <select data-status-update="${item.id}">
      ${statuses
        .filter((status) => status !== "all")
        .map((status) => `<option value="${status}" ${item.status === status ? "selected" : ""}>${status}</option>`)
        .join("")}
    </select>
  `;
}

function filteredFeedback() {
  return state.feedback.filter((item) => state.statusFilter === "all" || item.status === state.statusFilter);
}

function findDemo(id) {
  return state.demos.find((demo) => demo.id === id);
}

function updatePreviewDemo() {
  const demo = findDemo(state.selectedDemoId);
  if (!demo) return;
  $("#sampleTitle").textContent = demo.title;
  $(".sample-nav span").textContent = `Preview branch: ${demo.branch}`;
}

function openView(view) {
  state.activeView = view;
  render();
}

function createFeedback(point, comment, author) {
  const demo = findDemo(state.selectedDemoId);
  const item = {
    id: `fb-${Date.now()}`,
    demoId: demo.id,
    comment,
    author,
    x: point.x,
    y: point.y,
    selector: point.selector,
    pageUrl: demo.previewUrl,
    browser: navigator.userAgent,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    status: "new",
    issueUrl: `https://github.com/${demo.repo}/issues/new?title=${encodeURIComponent(`[PatchLoop] ${comment.slice(0, 70)}`)}`,
    pullRequestUrl: "",
    consoleLogs: ["info: local PatchLoop prototype captured metadata"],
    networkErrors: [],
    screenshot: createSnapshot({ ...point, comment, author }, demo),
    createdAt: new Date().toISOString()
  };
  state.feedback.unshift(item);
  state.selectedFeedbackId = item.id;
  state.activeView = "dashboard";
  render();
}

function createSnapshot(item, demo) {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="960" height="600" viewBox="0 0 960 600">
      <rect width="960" height="600" fill="#f7f8f5"/>
      <rect x="38" y="38" width="884" height="524" rx="18" fill="#fff" stroke="#d9e1dd"/>
      <rect x="38" y="38" width="884" height="86" rx="18" fill="#eef4f2"/>
      <text x="72" y="91" font-family="Arial" font-size="28" font-weight="700" fill="#15201d">${escapeSvg(demo?.title || "PatchLoop demo")}</text>
      <rect x="72" y="170" width="500" height="270" rx="12" fill="#e8f3ef"/>
      <rect x="612" y="170" width="238" height="110" rx="12" fill="#fff3d6"/>
      <rect x="612" y="310" width="238" height="130" rx="12" fill="#f8e4e8"/>
      <circle cx="${38 + (item.x / 100) * 884}" cy="${38 + (item.y / 100) * 524}" r="18" fill="#d1495b" stroke="#fff" stroke-width="6"/>
      <text x="72" y="506" font-family="Arial" font-size="20" fill="#15201d">${escapeSvg((item.comment || "").slice(0, 90))}</text>
    </svg>
  `;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function buildIssueBody(item, demo) {
  return [
    `## Feedback`,
    item.comment,
    ``,
    `## Context`,
    `- Demo: ${demo?.title}`,
    `- URL: ${item.pageUrl}`,
    `- Position: ${item.x.toFixed(1)}%, ${item.y.toFixed(1)}%`,
    `- Selector: ${item.selector}`,
    `- Browser: ${item.browser}`,
    `- Viewport: ${item.viewport}`,
    `- Branch: ${demo?.branch}`,
    `- Git SHA: ${demo?.gitSha}`,
    `- Data classification: ${demo?.dataClassification}`,
    ``,
    `## Logs`,
    `Console: ${item.consoleLogs.join(", ") || "none"}`,
    `Network errors: ${item.networkErrors.join(", ") || "none"}`,
    ``,
    `## AI instruction`,
    `Reproduce the preview state, inspect the referenced area, propose a minimal UI or behavior fix, and open a PR. Do not auto-merge.`
  ].join("\n");
}

function formatDate(value) {
  return new Intl.DateTimeFormat("ja-JP", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeSvg(value = "") {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

document.addEventListener("click", (event) => {
  const nav = event.target.closest("[data-view]");
  if (nav) openView(nav.dataset.view);

  const demoButton = event.target.closest("[data-open-demo]");
  if (demoButton) {
    state.selectedDemoId = demoButton.dataset.openDemo;
    openView("preview");
  }

  const feedbackButton = event.target.closest("[data-feedback]");
  if (feedbackButton) {
    state.selectedFeedbackId = feedbackButton.dataset.feedback;
    render();
  }

  const statusButton = event.target.closest("[data-status]");
  if (statusButton) {
    state.statusFilter = statusButton.dataset.status;
    state.selectedFeedbackId = null;
    render();
  }
});

$("#openPreviewButton").addEventListener("click", () => openView("preview"));

$("#feedbackModeButton").addEventListener("click", () => {
  feedbackMode = !feedbackMode;
  $("#feedbackModeButton").textContent = `Feedback mode: ${feedbackMode ? "ON" : "OFF"}`;
  $(".preview-shell").classList.toggle("feedback-mode", feedbackMode);
});

$("#sampleApp").addEventListener("click", (event) => {
  if (!feedbackMode) return;
  const rect = $("#sampleApp").getBoundingClientRect();
  pendingPoint = {
    x: ((event.clientX - rect.left) / rect.width) * 100,
    y: ((event.clientY - rect.top) / rect.height) * 100,
    selector: selectorFor(event.target)
  };
  $("#commentInput").value = "";
  $("#feedbackDialog").showModal();
});

$("#saveFeedbackButton").addEventListener("click", (event) => {
  event.preventDefault();
  const comment = $("#commentInput").value.trim();
  const author = $("#authorInput").value.trim() || "Anonymous";
  if (!comment || !pendingPoint) return;
  $("#feedbackDialog").close();
  feedbackMode = false;
  $("#feedbackModeButton").textContent = "Feedback mode: OFF";
  $(".preview-shell").classList.remove("feedback-mode");
  createFeedback(pendingPoint, comment, author);
  pendingPoint = null;
});

$("#newDemoButton").addEventListener("click", () => {
  $("#demoTitleInput").value = "";
  $("#demoDescriptionInput").value = "";
  $("#demoOwnerInput").value = "Kosako";
  $("#demoDialog").showModal();
});

$("#saveDemoButton").addEventListener("click", (event) => {
  event.preventDefault();
  const title = $("#demoTitleInput").value.trim();
  if (!title) return;
  const id = `demo-${Date.now()}`;
  state.demos.unshift({
    id,
    title,
    description: $("#demoDescriptionInput").value.trim() || "新しく追加されたローカルデモ。",
    owner: $("#demoOwnerInput").value.trim() || "Unassigned",
    previewUrl: `http://localhost:3000/previews/${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    repo: "kosako/patchloop-demo",
    branch: "demo/local",
    gitSha: Math.random().toString(16).slice(2, 9),
    status: "active",
    dataClassification: $("#demoClassificationInput").value,
    expiresAt: "2026-06-30",
    createdAt: new Date().toISOString()
  });
  state.selectedDemoId = id;
  $("#demoDialog").close();
  render();
});

$("#demoSelect").addEventListener("change", (event) => {
  state.selectedDemoId = event.target.value;
  render();
});

$("#resetButton").addEventListener("click", () => {
  state = structuredClone(seedState);
  render();
});

document.addEventListener("change", (event) => {
  const select = event.target.closest("[data-status-update]");
  if (!select) return;
  const item = state.feedback.find((feedback) => feedback.id === select.dataset.statusUpdate);
  if (item) {
    item.status = select.value;
    render();
  }
});

function selectorFor(target) {
  if (!target || target === document.body) return "body";
  if (target.id) return `#${target.id}`;
  const classes = Array.from(target.classList || []).slice(0, 2);
  if (classes.length) return `${target.tagName.toLowerCase()}.${classes.join(".")}`;
  return target.tagName.toLowerCase();
}

render();
