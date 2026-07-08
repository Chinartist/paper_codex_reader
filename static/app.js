const DEFAULT_PROMPT_TEMPLATES = [
  {
    id: "summary",
    title: "总结当前论文",
    prompt: "请用初学者能懂的中文总结当前论文：研究问题、核心方法、贡献、实验和局限。",
  },
  {
    id: "route",
    title: "给我阅读路线",
    prompt: "请给我一条阅读路线：先读哪些章节、关键术语是什么、哪些地方需要反复看。",
  },
];

const CONVERSATION_DRAFTS_KEY = "paperCodexConversationDrafts";
const RECENT_PAPERS_KEY = "paperCodexRecentPapers";
const READING_STATE_KEY = "paperCodexReadingState";
const RECENT_PAPER_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_SAVED_CONVERSATION_POSITIONS = 80;
const MAX_MESSAGE_ATTACHMENTS = 8;
const MAX_MESSAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const HIGHLIGHT_COLORS = ["yellow", "green", "blue", "pink", "purple"];

const state = {
  papers: [],
  conversations: [],
  activePaper: null,
  activeConversation: null,
  selectedText: "",
  selectedPage: null,
  selectionSource: "",
  activeHighlightId: null,
  selectedSnippets: [],
  highlights: [],
  highlightHoverTimer: 0,
  highlightPaletteOpen: false,
  pendingAttachments: [],
  selectedFiles: [],
  settings: {},
  busy: false,
  pending: {},
  tasks: [],
  taskStatuses: {},
  pdfDoc: null,
  pdfUrl: "",
  pdfRenderToken: 0,
  pdfOutline: [],
  pageObserver: null,
  renderedPages: new Set(),
  renderingPages: new Set(),
  zoomMode: "fit",
  zoom: 1,
  currentScale: 1,
  libraryQuery: "",
  librarySort: "created_desc",
  selectedLibraryPaperId: null,
  renamingPaperId: null,
  renamingConversationId: null,
  collapsedConversationGroups: JSON.parse(localStorage.getItem("paperCodexCollapsedConversationGroups") || "{}"),
  chatWidth: Number(localStorage.getItem("paperCodexChatWidth") || "440"),
  sidebarCollapsed: localStorage.getItem("paperCodexSidebarCollapsed") === "true",
  chatCollapsed: localStorage.getItem("paperCodexChatCollapsed") === "true",
  queueCollapsed: localStorage.getItem("paperCodexQueueCollapsed") === "true",
  promptTemplates: loadPromptTemplates(),
  conversationDrafts: loadConversationDrafts(),
  recentPapers: loadRecentPapers(),
  readingState: loadReadingState(),
  restoringPaperId: null,
  conversationAttachmentDrafts: {},
  editingPromptId: null,
  editingTaskId: null,
  editingResendMessageId: null,
  composingMessage: false,
  composerFocusUntil: 0,
  slashMenuIndex: 0,
  slashMenuSignature: "",
  selectionPositionFrame: 0,
  draggingTaskId: null,
  draggingFolderKey: null,
  draggingConversationId: null,
  sidebarDrag: null,
  suppressSidebarClickUntil: 0,
  mermaidRenderQueue: Promise.resolve(),
  mermaidPreviewUrls: [],
  mermaidPreviewToken: 0,
  mermaidPreviewZoom: 1,
};

const $ = (id) => document.getElementById(id);

const DEFAULT_MODEL = "gpt-5.5";

const MODEL_OPTIONS = [
  { value: "gpt-5.5", label: "gpt-5.5" },
  { value: "gpt-5.4", label: "gpt-5.4" },
  { value: "gpt-5.4-mini", label: "gpt-5.4-mini" },
  { value: "gpt-5.3-codex-spark", label: "gpt-5.3-codex-spark" },
  { value: "__custom__", label: "自定义..." },
];

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

applyPanelState();
applyChatWidth(state.chatWidth);

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const message = data && data.error ? data.error : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return data;
}

function toast(message, delay = 3200) {
  const box = $("toast");
  box.textContent = message;
  box.classList.remove("hidden");
  window.clearTimeout(box._timer);
  box._timer = window.setTimeout(() => box.classList.add("hidden"), delay);
}

function setBusy(value, label = "处理中...") {
  state.busy = value;
  $("workStatusText").textContent = label;
  $("workStatus").classList.toggle("hidden", !value);
  if (value) {
    toast(label, 60000);
  } else {
    $("toast").classList.add("hidden");
  }
  updateButtons();
}

function setConversationPending(conversationId, value, label = "Codex 正在处理...") {
  if (!conversationId) return;
  if (value) {
    state.pending[conversationId] = label;
  } else {
    delete state.pending[conversationId];
  }
  updateButtons();
  renderConversations();
}

async function loadInitialData() {
  resetShellScroll();
  await Promise.all([loadSettings(), loadStatus()]);
  await loadPapers();
  await loadConversations();
  await loadTasks({ silent: true });
  await restoreSavedConversation();
  updateContextHint();
  resetShellScroll();
  window.setInterval(() => loadTasks({ silent: false }).catch(() => {}), 1600);
}

async function loadSettings() {
  state.settings = await api("/api/settings");
  $("codexPathInput").value = state.settings.codex_path || "";
  syncModelControls(state.settings.model || "");
  $("reasoningInput").value = state.settings.reasoning_effort || "high";
  $("verbosityInput").value = state.settings.verbosity || "medium";
  $("timeoutInput").value = state.settings.codex_timeout_seconds || "600";
  $("quickReasoningInput").value = state.settings.reasoning_effort || "high";
}

async function saveSettings() {
  const payload = {
    codex_path: $("codexPathInput").value.trim(),
    model: selectedModelValue("modelInput", "customModelInput"),
    reasoning_effort: $("reasoningInput").value,
    verbosity: $("verbosityInput").value,
    codex_timeout_seconds: $("timeoutInput").value,
  };
  state.settings = await api("/api/settings", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  syncModelControls(state.settings.model || "");
  $("quickReasoningInput").value = state.settings.reasoning_effort || "high";
  toast("设置已保存");
  await loadStatus();
}

async function saveQuickSettings() {
  const payload = {
    ...state.settings,
    model: selectedModelValue("quickModelInput", "quickCustomModelInput"),
    reasoning_effort: $("quickReasoningInput").value,
  };
  state.settings = await api("/api/settings", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  syncModelControls(state.settings.model || "");
  $("reasoningInput").value = state.settings.reasoning_effort || "high";
  toast("Codex 配置已更新");
  await loadStatus();
}

function populateModelSelects() {
  for (const id of ["modelInput", "quickModelInput"]) {
    const select = $(id);
    select.innerHTML = MODEL_OPTIONS.map((option) => (
      `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`
    )).join("");
  }
}

function syncModelControls(value) {
  const normalizedValue = value || DEFAULT_MODEL;
  for (const [selectId, customId] of [["modelInput", "customModelInput"], ["quickModelInput", "quickCustomModelInput"]]) {
    const select = $(selectId);
    const custom = $(customId);
    const exists = MODEL_OPTIONS.some((option) => option.value === normalizedValue);
    select.value = exists ? normalizedValue : "__custom__";
    custom.value = exists ? "" : normalizedValue;
    custom.classList.toggle("hidden", select.value !== "__custom__");
  }
}

function selectedModelValue(selectId, customId) {
  const select = $(selectId);
  if (select.value === "__custom__") {
    return $(customId).value.trim() || DEFAULT_MODEL;
  }
  return select.value;
}

function handleModelChange(selectId, customId) {
  const custom = $(customId);
  custom.classList.toggle("hidden", $(selectId).value !== "__custom__");
  if ($(selectId).value === "__custom__") {
    custom.focus();
  }
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "未知";
  return new Intl.NumberFormat("zh-CN").format(number);
}

function formatPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "未知";
  return `${number.toFixed(number % 1 === 0 ? 0 : 1)}%`;
}

function formatTime(value) {
  if (!value) return "未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知";
  return date.toLocaleString("zh-CN", { hour12: false });
}

function accountDisplayName(account) {
  if (!account?.available) return "";
  return account.masked_email || account.display || account.name || account.account_id || account.auth_label || "";
}

function accountTooltip(status) {
  const account = status.account || {};
  const rows = [];
  rows.push(status.login_ok ? "Codex 已登录" : "Codex 未确认登录");
  if (account.available) {
    const name = accountDisplayName(account);
    if (name) rows.push(`账号：${name}`);
    if (account.name && account.name !== name) rows.push(`名称：${account.name}`);
  } else if (account.message) {
    rows.push(account.message);
  }
  if (status.version) rows.push(status.version);
  return rows.join("\n");
}

function loadConversationDrafts() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CONVERSATION_DRAFTS_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).map(([key, draft]) => [
        key,
        {
          message: typeof draft?.message === "string" ? draft.message : "",
          snippets: Array.isArray(draft?.snippets)
            ? draft.snippets
                .filter((item) => item && typeof item.text === "string")
                .map((item) => ({
                  id: item.id || makeId(),
                  text: item.text,
                  page: Number.isFinite(Number(item.page)) ? Number(item.page) : null,
                }))
            : [],
        },
      ])
    );
  } catch {
    return {};
  }
}

function activeDraftKey() {
  return state.activeConversation?.id ? `conversation:${state.activeConversation.id}` : null;
}

function draftIsEmpty(draft) {
  return !draft || (!draft.message?.trim() && !draft.snippets?.length);
}

function persistConversationDrafts() {
  const clean = Object.fromEntries(
    Object.entries(state.conversationDrafts).filter(([, draft]) => !draftIsEmpty(draft))
  );
  state.conversationDrafts = clean;
  try {
    localStorage.setItem(CONVERSATION_DRAFTS_KEY, JSON.stringify(clean));
  } catch {
    // Drafts are a convenience layer; storage failures should not block chatting.
  }
}

function saveActiveConversationDraft() {
  if (state.editingResendMessageId) return;
  const key = activeDraftKey();
  if (!key) return;
  state.conversationDrafts[key] = {
    message: $("messageInput")?.value || "",
    snippets: state.selectedSnippets.map((item) => ({ ...item })),
  };
  state.conversationAttachmentDrafts[key] = state.pendingAttachments.map((item) => ({ ...item }));
  persistConversationDrafts();
}

function restoreActiveConversationDraft() {
  const key = activeDraftKey();
  const draft = key ? state.conversationDrafts[key] : null;
  $("messageInput").value = draft?.message || "";
  state.selectedSnippets = draft?.snippets ? draft.snippets.map((item) => ({ ...item })) : [];
  state.pendingAttachments = key && state.conversationAttachmentDrafts[key]
    ? state.conversationAttachmentDrafts[key].map((item) => ({ ...item }))
    : [];
  renderSelectedContexts();
  renderAttachments();
}

function clearDraftForConversation(conversationId) {
  if (!conversationId) return;
  delete state.conversationDrafts[`conversation:${conversationId}`];
  delete state.conversationAttachmentDrafts[`conversation:${conversationId}`];
  persistConversationDrafts();
}

function usageWindowRow(label, limit) {
  if (!limit) {
    return `
      <div class="usage-window">
        <div><strong>${escapeHtml(label)}</strong><span>暂无数据</span></div>
      </div>
    `;
  }
  const used = Number(limit.used_percent);
  const width = Number.isFinite(used) ? clamp(used, 0, 100) : 0;
  const windowText = limit.window_minutes ? `${Math.round(Number(limit.window_minutes) / 60 * 10) / 10} 小时窗口` : "窗口未知";
  return `
    <div class="usage-window">
      <div>
        <strong>${escapeHtml(label)}</strong>
        <span>${escapeHtml(windowText)} · 剩余 ${escapeHtml(formatPercent(limit.remaining_percent))}</span>
      </div>
      <em>${escapeHtml(formatPercent(limit.used_percent))}</em>
      <div class="usage-meter" aria-hidden="true"><i style="width:${width}%"></i></div>
      <small>重置：${escapeHtml(formatTime(limit.resets_at_iso))}</small>
    </div>
  `;
}

function renderUsagePeek(usage) {
  const peek = $("usagePeek");
  const badge = $("usageBadge");
  const card = $("usageCard");
  if (!usage) {
    peek.classList.add("hidden");
    return;
  }
  peek.classList.remove("hidden");
  if (!usage.available) {
    badge.textContent = "用量未知";
    badge.classList.add("muted");
    card.innerHTML = `<p>${escapeHtml(usage.message || "Codex 未提供本地用量数据。")}</p>`;
    return;
  }
  badge.classList.remove("muted");
  const primary = usage.primary || {};
  badge.textContent = `用量 ${formatPercent(primary.used_percent)}`;
  const total = usage.total_token_usage || {};
  const last = usage.last_token_usage || {};
  const extraRows = [];
  if (usage.credits !== null && usage.credits !== undefined) {
    extraRows.push(`<span>Credits ${escapeHtml(formatNumber(usage.credits))}</span>`);
  }
  if (usage.individual_limit !== null && usage.individual_limit !== undefined) {
    extraRows.push(`<span>个人限额 ${escapeHtml(formatNumber(usage.individual_limit))}</span>`);
  }
  if (usage.rate_limit_reached_type) {
    extraRows.push(`<span>限额状态 ${escapeHtml(usage.rate_limit_reached_type)}</span>`);
  }
  card.innerHTML = `
    <div class="usage-card-head">
      <strong>Codex 用量</strong>
      <span>${escapeHtml(usage.plan_type || "plan 未知")}</span>
    </div>
    ${usageWindowRow("短窗口", usage.primary)}
    ${usageWindowRow("长窗口", usage.secondary)}
    <div class="usage-stats">
      <span>最近 ${escapeHtml(formatNumber(last.total_tokens))} tokens</span>
      <span>累计 ${escapeHtml(formatNumber(total.total_tokens))} tokens</span>
    </div>
    ${extraRows.length ? `<div class="usage-stats">${extraRows.join("")}</div>` : ""}
    <p>更新：${escapeHtml(formatTime(usage.updated_at))}</p>
  `;
}

async function loadStatus() {
  const status = await api("/api/status");
  const login = status.login_ok ? "已登录" : "未确认登录";
  const exists = Boolean(status.exists);
  const accountName = status.login_ok ? accountDisplayName(status.account) : "";
  $("codexStatus").innerHTML = `
    <strong>${escapeHtml(accountName ? `${login} · ${accountName}` : login)}</strong>
    <span class="codex-version">${escapeHtml(status.version || status.version_error || "未找到版本")}</span>
  `;
  $("codexStatus").title = accountTooltip(status);
  $("codexLoginBtn").disabled = !exists || status.login_ok;
  $("codexLogoutBtn").disabled = !exists || !status.login_ok;
  $("codexLoginBtn").title = exists ? "打开 Codex 登录流程" : "未找到 Codex CLI";
  $("codexLogoutBtn").title = exists ? "退出当前 Codex 账号" : "未找到 Codex CLI";
  renderUsagePeek(status.usage);
}

async function startCodexLogin() {
  const button = $("codexLoginBtn");
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "打开中";
  try {
    const result = await api("/api/codex/login", { method: "POST", body: "{}" });
    toast(result.message || "已打开 Codex 登录流程，请完成登录后刷新状态", 7000);
    window.setTimeout(() => loadStatus().catch(() => {}), 2000);
  } catch (error) {
    toast(error.message || "无法打开 Codex 登录流程", 7000);
  } finally {
    button.textContent = originalText;
    await loadStatus().catch(() => {});
  }
}

async function logoutCodex() {
  if (!window.confirm("确定要退出当前 Codex 账号吗？")) return;
  const button = $("codexLogoutBtn");
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "退出中";
  try {
    const result = await api("/api/codex/logout", { method: "POST", body: "{}" });
    toast(result.message || "已退出 Codex 账号");
  } catch (error) {
    toast(error.message || "退出 Codex 账号失败", 7000);
  } finally {
    button.textContent = originalText;
    await loadStatus().catch(() => {});
  }
}

async function loadPapers() {
  state.papers = await api("/api/papers");
  renderPapers();
  renderRecentPapers();
  if (!state.activePaper && state.papers.length) {
    const savedPaperId = state.readingState?.paperId;
    const paper = state.papers.find((item) => item.id === savedPaperId) || state.papers[0];
    await selectPaper(paper.id, { restoreReadingState: paper.id === savedPaperId });
  }
  updateContextHint();
}

function renderPapers() {
  const list = $("papersList");
  list.innerHTML = "";
  $("librarySummary").textContent = `${state.papers.length} 篇论文`;
  const papers = filteredPapers();
  if (!state.selectedLibraryPaperId && papers.length) {
    state.selectedLibraryPaperId = state.activePaper?.id || papers[0].id;
  }
  if (papers.length && !papers.some((paper) => paper.id === state.selectedLibraryPaperId)) {
    state.selectedLibraryPaperId = papers[0].id;
  }
  for (const paper of papers) {
    const item = document.createElement("button");
    item.type = "button";
    item.title = "双击打开阅读";
    item.className = [
      "paper-row",
      state.activePaper?.id === paper.id ? "active" : "",
      state.selectedLibraryPaperId === paper.id ? "selected" : "",
    ].filter(Boolean).join(" ");
    item.innerHTML = `
      <span class="paper-row-main">
        <strong>${escapeHtml(paper.title)}</strong>
        <span>${escapeHtml(shortSource(paper.source || paper.path))}</span>
      </span>
      <span class="paper-row-meta">
        <span>${escapeHtml(formatDate(paper.created_at))}</span>
        ${state.activePaper?.id === paper.id ? "<em>当前</em>" : ""}
      </span>
    `;
    item.addEventListener("click", () => selectLibraryPaper(paper.id));
    item.addEventListener("dblclick", () => openLibraryPaper(paper.id, false));
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        openLibraryPaper(paper.id, false);
      }
    });
    list.appendChild(item);
  }
  if (!state.papers.length) {
    list.innerHTML = `<div class="list-empty">还没有论文，可以先导入一个 PDF。</div>`;
  } else if (!papers.length) {
    list.innerHTML = `<div class="list-empty">没有匹配的论文。</div>`;
  }
  renderPaperDetail();
  renderRecentPapers();
}

function loadRecentPapers() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_PAPERS_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => ({ id: String(item.id || ""), openedAt: Number(item.openedAt) || 0 }))
      .filter((item) => item.id && item.openedAt);
  } catch {
    return [];
  }
}

function saveRecentPapers() {
  localStorage.setItem(RECENT_PAPERS_KEY, JSON.stringify(state.recentPapers.slice(0, 30)));
}

function loadReadingState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(READING_STATE_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveReadingState(patch = {}) {
  state.readingState = { ...state.readingState, ...patch, updatedAt: Date.now() };
  localStorage.setItem(READING_STATE_KEY, JSON.stringify(state.readingState));
}

function conversationPaperKey(conversation = state.activeConversation) {
  const paperId = conversation?.paper_id || state.activePaper?.id || "";
  return paperId ? `paper:${paperId}` : "paper:none";
}

function saveActiveConversationChoice() {
  if (!state.activeConversation) return;
  const lastConversationByPaper = {
    ...(state.readingState?.lastConversationByPaper || {}),
    [conversationPaperKey(state.activeConversation)]: state.activeConversation.id,
  };
  saveReadingState({
    conversationId: state.activeConversation.id,
    lastConversationByPaper,
  });
}

function saveCurrentConversationPosition() {
  if (!state.activeConversation) return;
  const box = $("messages");
  const id = state.activeConversation.id;
  const positions = {
    ...(state.readingState?.messageScrollByConversation || {}),
    [id]: {
      scrollTop: Math.max(0, Math.round(box.scrollTop)),
      updatedAt: Date.now(),
    },
  };
  const prunedPositions = Object.fromEntries(
    Object.entries(positions)
      .sort(([, a], [, b]) => (Number(b?.updatedAt) || 0) - (Number(a?.updatedAt) || 0))
      .slice(0, MAX_SAVED_CONVERSATION_POSITIONS)
  );
  const lastConversationByPaper = {
    ...(state.readingState?.lastConversationByPaper || {}),
    [conversationPaperKey(state.activeConversation)]: id,
  };
  saveReadingState({
    conversationId: id,
    lastConversationByPaper,
    messageScrollByConversation: prunedPositions,
  });
}

function scheduleConversationPositionSave() {
  window.clearTimeout(scheduleConversationPositionSave._timer);
  scheduleConversationPositionSave._timer = window.setTimeout(saveCurrentConversationPosition, 160);
}

function restoreMessagesScrollPosition({ fallbackToBottom = true } = {}) {
  const box = $("messages");
  const id = state.activeConversation?.id;
  const saved = id ? state.readingState?.messageScrollByConversation?.[id] : null;
  const apply = () => {
    if (saved && Number.isFinite(Number(saved.scrollTop))) {
      box.scrollTop = clamp(Number(saved.scrollTop), 0, Math.max(0, box.scrollHeight - box.clientHeight));
    } else if (fallbackToBottom) {
      box.scrollTop = box.scrollHeight;
    }
  };
  apply();
  window.requestAnimationFrame(apply);
}

async function restoreSavedConversation() {
  const activePaperKey = state.activePaper ? `paper:${state.activePaper.id}` : "paper:none";
  const candidates = [
    state.readingState?.conversationId,
    state.readingState?.lastConversationByPaper?.[activePaperKey],
  ].filter(Boolean);
  const conversation = candidates
    .map((id) => state.conversations.find((conv) => conv.id === id))
    .find(Boolean);
  if (conversation) {
    await selectConversation(conversation.id, { restoreMessagePosition: true });
  }
}

function forgetConversationState(conversationId) {
  if (!conversationId) return;
  const positions = { ...(state.readingState?.messageScrollByConversation || {}) };
  delete positions[conversationId];
  const lastConversationByPaper = Object.fromEntries(
    Object.entries(state.readingState?.lastConversationByPaper || {})
      .filter(([, id]) => id !== conversationId)
  );
  saveReadingState({
    conversationId: state.readingState?.conversationId === conversationId ? "" : state.readingState?.conversationId,
    lastConversationByPaper,
    messageScrollByConversation: positions,
  });
}

function recordRecentPaper(paperId) {
  if (!paperId) return;
  const now = Date.now();
  state.recentPapers = [
    { id: paperId, openedAt: now },
    ...state.recentPapers.filter((item) => item.id !== paperId && now - item.openedAt <= RECENT_PAPER_WINDOW_MS),
  ].slice(0, 30);
  saveRecentPapers();
  renderRecentPapers();
}

function getRecentOpenedPapers() {
  const now = Date.now();
  const known = new Map(state.papers.map((paper) => [paper.id, paper]));
  return state.recentPapers
    .filter((item) => now - item.openedAt <= RECENT_PAPER_WINDOW_MS && known.has(item.id))
    .sort((a, b) => b.openedAt - a.openedAt)
    .map((item) => ({ paper: known.get(item.id), openedAt: item.openedAt }));
}

function renderRecentPapers() {
  const menu = $("recentPaperMenu");
  const trigger = $("recentPaperTrigger");
  if (!menu || !trigger) return;
  $("recentPaperSwitcher")?.classList.remove("open");
  const recent = getRecentOpenedPapers();
  trigger.disabled = !recent.length;
  trigger.setAttribute("aria-expanded", "false");
  if (!recent.length) {
    menu.innerHTML = `<div class="recent-paper-empty">最近一天还没有打开过论文</div>`;
    return;
  }
  menu.innerHTML = `
    <div class="recent-paper-menu-title">最近一天</div>
    ${recent.map(({ paper, openedAt }) => `
      <button
        type="button"
        class="recent-paper-item ${state.activePaper?.id === paper.id ? "active" : ""}"
        data-paper-id="${escapeHtml(paper.id)}"
        title="${escapeHtml(paper.title)}"
        role="menuitem"
      >
        <span>${escapeHtml(paper.title)}</span>
        <small>${escapeHtml(formatRecentOpenedTime(openedAt))}</small>
      </button>
    `).join("")}
  `;
}

function filteredPapers() {
  const query = state.libraryQuery.trim().toLowerCase();
  const papers = state.papers.filter((paper) => {
    if (!query) return true;
    return [paper.title, paper.source, paper.path].some((value) => String(value || "").toLowerCase().includes(query));
  });
  return papers.sort((a, b) => {
    if (state.librarySort === "title_asc") {
      return a.title.localeCompare(b.title);
    }
    if (state.librarySort === "source_asc") {
      return String(a.source || a.path || "").localeCompare(String(b.source || b.path || ""));
    }
    return String(b.created_at || "").localeCompare(String(a.created_at || ""));
  });
}

function selectLibraryPaper(paperId) {
  state.selectedLibraryPaperId = paperId;
  renderPapers();
}

function renderPaperDetail() {
  const detail = $("paperDetail");
  const paper = state.papers.find((item) => item.id === state.selectedLibraryPaperId) || state.activePaper || state.papers[0];
  if (!paper) {
    detail.innerHTML = `<div class="paper-detail-empty">选择一篇论文查看详情</div>`;
    return;
  }
  detail.innerHTML = `
    <div class="paper-detail-head">
      <span class="paper-kind">PDF</span>
      ${state.activePaper?.id === paper.id ? '<span class="paper-current">当前阅读</span>' : ""}
    </div>
    <h3>${escapeHtml(paper.title)}</h3>
    <dl>
      <div>
        <dt>导入时间</dt>
        <dd>${escapeHtml(formatDate(paper.created_at))}</dd>
      </div>
      <div>
        <dt>来源</dt>
        <dd title="${escapeHtml(paper.source || paper.path)}">${escapeHtml(shortSource(paper.source || paper.path))}</dd>
      </div>
      <div>
        <dt>本地文件</dt>
        <dd title="${escapeHtml(paper.path)}">${escapeHtml(shortSource(paper.path))}</dd>
      </div>
    </dl>
    <div class="paper-detail-actions">
      <button type="button" id="openSelectedPaperBtn">打开阅读</button>
      <button type="button" id="newSelectedPaperConversationBtn" class="secondary-btn">新对话</button>
      <button type="button" id="renameSelectedPaperBtn" class="secondary-btn">重命名</button>
      <button type="button" id="deleteSelectedPaperBtn" class="danger-btn">删除副本</button>
    </div>
  `;
  $("openSelectedPaperBtn").addEventListener("click", () => openLibraryPaper(paper.id, false));
  $("newSelectedPaperConversationBtn").addEventListener("click", () => openLibraryPaper(paper.id, true));
  $("renameSelectedPaperBtn").addEventListener("click", () => openRenamePaper(paper.id));
  $("deleteSelectedPaperBtn").addEventListener("click", () => deletePaper(paper.id));
}

async function openLibraryPaper(paperId, createConversation) {
  await selectPaper(paperId);
  if (createConversation) {
    await newConversation();
  }
  $("libraryDialog").close();
}

function openRenamePaper(paperId) {
  const paper = state.papers.find((item) => item.id === paperId);
  if (!paper) return;
  state.renamingPaperId = paperId;
  $("renamePaperInput").value = paper.title || "";
  $("renamePaperDialog").showModal();
  $("renamePaperInput").focus();
  $("renamePaperInput").select();
}

function openActivePaperRename() {
  if (!state.activePaper) {
    toast("请先打开一篇论文");
    return;
  }
  openRenamePaper(state.activePaper.id);
}

async function savePaperTitle() {
  const paperId = state.renamingPaperId;
  const title = $("renamePaperInput").value.trim();
  if (!paperId || !title) {
    toast("请输入论文名称");
    return;
  }
  try {
    const updated = await api(`/api/papers/${paperId}`, {
      method: "POST",
      body: JSON.stringify({ title }),
    });
    state.papers = state.papers.map((paper) => paper.id === paperId ? { ...paper, ...updated } : paper);
    state.conversations = state.conversations.map((conv) =>
      conv.paper_id === paperId ? { ...conv, paper_title: updated.title } : conv
    );
    if (state.activePaper?.id === paperId) {
      state.activePaper = { ...state.activePaper, ...updated };
      $("activePaperTitle").textContent = state.activePaper.title;
    }
    renderPapers();
    renderRecentPapers();
    renderConversations();
    updateContextHint();
    $("renamePaperDialog").close();
    toast("论文名称已更新");
  } catch (error) {
    toast(error.message, 7000);
  }
}

async function deletePaper(paperId) {
  const paper = state.papers.find((item) => item.id === paperId);
  if (!paper) return;
  const confirmed = window.confirm(
    `删除论文“${paper.title}”的本地副本？\n\n这会从论文库移除它，并删除软件数据目录里的 PDF 副本；不会删除你最初导入时的原始文件。`
  );
  if (!confirmed) return;
  try {
    await api(`/api/papers/${paperId}`, { method: "DELETE" });
    state.papers = state.papers.filter((item) => item.id !== paperId);
    state.selectedLibraryPaperId = null;
    if (state.activePaper?.id === paperId) {
      state.activePaper = null;
      state.pdfDoc = null;
      state.pdfUrl = "";
      $("activePaperTitle").textContent = "未选择论文";
      $("activeConversationTitle").textContent = state.activeConversation ? ` · ${state.activeConversation.title}` : "";
      $("pdfViewer").innerHTML = `
        <div class="empty-state">
          <h2>打开论文库选择 PDF</h2>
          <p>也可以先在右侧新建空对话，直接向 Codex 提问。</p>
        </div>
      `;
      clearSelection();
      clearConversationSelections();
    }
    await loadConversations();
    renderPapers();
    renderRecentPapers();
    renderConversations();
    updateContextHint();
    updateButtons();
    toast("论文副本已删除");
  } catch (error) {
    toast(error.message, 9000);
  }
}

async function importPaper(options = {}) {
  const filesOnly = options.filesOnly === true;
  const sources = filesOnly ? [] : parsePaperSources($("paperSourceInput").value);
  const title = $("paperTitleInput").value.trim();
  const files = [...state.selectedFiles];
  const items = [
    ...files.map((file) => ({ type: "file", file, label: file.name })),
    ...sources.map((source) => ({ type: "source", source, label: source })),
  ];
  if (!items.length) {
    toast(filesOnly ? "请选择一个或多个 PDF" : "请选择一个或多个 PDF，或输入 PDF 本地路径/链接");
    return;
  }
  const batch = items.length > 1;
  const imported = [];
  const failed = [];
  let finalToast = "";
  let finalToastDelay = 4000;
  setBusy(true, batch ? `正在批量导入 0/${items.length}...` : "正在导入论文...");
  setImportProgress(batch ? `准备导入 ${items.length} 篇论文...` : "正在导入论文...");
  try {
    for (const [index, item] of items.entries()) {
      setBusy(true, `正在导入 ${index + 1}/${items.length}...`);
      setImportProgress(importProgressText(items, imported, failed, item, index));
      try {
        const paper = await importPaperItem(item, itemImportTitle(title, index, batch));
        imported.push(paper);
      } catch (error) {
        failed.push({ item, label: item.label, message: error.message || "导入失败" });
      }
    }
    await loadPapers();
    if (imported.length) {
      await selectPaper(imported[imported.length - 1].id);
      if (failed.length) {
        restoreFailedImportItems(failed);
      } else {
        resetImportForm();
      }
    }
    setImportProgress(importFinishedText(imported, failed));
    if (!failed.length && imported.length) {
      $("libraryDialog").close();
      finalToast = batch ? `已导入 ${imported.length} 篇论文` : "论文已导入";
    } else if (imported.length) {
      finalToast = `已导入 ${imported.length} 篇，${failed.length} 篇失败`;
      finalToastDelay = 9000;
    } else {
      finalToast = "导入失败，请检查来源";
      finalToastDelay = 9000;
    }
  } catch (error) {
    finalToast = error.message;
    finalToastDelay = 7000;
  } finally {
    setBusy(false);
    if (finalToast) toast(finalToast, finalToastDelay);
  }
}

function parsePaperSources(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function itemImportTitle(title, index, batch) {
  if (!title) return "";
  return batch ? `${title} ${index + 1}` : title;
}

async function importPaperItem(item, title) {
  let payload = null;
  if (item.type === "file") {
    const dataBase64 = await fileToBase64(item.file);
    payload = {
      filename: item.file.name,
      data_base64: dataBase64,
      title,
    };
  } else {
    payload = item.source.startsWith("http://") || item.source.startsWith("https://")
      ? { url: item.source, title }
      : { path: item.source, title };
  }
  return api("/api/papers/import", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

function resetImportForm() {
  $("paperSourceInput").value = "";
  $("paperTitleInput").value = "";
  state.selectedFiles = [];
  $("paperFileInput").value = "";
  updateChosenPaperFiles();
}

function restoreFailedImportItems(failed) {
  const failedItems = failed.map((item) => item.item).filter(Boolean);
  state.selectedFiles = failedItems
    .filter((item) => item.type === "file")
    .map((item) => item.file)
    .filter(Boolean);
  $("paperSourceInput").value = failedItems
    .filter((item) => item.type === "source")
    .map((item) => item.source)
    .join("\n");
  $("paperFileInput").value = "";
  updateChosenPaperFiles();
}

function updateChosenPaperFiles() {
  const count = state.selectedFiles.length;
  if (!count) {
    $("chosenFileName").textContent = "也可以粘贴 PDF 链接或本地路径";
  } else if (count === 1) {
    $("chosenFileName").textContent = state.selectedFiles[0].name;
  } else {
    $("chosenFileName").textContent = `已选择 ${count} 个 PDF`;
  }
}

function setImportProgress(text) {
  const box = $("importProgress");
  box.textContent = text || "";
  box.classList.toggle("hidden", !text);
}

function importProgressText(items, imported, failed, current, index) {
  const lines = [
    `正在导入 ${index + 1}/${items.length}: ${current.label}`,
  ];
  if (imported.length) lines.push(`已完成 ${imported.length} 篇`);
  if (failed.length) lines.push(`失败 ${failed.length} 篇`);
  return lines.join("\n");
}

function importFinishedText(imported, failed) {
  const lines = [`完成：${imported.length} 篇成功，${failed.length} 篇失败。`];
  for (const item of failed.slice(0, 6)) {
    lines.push(`失败：${item.label} - ${item.message}`);
  }
  if (failed.length > 6) lines.push(`还有 ${failed.length - 6} 个失败项未显示。`);
  return lines.join("\n");
}

async function selectPaper(paperId, options = {}) {
  saveCurrentReadingPosition();
  resetShellScroll();
  clearConversationSelections();
  state.activePaper = state.papers.find((paper) => paper.id === paperId) || null;
  state.selectedLibraryPaperId = state.activePaper?.id || state.selectedLibraryPaperId;
  if (state.activePaper) {
    recordRecentPaper(state.activePaper.id);
    saveReadingState({ paperId: state.activePaper.id });
  }
  renderPapers();
  renderConversations();
  $("activePaperTitle").textContent = state.activePaper ? state.activePaper.title : "未选择论文";
  $("activeConversationTitle").textContent = state.activeConversation ? ` · ${state.activeConversation.title}` : "";
  clearSelection();
  if (state.activePaper) {
    await loadHighlights(state.activePaper.id);
    state.restoringPaperId = options.restoreReadingState ? state.activePaper.id : null;
    if (state.restoringPaperId) restoreSavedZoomState();
    await renderPdf(`/api/papers/${state.activePaper.id}/file`);
    state.restoringPaperId = null;
  } else {
    state.pdfDoc = null;
    state.pdfUrl = "";
    state.pdfOutline = [];
    state.highlights = [];
    renderPdfOutline();
    $("pdfViewer").innerHTML = `
      <div class="empty-state">
        <h2>打开论文库选择 PDF</h2>
        <p>也可以先在右侧新建空对话，直接向 Codex 提问。</p>
      </div>
    `;
  }
  updateContextHint();
  updateButtons();
  resetShellScroll();
}

async function loadHighlights(paperId) {
  try {
    state.highlights = await api(`/api/papers/${paperId}/highlights`);
  } catch (error) {
    state.highlights = [];
    toast(error.message || "加载高亮失败", 7000);
  }
}

async function loadConversations() {
  state.conversations = await api("/api/conversations");
  if (state.activeConversation) {
    state.activeConversation = state.conversations.find((conv) => conv.id === state.activeConversation.id) || null;
  }
  renderConversations();
  updateContextHint();
}

function renderConversations() {
  if (state.draggingFolderKey || state.draggingConversationId || state.sidebarDrag) return;
  const list = $("conversationsList");
  list.innerHTML = "";
  const groups = conversationGroups();
  if (!groups.length) {
    list.innerHTML = `
      <div class="list-empty">
        还没有对话。直接在右侧发送问题会自动创建。
      </div>
    `;
    return;
  }
  for (const group of groups) {
    const isCollapsed = Boolean(state.collapsedConversationGroups[group.key]);
    const hasActiveConversation = group.conversations.some((conv) => conv.id === state.activeConversation?.id);
    const hasRunningTask = group.conversations.some((conv) => activeTaskForConversation(conv.id));
    const section = document.createElement("section");
    section.className = `conversation-folder${hasActiveConversation ? " active" : ""}${hasRunningTask ? " running" : ""}`;
    section.dataset.groupKey = group.key;
    section.draggable = false;
    section.tabIndex = 0;
    section.title = "按 Alt + ↑/↓ 调整文件夹顺序，也可以拖动抓手";
    section.innerHTML = `
      <div class="folder-head">
        <button class="folder-toggle" type="button" aria-expanded="${String(!isCollapsed)}">
          <span class="sidebar-drag-grip folder-grip" aria-hidden="true" title="拖动调整文件夹顺序"></span>
          <span class="folder-chevron${isCollapsed ? " collapsed" : ""}" aria-hidden="true"></span>
          <span class="folder-title">${escapeHtml(group.title)}</span>
          <span class="folder-count">${group.conversations.length}</span>
        </button>
        <button class="folder-open-paper-btn" type="button" ${group.paperId ? "" : "disabled"} aria-label="打开 ${escapeHtml(group.title)} 对应论文" title="${group.paperId ? "打开论文" : "没有绑定论文"}"></button>
        <button class="folder-new-conversation-btn" type="button" aria-label="在 ${escapeHtml(group.title)} 中新建对话" title="新建对话">+</button>
      </div>
      <div class="folder-children${isCollapsed ? " hidden" : ""}"></div>
    `;
    section.querySelector(".folder-toggle").addEventListener("click", () => toggleConversationGroup(group.key));
    section.querySelector(".folder-open-paper-btn").addEventListener("click", (event) => {
      event.stopPropagation();
      openPaperForGroup(group);
    });
    section.querySelector(".folder-new-conversation-btn").addEventListener("click", (event) => {
      event.stopPropagation();
      newConversationForGroup(group);
    });
    wireSidebarDragHandle(section.querySelector(".folder-grip"), section, "folder");
    section.addEventListener("keydown", handleFolderKeyboardReorder);
    const children = section.querySelector(".folder-children");
    for (const conv of group.conversations) {
      children.appendChild(renderConversationItem(conv));
    }
    if (!group.conversations.length) {
      const empty = document.createElement("div");
      empty.className = "folder-empty";
      empty.textContent = "还没有对话";
      children.appendChild(empty);
    }
    list.appendChild(section);
  }
}

function conversationGroups() {
  const groups = [];
  const byKey = new Map();
  if (state.activePaper) {
    const key = `paper:${state.activePaper.id}`;
    const hasConversationGroup = state.conversations.some((conv) =>
      (conv.folder_key || (conv.paper_id ? `paper:${conv.paper_id}` : "paper:none")) === key
    );
    if (!hasConversationGroup) {
      const group = {
        key,
        paperId: state.activePaper.id,
        title: state.activePaper.title,
        conversations: [],
        fallbackOrder: state.conversations.length,
        order: null,
      };
      groups.push(group);
      byKey.set(key, group);
    }
  }
  for (const [index, conv] of state.conversations.entries()) {
    const key = conv.folder_key || (conv.paper_id ? `paper:${conv.paper_id}` : "paper:none");
    const order = Number.isFinite(Number(conv.folder_order)) ? Number(conv.folder_order) : null;
    if (!byKey.has(key)) {
      const group = {
        key,
        paperId: conv.paper_id || null,
        title: conv.paper_title || (conv.paper_id ? "已删除论文" : "空对话"),
        conversations: [],
        fallbackOrder: index,
        order,
      };
      groups.push(group);
      byKey.set(key, group);
    } else {
      const group = byKey.get(key);
      group.fallbackOrder = Math.min(group.fallbackOrder, index);
      if (conv.paper_title) group.title = conv.paper_title;
      if (order !== null) group.order = order;
    }
    byKey.get(key).conversations.push({ ...conv, fallbackOrder: index });
  }
  for (const group of groups) {
    group.conversations.sort((a, b) =>
      compareOptionalOrder(a.conversation_order, a.fallbackOrder, b.conversation_order, b.fallbackOrder)
    );
  }
  return groups.sort((a, b) => compareOptionalOrder(a.order, a.fallbackOrder, b.order, b.fallbackOrder));
}

function compareOptionalOrder(orderA, fallbackA, orderB, fallbackB) {
  const a = Number.isFinite(Number(orderA)) ? Number(orderA) : 1000000 + Number(fallbackA || 0);
  const b = Number.isFinite(Number(orderB)) ? Number(orderB) : 1000000 + Number(fallbackB || 0);
  return a - b;
}

function renderConversationItem(conv) {
  const item = document.createElement("div");
  item.className = "list-item conversation-item" + (state.activeConversation?.id === conv.id ? " active" : "");
  item.dataset.conversationId = conv.id;
  item.draggable = false;
  item.tabIndex = 0;
  item.title = "按 Alt + ↑/↓ 调整会话顺序，也可以拖动抓手";
  const subtitle = conv.paper_title ? conv.paper_title : "无绑定论文";
  const pending = activeTaskForConversation(conv.id);
  item.innerHTML = `
    <span class="sidebar-drag-grip conversation-grip" aria-hidden="true" title="拖动调整会话顺序"></span>
    <div class="list-title-row">
      <strong>${escapeHtml(conv.title)}</strong>
      <span class="conversation-actions">
        ${pending ? `<span class="running-badge">${escapeHtml(taskStatusText(pending.status))}</span>` : ""}
        <button class="rename-conversation-btn" type="button" data-conversation-id="${escapeHtml(conv.id)}" aria-label="改名" title="改名"></button>
        <button class="delete-conversation-btn" type="button" data-conversation-id="${escapeHtml(conv.id)}" aria-label="删除" title="删除"></button>
      </span>
    </div>
    <div class="meta">${escapeHtml(pending ? pending.label : subtitle)}</div>
  `;
  item.addEventListener("click", (event) => {
    if (state.draggingConversationId || Date.now() < state.suppressSidebarClickUntil || event.target.closest(".sidebar-drag-grip")) return;
    selectConversation(conv.id);
  });
  wireSidebarDragHandle(item.querySelector(".conversation-grip"), item, "conversation");
  item.addEventListener("keydown", handleConversationKeyboardReorder);
  item.querySelector(".rename-conversation-btn").addEventListener("click", (event) => {
    event.stopPropagation();
    openRenameConversation(conv.id);
  });
  item.querySelector(".delete-conversation-btn").addEventListener("click", (event) => {
    event.stopPropagation();
    deleteConversation(conv.id);
  });
  return item;
}

function wireSidebarDragHandle(handle, item, type) {
  if (!handle) return;
  handle.addEventListener("pointerdown", (event) => startSidebarPointerDrag(event, item, type));
  handle.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
}

function startSidebarPointerDrag(event, item, type) {
  if (event.button !== 0) return;
  const container = type === "folder" ? $("conversationsList") : item.closest(".folder-children");
  if (!container) return;
  const sortableItems = type === "folder" ? conversationFolderItems() : conversationItemsForContainer(container);
  if (sortableItems.length < 2) return;
  event.preventDefault();
  event.stopPropagation();

  state.sidebarDrag = {
    type,
    item,
    container,
    startY: event.clientY,
    didMove: false,
  };
  if (type === "folder") {
    state.draggingFolderKey = item.dataset.groupKey;
  } else {
    state.draggingConversationId = item.dataset.conversationId;
  }
  item.classList.add("dragging");
  container.classList.add("sorting");
  document.body.classList.add("sidebar-sorting");
  try {
    event.currentTarget.setPointerCapture(event.pointerId);
  } catch {
    // Pointer capture can fail if the browser has already released the pointer.
  }
  document.addEventListener("pointermove", handleSidebarPointerMove);
  document.addEventListener("pointerup", handleSidebarPointerUp);
  document.addEventListener("pointercancel", handleSidebarPointerUp);
}

function handleSidebarPointerMove(event) {
  const drag = state.sidebarDrag;
  if (!drag) return;
  event.preventDefault();
  if (Math.abs(event.clientY - drag.startY) > 3) {
    drag.didMove = true;
  }
  const items = [...drag.container.querySelectorAll(drag.type === "folder" ? ".conversation-folder" : ".conversation-item")]
    .filter((item) => item !== drag.item);
  let inserted = false;
  for (const target of items) {
    const rect = target.getBoundingClientRect();
    if (event.clientY < rect.top + rect.height / 2) {
      drag.container.insertBefore(drag.item, target);
      inserted = true;
      break;
    }
  }
  if (!inserted) {
    drag.container.appendChild(drag.item);
  }
}

async function handleSidebarPointerUp(event) {
  const drag = state.sidebarDrag;
  if (!drag) return;
  event.preventDefault();
  event.stopPropagation();
  document.removeEventListener("pointermove", handleSidebarPointerMove);
  document.removeEventListener("pointerup", handleSidebarPointerUp);
  document.removeEventListener("pointercancel", handleSidebarPointerUp);
  drag.item.classList.remove("dragging");
  drag.container.classList.remove("sorting");
  document.body.classList.remove("sidebar-sorting");
  state.draggingFolderKey = null;
  state.draggingConversationId = null;
  state.sidebarDrag = null;
  if (!drag.didMove) return;
  state.suppressSidebarClickUntil = Date.now() + 250;
  if (drag.type === "folder") {
    await persistFolderOrder();
  } else {
    await persistConversationOrder(drag.container);
  }
}

function handleSidebarDrop(event) {
  event.preventDefault();
}

function conversationFolderItems() {
  return [...$("conversationsList").querySelectorAll(".conversation-folder")];
}

function conversationItemsForContainer(container) {
  return [...container.querySelectorAll(".conversation-item")];
}

function handleFolderDragStart(event) {
  const section = event.currentTarget;
  state.draggingFolderKey = section.dataset.groupKey;
  section.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", state.draggingFolderKey);
}

function handleFolderDragOver(event) {
  event.preventDefault();
  const dragging = $("conversationsList").querySelector(".conversation-folder.dragging");
  const target = event.currentTarget;
  if (!dragging || dragging === target) return;
  const rect = target.getBoundingClientRect();
  const before = event.clientY < rect.top + rect.height / 2;
  $("conversationsList").insertBefore(dragging, before ? target : target.nextSibling);
}

async function handleFolderDragEnd(event) {
  event.currentTarget.classList.remove("dragging");
  state.draggingFolderKey = null;
  await persistFolderOrder();
}

async function handleFolderKeyboardReorder(event) {
  if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
  event.preventDefault();
  const items = conversationFolderItems();
  const currentIndex = items.indexOf(event.currentTarget);
  const nextIndex = currentIndex + (event.key === "ArrowUp" ? -1 : 1);
  if (currentIndex < 0 || nextIndex < 0 || nextIndex >= items.length) return;
  const list = $("conversationsList");
  if (nextIndex < currentIndex) {
    list.insertBefore(event.currentTarget, items[nextIndex]);
  } else {
    list.insertBefore(event.currentTarget, items[nextIndex].nextSibling);
  }
  event.currentTarget.focus();
  await persistFolderOrder();
}

async function persistFolderOrder() {
  try {
    const groupKeys = conversationFolderItems().map((item) => item.dataset.groupKey).filter(Boolean);
    state.conversations = await api("/api/conversation-folders/reorder", {
      method: "POST",
      body: JSON.stringify({ group_keys: groupKeys }),
    });
    renderConversations();
  } catch (error) {
    toast(error.message || "调整文件夹顺序失败", 7000);
    await loadConversations();
  }
}

function handleConversationDragStart(event) {
  const item = event.currentTarget;
  state.draggingConversationId = item.dataset.conversationId;
  item.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", state.draggingConversationId);
  event.stopPropagation();
}

function handleConversationDragOver(event) {
  event.preventDefault();
  event.stopPropagation();
  const dragging = $("conversationsList").querySelector(".conversation-item.dragging");
  const target = event.currentTarget;
  if (!dragging || dragging === target) return;
  const sourceContainer = dragging.closest(".folder-children");
  const targetContainer = target.closest(".folder-children");
  if (!sourceContainer || sourceContainer !== targetContainer) return;
  const rect = target.getBoundingClientRect();
  const before = event.clientY < rect.top + rect.height / 2;
  targetContainer.insertBefore(dragging, before ? target : target.nextSibling);
}

async function handleConversationDragEnd(event) {
  event.stopPropagation();
  event.currentTarget.classList.remove("dragging");
  const container = event.currentTarget.closest(".folder-children");
  state.draggingConversationId = null;
  if (container) {
    await persistConversationOrder(container);
  }
}

async function handleConversationKeyboardReorder(event) {
  if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  const container = event.currentTarget.closest(".folder-children");
  if (!container) return;
  const items = conversationItemsForContainer(container);
  const currentIndex = items.indexOf(event.currentTarget);
  const nextIndex = currentIndex + (event.key === "ArrowUp" ? -1 : 1);
  if (currentIndex < 0 || nextIndex < 0 || nextIndex >= items.length) return;
  if (nextIndex < currentIndex) {
    container.insertBefore(event.currentTarget, items[nextIndex]);
  } else {
    container.insertBefore(event.currentTarget, items[nextIndex].nextSibling);
  }
  event.currentTarget.focus();
  await persistConversationOrder(container);
}

async function persistConversationOrder(container) {
  try {
    const conversationIds = conversationItemsForContainer(container).map((item) => item.dataset.conversationId).filter(Boolean);
    state.conversations = await api("/api/conversations/reorder", {
      method: "POST",
      body: JSON.stringify({ conversation_ids: conversationIds }),
    });
    renderConversations();
  } catch (error) {
    toast(error.message || "调整会话顺序失败", 7000);
    await loadConversations();
  }
}

function toggleConversationGroup(groupKey) {
  state.collapsedConversationGroups[groupKey] = !state.collapsedConversationGroups[groupKey];
  localStorage.setItem("paperCodexCollapsedConversationGroups", JSON.stringify(state.collapsedConversationGroups));
  renderConversations();
}

function openRenameConversation(conversationId) {
  const conversation = state.conversations.find((conv) => conv.id === conversationId);
  if (!conversation) return;
  state.renamingConversationId = conversationId;
  $("renameConversationInput").value = conversation.title || "";
  $("renameConversationDialog").showModal();
  $("renameConversationInput").focus();
  $("renameConversationInput").select();
}

async function saveConversationTitle() {
  const convId = state.renamingConversationId;
  const title = $("renameConversationInput").value.trim();
  if (!convId || !title) {
    toast("请输入对话标题");
    return;
  }
  try {
    const updated = await api(`/api/conversations/${convId}`, {
      method: "POST",
      body: JSON.stringify({ title }),
    });
    state.conversations = state.conversations.map((conv) => conv.id === convId ? { ...conv, ...updated } : conv);
    if (state.activeConversation?.id === convId) {
      state.activeConversation = { ...state.activeConversation, ...updated };
      $("activeConversationTitle").textContent = ` · ${state.activeConversation.title}`;
    }
    renderConversations();
    updateContextHint();
    $("renameConversationDialog").close();
    toast("对话已改名");
  } catch (error) {
    toast(error.message, 7000);
  }
}

async function deleteConversation(conversationId) {
  const conversation = state.conversations.find((conv) => conv.id === conversationId);
  if (!conversation) return;
  const confirmed = window.confirm(`删除会话“${conversation.title}”？\n\n这会同时删除这个会话里的聊天记录，不能撤销。`);
  if (!confirmed) return;
  try {
    await api(`/api/conversations/${conversationId}`, {
      method: "DELETE",
    });
    clearDraftForConversation(conversationId);
    forgetConversationState(conversationId);
    if (state.activeConversation?.id === conversationId) {
      state.activeConversation = null;
      $("activeConversationTitle").textContent = "";
      $("messageInput").value = "";
      clearConversationSelections({ persist: false });
      clearAttachments({ persist: false });
    }
    await loadConversations();
    if (!state.activeConversation) {
      await loadMessages();
    }
    updateContextHint();
    toast("会话已删除");
  } catch (error) {
    toast(error.message, 9000);
  }
}

async function newConversation(paperId = state.activePaper ? state.activePaper.id : null) {
  const payload = {
    paper_id: paperId,
  };
  const conv = await api("/api/conversations", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  await loadConversations();
  await selectConversation(conv.id);
}

async function newConversationForGroup(group) {
  state.collapsedConversationGroups[group.key] = false;
  localStorage.setItem("paperCodexCollapsedConversationGroups", JSON.stringify(state.collapsedConversationGroups));
  await newConversation(group.paperId || null);
}

async function openPaperForGroup(group) {
  if (!group.paperId) {
    toast("这个文件夹没有绑定论文");
    return;
  }
  await selectPaper(group.paperId);
}

async function ensureConversation() {
  if (state.activeConversation) {
    return state.activeConversation;
  }
  const payload = {
    paper_id: state.activePaper ? state.activePaper.id : null,
  };
  const conv = await api("/api/conversations", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  await loadConversations();
  await selectConversation(conv.id);
  return state.activeConversation;
}

async function selectConversation(convId, options = {}) {
  saveActiveConversationDraft();
  saveCurrentConversationPosition();
  state.editingResendMessageId = null;
  clearSelection();
  state.activeConversation = state.conversations.find((conv) => conv.id === convId) || null;
  renderConversations();
  $("activeConversationTitle").textContent = state.activeConversation
    ? ` · ${state.activeConversation.title}`
    : "";
  if (state.activeConversation) {
    saveActiveConversationChoice();
  }
  await loadMessages({ restoreMessagePosition: options.restoreMessagePosition !== false });
  restoreActiveConversationDraft();
  updateComposerMode();
  updateContextHint();
  updateButtons();
}

async function loadMessages(options = {}) {
  const restoreMessagePosition = options.restoreMessagePosition !== false;
  const forceBottom = options.forceBottom === true;
  const box = $("messages");
  box.innerHTML = "";
  if (!state.activeConversation) {
    box.innerHTML = `
      <div class="empty-state">
        <h2>可以直接开始</h2>
        <p>右下角输入问题会自动创建当前论文对话。想先让 Codex 读完整篇，就点“读全文”。</p>
      </div>
    `;
    updateAnswerNavButtons();
    return;
  }
  const messages = await api(`/api/conversations/${state.activeConversation.id}/messages`);
  const activeTasks = state.tasks.filter((task) =>
    task.conversation_id === state.activeConversation.id && isActiveTask(task)
  );
  for (const item of conversationTimeline(messages, activeTasks)) {
    if (item.type === "task") {
      appendTaskPlaceholder(item.task);
    } else {
      appendMessage(item.message.role, item.message.content, item.message);
    }
  }
  updateAnswerNavButtons();
  if (forceBottom) {
    scrollMessages();
  } else if (restoreMessagePosition) {
    restoreMessagesScrollPosition();
  } else {
    scrollMessages();
  }
}

function conversationTimeline(messages, tasks = []) {
  const sortedMessages = [...messages].sort((a, b) => messageTime(a) - messageTime(b));
  const byId = new Map(sortedMessages.map((message) => [message.id, message]));
  const childMessages = new Map();
  for (const message of sortedMessages) {
    if (!message.parent_message_id || !byId.has(message.parent_message_id)) continue;
    if (!childMessages.has(message.parent_message_id)) childMessages.set(message.parent_message_id, []);
    childMessages.get(message.parent_message_id).push(message);
  }
  const taskByParent = new Map();
  for (const task of tasks) {
    if (!task.user_message_id) continue;
    if (!taskByParent.has(task.user_message_id)) taskByParent.set(task.user_message_id, []);
    taskByParent.get(task.user_message_id).push(task);
  }
  const seen = new Set();
  const timeline = [];
  for (const message of sortedMessages) {
    if (seen.has(message.id)) continue;
    if (message.parent_message_id && byId.has(message.parent_message_id)) continue;
    timeline.push({ type: "message", message });
    seen.add(message.id);
    for (const child of childMessages.get(message.id) || []) {
      timeline.push({ type: "message", message: child });
      seen.add(child.id);
    }
    for (const task of taskByParent.get(message.id) || []) {
      timeline.push({ type: "task", task });
    }
  }
  for (const task of tasks.filter((task) => !task.user_message_id || !byId.has(task.user_message_id))) {
    timeline.push({ type: "task", task });
  }
  return timeline;
}

function messageTime(message) {
  const stamp = Date.parse(message.created_at || message.updated_at || "");
  return Number.isFinite(stamp) ? stamp : 0;
}

function appendMessage(role, content, meta = {}) {
  const box = $("messages");
  const node = document.createElement("div");
  node.className = `message ${role}`;
  if (meta.id) {
    node.dataset.messageId = meta.id;
  }
  if (meta.parent_message_id) {
    node.dataset.parentMessageId = meta.parent_message_id;
  }
  node.innerHTML = `
    <div class="role">${role === "user" ? "你" : "Codex"}</div>
    ${renderMessageContent(role, content)}
    ${["user", "assistant"].includes(role) ? `
      <div class="message-actions" aria-label="消息操作">
        <button class="message-action-btn copy-message-btn" type="button" aria-label="复制" title="复制"></button>
        ${role === "user" ? `<button class="message-action-btn edit-message-btn" type="button" aria-label="编辑再发送" title="编辑再发送"></button>` : ""}
      </div>
    ` : ""}
  `;
  if (["user", "assistant"].includes(role)) {
    node.querySelector(".copy-message-btn")?.addEventListener("click", () => copyMessageContent(content));
  }
  if (role === "user") {
    node.querySelector(".edit-message-btn").addEventListener("click", () => startResendEdit(content, meta.id || ""));
  }
  box.appendChild(node);
  renderMermaidDiagrams(node);
  updateAnswerNavButtons();
}

function renderMessageContent(role, content) {
  if (role === "assistant") {
    return `<div class="message-body markdown-body">${markdownToHtml(content)}</div>`;
  }
  return `<div class="message-body plain-message">${escapeHtml(content)}</div>`;
}

function markdownToHtml(value) {
  const lines = String(value || "").replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let index = 0;
  let inCode = false;
  let codeLines = [];
  let codeLanguage = "";
  let listType = "";

  const closeList = () => {
    if (!listType) return;
    html.push(`</${listType}>`);
    listType = "";
  };

  const flushCode = () => {
    const source = codeLines.join("\n");
    if (shouldRenderMermaidCode(source, codeLanguage)) {
      html.push(`<div class="mermaid-block"><pre class="mermaid">${escapeHtml(source)}</pre></div>`);
    } else {
      const languageClass = codeLanguage ? ` class="language-${escapeHtml(codeLanguage)}"` : "";
      html.push(`<pre><code${languageClass}>${escapeHtml(source)}</code></pre>`);
    }
    codeLines = [];
    codeLanguage = "";
  };

  while (index < lines.length) {
    const raw = lines[index];
    const line = raw.trimEnd();

    if (line.startsWith("```")) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        closeList();
        inCode = true;
        codeLines = [];
        codeLanguage = parseCodeLanguage(line);
      }
      index += 1;
      continue;
    }

    if (inCode) {
      codeLines.push(raw);
      index += 1;
      continue;
    }

    if (!line.trim()) {
      closeList();
      index += 1;
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length + 2;
      html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (line.startsWith(">")) {
      closeList();
      const quoteLines = [];
      while (index < lines.length && lines[index].trimStart().startsWith(">")) {
        quoteLines.push(lines[index].trimStart().replace(/^>\s?/, ""));
        index += 1;
      }
      html.push(`<blockquote>${quoteLines.map((item) => inlineMarkdown(item)).join("<br>")}</blockquote>`);
      continue;
    }

    const unordered = /^[-*]\s+(.+)$/.exec(line);
    const ordered = /^\d+[.)]\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      const nextType = unordered ? "ul" : "ol";
      if (listType !== nextType) {
        closeList();
        listType = nextType;
        html.push(`<${listType}>`);
      }
      html.push(`<li>${inlineMarkdown((unordered || ordered)[1])}</li>`);
      index += 1;
      continue;
    }

    closeList();
    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length) {
      const next = lines[index].trimEnd();
      if (
        !next.trim()
        || next.startsWith("```")
        || next.startsWith(">")
        || /^(#{1,3})\s+/.test(next)
        || /^[-*]\s+/.test(next)
        || /^\d+[.)]\s+/.test(next)
      ) {
        break;
      }
      paragraph.push(next.trim());
      index += 1;
    }
    html.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
  }

  if (inCode) flushCode();
  closeList();
  return html.join("");
}

function parseCodeLanguage(fenceLine) {
  const match = /^```\s*([A-Za-z0-9_-]+)?/.exec(fenceLine.trim());
  return (match?.[1] || "").toLowerCase();
}

function shouldRenderMermaidCode(source, language = "") {
  const normalizedLanguage = String(language || "").toLowerCase();
  if (normalizedLanguage === "mermaid") return true;
  if (!["", "text", "txt", "plain", "plaintext"].includes(normalizedLanguage)) return false;
  return looksLikeMermaid(source);
}

function looksLikeMermaid(source) {
  const firstMeaningfulLine = String(source || "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("%%"));
  if (!firstMeaningfulLine) return false;
  return /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph|quadrantChart|requirementDiagram|C4Context|C4Container|C4Component|C4Dynamic|block-beta|packet-beta|xychart-beta|sankey-beta|architecture-beta|kanban|radar-beta)\b/.test(firstMeaningfulLine);
}

function setupMermaid() {
  if (!window.mermaid) return;
  try {
    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      flowchart: {
        htmlLabels: false,
        curve: "basis",
      },
      themeVariables: {
        fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        primaryColor: "#eef4ff",
        primaryTextColor: "#0f172a",
        primaryBorderColor: "#bfdbfe",
        lineColor: "#64748b",
        secondaryColor: "#f8fafc",
        tertiaryColor: "#ffffff",
        clusterBkg: "#f8fafc",
        clusterBorder: "#cbd5e1",
        edgeLabelBackground: "#ffffff",
      },
    });
  } catch (error) {
    console.warn("Mermaid initialization failed", error);
  }
}

function renderMermaidDiagrams(root = document) {
  if (!window.mermaid) return;
  const nodes = [...root.querySelectorAll(".mermaid:not([data-processed])")];
  if (!nodes.length) return;
  state.mermaidRenderQueue = state.mermaidRenderQueue
    .then(async () => {
      for (const node of nodes) {
        if (!node.isConnected || node.dataset.processed === "true") continue;
        await renderMermaidNode(node);
      }
    })
    .catch((error) => console.warn("Mermaid rendering failed", error));
}

async function renderMermaidNode(node) {
  const source = node.textContent || "";
  const renderId = `mermaid-${makeId().replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  try {
    const result = await window.mermaid.render(renderId, source);
    node.innerHTML = result.svg;
    node.dataset.processed = "true";
    normalizeMermaidSvg(node.closest(".mermaid-block"));
    enhanceMermaidBlocks([node]);
  } catch (error) {
    node.textContent = source;
    node.classList.add("mermaid-error");
    node.dataset.processed = "true";
    console.warn("Mermaid render failed", error);
  }
}

function normalizeMermaidSvg(block) {
  const svg = mermaidSvgForBlock(block);
  if (!svg) return;
  const { width, height } = mermaidSvgSize(svg);
  svg.setAttribute("width", String(Math.ceil(width)));
  svg.setAttribute("height", String(Math.ceil(height)));
  svg.style.width = `${Math.ceil(width)}px`;
  svg.style.height = `${Math.ceil(height)}px`;
  svg.style.maxWidth = "none";
}

function enhanceMermaidBlocks(nodes) {
  for (const node of nodes) {
    const block = node.closest(".mermaid-block");
    if (!block || block.dataset.enhanced === "true" || !block.querySelector("svg")) continue;
    block.dataset.enhanced = "true";
    block.classList.add("mermaid-interactive");
    block.tabIndex = 0;
    block.title = "双击预览 Mermaid 图表";
    block.addEventListener("dblclick", () => openMermaidPngPreview(block));
    block.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openMermaidPngPreview(block);
    });
  }
}

function mermaidSvgForBlock(block) {
  return block?.querySelector(".mermaid svg") || null;
}

function serializedMermaidSvg(svg) {
  const clone = svg.cloneNode(true);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
  return new XMLSerializer().serializeToString(clone);
}

async function openMermaidPngPreview(block) {
  const svg = mermaidSvgForBlock(block);
  if (!svg) {
    toast("图表还没有渲染完成");
    return;
  }
  revokeMermaidPreviewUrls();
  const previewToken = ++state.mermaidPreviewToken;
  setMermaidPreviewHeader("PNG 预览", "可缩放预览，也可下载 SVG 或 PNG。");
  clearMermaidPreviewActions();
  const body = $("mermaidPreviewBody");
  body.replaceChildren(mermaidPreviewLoading());
  const dialog = $("mermaidPreviewDialog");
  if (!dialog.open) dialog.showModal();

  const svgBlob = new Blob([serializedMermaidSvg(svg)], { type: "image/svg+xml;charset=utf-8" });
  const svgUrl = URL.createObjectURL(svgBlob);
  try {
    const pngBlob = await mermaidSvgToPngBlob(svg);
    const pngUrl = URL.createObjectURL(pngBlob);
    if (previewToken !== state.mermaidPreviewToken || !dialog.open) {
      URL.revokeObjectURL(svgUrl);
      URL.revokeObjectURL(pngUrl);
      return;
    }
    setMermaidPreviewUrls([svgUrl, pngUrl]);
    showMermaidPreviewImage(pngUrl, {
      svgName: mermaidDownloadName("svg"),
      pngName: mermaidDownloadName("png"),
      svgUrl,
      pngUrl,
    });
  } catch (error) {
    if (previewToken !== state.mermaidPreviewToken || !dialog.open) {
      URL.revokeObjectURL(svgUrl);
      return;
    }
    setMermaidPreviewUrls([svgUrl]);
    showMermaidPreviewFallback(svg.cloneNode(true), {
      svgName: mermaidDownloadName("svg"),
      svgUrl,
    });
    toast(error.message || "PNG 生成失败，请先下载 SVG", 7000);
  }
}

function mermaidPreviewLoading() {
  const loading = document.createElement("div");
  loading.className = "mermaid-preview-loading";
  loading.textContent = "正在生成 PNG 预览...";
  return loading;
}

function setMermaidPreviewUrls(urls) {
  revokeMermaidPreviewUrls();
  state.mermaidPreviewUrls = urls;
}

function revokeMermaidPreviewUrls() {
  for (const url of state.mermaidPreviewUrls) {
    URL.revokeObjectURL(url);
  }
  state.mermaidPreviewUrls = [];
}

function makeMermaidPreviewDownload(label, url, filename) {
  const link = document.createElement("a");
  link.className = "mermaid-preview-download";
  link.href = url;
  link.download = filename;
  link.textContent = label;
  return link;
}

function showMermaidPreviewActions(links) {
  const actions = $("mermaidPreviewActions");
  actions.classList.remove("hidden");
  const downloads = document.createElement("div");
  downloads.className = "mermaid-preview-downloads";
  downloads.replaceChildren(...links);
  actions.replaceChildren(makeMermaidPreviewZoomControls(), downloads);
}

function makeMermaidPreviewZoomControls() {
  const controls = document.createElement("div");
  controls.className = "mermaid-preview-zoom-controls";
  controls.setAttribute("aria-label", "图表预览缩放");
  controls.innerHTML = `
    <button type="button" class="mermaid-preview-zoom-btn" data-zoom-action="out" aria-label="缩小预览" title="缩小">-</button>
    <button type="button" class="mermaid-preview-zoom-btn mermaid-preview-zoom-reset" data-zoom-action="reset" aria-label="恢复 100%" title="恢复 100%">100%</button>
    <button type="button" class="mermaid-preview-zoom-btn" data-zoom-action="in" aria-label="放大预览" title="放大">+</button>
    <span class="mermaid-preview-zoom-value" aria-live="polite">100%</span>
  `;
  controls.addEventListener("click", (event) => {
    const button = event.target.closest("[data-zoom-action]");
    if (!button) return;
    if (button.dataset.zoomAction === "in") zoomMermaidPreview(1.15);
    if (button.dataset.zoomAction === "out") zoomMermaidPreview(1 / 1.15);
    if (button.dataset.zoomAction === "reset") setMermaidPreviewZoom(1);
  });
  return controls;
}

function showMermaidPreviewImage(url, { svgName, pngName, svgUrl, pngUrl }) {
  showMermaidPreviewActions([
    makeMermaidPreviewDownload("下载 SVG", svgUrl, svgName),
    makeMermaidPreviewDownload("下载 PNG", pngUrl, pngName),
  ]);

  const image = document.createElement("img");
  image.className = "mermaid-preview-image";
  image.alt = "Mermaid PNG 预览";
  image.src = url;
  image.addEventListener("load", () => {
    image.dataset.baseWidth = String(image.naturalWidth || image.width || 1);
    applyMermaidPreviewZoom();
  }, { once: true });
  $("mermaidPreviewBody").replaceChildren(image);
  setMermaidPreviewZoom(1);
}

function showMermaidPreviewFallback(svg, { svgName, svgUrl }) {
  setMermaidPreviewHeader("图表预览", "PNG 生成失败，可先下载 SVG。");
  showMermaidPreviewActions([makeMermaidPreviewDownload("下载 SVG", svgUrl, svgName)]);
  const size = mermaidSvgSize(svg);
  svg.dataset.baseWidth = String(size.width || 1);
  $("mermaidPreviewBody").replaceChildren(svg);
  setMermaidPreviewZoom(1);
}

function setMermaidPreviewHeader(title, hint) {
  $("mermaidPreviewTitle").textContent = title;
  $("mermaidPreviewHint").textContent = hint;
}

function clearMermaidPreviewActions() {
  const actions = $("mermaidPreviewActions");
  actions.classList.add("hidden");
  actions.replaceChildren();
}

function closeMermaidPreview() {
  $("mermaidPreviewDialog").close();
}

function resetMermaidPreview() {
  state.mermaidPreviewToken += 1;
  state.mermaidPreviewZoom = 1;
  revokeMermaidPreviewUrls();
  clearMermaidPreviewActions();
  $("mermaidPreviewBody").replaceChildren();
}

function setMermaidPreviewZoom(value) {
  state.mermaidPreviewZoom = clamp(value, 0.4, 4);
  applyMermaidPreviewZoom();
}

function zoomMermaidPreview(multiplier) {
  setMermaidPreviewZoom(state.mermaidPreviewZoom * multiplier);
}

function applyMermaidPreviewZoom() {
  const zoom = state.mermaidPreviewZoom || 1;
  const target = $("mermaidPreviewBody").querySelector(".mermaid-preview-image, svg");
  if (target) {
    const baseWidth = Number(target.dataset.baseWidth) || target.naturalWidth || target.getBoundingClientRect().width || 760;
    target.style.width = `${Math.max(120, Math.round(baseWidth * zoom))}px`;
    target.style.height = "auto";
  }
  const value = $("mermaidPreviewActions").querySelector(".mermaid-preview-zoom-value");
  if (value) value.textContent = `${Math.round(zoom * 100)}%`;
}

function handleMermaidPreviewKeydown(event) {
  const tag = event.target?.tagName;
  const isEditing = ["INPUT", "TEXTAREA", "SELECT"].includes(tag) || event.target?.isContentEditable;
  if (isEditing) return;
  const key = event.key.toLowerCase();
  if (key === "+" || key === "=") {
    event.preventDefault();
    zoomMermaidPreview(1.15);
  } else if (key === "-") {
    event.preventDefault();
    zoomMermaidPreview(1 / 1.15);
  } else if (key === "0") {
    event.preventDefault();
    setMermaidPreviewZoom(1);
  }
}

function handleMermaidPreviewWheel(event) {
  if (!event.metaKey && !event.ctrlKey) return;
  event.preventDefault();
  zoomMermaidPreview(event.deltaY < 0 ? 1.12 : 1 / 1.12);
}

function mermaidDownloadName(extension) {
  const title = state.activeConversation?.title || state.activePaper?.title || "mermaid-diagram";
  const safeTitle = title.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-").slice(0, 80) || "mermaid-diagram";
  return `${safeTitle}.${extension}`;
}

function mermaidSvgSize(svg) {
  const viewBox = svg.viewBox?.baseVal;
  if (viewBox?.width && viewBox?.height) {
    return { width: viewBox.width, height: viewBox.height };
  }
  const rect = svg.getBoundingClientRect();
  return {
    width: Math.max(1, Math.ceil(rect.width || Number(svg.getAttribute("width")) || 800)),
    height: Math.max(1, Math.ceil(rect.height || Number(svg.getAttribute("height")) || 600)),
  };
}

function mermaidSvgToPngBlob(svg) {
  return new Promise((resolve, reject) => {
    const source = `<?xml version="1.0" encoding="UTF-8"?>\n${serializedMermaidSvg(svg)}`;
    const image = new Image();
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
    const timer = window.setTimeout(() => {
      reject(new Error("PNG 生成超时，请先下载 SVG"));
    }, 8000);
    image.onload = () => {
      window.clearTimeout(timer);
      try {
        const { width, height } = mermaidSvgSize(svg);
        const scale = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(width * scale);
        canvas.height = Math.ceil(height * scale);
        const context = canvas.getContext("2d");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.setTransform(scale, 0, 0, scale, 0, 0);
        context.drawImage(image, 0, 0, width, height);
        canvas.toBlob((blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error("PNG 下载失败"));
          }
        }, "image/png");
      } catch (error) {
        reject(error);
      }
    };
    image.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error("PNG 下载失败"));
    };
    image.src = url;
  });
}

function markMermaidRenderError(root = document) {
  for (const node of root.querySelectorAll(".mermaid:not([data-processed])")) {
    node.classList.add("mermaid-error");
    node.dataset.processed = "true";
  }
}

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

async function copyMessageContent(content) {
  try {
    await navigator.clipboard.writeText(content);
    toast("已复制");
  } catch {
    toast("复制失败，请手动选择文本");
  }
}

function startResendEdit(content, messageId = "") {
  saveActiveConversationDraft();
  state.editingResendMessageId = messageId || makeId();
  $("messageInput").value = content;
  clearConversationSelections({ persist: false });
  clearAttachments({ persist: false });
  clearSelection();
  updateComposerMode();
  $("messageInput").focus();
  $("messageInput").setSelectionRange($("messageInput").value.length, $("messageInput").value.length);
}

function cancelResendEdit() {
  state.editingResendMessageId = null;
  $("messageInput").value = "";
  restoreActiveConversationDraft();
  updateComposerMode();
}

function focusMessageInput({ moveCaretToEnd = true } = {}) {
  const input = $("messageInput");
  if (!input) return;
  const applyFocus = () => {
    try {
      input.focus({ preventScroll: true });
    } catch {
      input.focus();
    }
    if (moveCaretToEnd && typeof input.setSelectionRange === "function") {
      const end = input.value.length;
      input.setSelectionRange(end, end);
    }
  };
  applyFocus();
  window.requestAnimationFrame(() => {
    applyFocus();
    window.setTimeout(applyFocus, 0);
  });
}

function requestComposerFocusReturn(duration = 1600) {
  state.composerFocusUntil = Math.max(state.composerFocusUntil, Date.now() + duration);
  [0, 16, 80, 220, 500, 900, 1400].forEach((delay) => {
    window.setTimeout(() => {
      if (Date.now() <= state.composerFocusUntil) {
        focusMessageInput();
      }
    }, delay);
  });
}

function settleComposerFocusReturn() {
  if (Date.now() > state.composerFocusUntil) return;
  focusMessageInput();
  window.setTimeout(() => {
    focusMessageInput();
  }, 40);
}

function sendMessageFromKeyboard() {
  requestComposerFocusReturn();
  window.setTimeout(() => {
    sendMessage().finally(settleComposerFocusReturn);
  }, 0);
}

function updateComposerMode() {
  const editing = Boolean(state.editingResendMessageId);
  $("composer").classList.toggle("resend-editing", editing);
  $("resendEditBar").classList.toggle("hidden", !editing);
  $("initializeBtn").classList.toggle("hidden", editing);
  updateButtons();
}

function composerHasPayload() {
  return Boolean(
    ($("messageInput")?.value || "").trim()
    || state.selectedSnippets.length
    || state.pendingAttachments.length
  );
}

function shouldComposerButtonStop() {
  if (state.editingResendMessageId || composerHasPayload()) return false;
  const task = state.activeConversation ? activeTaskForConversation(state.activeConversation.id) : null;
  return Boolean(task && ["running", "canceling"].includes(task.status));
}

async function handleComposerAction() {
  if (shouldComposerButtonStop()) {
    const task = activeTaskForConversation(state.activeConversation.id);
    if (task && task.status !== "canceling") {
      await cancelTask(task.id);
    }
    return;
  }
  await sendMessage();
}

async function initializeConversation() {
  if (!state.activePaper) {
    toast("请先选择一篇论文");
    return;
  }
  await ensureConversation();
  const convId = state.activeConversation.id;
  try {
    appendMessage("user", `读全文：${state.activePaper.title}`);
    scrollMessages();
    await api(`/api/conversations/${convId}/initialize`, {
      method: "POST",
      body: JSON.stringify({ paper_id: state.activePaper.id }),
    });
    await loadConversations();
    await loadTasks({ silent: true });
    if (state.activeConversation?.id === convId) {
      await loadMessages({ forceBottom: true });
    }
    updateContextHint();
    scrollMessages();
    toast("读全文任务已加入队列");
  } catch (error) {
    if (state.activeConversation?.id === convId) {
      appendMessage("assistant", `出错了：${error.message}`);
    }
    toast(error.message, 9000);
  }
}

async function sendMessage() {
  const content = $("messageInput").value.trim();
  const snippets = [...state.selectedSnippets];
  const attachments = [...state.pendingAttachments];
  const selectedText = buildSelectedText(snippets);
  if (!content && !selectedText && !attachments.length) {
    toast("请输入问题，或先添加论文选区、图片或文件");
    focusMessageInput({ moveCaretToEnd: false });
    return;
  }
  await ensureConversation();
  const convId = state.activeConversation.id;
  let attachmentPayload = [];
  try {
    attachmentPayload = await buildAttachmentPayload(attachments);
  } catch (error) {
    toast(error.message || "读取附件失败", 7000);
    focusMessageInput({ moveCaretToEnd: false });
    return;
  }
  const payload = {
    content,
    selected_text: selectedText,
    attachments: attachmentPayload,
    paper_id: state.activePaper ? state.activePaper.id : null,
  };
  $("messageInput").value = "";
  const localVisible = formatLocalVisibleMessage(content, snippets, attachments);
  appendMessage("user", localVisible);
  clearSelection();
  clearConversationSelections({ persist: false });
  clearAttachments({ persist: false });
  clearDraftForConversation(convId);
  scrollMessages();
  focusMessageInput();
  try {
    await api(`/api/conversations/${convId}/messages`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    await loadConversations();
    await loadTasks({ silent: true });
    if (state.activeConversation?.id === convId) {
      await loadMessages({ forceBottom: true });
    }
    updateContextHint();
    state.editingResendMessageId = null;
    updateComposerMode();
    toast("问题已加入队列");
  } catch (error) {
    if (state.activeConversation?.id === convId) {
      appendMessage("assistant", `出错了：${error.message}`);
    }
    toast(error.message, 9000);
  } finally {
    focusMessageInput();
  }
}

async function loadTasks({ silent } = { silent: false }) {
  const previous = { ...state.taskStatuses };
  state.tasks = await api("/api/tasks");
  state.taskStatuses = Object.fromEntries(state.tasks.map((task) => [task.id, task.status]));
  renderTasks();
  renderConversations();
  showActiveWorkStatus();

  const changedToFinal = state.tasks.filter((task) => {
    const oldStatus = previous[task.id];
    return oldStatus !== task.status && ["done", "error", "canceled"].includes(task.status);
  });
  if (changedToFinal.length) {
    await loadConversations();
    if (state.activeConversation && changedToFinal.some((task) => task.conversation_id === state.activeConversation.id)) {
      await loadMessages({ forceBottom: true });
    }
    if (state.activePaper && changedToFinal.some((task) => task.status === "done")) {
      await loadHighlights(state.activePaper.id);
      for (const pageNode of $("pdfViewer").querySelectorAll(".pdf-page")) {
        renderHighlightsForPage(pageNode);
      }
    }
    for (const task of changedToFinal) {
      if (!silent && task.status === "error") {
        toast(task.error || "Codex 任务失败", 9000);
      }
    }
  }
}

function renderTasks() {
  if (state.draggingTaskId) return;
  const activeTasks = state.tasks.filter((task) => isActiveTask(task));
  $("queuePanel").classList.toggle("hidden", activeTasks.length === 0);
  $("queuePanel").classList.toggle("collapsed", state.queueCollapsed);
  $("queueCount").textContent = String(activeTasks.length);
  $("queueToggleBtn").setAttribute("aria-expanded", String(!state.queueCollapsed));
  $("queueToggleLabel").textContent = state.queueCollapsed ? "展开" : "收起";
  const runningCount = activeTasks.filter((task) => task.status === "running" || task.status === "canceling").length;
  const queuedCount = activeTasks.filter((task) => task.status === "queued").length;
  $("queueSummary").textContent = activeTasks.length ? `运行 ${runningCount} · 排队 ${queuedCount}` : "没有运行中的任务";
  const list = $("taskList");
  list.innerHTML = "";
  for (const task of activeTasks) {
    const conv = state.conversations.find((item) => item.id === task.conversation_id);
    const item = document.createElement("div");
    item.className = `task-item ${task.status}`;
    item.dataset.taskId = task.id;
    item.draggable = task.can_reorder;
    if (task.can_reorder) {
      item.tabIndex = 0;
      item.title = "拖动调整排队顺序";
    }
    const status = taskStatusText(task.status);
    const title = taskQueueTitle(task);
    const meta = conv ? conv.title : status;
    item.innerHTML = `
      <span class="task-leading-icon" aria-hidden="true"></span>
      <div class="task-copy">
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(status)}${meta && meta !== status ? ` · ${escapeHtml(meta)}` : ""}</span>
      </div>
      <div class="task-actions">
        ${task.can_edit ? `<button class="task-edit-btn" type="button" data-task-id="${escapeHtml(task.id)}" aria-label="编辑排队任务" title="编辑"></button>` : ""}
        <button class="task-cancel-btn" type="button" data-task-id="${escapeHtml(task.id)}" aria-label="取消任务" title="取消任务"></button>
        <button class="task-more-btn" type="button" aria-label="更多" title="更多"></button>
      </div>
    `;
    if (task.can_reorder) {
      item.addEventListener("dragstart", handleTaskDragStart);
      item.addEventListener("dragover", handleTaskDragOver);
      item.addEventListener("drop", handleTaskDrop);
      item.addEventListener("dragend", handleTaskDragEnd);
      item.addEventListener("keydown", handleTaskKeyboardReorder);
    }
    item.querySelector(".task-edit-btn")?.addEventListener("click", () => openTaskEditor(task.id));
    item.querySelector(".task-cancel-btn").addEventListener("click", () => cancelTask(task.id));
    list.appendChild(item);
  }
  updateButtons();
}

function toggleQueuePanel() {
  state.queueCollapsed = !state.queueCollapsed;
  localStorage.setItem("paperCodexQueueCollapsed", String(state.queueCollapsed));
  renderTasks();
}

function taskQueueTitle(task) {
  const label = (task.label || task.kind || "").trim();
  if (!label) return "发送到 Codex";
  return label.replace(/^提问：/, "").replace(/^读全文：/, "读全文 · ");
}

function activeTaskIdsFromDom() {
  return [...$("taskList").querySelectorAll(".task-item")].map((item) => item.dataset.taskId).filter(Boolean);
}

function queuedTaskItems() {
  return [...$("taskList").querySelectorAll(".task-item.queued")];
}

function handleTaskDragStart(event) {
  const item = event.currentTarget;
  state.draggingTaskId = item.dataset.taskId;
  item.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", state.draggingTaskId);
}

function handleTaskDragOver(event) {
  event.preventDefault();
  const dragging = $("taskList").querySelector(".task-item.dragging");
  const target = event.currentTarget;
  if (!dragging || dragging === target || !target.classList.contains("queued")) return;
  const rect = target.getBoundingClientRect();
  const before = event.clientY < rect.top + rect.height / 2;
  $("taskList").insertBefore(dragging, before ? target : target.nextSibling);
}

function handleTaskDrop(event) {
  event.preventDefault();
}

async function handleTaskDragEnd(event) {
  event.currentTarget.classList.remove("dragging");
  state.draggingTaskId = null;
  await persistTaskOrder();
}

async function handleTaskKeyboardReorder(event) {
  if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
  event.preventDefault();
  const items = queuedTaskItems();
  const currentIndex = items.indexOf(event.currentTarget);
  const nextIndex = currentIndex + (event.key === "ArrowUp" ? -1 : 1);
  if (currentIndex < 0 || nextIndex < 0 || nextIndex >= items.length) return;
  const list = $("taskList");
  if (nextIndex < currentIndex) {
    list.insertBefore(event.currentTarget, items[nextIndex]);
  } else {
    list.insertBefore(event.currentTarget, items[nextIndex].nextSibling);
  }
  event.currentTarget.focus();
  await persistTaskOrder();
}

async function persistTaskOrder() {
  try {
    const taskIds = activeTaskIdsFromDom();
    await api("/api/tasks/reorder", {
      method: "POST",
      body: JSON.stringify({ task_ids: taskIds }),
    });
    await loadTasks({ silent: true });
  } catch (error) {
    toast(error.message || "调整队列顺序失败", 7000);
    await loadTasks({ silent: true });
  }
}

async function cancelTask(taskId) {
  try {
    await api(`/api/tasks/${taskId}/cancel`, { method: "POST", body: "{}" });
    await loadTasks({ silent: true });
    toast("已请求取消任务");
  } catch (error) {
    toast(error.message, 7000);
  }
}

function openTaskEditor(taskId) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task?.can_edit) {
    toast("只能编辑正在排队的提问");
    return;
  }
  state.editingTaskId = taskId;
  $("taskEditInput").value = task.editable_content || task.label || "";
  $("taskEditDialog").showModal();
  $("taskEditInput").focus();
}

function closeTaskEditor() {
  state.editingTaskId = null;
  $("taskEditInput").value = "";
  $("taskEditDialog").close();
}

async function saveTaskEdit(event) {
  event.preventDefault();
  const taskId = state.editingTaskId;
  const content = $("taskEditInput").value.trim();
  if (!taskId) return;
  if (!content) {
    toast("请输入任务内容");
    return;
  }
  try {
    await api(`/api/tasks/${taskId}`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
    const task = state.tasks.find((item) => item.id === taskId);
    closeTaskEditor();
    await loadTasks({ silent: true });
    if (task?.conversation_id && state.activeConversation?.id === task.conversation_id) {
      await loadMessages();
    }
    toast("已更新排队任务");
  } catch (error) {
    toast(error.message || "编辑任务失败", 7000);
    await loadTasks({ silent: true });
  }
}

function activeTaskForConversation(conversationId) {
  return state.tasks.find((task) => task.conversation_id === conversationId && isActiveTask(task));
}

function isActiveTask(task) {
  return ["queued", "running", "canceling"].includes(task.status);
}

function taskStatusText(status) {
  return {
    queued: "排队中",
    running: "运行中",
    canceling: "取消中",
    canceled: "已取消",
    done: "已完成",
    error: "失败",
  }[status] || status;
}

function appendTaskPlaceholder(task) {
  const box = $("messages");
  const node = document.createElement("div");
  node.className = `message assistant task-placeholder ${task.status}`;
  if (task.user_message_id) {
    node.dataset.parentMessageId = task.user_message_id;
  }
  node.innerHTML = `
    <div class="role">Codex · ${escapeHtml(taskStatusText(task.status))}</div>
    <pre>${escapeHtml(task.label || "正在处理")}</pre>
  `;
  box.appendChild(node);
}

function answerNodes() {
  return [...$("messages").querySelectorAll(".message.assistant:not(.task-placeholder)")];
}

function updateAnswerNavButtons() {
  const hasAnswers = answerNodes().length > 0;
  $("prevAnswerBtn").disabled = !hasAnswers;
  $("nextAnswerBtn").disabled = !hasAnswers;
}

function jumpAnswer(direction) {
  const answers = answerNodes();
  if (!answers.length) return;
  const box = $("messages");
  const currentTop = box.scrollTop + 8;
  let target = null;
  if (direction < 0) {
    target = [...answers].reverse().find((node) => node.offsetTop < currentTop - 8) || answers[0];
  } else {
    target = answers.find((node) => node.offsetTop > currentTop + 8) || answers[answers.length - 1];
  }
  box.scrollTo({ top: Math.max(0, target.offsetTop - 10), behavior: "smooth" });
}

async function renderPdf(url) {
  const viewer = $("pdfViewer");
  const token = ++state.pdfRenderToken;
  viewer.innerHTML = `<div class="empty-state"><h2>正在加载 PDF...</h2></div>`;
  if (state.pdfUrl !== url || !state.pdfDoc) {
    state.pdfUrl = url;
    state.pdfDoc = await pdfjsLib.getDocument(url).promise;
  }
  if (token !== state.pdfRenderToken) return;
  await loadPdfOutline(token);
  await renderPdfPages(token);
}

async function loadPdfOutline(token = state.pdfRenderToken) {
  state.pdfOutline = [];
  renderPdfOutline();
  if (!state.pdfDoc) return;
  try {
    const outline = await state.pdfDoc.getOutline();
    if (token !== state.pdfRenderToken) return;
    state.pdfOutline = flattenPdfOutline(outline || []);
    renderPdfOutline();
  } catch (error) {
    console.warn("PDF outline unavailable", error);
    renderPdfOutline();
  }
}

function flattenPdfOutline(items, level = 0, result = []) {
  for (const item of items || []) {
    const title = String(item.title || "").trim();
    if (title && (item.dest || item.url)) {
      result.push({
        title,
        dest: item.dest || null,
        url: item.url || "",
        level: Math.min(level, 4),
      });
    }
    if (item.items?.length) flattenPdfOutline(item.items, level + 1, result);
  }
  return result.slice(0, 160);
}

function renderPdfOutline() {
  const switcher = $("outlineSwitcher");
  const menu = $("outlineMenu");
  const trigger = $("outlineTrigger");
  if (!switcher || !menu || !trigger) return;
  const items = state.pdfOutline || [];
  switcher.classList.toggle("hidden", !items.length);
  trigger.disabled = !items.length;
  trigger.setAttribute("aria-expanded", "false");
  if (!items.length) {
    menu.innerHTML = "";
    return;
  }
  menu.innerHTML = `
    <div class="outline-menu-title">PDF 目录</div>
    ${items.map((item, index) => `
      <button
        class="outline-item"
        style="--outline-level: ${item.level}"
        type="button"
        role="menuitem"
        data-outline-index="${index}"
        title="${escapeHtml(item.title)}"
      >
        <span>${escapeHtml(item.title)}</span>
      </button>
    `).join("")}
  `;
}

async function openOutlineItem(index) {
  const item = state.pdfOutline[Number(index)];
  if (!item) return;
  if (item.url) {
    window.open(item.url, "_blank", "noopener");
    return;
  }
  try {
    const pageNumber = await pageNumberForPdfDestination(item.dest);
    if (!pageNumber) {
      toast("无法定位这个目录项");
      return;
    }
    jumpToPdfPage(pageNumber);
  } catch (error) {
    toast(error.message || "目录跳转失败", 7000);
  }
}

async function pageNumberForPdfDestination(dest) {
  if (!state.pdfDoc || !dest) return null;
  const explicit = Array.isArray(dest) ? dest : await state.pdfDoc.getDestination(dest);
  const target = explicit?.[0];
  if (typeof target === "number") return target + 1;
  if (target) return (await state.pdfDoc.getPageIndex(target)) + 1;
  return null;
}

function jumpToPdfPage(pageNumber) {
  const viewer = $("pdfViewer");
  const page = viewer.querySelector(`.pdf-page[data-page="${pageNumber}"]`);
  if (!page) return;
  viewer.scrollTo({ top: Math.max(0, page.offsetTop - 18), behavior: "smooth" });
  window.setTimeout(() => queueVisiblePages(state.pdfRenderToken), 220);
}

async function renderPdfPages(token = ++state.pdfRenderToken) {
  const viewer = $("pdfViewer");
  const pdf = state.pdfDoc;
  if (!pdf) return;
  const anchor = getRestoreAnchor();
  const firstPage = await pdf.getPage(1);
  const firstViewport = firstPage.getViewport({ scale: 1 });
  const fitScale = Math.max(0.45, Math.min(2.6, (viewer.clientWidth - 72) / firstViewport.width));
  const scale = state.zoomMode === "fit" ? fitScale : state.zoom;
  state.currentScale = scale;
  updateZoomDisplay();
  const fragment = document.createDocumentFragment();
  resetPageRendering();
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    if (token !== state.pdfRenderToken) return;
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale });

    const pageNode = document.createElement("div");
    pageNode.className = "pdf-page loading";
    pageNode.dataset.page = String(pageNumber);
    pageNode.style.width = `${viewport.width}px`;
    pageNode.style.height = `${viewport.height}px`;
    fragment.appendChild(pageNode);
  }
  if (token !== state.pdfRenderToken) return;
  viewer.replaceChildren(fragment);
  restorePdfScrollAnchor(anchor);
  setupPageObserver(token);
  queueVisiblePages(token);
}

function getRestoreAnchor() {
  if (state.restoringPaperId && state.readingState?.paperId === state.restoringPaperId && state.readingState?.anchor) {
    return state.readingState.anchor;
  }
  return getPdfScrollAnchor();
}

function resetPageRendering() {
  state.renderedPages = new Set();
  state.renderingPages = new Set();
  if (state.pageObserver) {
    state.pageObserver.disconnect();
    state.pageObserver = null;
  }
}

function setupPageObserver(token) {
  const viewer = $("pdfViewer");
  state.pageObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        renderPdfPage(Number(entry.target.dataset.page), token).catch((error) => toast(error.message, 7000));
      }
    }
  }, {
    root: viewer,
    rootMargin: "900px 0px",
    threshold: 0.01,
  });
  viewer.querySelectorAll(".pdf-page").forEach((page) => state.pageObserver.observe(page));
}

function queueVisiblePages(token) {
  const viewer = $("pdfViewer");
  const top = viewer.scrollTop - 900;
  const bottom = viewer.scrollTop + viewer.clientHeight + 900;
  for (const page of viewer.querySelectorAll(".pdf-page")) {
    if (page.offsetTop < bottom && page.offsetTop + page.offsetHeight > top) {
      renderPdfPage(Number(page.dataset.page), token).catch((error) => toast(error.message, 7000));
    }
  }
}

async function renderPdfPage(pageNumber, token = state.pdfRenderToken) {
  if (!state.pdfDoc || token !== state.pdfRenderToken || !pageNumber) return;
  if (state.renderedPages.has(pageNumber) || state.renderingPages.has(pageNumber)) return;
  state.renderingPages.add(pageNumber);
  try {
    const pageNode = $("pdfViewer").querySelector(`.pdf-page[data-page="${pageNumber}"]`);
    if (!pageNode || token !== state.pdfRenderToken) return;
    const page = await state.pdfDoc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: state.currentScale });
    const outputScale = Math.min(window.devicePixelRatio || 1, 2.5);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    const textLayer = document.createElement("div");
    textLayer.className = "text-layer";
    textLayer.style.setProperty("--scale-factor", String(state.currentScale));
    const highlightLayer = document.createElement("div");
    highlightLayer.className = "highlight-layer";
    pageNode.replaceChildren(canvas, textLayer, highlightLayer);
    pageNode.classList.remove("loading");

    await page.render({
      canvasContext: context,
      viewport,
      transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0],
    }).promise;
    if (token !== state.pdfRenderToken) return;
    const textContent = await page.getTextContent();
    await renderTextLayer(textContent, textLayer, viewport);
    renderHighlightsForPage(pageNode);
    state.renderedPages.add(pageNumber);
  } finally {
    state.renderingPages.delete(pageNumber);
  }
}

function getPdfScrollAnchor() {
  const viewer = $("pdfViewer");
  const pages = Array.from(viewer.querySelectorAll(".pdf-page"));
  const viewportTop = viewer.scrollTop + 24;
  for (const page of pages) {
    const top = page.offsetTop;
    const bottom = top + page.offsetHeight;
    if (bottom >= viewportTop) {
      const ratio = page.offsetHeight ? clamp((viewportTop - top) / page.offsetHeight, 0, 1) : 0;
      return { page: page.dataset.page || "1", ratio };
    }
  }
  return { page: "1", ratio: 0 };
}

function restorePdfScrollAnchor(anchor) {
  const viewer = $("pdfViewer");
  const page = viewer.querySelector(`.pdf-page[data-page="${anchor.page}"]`) || viewer.querySelector(".pdf-page");
  if (!page) return;
  const target = page.offsetTop + page.offsetHeight * anchor.ratio - 24;
  viewer.scrollTop = clamp(target, 0, viewer.scrollHeight - viewer.clientHeight);
}

function saveCurrentReadingPosition() {
  if (!state.activePaper || !state.pdfDoc) return;
  saveReadingState({
    paperId: state.activePaper.id,
    anchor: getPdfScrollAnchor(),
    zoomMode: state.zoomMode,
    zoom: state.zoom,
  });
}

function scheduleReadingPositionSave() {
  window.clearTimeout(scheduleReadingPositionSave._timer);
  scheduleReadingPositionSave._timer = window.setTimeout(saveCurrentReadingPosition, 180);
}

function restoreSavedZoomState() {
  const mode = state.readingState?.zoomMode;
  if (mode === "fit") {
    state.zoomMode = "fit";
  } else if (mode === "custom") {
    state.zoomMode = "custom";
    state.zoom = clamp(Number(state.readingState.zoom) || 1, 0.45, 3);
  }
}

function setZoomMode(mode) {
  if (!state.pdfDoc) return;
  state.zoomMode = mode;
  if (mode === "actual") {
    state.zoomMode = "custom";
    state.zoom = 1;
  }
  saveCurrentReadingPosition();
  renderPdfPages().catch((error) => toast(error.message, 7000));
}

function zoomBy(multiplier) {
  if (!state.pdfDoc) return;
  state.zoomMode = "custom";
  state.zoom = clamp((state.currentScale || state.zoom || 1) * multiplier, 0.45, 3);
  saveCurrentReadingPosition();
  renderPdfPages().catch((error) => toast(error.message, 7000));
}

function updateZoomDisplay() {
  $("zoomValue").textContent = state.zoomMode === "fit" ? "适合" : `${Math.round((state.currentScale || 1) * 100)}%`;
}

function rerenderPdfSoon() {
  window.clearTimeout(rerenderPdfSoon._timer);
  rerenderPdfSoon._timer = window.setTimeout(() => {
    if (state.pdfDoc && state.zoomMode === "fit") {
      renderPdfPages().catch((error) => toast(error.message, 7000));
    }
  }, 180);
}

function handleGlobalShortcuts(event) {
  if (event.defaultPrevented) return;
  const tag = event.target?.tagName;
  const isEditing = ["INPUT", "TEXTAREA", "SELECT"].includes(tag) || event.target?.isContentEditable;
  const key = event.key.toLowerCase();
  const withCommand = event.metaKey || event.ctrlKey;

  if (key === "escape") {
    if (isSlashMenuOpen()) closeSlashMenu();
    clearSelection();
    return;
  }
  if (withCommand && event.shiftKey && key === "s") {
    const task = state.activeConversation ? activeTaskForConversation(state.activeConversation.id) : null;
    if (task && ["running", "canceling"].includes(task.status)) {
      event.preventDefault();
      cancelTask(task.id);
    }
    return;
  }
  if (isEditing) return;

  if (withCommand && (key === "+" || key === "=")) {
    event.preventDefault();
    zoomBy(1.15);
    return;
  }
  if (withCommand && key === "-") {
    event.preventDefault();
    zoomBy(1 / 1.15);
    return;
  }
  if (withCommand && key === "0") {
    event.preventDefault();
    setZoomMode("actual");
    return;
  }
  if (!withCommand && !event.altKey && (key === "+" || key === "=")) {
    event.preventDefault();
    zoomBy(1.15);
    return;
  }
  if (!withCommand && !event.altKey && key === "-") {
    event.preventDefault();
    zoomBy(1 / 1.15);
    return;
  }
  if (!withCommand && !event.altKey && key === "0") {
    event.preventDefault();
    setZoomMode("actual");
    return;
  }
  if (!withCommand && key === "f" && state.pdfDoc) {
    event.preventDefault();
    setZoomMode("fit");
    return;
  }
  if (!withCommand && key === " ") {
    event.preventDefault();
    scrollReaderBy(event.shiftKey ? -0.85 : 0.85);
    return;
  }
  if (!withCommand && key === "pagedown") {
    event.preventDefault();
    scrollReaderBy(0.9);
    return;
  }
  if (!withCommand && key === "pageup") {
    event.preventDefault();
    scrollReaderBy(-0.9);
  }
}

function scrollReaderBy(viewportRatio) {
  const viewer = $("pdfViewer");
  viewer.scrollBy({ top: viewer.clientHeight * viewportRatio, behavior: "smooth" });
  window.setTimeout(() => queueVisiblePages(state.pdfRenderToken), 220);
}

async function renderTextLayer(textContent, container, viewport) {
  if (pdfjsLib.renderTextLayer) {
    const task = pdfjsLib.renderTextLayer({
      textContentSource: textContent,
      container,
      viewport,
      textDivs: [],
    });
    if (task && task.promise) {
      await task.promise;
      return;
    }
  }
  for (const item of textContent.items) {
    const span = document.createElement("span");
    span.textContent = item.str;
    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const fontHeight = Math.hypot(tx[2], tx[3]);
    span.style.left = `${tx[4]}px`;
    span.style.top = `${tx[5] - fontHeight}px`;
    span.style.fontSize = `${fontHeight}px`;
    span.style.transform = `scaleX(${item.width ? (tx[0] / item.width) : 1})`;
    container.appendChild(span);
  }
}

function renderHighlightsForPage(pageNode) {
  const layer = pageNode.querySelector(".highlight-layer");
  if (!layer) return;
  layer.innerHTML = "";
  const page = pageNode.dataset.page;
  const pageHighlights = state.highlights.filter((item) => String(item.page) === String(page));
  for (const highlight of pageHighlights) {
    for (const rect of mergeHighlightRects(highlight.rects || [])) {
      const item = document.createElement("div");
      item.className = `paper-highlight ${highlightColorClass(highlight.color)}`;
      item.dataset.highlightId = highlight.id;
      item.style.left = `${rect.left * 100}%`;
      item.style.top = `${rect.top * 100}%`;
      item.style.width = `${rect.width * 100}%`;
      item.style.height = `${rect.height * 100}%`;
      item.addEventListener("pointerenter", () => enterHighlight(highlight, item));
      item.addEventListener("pointerleave", () => leaveHighlight(highlight));
      layer.appendChild(item);
    }
  }
}

function renderHighlightEverywhere(highlight) {
  const pageNode = $("pdfViewer").querySelector(`.pdf-page[data-page="${highlight.page}"]`);
  if (pageNode) renderHighlightsForPage(pageNode);
}

function highlightColorClass(color) {
  return HIGHLIGHT_COLORS.includes(color) ? color : "yellow";
}

function mergeHighlightRects(rects) {
  const cleanRects = (Array.isArray(rects) ? rects : [])
    .map((rect) => {
      const left = clamp(Number(rect.left) || 0, 0, 1);
      const top = clamp(Number(rect.top) || 0, 0, 1);
      const right = clamp(left + (Number(rect.width) || 0), left, 1);
      const bottom = clamp(top + (Number(rect.height) || 0), top, 1);
      return {
        left,
        top,
        width: Math.max(0.001, right - left),
        height: Math.max(0.001, bottom - top),
      };
    })
    .filter((rect) => rect.width > 0.001 && rect.height > 0.001)
    .sort((a, b) => a.top - b.top || a.left - b.left);

  const rows = [];
  for (const rect of cleanRects) {
    const center = rect.top + rect.height / 2;
    const row = rows.find((candidate) => {
      const rowCenter = (candidate.top + candidate.bottom) / 2;
      const overlap = Math.min(candidate.bottom, rect.top + rect.height) - Math.max(candidate.top, rect.top);
      const lineHeight = Math.max(candidate.bottom - candidate.top, rect.height);
      return overlap > Math.min(candidate.bottom - candidate.top, rect.height) * 0.42
        || Math.abs(center - rowCenter) < lineHeight * 0.38;
    });
    if (row) {
      row.top = Math.min(row.top, rect.top);
      row.bottom = Math.max(row.bottom, rect.top + rect.height);
      row.rects.push(rect);
    } else {
      rows.push({
        top: rect.top,
        bottom: rect.top + rect.height,
        rects: [rect],
      });
    }
  }

  return rows.flatMap((row) => {
    const sorted = row.rects.sort((a, b) => a.left - b.left);
    const merged = [];
    for (const rect of sorted) {
      const previous = merged[merged.length - 1];
      const rectRight = rect.left + rect.width;
      if (!previous) {
        merged.push({ ...rect });
        continue;
      }
      const previousRight = previous.left + previous.width;
      const gap = rect.left - previousRight;
      const maxGap = Math.max(0.012, Math.min(previous.height, rect.height) * 0.7);
      if (gap <= maxGap) {
        const left = Math.min(previous.left, rect.left);
        const top = Math.min(previous.top, rect.top);
        const right = Math.max(previousRight, rectRight);
        const bottom = Math.max(previous.top + previous.height, rect.top + rect.height);
        previous.left = left;
        previous.top = top;
        previous.width = Math.max(0.001, right - left);
        previous.height = Math.max(0.001, bottom - top);
      } else {
        merged.push({ ...rect });
      }
    }
    return merged;
  });
}

function rectsFromCurrentSelection() {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount || !state.selectedPage) return [];
  const range = selection.getRangeAt(0);
  const pageNode = $("pdfViewer").querySelector(`.pdf-page[data-page="${state.selectedPage}"]`);
  if (!pageNode) return [];
  const pageRect = pageNode.getBoundingClientRect();
  const rects = Array.from(range.getClientRects())
    .filter((rect) =>
      rect.width > 1
      && rect.height > 1
      && rect.bottom > pageRect.top
      && rect.top < pageRect.bottom
      && rect.right > pageRect.left
      && rect.left < pageRect.right
    )
    .map((rect) => {
      const left = clamp((Math.max(rect.left, pageRect.left) - pageRect.left) / pageRect.width, 0, 1);
      const top = clamp((Math.max(rect.top, pageRect.top) - pageRect.top) / pageRect.height, 0, 1);
      const right = clamp((Math.min(rect.right, pageRect.right) - pageRect.left) / pageRect.width, 0, 1);
      const bottom = clamp((Math.min(rect.bottom, pageRect.bottom) - pageRect.top) / pageRect.height, 0, 1);
      return {
        left,
        top,
        width: Math.max(0.001, right - left),
        height: Math.max(0.001, bottom - top),
      };
    })
    .filter((rect) => rect.width > 0.001 && rect.height > 0.001);
  return mergeHighlightRects(rects);
}

async function createHighlightFromSelection(color = "yellow") {
  if (!state.activePaper || !state.selectedText || !state.selectedPage) {
    toast("请先选中论文文本");
    return;
  }
  const rects = rectsFromCurrentSelection();
  if (!rects.length) {
    toast("没有找到可高亮的选区位置");
    return;
  }
  try {
    const highlight = await api("/api/highlights", {
      method: "POST",
      body: JSON.stringify({
        paper_id: state.activePaper.id,
        conversation_id: state.activeConversation ? state.activeConversation.id : null,
        page: state.selectedPage,
        text: state.selectedText,
        color: highlightColorClass(color),
        rects,
      }),
    });
    state.highlights.push(highlight);
    renderHighlightEverywhere(highlight);
    clearSelection();
    toast("已高亮");
  } catch (error) {
    toast(error.message || "高亮失败", 7000);
  }
}

function enterHighlight(highlight, element) {
  window.clearTimeout(state.highlightHoverTimer);
  state.selectedText = highlight.text;
  state.selectedPage = highlight.page;
  state.selectionSource = "highlight";
  state.activeHighlightId = highlight.id;
  $("selectionMeta").textContent = `${highlight.text.length} 字符 · 第 ${highlight.page} 页`;
  positionSelectionBoxForRect(element.getBoundingClientRect());
  $("selectionBox").classList.remove("hidden");
  showHighlightAnswer(highlight, element);
}

function leaveHighlight() {
  scheduleHighlightClear();
}

function scheduleHighlightClear() {
  if (state.highlightPaletteOpen) return;
  window.clearTimeout(state.highlightHoverTimer);
  state.highlightHoverTimer = window.setTimeout(() => {
    if (state.selectionSource === "highlight" && !state.highlightPaletteOpen) {
      clearSelection();
    }
  }, 180);
}

function showHighlightAnswer(highlight, element) {
  const card = $("highlightAnswerCard");
  const rect = element.getBoundingClientRect();
  const left = Math.min(Math.max(rect.left + rect.width / 2, 180), window.innerWidth - 180);
  const top = rect.bottom + 10 < window.innerHeight - 80 ? rect.bottom + 10 : rect.top - 12;
  const answer = highlight.answer || "";
  card.dataset.highlightId = highlight.id;
  card.innerHTML = `
    <form class="highlight-note-form">
      <label class="highlight-note-label" for="highlightNoteInput">高亮备注 / Codex 回答</label>
      <textarea id="highlightNoteInput" class="highlight-note-input" rows="5" placeholder="给这处高亮写备注；发送给 Codex 后，回答也会写在这里。">${escapeHtml(answer)}</textarea>
      <div class="highlight-note-actions">
        <span>${answer ? "已保存内容，可直接修改" : "还没有备注"}</span>
        <div class="highlight-note-buttons">
          <button class="small-btn danger-btn delete-highlight-btn" type="button">删除高亮</button>
          <button class="small-btn" type="submit">保存</button>
        </div>
      </div>
    </form>
  `;
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
  card.classList.toggle("above-highlight", top < rect.top);
  card.classList.remove("hidden");
}

async function saveHighlightNote(event) {
  event.preventDefault();
  const card = $("highlightAnswerCard");
  const highlightId = card.dataset.highlightId;
  if (!highlightId) return;
  const input = card.querySelector(".highlight-note-input");
  const answer = input ? input.value : "";
  try {
    const updated = await api(`/api/highlights/${highlightId}`, {
      method: "POST",
      body: JSON.stringify({ answer }),
    });
    state.highlights = state.highlights.map((item) => item.id === updated.id ? updated : item);
    const pageNode = $("pdfViewer").querySelector(`.pdf-page[data-page="${updated.page}"]`);
    if (pageNode) renderHighlightsForPage(pageNode);
    card.dataset.highlightId = updated.id;
    toast(answer.trim() ? "备注已保存" : "备注已清空");
  } catch (error) {
    toast(error.message || "保存备注失败", 7000);
  }
}

async function deleteActiveHighlight() {
  const card = $("highlightAnswerCard");
  const highlightId = card.dataset.highlightId;
  if (!highlightId) return;
  const highlight = state.highlights.find((item) => item.id === highlightId);
  const confirmed = window.confirm("删除这处高亮和它的备注/回答？");
  if (!confirmed) return;
  try {
    const deleted = await api(`/api/highlights/${highlightId}`, { method: "DELETE" });
    state.highlights = state.highlights.filter((item) => item.id !== highlightId);
    const page = deleted.page || highlight?.page;
    const pageNode = page ? $("pdfViewer").querySelector(`.pdf-page[data-page="${page}"]`) : null;
    if (pageNode) renderHighlightsForPage(pageNode);
    clearSelection();
    toast("高亮已删除");
  } catch (error) {
    toast(error.message || "删除高亮失败", 7000);
  }
}

function openHighlightPalette() {
  if (!state.selectedText) {
    toast("请先选中论文文本");
    return;
  }
  state.highlightPaletteOpen = true;
  window.clearTimeout(state.highlightHoverTimer);
  $("selectionBox").classList.add("palette-open");
  $("highlightSelectionBtn").setAttribute("aria-expanded", "true");
}

function closeHighlightPalette() {
  state.highlightPaletteOpen = false;
  $("selectionBox")?.classList.remove("palette-open");
  $("highlightSelectionBtn")?.setAttribute("aria-expanded", "false");
}

function refreshHighlightAnswer(highlightId) {
  if (!highlightId || !state.activePaper) return;
  loadHighlights(state.activePaper.id)
    .then(() => {
      for (const pageNode of $("pdfViewer").querySelectorAll(".pdf-page")) {
        renderHighlightsForPage(pageNode);
      }
    })
    .catch(() => {});
}

function handleSelection() {
  const selection = window.getSelection();
  const text = selection ? selection.toString().trim() : "";
  if (!text || text.length < 2) {
    if (state.selectedText) {
      clearSelection();
    }
    return;
  }
  const node = selection.anchorNode && selection.anchorNode.nodeType === 3
    ? selection.anchorNode.parentElement
    : selection.anchorNode;
  const pageNode = node && node.closest ? node.closest(".pdf-page") : null;
  state.selectedText = text;
  state.selectedPage = pageNode ? pageNode.dataset.page : null;
  state.selectionSource = "native";
  state.activeHighlightId = null;
  $("selectionMeta").textContent = `${text.length} 字符${state.selectedPage ? ` · 第 ${state.selectedPage} 页` : ""}`;
  $("selectionBox").classList.toggle("hidden", !positionSelectionBox(selection));
}

function positionSelectionBox(selection) {
  if (!selection || !selection.rangeCount) return false;
  const range = selection.getRangeAt(0);
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width && rect.height);
  const viewer = $("pdfViewer");
  const viewerRect = viewer.getBoundingClientRect();
  const visibleTop = Math.max(viewerRect.top, 0);
  const visibleRight = Math.min(viewerRect.right, window.innerWidth);
  const visibleBottom = Math.min(viewerRect.bottom, window.innerHeight);
  const visibleLeft = Math.max(viewerRect.left, 0);
  const rect = rects.find((item) =>
    item.bottom > visibleTop && item.top < visibleBottom && item.right > visibleLeft && item.left < visibleRight
  );
  if (!rect) return false;
  return positionSelectionBoxForRect(rect);
}

function positionSelectionBoxForRect(rect) {
  const viewer = $("pdfViewer");
  const viewerRect = viewer.getBoundingClientRect();
  const visibleTop = Math.max(viewerRect.top, 0);
  const visibleRight = Math.min(viewerRect.right, window.innerWidth);
  const visibleBottom = Math.min(viewerRect.bottom, window.innerHeight);
  const visibleLeft = Math.max(viewerRect.left, 0);
  const box = $("selectionBox");
  const toolbarHalfWidth = 58;
  const left = Math.min(Math.max(rect.left + rect.width / 2, visibleLeft + toolbarHalfWidth), visibleRight - toolbarHalfWidth);
  const topAbove = rect.top - 42;
  const placedBelow = topAbove < visibleTop + 8;
  const rawTop = placedBelow ? rect.bottom + 8 : topAbove;
  const top = Math.min(Math.max(rawTop, visibleTop + 8), visibleBottom - 42);
  box.classList.toggle("below-selection", placedBelow);
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  return true;
}

function scheduleSelectionBoxSync() {
  if (!state.selectedText || state.selectionPositionFrame) return;
  state.selectionPositionFrame = window.requestAnimationFrame(() => {
    state.selectionPositionFrame = 0;
    syncSelectionBoxPosition();
  });
}

function syncSelectionBoxPosition() {
  if (!state.selectedText) return;
  const selection = window.getSelection();
  const hasLiveSelection = selection && selection.rangeCount && selection.toString().trim();
  $("selectionBox").classList.toggle("hidden", !hasLiveSelection || !positionSelectionBox(selection));
}

function addSelectionToConversation() {
  if (!state.selectedText) {
    return;
  }
  const duplicate = state.selectedSnippets.some((item) => item.text === state.selectedText && item.page === state.selectedPage);
  if (duplicate) {
    toast("这处选区已经添加过");
    clearSelection();
    return;
  }
  state.selectedSnippets.push({
    id: makeId(),
    text: state.selectedText,
    page: state.selectedPage,
  });
  renderSelectedContexts();
  saveActiveConversationDraft();
  clearSelection();
  $("messageInput").focus();
  toast(`已添加 ${state.selectedSnippets.length} 处选区`);
}

async function sendSelectionImmediately() {
  if (!state.selectedText) return;
  const highlightId = state.activeHighlightId;
  const snippet = {
    id: makeId(),
    text: state.selectedText,
    page: state.selectedPage,
  };
  const selectedText = buildSelectedText([snippet]);
  const localVisible = formatLocalVisibleMessage("", [snippet], []);
  try {
    await ensureConversation();
    const convId = state.activeConversation.id;
    appendMessage("user", localVisible);
    clearSelection();
    scrollMessages();
    await api(`/api/conversations/${convId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        content: "",
        selected_text: selectedText,
        attachments: [],
        paper_id: state.activePaper ? state.activePaper.id : null,
        highlight_id: highlightId,
      }),
    });
    await loadConversations();
    await loadTasks({ silent: true });
    if (state.activeConversation?.id === convId) {
      await loadMessages({ forceBottom: true });
    }
    if (highlightId) refreshHighlightAnswer(highlightId);
    updateContextHint();
    toast("选区已加入队列");
  } catch (error) {
    if (state.activeConversation) {
      appendMessage("assistant", `出错了：${error.message}`);
    }
    toast(error.message, 9000);
  }
}

function renderSelectedContexts() {
  const tray = $("contextTray");
  const list = $("contextList");
  const count = state.selectedSnippets.length;
  tray.classList.toggle("hidden", count === 0);
  $("contextTrayTitle").textContent = `已添加 ${count} 处选区`;
  list.innerHTML = "";
  for (const [index, item] of state.selectedSnippets.entries()) {
    const node = document.createElement("div");
    node.className = "context-chip";
    node.innerHTML = `
      <div class="context-chip-main">
        <strong>${escapeHtml(selectionLabel(item, index))}</strong>
        <span>${escapeHtml(compactText(item.text, 140))}</span>
      </div>
      <button class="icon-btn remove-context-btn" type="button" data-context-id="${escapeHtml(item.id)}" aria-label="移除选区" title="移除选区">×</button>
    `;
    list.appendChild(node);
  }
  updateButtons();
}

function removeSelectedContext(id) {
  state.selectedSnippets = state.selectedSnippets.filter((item) => item.id !== id);
  renderSelectedContexts();
  saveActiveConversationDraft();
}

function clearConversationSelections({ persist = true } = {}) {
  state.selectedSnippets = [];
  renderSelectedContexts();
  if (persist) {
    saveActiveConversationDraft();
  }
}

function loadPromptTemplates() {
  try {
    const parsed = JSON.parse(localStorage.getItem("paperCodexPromptTemplates") || "null");
    if (Array.isArray(parsed) && parsed.length) {
      return parsed.filter((item) => item && item.id && item.title && item.prompt);
    }
  } catch {
    // Fall back to defaults if local data is malformed.
  }
  return DEFAULT_PROMPT_TEMPLATES.map((item) => ({ ...item }));
}

function savePromptTemplates() {
  localStorage.setItem("paperCodexPromptTemplates", JSON.stringify(state.promptTemplates));
}

function renderPromptTemplates() {
  const list = $("promptList");
  if (!list) return;
  list.innerHTML = "";
  if (!state.promptTemplates.length) {
    list.innerHTML = `<div class="list-empty">还没有 prompt。点“新增”创建一个。</div>`;
    return;
  }
  for (const prompt of state.promptTemplates) {
    const item = document.createElement("div");
    item.className = "prompt-item";
    item.innerHTML = `
      <div>
        <strong>${escapeHtml(prompt.title)}</strong>
        <p>${escapeHtml(prompt.prompt)}</p>
      </div>
      <div class="prompt-item-actions">
        <button class="small-btn use-prompt-btn" type="button" data-prompt-id="${escapeHtml(prompt.id)}">使用</button>
        <button class="small-btn secondary-btn edit-prompt-btn" type="button" data-prompt-id="${escapeHtml(prompt.id)}">修改</button>
        <button class="small-btn danger-btn delete-prompt-btn" type="button" data-prompt-id="${escapeHtml(prompt.id)}">删除</button>
      </div>
    `;
    item.querySelector(".use-prompt-btn").addEventListener("click", () => usePromptTemplate(prompt.id));
    item.querySelector(".edit-prompt-btn").addEventListener("click", () => openPromptForm(prompt.id));
    item.querySelector(".delete-prompt-btn").addEventListener("click", () => deletePromptTemplate(prompt.id));
    list.appendChild(item);
  }
}

function usePromptTemplate(promptId) {
  const prompt = state.promptTemplates.find((item) => item.id === promptId);
  if (!prompt) return;
  $("messageInput").value = prompt.prompt;
  saveActiveConversationDraft();
  closeSlashMenu();
  updateButtons();
  $("messageInput").focus();
}

function renderSlashMenuFromInput() {
  const menu = $("slashMenu");
  const input = $("messageInput");
  if (!menu || !input) return;
  const value = input.value;
  const firstLine = value.split(/\n/)[0] || "";
  if (!firstLine.startsWith("/") || value.trimStart() !== value || state.editingResendMessageId) {
    closeSlashMenu();
    return;
  }
  const query = firstLine.slice(1).trim().toLowerCase();
  const matches = state.promptTemplates
    .filter((item) => {
      const haystack = `${item.title} ${item.prompt}`.toLowerCase();
      return !query || haystack.includes(query);
    })
    .slice(0, 6);
  if (!matches.length) {
    closeSlashMenu();
    return;
  }
  state.slashMenuIndex = Math.min(state.slashMenuIndex, matches.length - 1);
  const signature = JSON.stringify(matches.map((item) => [item.id, item.title, item.prompt]));
  if (state.slashMenuSignature !== signature) {
    menu.innerHTML = matches
      .map((item, index) => `
        <button class="slash-item" type="button" role="option" aria-selected="false" data-slash-index="${index}" data-prompt-id="${escapeHtml(item.id)}">
          <strong>${escapeHtml(item.title)}</strong>
          <span>${escapeHtml(compactText(item.prompt, 86))}</span>
        </button>
      `)
      .join("");
    state.slashMenuSignature = signature;
  }
  updateSlashMenuActive();
  menu.classList.remove("hidden");
}

function closeSlashMenu() {
  const menu = $("slashMenu");
  if (!menu) return;
  menu.classList.add("hidden");
  menu.innerHTML = "";
  state.slashMenuIndex = 0;
  state.slashMenuSignature = "";
}

function isSlashMenuOpen() {
  return Boolean($("slashMenu") && !$("slashMenu").classList.contains("hidden"));
}

function selectSlashPromptByIndex() {
  const items = [...$("slashMenu").querySelectorAll(".slash-item")];
  const item = items[state.slashMenuIndex] || items[0];
  if (item?.dataset.promptId) {
    usePromptTemplate(item.dataset.promptId);
    return true;
  }
  return false;
}

function moveSlashMenuSelection(delta) {
  const items = [...$("slashMenu").querySelectorAll(".slash-item")];
  if (!items.length) return;
  state.slashMenuIndex = (state.slashMenuIndex + delta + items.length) % items.length;
  updateSlashMenuActive();
}

function updateSlashMenuActive() {
  const items = [...$("slashMenu").querySelectorAll(".slash-item")];
  for (const [index, item] of items.entries()) {
    const active = index === state.slashMenuIndex;
    item.classList.toggle("active", active);
    item.setAttribute("aria-selected", active ? "true" : "false");
  }
}

function openPromptForm(promptId = null) {
  const prompt = promptId ? state.promptTemplates.find((item) => item.id === promptId) : null;
  state.editingPromptId = prompt ? prompt.id : null;
  $("promptTitleInput").value = prompt ? prompt.title : "";
  $("promptContentInput").value = prompt ? prompt.prompt : "";
  $("promptForm").classList.remove("hidden");
  $("promptTitleInput").focus();
}

function closePromptForm() {
  state.editingPromptId = null;
  $("promptTitleInput").value = "";
  $("promptContentInput").value = "";
  $("promptForm").classList.add("hidden");
}

function savePromptTemplate(event) {
  event.preventDefault();
  const title = $("promptTitleInput").value.trim();
  const prompt = $("promptContentInput").value.trim();
  if (!title || !prompt) {
    toast("请输入 prompt 名称和内容");
    return;
  }
  if (state.editingPromptId) {
    state.promptTemplates = state.promptTemplates.map((item) =>
      item.id === state.editingPromptId ? { ...item, title, prompt } : item
    );
  } else {
    state.promptTemplates.push({
      id: `prompt-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      title,
      prompt,
    });
  }
  savePromptTemplates();
  renderPromptTemplates();
  refreshOpenSlashMenu();
  closePromptForm();
}

function deletePromptTemplate(promptId) {
  const prompt = state.promptTemplates.find((item) => item.id === promptId);
  if (!prompt) return;
  if (!window.confirm(`删除 prompt“${prompt.title}”？`)) return;
  state.promptTemplates = state.promptTemplates.filter((item) => item.id !== promptId);
  if (state.editingPromptId === promptId) {
    closePromptForm();
  }
  savePromptTemplates();
  renderPromptTemplates();
  refreshOpenSlashMenu();
}

function refreshOpenSlashMenu() {
  if (!isSlashMenuOpen()) return;
  state.slashMenuSignature = "";
  renderSlashMenuFromInput();
}

function clearSelection() {
  closeHighlightPalette();
  state.selectedText = "";
  state.selectedPage = null;
  state.selectionSource = "";
  state.activeHighlightId = null;
  if (state.selectionPositionFrame) {
    window.cancelAnimationFrame(state.selectionPositionFrame);
    state.selectionPositionFrame = 0;
  }
  window.clearTimeout(state.highlightHoverTimer);
  $("highlightAnswerCard")?.classList.add("hidden");
  $("selectionBox").classList.add("hidden");
  $("selectionBox").classList.remove("below-selection");
  $("selectionBox").style.removeProperty("left");
  $("selectionBox").style.removeProperty("top");
  const sel = window.getSelection();
  if (sel) {
    sel.removeAllRanges();
  }
}

function buildSelectedText(snippets = state.selectedSnippets) {
  return snippets
    .map((item, index) => `[${selectionLabel(item, index)}]\n${item.text.trim()}`)
    .join("\n\n");
}

function formatLocalVisibleMessage(content, snippets, attachments = []) {
  const selectedText = buildSelectedText(snippets);
  const attachmentText = formatAttachmentVisibleText(attachments);
  const text = selectedText
    ? `${content}\n\n> 已添加论文选区：\n${selectedText}`
    : content;
  return `${text || ""}${attachmentText}`.trim();
}

function formatAttachmentVisibleText(attachments) {
  if (!attachments.length) return "";
  const rows = attachments.map((item) => `> - ${item.name} (${item.mime || "文件"}, ${formatBytes(item.size)})`);
  return `\n\n> 附件记录（临时副本会在 Codex 成功处理后清理）：\n${rows.join("\n")}`;
}

function isImageAttachmentItem(item) {
  return String(item?.mime || "").startsWith("image/");
}

function addAttachmentFiles(fileList, source = "file") {
  const incoming = [...fileList].filter(Boolean);
  if (!incoming.length) return;
  const accepted = [];
  for (const rawFile of incoming) {
    if (state.pendingAttachments.length + accepted.length >= MAX_MESSAGE_ATTACHMENTS) {
      toast(`一次最多添加 ${MAX_MESSAGE_ATTACHMENTS} 个附件`);
      break;
    }
    const file = normalizeAttachmentFile(rawFile);
    if (file.size > MAX_MESSAGE_ATTACHMENT_BYTES) {
      toast(`${file.name} 超过 20MB，已跳过`, 7000);
      continue;
    }
    const duplicate = [...state.pendingAttachments, ...accepted].some(
      (item) => item.name === file.name && item.size === file.size && item.mime === (file.type || "application/octet-stream")
    );
    if (duplicate) continue;
    accepted.push({
      id: makeId(),
      file,
      name: file.name,
      mime: file.type || "application/octet-stream",
      size: file.size,
      source,
    });
  }
  if (!accepted.length) return;
  state.pendingAttachments = [...state.pendingAttachments, ...accepted];
  renderAttachments();
  saveActiveConversationDraft();
  toast(`已添加 ${accepted.length} 个附件`);
}

function normalizeAttachmentFile(file) {
  if (file.name) return file;
  const ext = extensionForMime(file.type);
  try {
    return new File([file], `pasted-${Date.now()}${ext}`, { type: file.type || "application/octet-stream" });
  } catch {
    file.name = `pasted-${Date.now()}${ext}`;
    return file;
  }
}

function extensionForMime(mime = "") {
  const map = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
  };
  return map[mime] || "";
}

function renderAttachments() {
  const tray = $("attachmentTray");
  if (!tray) return;
  tray.classList.toggle("hidden", !state.pendingAttachments.length);
  if (!state.pendingAttachments.length) {
    tray.innerHTML = "";
    updateButtons();
    return;
  }
  tray.innerHTML = state.pendingAttachments
    .map((item) => {
      const isImage = isImageAttachmentItem(item);
      const transport = isImage ? "--image" : "@file";
      const title = isImage
        ? "图片将通过 Codex CLI --image 发送；成功处理后只保留历史记录。"
        : "文件将通过 Codex 风格 @file 路径发送；成功处理后只保留历史记录。";
      return `
      <div class="attachment-chip ${isImage ? "image" : "file"}" data-attachment-id="${escapeHtml(item.id)}" title="${escapeHtml(title)}">
        <span class="attachment-glyph" aria-hidden="true"></span>
        <span class="attachment-main">
          <strong title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong>
          <small>${transport} · 临时 · ${formatBytes(item.size)}</small>
        </span>
        <button class="remove-attachment-btn" type="button" aria-label="移除 ${escapeHtml(item.name)}" title="移除"></button>
      </div>
    `;
    })
    .join("");
  updateButtons();
}

function removeAttachment(id, options = {}) {
  state.pendingAttachments = state.pendingAttachments.filter((item) => item.id !== id);
  renderAttachments();
  if (options.persist !== false) saveActiveConversationDraft();
}

function clearAttachments(options = {}) {
  state.pendingAttachments = [];
  renderAttachments();
  if (options.persist !== false) saveActiveConversationDraft();
}

async function buildAttachmentPayload(attachments) {
  const payload = [];
  for (const item of attachments) {
    payload.push({
      filename: item.name,
      mime: item.mime,
      data_base64: await fileToBase64(item.file),
    });
  }
  return payload;
}

function selectionLabel(item, index) {
  return `选区 ${index + 1}${item.page ? ` · 第 ${item.page} 页` : ""}`;
}

function compactText(value, limit = 120) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value > 10 * 1024 ? 0 : 1)} KB`;
  return `${(value / 1024 / 1024).toFixed(value > 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function makeId() {
  return window.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function updateButtons() {
  const stopMode = shouldComposerButtonStop();
  const activeTask = state.activeConversation ? activeTaskForConversation(state.activeConversation.id) : null;
  $("sendBtn").classList.toggle("send-stop", stopMode);
  $("sendBtn").disabled = stopMode ? activeTask?.status === "canceling" : state.busy || !composerHasPayload();
  $("sendBtn").setAttribute("aria-label", stopMode ? "停止当前任务" : "发送");
  $("sendBtn").setAttribute("title", stopMode ? "停止当前任务" : "发送");
  $("initializeBtn").disabled = state.busy || !state.activePaper;
  updateContextHint();
  renderSendPreview();
  showActiveWorkStatus();
}

function updateContextHint() {
  const paper = state.activePaper ? `论文：${state.activePaper.title}` : "论文：未选择";
  const conv = state.activeConversation ? `对话：${state.activeConversation.title}` : "对话：自动创建";
  const session = state.activeConversation?.codex_session_id ? "session resume" : "session new";
  updateChatTitle();
  $("contextHint").textContent = `当前上下文：${paper} · ${conv} · ${session}`;
}

function updateChatTitle() {
  const title = state.activeConversation?.title || "新对话";
  $("chatTitle").textContent = title;
  $("chatTitle").title = title;
}

function showActiveWorkStatus() {
  const task = state.activeConversation ? activeTaskForConversation(state.activeConversation.id) : null;
  $("workStatusText").textContent = task
    ? `${taskStatusText(task.status)} ${formatTaskElapsed(task)} · ${task.label}`
    : "Codex 正在处理...";
  $("workStatus").classList.toggle("hidden", !task);
}

function renderSendPreview() {
  const box = $("sendPreview");
  if (!box) return;
  if (!composerHasPayload()) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  const imageCount = state.pendingAttachments.filter(isImageAttachmentItem).length;
  const fileCount = state.pendingAttachments.length - imageCount;
  const parts = [
    state.activeConversation ? state.activeConversation.title : "自动创建对话",
    state.activeConversation?.codex_session_id ? "resume" : "new session",
  ];
  if (state.activePaper) parts.push(state.activePaper.title);
  if (state.selectedSnippets.length) parts.push(`选区 ${state.selectedSnippets.length}`);
  if (imageCount) parts.push(`--image ${imageCount}`);
  if (fileCount) parts.push(`@file ${fileCount}`);
  box.innerHTML = `
    <span class="send-preview-label">将发送</span>
    ${parts.map((part) => `<span class="send-preview-pill">${escapeHtml(part)}</span>`).join("")}
  `;
  box.classList.remove("hidden");
}

function formatTaskElapsed(task) {
  const start = Date.parse(task.created_at || task.updated_at || "");
  if (!Number.isFinite(start)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.split(",")[1] : result);
    };
    reader.onerror = () => reject(reader.error || new Error("File read failed."));
    reader.readAsDataURL(file);
  });
}

function scrollMessages() {
  const box = $("messages");
  box.scrollTop = box.scrollHeight;
  saveCurrentConversationPosition();
}

function resetShellScroll() {
  window.scrollTo(0, 0);
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
}

function shortSource(source) {
  if (!source) return "";
  if (source.startsWith("http")) return source;
  const parts = source.split(/[\\/]+/);
  return parts.slice(-3).join("/");
}

function formatRecentOpenedTime(value) {
  const diff = Math.max(0, Date.now() - Number(value || 0));
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return formatDate(value);
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function applyPanelState({ persist = false } = {}) {
  const compactLayout = window.innerWidth <= 940;
  const sidebarCollapsed = state.sidebarCollapsed && !compactLayout;
  const chatCollapsed = state.chatCollapsed && !compactLayout;
  document.body.classList.toggle("sidebar-collapsed", sidebarCollapsed);
  document.body.classList.toggle("chat-collapsed", chatCollapsed);
  const collapseSidebarBtn = $("collapseSidebarBtn");
  const expandSidebarBtn = $("expandSidebarBtn");
  const collapseChatBtn = $("collapseChatBtn");
  const expandChatBtn = $("expandChatBtn");
  if (collapseSidebarBtn) {
    collapseSidebarBtn.setAttribute("aria-expanded", String(!sidebarCollapsed));
  }
  if (expandSidebarBtn) {
    expandSidebarBtn.setAttribute("aria-expanded", String(!sidebarCollapsed));
  }
  if (collapseChatBtn) {
    collapseChatBtn.setAttribute("aria-expanded", String(!chatCollapsed));
  }
  if (expandChatBtn) {
    expandChatBtn.setAttribute("aria-expanded", String(!chatCollapsed));
  }
  if (persist) {
    localStorage.setItem("paperCodexSidebarCollapsed", String(state.sidebarCollapsed));
    localStorage.setItem("paperCodexChatCollapsed", String(state.chatCollapsed));
  }
}

function setSidebarCollapsed(collapsed) {
  state.sidebarCollapsed = Boolean(collapsed);
  applyPanelState({ persist: true });
  applyChatWidth(state.chatWidth);
  rerenderPdfSoon();
}

function setChatCollapsed(collapsed) {
  state.chatCollapsed = Boolean(collapsed);
  applyPanelState({ persist: true });
  if (!state.chatCollapsed) {
    applyChatWidth(state.chatWidth);
  }
  rerenderPdfSoon();
}

function chatWidthBounds() {
  if (window.innerWidth <= 940) {
    return { min: 320, max: 520 };
  }
  const sidebarWidth = document.querySelector(".sidebar")?.getBoundingClientRect().width || 282;
  const minReaderWidth = window.innerWidth <= 1240 ? 420 : 480;
  const max = Math.max(360, window.innerWidth - sidebarWidth - minReaderWidth - 8);
  return { min: 320, max };
}

function applyChatWidth(width, { persist = false } = {}) {
  const { min, max } = chatWidthBounds();
  const nextWidth = Math.round(clamp(Number(width) || 440, min, max));
  state.chatWidth = nextWidth;
  document.documentElement.style.setProperty("--chat-width", `${nextWidth}px`);
  const resizer = $("chatResizer");
  if (resizer) {
    resizer.setAttribute("aria-valuemin", String(min));
    resizer.setAttribute("aria-valuemax", String(max));
    resizer.setAttribute("aria-valuenow", String(nextWidth));
  }
  if (persist) {
    localStorage.setItem("paperCodexChatWidth", String(nextWidth));
  }
  return nextWidth;
}

function setupChatResizer() {
  const resizer = $("chatResizer");
  if (!resizer) return;
  applyChatWidth(state.chatWidth);
  resizer.addEventListener("pointerdown", (event) => {
    if (window.innerWidth <= 940 || state.chatCollapsed) return;
    event.preventDefault();
    resizer.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing-chat");
  });
  resizer.addEventListener("pointermove", (event) => {
    if (!document.body.classList.contains("resizing-chat")) return;
    applyChatWidth(window.innerWidth - event.clientX);
    rerenderPdfSoon();
  });
  resizer.addEventListener("pointerup", (event) => {
    if (!document.body.classList.contains("resizing-chat")) return;
    resizer.releasePointerCapture(event.pointerId);
    document.body.classList.remove("resizing-chat");
    applyChatWidth(state.chatWidth, { persist: true });
    rerenderPdfSoon();
  });
  resizer.addEventListener("pointercancel", () => {
    document.body.classList.remove("resizing-chat");
    applyChatWidth(state.chatWidth, { persist: true });
  });
  resizer.addEventListener("keydown", (event) => {
    if (state.chatCollapsed) return;
    const step = event.shiftKey ? 64 : 24;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      applyChatWidth(state.chatWidth + step, { persist: true });
      rerenderPdfSoon();
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      applyChatWidth(state.chatWidth - step, { persist: true });
      rerenderPdfSoon();
    } else if (event.key === "Home") {
      event.preventDefault();
      applyChatWidth(chatWidthBounds().min, { persist: true });
      rerenderPdfSoon();
    } else if (event.key === "End") {
      event.preventDefault();
      applyChatWidth(chatWidthBounds().max, { persist: true });
      rerenderPdfSoon();
    }
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function bindEvents() {
  setupMermaid();
  setupChatResizer();
  renderPromptTemplates();
  $("collapseSidebarBtn").addEventListener("click", () => setSidebarCollapsed(true));
  $("expandSidebarBtn").addEventListener("click", () => setSidebarCollapsed(false));
  $("collapseChatBtn").addEventListener("click", () => setChatCollapsed(true));
  $("expandChatBtn").addEventListener("click", () => setChatCollapsed(false));
  $("prevAnswerBtn").addEventListener("click", () => jumpAnswer(-1));
  $("nextAnswerBtn").addEventListener("click", () => jumpAnswer(1));
  $("queueToggleBtn").addEventListener("click", toggleQueuePanel);
  populateModelSelects();
  $("openLibraryBtn").addEventListener("click", () => $("libraryDialog").showModal());
  $("paperSearchInput").addEventListener("input", (event) => {
    state.libraryQuery = event.target.value;
    renderPapers();
  });
  $("paperSortInput").addEventListener("change", (event) => {
    state.librarySort = event.target.value;
    renderPapers();
  });
  $("recentPaperSwitcher").addEventListener("mouseenter", () => {
    $("recentPaperTrigger").setAttribute("aria-expanded", "true");
  });
  $("recentPaperSwitcher").addEventListener("mouseleave", () => {
    if (!$("recentPaperSwitcher").classList.contains("open")) {
      $("recentPaperTrigger").setAttribute("aria-expanded", "false");
    }
  });
  $("recentPaperTrigger").addEventListener("click", (event) => {
    event.stopPropagation();
    const open = !$("recentPaperSwitcher").classList.contains("open");
    $("recentPaperSwitcher").classList.toggle("open", open);
    $("recentPaperTrigger").setAttribute("aria-expanded", String(open));
  });
  $("recentPaperMenu").addEventListener("click", (event) => {
    const item = event.target.closest(".recent-paper-item");
    if (!item?.dataset.paperId) return;
    $("recentPaperSwitcher").classList.remove("open");
    $("recentPaperTrigger").setAttribute("aria-expanded", "false");
    selectPaper(item.dataset.paperId).catch((error) => toast(error.message, 7000));
  });
  $("outlineSwitcher").addEventListener("mouseenter", () => {
    $("outlineTrigger").setAttribute("aria-expanded", "true");
  });
  $("outlineSwitcher").addEventListener("mouseleave", () => {
    if (!$("outlineSwitcher").classList.contains("open")) {
      $("outlineTrigger").setAttribute("aria-expanded", "false");
    }
  });
  $("outlineTrigger").addEventListener("click", (event) => {
    event.stopPropagation();
    const open = !$("outlineSwitcher").classList.contains("open");
    $("outlineSwitcher").classList.toggle("open", open);
    $("outlineTrigger").setAttribute("aria-expanded", String(open));
  });
  $("outlineMenu").addEventListener("click", (event) => {
    const item = event.target.closest(".outline-item");
    if (!item?.dataset.outlineIndex) return;
    $("outlineSwitcher").classList.remove("open");
    $("outlineTrigger").setAttribute("aria-expanded", "false");
    openOutlineItem(item.dataset.outlineIndex);
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest("#recentPaperSwitcher")) {
      $("recentPaperSwitcher").classList.remove("open");
      $("recentPaperTrigger").setAttribute("aria-expanded", "false");
    }
    if (event.target.closest("#outlineSwitcher")) return;
    $("outlineSwitcher").classList.remove("open");
    $("outlineTrigger").setAttribute("aria-expanded", "false");
  });
  $("zoomOutBtn").addEventListener("click", () => zoomBy(1 / 1.15));
  $("zoomInBtn").addEventListener("click", () => zoomBy(1.15));
  $("zoomFitBtn").addEventListener("click", () => setZoomMode("fit"));
  $("zoomActualBtn").addEventListener("click", () => setZoomMode("actual"));
  $("chooseFileBtn").addEventListener("click", () => $("paperFileInput").click());
  $("paperFileInput").addEventListener("change", () => {
    state.selectedFiles = [...($("paperFileInput").files || [])];
    updateChosenPaperFiles();
    $("paperFileInput").value = "";
    if (state.selectedFiles.length) {
      importPaper({ filesOnly: true });
    }
  });
  $("importPaperBtn").addEventListener("click", importPaper);
  $("initializeBtn").addEventListener("click", initializeConversation);
  $("sendBtn").addEventListener("click", handleComposerAction);
  $("cancelResendEditBtn").addEventListener("click", cancelResendEdit);
  $("attachFileBtn").addEventListener("click", () => $("messageAttachmentInput").click());
  $("messageAttachmentInput").addEventListener("change", () => {
    addAttachmentFiles($("messageAttachmentInput").files, "picker");
    $("messageAttachmentInput").value = "";
  });
  $("attachmentTray").addEventListener("click", (event) => {
    const button = event.target.closest(".remove-attachment-btn");
    if (!button) return;
    const item = button.closest(".attachment-chip");
    if (item?.dataset.attachmentId) {
      removeAttachment(item.dataset.attachmentId);
    }
  });
  $("slashMenu").addEventListener("click", (event) => {
    const item = event.target.closest(".slash-item");
    if (item?.dataset.promptId) {
      usePromptTemplate(item.dataset.promptId);
    }
  });
  $("slashMenu").addEventListener("pointerover", (event) => {
    const item = event.target.closest(".slash-item");
    if (!item || item.dataset.slashIndex === undefined) return;
    state.slashMenuIndex = Number(item.dataset.slashIndex) || 0;
    updateSlashMenuActive();
  });
  $("messageInput").addEventListener("input", () => {
    saveActiveConversationDraft();
    state.slashMenuIndex = 0;
    updateButtons();
    renderSlashMenuFromInput();
  });
  $("messageInput").addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.files || [])];
    if (!files.length) return;
    event.preventDefault();
    addAttachmentFiles(files, "paste");
  });
  $("messageInput").addEventListener("compositionstart", () => {
    state.composingMessage = true;
  });
  $("messageInput").addEventListener("compositionend", () => {
    state.composingMessage = false;
    saveActiveConversationDraft();
  });
  $("messageInput").addEventListener("keydown", (event) => {
    if (event.isComposing || state.composingMessage || event.keyCode === 229) {
      return;
    }
    if (isSlashMenuOpen() && ["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      moveSlashMenuSelection(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (isSlashMenuOpen() && event.key === "Enter") {
      event.preventDefault();
      selectSlashPromptByIndex();
      return;
    }
    if (event.key === "Escape") {
      if (isSlashMenuOpen()) closeSlashMenu();
      clearSelection();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      sendMessageFromKeyboard();
    }
  });
  $("messageInput").addEventListener("keyup", (event) => {
    if (event.key === "Enter" && Date.now() <= state.composerFocusUntil) {
      focusMessageInput();
    }
  });
  $("messageInput").addEventListener("blur", () => {
    if (Date.now() > state.composerFocusUntil) return;
    window.setTimeout(() => {
      const active = document.activeElement;
      const composer = $("composer");
      const focusMovedInsideComposer = active && composer.contains(active) && active !== document.body;
      if (!focusMovedInsideComposer) {
        focusMessageInput();
      }
    }, 0);
  });
  $("messages").addEventListener("scroll", scheduleConversationPositionSave, { passive: true });
  $("composer").addEventListener("dragover", (event) => {
    if (![...(event.dataTransfer?.items || [])].some((item) => item.kind === "file")) return;
    event.preventDefault();
    $("composer").classList.add("dragging-attachments");
  });
  $("composer").addEventListener("dragleave", (event) => {
    if ($("composer").contains(event.relatedTarget)) return;
    $("composer").classList.remove("dragging-attachments");
  });
  $("composer").addEventListener("drop", (event) => {
    const files = [...(event.dataTransfer?.files || [])];
    if (!files.length) return;
    event.preventDefault();
    $("composer").classList.remove("dragging-attachments");
    addAttachmentFiles(files, "drop");
  });
  $("pdfViewer").addEventListener("mouseup", () => window.setTimeout(handleSelection, 20));
  $("pdfViewer").addEventListener("scroll", () => {
    scheduleSelectionBoxSync();
    scheduleReadingPositionSave();
  }, { passive: true });
  window.addEventListener("resize", scheduleSelectionBoxSync);
  $("selectionBox").addEventListener("mousedown", (event) => event.preventDefault());
  $("selectionBox").addEventListener("pointerenter", () => window.clearTimeout(state.highlightHoverTimer));
  $("selectionBox").addEventListener("pointerleave", () => {
    if (state.selectionSource === "highlight") scheduleHighlightClear();
  });
  $("highlightAnswerCard").addEventListener("pointerenter", () => window.clearTimeout(state.highlightHoverTimer));
  $("highlightAnswerCard").addEventListener("pointerleave", () => {
    if (state.selectionSource === "highlight") scheduleHighlightClear();
  });
  $("highlightAnswerCard").addEventListener("submit", saveHighlightNote);
  $("highlightAnswerCard").addEventListener("click", (event) => {
    if (event.target.closest(".delete-highlight-btn")) {
      deleteActiveHighlight();
    }
  });
  $("highlightAnswerCard").addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      const form = event.target.closest(".highlight-note-form");
      if (form) saveHighlightNote(event);
    }
  });
  $("addSelectionBtn").addEventListener("click", addSelectionToConversation);
  $("sendSelectionBtn").addEventListener("click", sendSelectionImmediately);
  $("highlightSelectionBtn").addEventListener("click", openHighlightPalette);
  $("highlightSelectionBtn").addEventListener("dblclick", () => {
    closeHighlightPalette();
    createHighlightFromSelection("yellow");
  });
  $("highlightPalette").addEventListener("click", (event) => {
    const button = event.target.closest(".highlight-color-btn");
    if (button?.dataset.highlightColor) {
      closeHighlightPalette();
      createHighlightFromSelection(button.dataset.highlightColor);
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!state.highlightPaletteOpen) return;
    if ($("selectionBox").contains(event.target)) return;
    closeHighlightPalette();
  });
  $("clearContextBtn").addEventListener("click", clearConversationSelections);
  $("contextList").addEventListener("click", (event) => {
    const button = event.target.closest(".remove-context-btn");
    if (button) {
      removeSelectedContext(button.dataset.contextId);
    }
  });
  $("addPromptBtn").addEventListener("click", () => openPromptForm());
  $("promptForm").addEventListener("submit", savePromptTemplate);
  $("cancelPromptBtn").addEventListener("click", closePromptForm);
  $("taskEditForm").addEventListener("submit", saveTaskEdit);
  $("cancelTaskEditBtn").addEventListener("click", closeTaskEditor);
  $("discardTaskEditBtn").addEventListener("click", closeTaskEditor);
  $("codexLoginBtn").addEventListener("click", startCodexLogin);
  $("codexLogoutBtn").addEventListener("click", logoutCodex);
  $("settingsBtn").addEventListener("click", () => $("settingsDialog").showModal());
  $("closeMermaidPreviewBtn").addEventListener("click", closeMermaidPreview);
  $("mermaidPreviewDialog").addEventListener("close", resetMermaidPreview);
  $("mermaidPreviewDialog").addEventListener("keydown", handleMermaidPreviewKeydown);
  $("mermaidPreviewBody").addEventListener("wheel", handleMermaidPreviewWheel, { passive: false });
  $("saveConversationTitleBtn").addEventListener("click", saveConversationTitle);
  $("savePaperTitleBtn").addEventListener("click", savePaperTitle);
  $("activePaperTitle").addEventListener("dblclick", openActivePaperRename);
  $("activePaperTitle").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== "F2") return;
    event.preventDefault();
    openActivePaperRename();
  });
  $("renameConversationInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      saveConversationTitle();
    }
  });
  $("renamePaperInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      savePaperTitle();
    }
  });
  $("quickModelInput").addEventListener("change", () => {
    handleModelChange("quickModelInput", "quickCustomModelInput");
    if ($("quickModelInput").value !== "__custom__") {
      saveQuickSettings();
    }
  });
  $("quickCustomModelInput").addEventListener("change", saveQuickSettings);
  $("quickCustomModelInput").addEventListener("blur", () => {
    if ($("quickCustomModelInput").value.trim()) {
      saveQuickSettings();
    }
  });
  $("modelInput").addEventListener("change", () => handleModelChange("modelInput", "customModelInput"));
  $("quickReasoningInput").addEventListener("change", saveQuickSettings);
  $("saveSettingsBtn").addEventListener("click", async (event) => {
    event.preventDefault();
    await saveSettings();
    $("settingsDialog").close();
  });
  updateComposerMode();
}

bindEvents();
window.addEventListener("resize", () => {
  applyPanelState();
  applyChatWidth(state.chatWidth, { persist: true });
  rerenderPdfSoon();
});
window.addEventListener("keydown", handleGlobalShortcuts);
window.addEventListener("beforeunload", saveCurrentReadingPosition);
loadInitialData().catch((error) => toast(error.message, 7000));
