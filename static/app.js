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

const state = {
  papers: [],
  conversations: [],
  activePaper: null,
  activeConversation: null,
  selectedText: "",
  selectedPage: null,
  selectedSnippets: [],
  selectedFile: null,
  settings: {},
  busy: false,
  pending: {},
  tasks: [],
  taskStatuses: {},
  pdfDoc: null,
  pdfUrl: "",
  pdfRenderToken: 0,
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
  promptTemplates: loadPromptTemplates(),
  editingPromptId: null,
  selectionPositionFrame: 0,
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
  if (state.activeConversation) {
    await selectConversation(state.activeConversation.id);
  }
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
  $("chunkInput").value = state.settings.paper_chunk_chars || "18000";
  $("timeoutInput").value = state.settings.codex_timeout_seconds || "600";
  $("quickReasoningInput").value = state.settings.reasoning_effort || "high";
}

async function saveSettings() {
  const payload = {
    codex_path: $("codexPathInput").value.trim(),
    model: selectedModelValue("modelInput", "customModelInput"),
    reasoning_effort: $("reasoningInput").value,
    verbosity: $("verbosityInput").value,
    paper_chunk_chars: $("chunkInput").value,
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

async function loadStatus() {
  const status = await api("/api/status");
  const login = status.login_ok ? "已登录" : "未确认登录";
  $("codexStatus").innerHTML = `
    <strong>${escapeHtml(login)}</strong>
    <span>${escapeHtml(status.version || status.version_error || "未找到版本")}</span>
  `;
}

async function loadPapers() {
  state.papers = await api("/api/papers");
  renderPapers();
  if (!state.activePaper && state.papers.length) {
    await selectPaper(state.papers[0].id);
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
    list.appendChild(item);
  }
  if (!state.papers.length) {
    list.innerHTML = `<div class="list-empty">还没有论文，可以先导入一个 PDF。</div>`;
  } else if (!papers.length) {
    list.innerHTML = `<div class="list-empty">没有匹配的论文。</div>`;
  }
  renderPaperDetail();
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
    </div>
  `;
  $("openSelectedPaperBtn").addEventListener("click", () => openLibraryPaper(paper.id, false));
  $("newSelectedPaperConversationBtn").addEventListener("click", () => openLibraryPaper(paper.id, true));
  $("renameSelectedPaperBtn").addEventListener("click", () => openRenamePaper(paper.id));
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
    renderConversations();
    updateContextHint();
    $("renamePaperDialog").close();
    toast("论文名称已更新");
  } catch (error) {
    toast(error.message, 7000);
  }
}

async function importPaper() {
  const source = $("paperSourceInput").value.trim();
  const title = $("paperTitleInput").value.trim();
  if (!source && !state.selectedFile) {
    toast("请选择 PDF，或输入 PDF 本地路径/链接");
    return;
  }
  let payload = null;
  setBusy(true, "正在导入论文...");
  try {
    if (state.selectedFile) {
      const dataBase64 = await fileToBase64(state.selectedFile);
      payload = {
        filename: state.selectedFile.name,
        data_base64: dataBase64,
        title,
      };
    } else {
      payload = source.startsWith("http://") || source.startsWith("https://")
        ? { url: source, title }
        : { path: source, title };
    }
    const paper = await api("/api/papers/import", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    $("paperSourceInput").value = "";
    $("paperTitleInput").value = "";
    state.selectedFile = null;
    $("paperFileInput").value = "";
    $("chosenFileName").textContent = "也可以粘贴 PDF 链接或本地路径";
    await loadPapers();
    await selectPaper(paper.id);
    $("libraryDialog").close();
    toast("论文已导入");
  } catch (error) {
    toast(error.message, 7000);
  } finally {
    setBusy(false);
  }
}

async function selectPaper(paperId) {
  resetShellScroll();
  clearConversationSelections();
  state.activePaper = state.papers.find((paper) => paper.id === paperId) || null;
  state.selectedLibraryPaperId = state.activePaper?.id || state.selectedLibraryPaperId;
  renderPapers();
  renderConversations();
  $("activePaperTitle").textContent = state.activePaper ? state.activePaper.title : "未选择论文";
  $("activeConversationTitle").textContent = state.activeConversation ? ` · ${state.activeConversation.title}` : "";
  clearSelection();
  if (state.activePaper) {
    await renderPdf(`/api/papers/${state.activePaper.id}/file`);
  } else {
    state.pdfDoc = null;
    state.pdfUrl = "";
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

async function loadConversations() {
  state.conversations = await api("/api/conversations");
  if (state.activeConversation) {
    state.activeConversation = state.conversations.find((conv) => conv.id === state.activeConversation.id) || null;
  }
  renderConversations();
  updateContextHint();
}

function renderConversations() {
  const list = $("conversationsList");
  list.innerHTML = "";
  if (!state.conversations.length) {
    list.innerHTML = `
      <div class="list-empty">
        还没有对话。直接在右侧发送问题，或点“新建”开始。
      </div>
    `;
    return;
  }
  for (const group of conversationGroups()) {
    const isCollapsed = Boolean(state.collapsedConversationGroups[group.key]);
    const hasActiveConversation = group.conversations.some((conv) => conv.id === state.activeConversation?.id);
    const hasRunningTask = group.conversations.some((conv) => activeTaskForConversation(conv.id));
    const section = document.createElement("section");
    section.className = `conversation-folder${hasActiveConversation ? " active" : ""}${hasRunningTask ? " running" : ""}`;
    section.innerHTML = `
      <button class="folder-toggle" type="button" aria-expanded="${String(!isCollapsed)}">
        <span class="folder-chevron${isCollapsed ? " collapsed" : ""}" aria-hidden="true"></span>
        <span class="folder-title">${escapeHtml(group.title)}</span>
        <span class="folder-count">${group.conversations.length}</span>
      </button>
      <div class="folder-children${isCollapsed ? " hidden" : ""}"></div>
    `;
    section.querySelector(".folder-toggle").addEventListener("click", () => toggleConversationGroup(group.key));
    const children = section.querySelector(".folder-children");
    for (const conv of group.conversations) {
      children.appendChild(renderConversationItem(conv));
    }
    list.appendChild(section);
  }
}

function conversationGroups() {
  const groups = [];
  const byKey = new Map();
  for (const conv of state.conversations) {
    const key = conv.paper_id ? `paper:${conv.paper_id}` : "paper:none";
    if (!byKey.has(key)) {
      const group = {
        key,
        title: conv.paper_title || (conv.paper_id ? "已删除论文" : "空对话"),
        conversations: [],
      };
      groups.push(group);
      byKey.set(key, group);
    }
    byKey.get(key).conversations.push(conv);
  }
  return groups;
}

function renderConversationItem(conv) {
  const item = document.createElement("div");
  item.className = "list-item conversation-item" + (state.activeConversation?.id === conv.id ? " active" : "");
  const subtitle = conv.paper_title ? conv.paper_title : "无绑定论文";
  const pending = activeTaskForConversation(conv.id);
  item.innerHTML = `
    <div class="list-title-row">
      <strong>${escapeHtml(conv.title)}</strong>
      <span class="conversation-actions">
        ${pending ? `<span class="running-badge">${escapeHtml(taskStatusText(pending.status))}</span>` : ""}
        <button class="rename-conversation-btn" type="button" data-conversation-id="${escapeHtml(conv.id)}">改名</button>
        <button class="delete-conversation-btn" type="button" data-conversation-id="${escapeHtml(conv.id)}">删除</button>
      </span>
    </div>
    <div class="meta">${escapeHtml(pending ? pending.label : subtitle)}</div>
  `;
  item.addEventListener("click", () => selectConversation(conv.id));
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
    if (state.activeConversation?.id === conversationId) {
      state.activeConversation = null;
      $("activeConversationTitle").textContent = "";
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

async function newConversation() {
  const payload = {
    paper_id: state.activePaper ? state.activePaper.id : null,
  };
  const conv = await api("/api/conversations", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  await loadConversations();
  await selectConversation(conv.id);
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

async function selectConversation(convId) {
  clearConversationSelections();
  clearSelection();
  state.activeConversation = state.conversations.find((conv) => conv.id === convId) || null;
  renderConversations();
  $("activeConversationTitle").textContent = state.activeConversation
    ? ` · ${state.activeConversation.title}`
    : "";
  await loadMessages();
  updateContextHint();
  updateButtons();
}

async function loadMessages() {
  const box = $("messages");
  box.innerHTML = "";
  if (!state.activeConversation) {
    box.innerHTML = `
      <div class="empty-state">
        <h2>可以直接开始</h2>
        <p>右下角输入问题会自动创建当前论文对话。想先让 Codex 读完整篇，就点“读全文”。</p>
      </div>
    `;
    return;
  }
  const messages = await api(`/api/conversations/${state.activeConversation.id}/messages`);
  for (const msg of messages) {
    appendMessage(msg.role, msg.content);
  }
  const active = activeTaskForConversation(state.activeConversation.id);
  if (active) {
    appendTaskPlaceholder(active);
  }
  scrollMessages();
}

function appendMessage(role, content) {
  const box = $("messages");
  const node = document.createElement("div");
  node.className = `message ${role}`;
  node.innerHTML = `
    <div class="role">${role === "user" ? "你" : "Codex"}</div>
    <pre>${escapeHtml(content)}</pre>
  `;
  box.appendChild(node);
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
  const selectedText = buildSelectedText(snippets);
  if (!content && !selectedText) {
    toast("请输入问题，或先添加一段论文选区");
    return;
  }
  await ensureConversation();
  const convId = state.activeConversation.id;
  const payload = {
    content,
    selected_text: selectedText,
    paper_id: state.activePaper ? state.activePaper.id : null,
  };
  $("messageInput").value = "";
  const localVisible = formatLocalVisibleMessage(content, snippets);
  appendMessage("user", localVisible);
  clearSelection();
  scrollMessages();
  try {
    await api(`/api/conversations/${convId}/messages`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    await loadConversations();
    await loadTasks({ silent: true });
    updateContextHint();
    clearConversationSelections();
    toast("问题已加入队列");
  } catch (error) {
    if (state.activeConversation?.id === convId) {
      appendMessage("assistant", `出错了：${error.message}`);
    }
    toast(error.message, 9000);
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
      await loadMessages();
    }
    for (const task of changedToFinal) {
      if (!silent && task.status === "error") {
        toast(task.error || "Codex 任务失败", 9000);
      }
    }
  }
}

function renderTasks() {
  const activeTasks = state.tasks.filter((task) => isActiveTask(task));
  $("queuePanel").classList.toggle("hidden", activeTasks.length === 0);
  $("queueCount").textContent = String(activeTasks.length);
  $("queueSummary").textContent = activeTasks.length ? `${activeTasks.length} 个任务运行或排队中` : "没有运行中的任务";
  const list = $("taskList");
  list.innerHTML = "";
  for (const task of activeTasks) {
    const conv = state.conversations.find((item) => item.id === task.conversation_id);
    const item = document.createElement("div");
    item.className = `task-item ${task.status}`;
    item.innerHTML = `
      <div>
        <strong>${escapeHtml(task.label || task.kind)}</strong>
        <span>${escapeHtml(taskStatusText(task.status))}${conv ? ` · ${escapeHtml(conv.title)}` : ""}</span>
      </div>
      <button class="small-btn danger-btn" type="button" data-task-id="${escapeHtml(task.id)}">取消</button>
    `;
    item.querySelector("button").addEventListener("click", () => cancelTask(task.id));
    list.appendChild(item);
  }
  updateButtons();
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
  node.innerHTML = `
    <div class="role">Codex · ${escapeHtml(taskStatusText(task.status))}</div>
    <pre>${escapeHtml(task.label || "正在处理")}</pre>
  `;
  box.appendChild(node);
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
  await renderPdfPages(token);
}

async function renderPdfPages(token = ++state.pdfRenderToken) {
  const viewer = $("pdfViewer");
  const pdf = state.pdfDoc;
  if (!pdf) return;
  const anchor = getPdfScrollAnchor();
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
    pageNode.replaceChildren(canvas, textLayer);
    pageNode.classList.remove("loading");

    await page.render({
      canvasContext: context,
      viewport,
      transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0],
    }).promise;
    if (token !== state.pdfRenderToken) return;
    const textContent = await page.getTextContent();
    await renderTextLayer(textContent, textLayer, viewport);
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

function setZoomMode(mode) {
  if (!state.pdfDoc) return;
  state.zoomMode = mode;
  if (mode === "actual") {
    state.zoomMode = "custom";
    state.zoom = 1;
  }
  renderPdfPages().catch((error) => toast(error.message, 7000));
}

function zoomBy(multiplier) {
  if (!state.pdfDoc) return;
  state.zoomMode = "custom";
  state.zoom = clamp((state.currentScale || state.zoom || 1) * multiplier, 0.45, 3);
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
  const tag = event.target?.tagName;
  const isEditing = ["INPUT", "TEXTAREA", "SELECT"].includes(tag) || event.target?.isContentEditable;
  if (isEditing) return;
  const key = event.key.toLowerCase();
  const withCommand = event.metaKey || event.ctrlKey;

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
  const box = $("selectionBox");
  const left = Math.min(Math.max(rect.left + rect.width / 2, visibleLeft + 18), visibleRight - 18);
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
  clearSelection();
  $("messageInput").focus();
  toast(`已添加 ${state.selectedSnippets.length} 处选区`);
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
}

function removeSelectedContext(id) {
  state.selectedSnippets = state.selectedSnippets.filter((item) => item.id !== id);
  renderSelectedContexts();
}

function clearConversationSelections() {
  state.selectedSnippets = [];
  renderSelectedContexts();
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
  $("messageInput").focus();
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
}

function clearSelection() {
  state.selectedText = "";
  state.selectedPage = null;
  if (state.selectionPositionFrame) {
    window.cancelAnimationFrame(state.selectionPositionFrame);
    state.selectionPositionFrame = 0;
  }
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

function formatLocalVisibleMessage(content, snippets) {
  const selectedText = buildSelectedText(snippets);
  if (!selectedText) return content;
  return content
    ? `${content}\n\n> 已添加论文选区：\n${selectedText}`
    : `解释已添加的论文选区：\n${selectedText}`;
}

function selectionLabel(item, index) {
  return `选区 ${index + 1}${item.page ? ` · 第 ${item.page} 页` : ""}`;
}

function compactText(value, limit = 120) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function makeId() {
  return window.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function updateButtons() {
  $("sendBtn").disabled = state.busy;
  $("initializeBtn").disabled = state.busy || !state.activePaper;
  updateContextHint();
  showActiveWorkStatus();
}

function updateContextHint() {
  const paper = state.activePaper ? `论文：${state.activePaper.title}` : "论文：未选择";
  const conv = state.activeConversation ? `对话：${state.activeConversation.title}` : "对话：自动创建";
  $("contextHint").textContent = `当前上下文：${paper} · ${conv}`;
}

function showActiveWorkStatus() {
  const task = state.activeConversation ? activeTaskForConversation(state.activeConversation.id) : null;
  $("workStatusText").textContent = task ? `${taskStatusText(task.status)}：${task.label}` : "Codex 正在处理...";
  $("workStatus").classList.toggle("hidden", !task);
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
  setupChatResizer();
  renderPromptTemplates();
  $("collapseSidebarBtn").addEventListener("click", () => setSidebarCollapsed(true));
  $("expandSidebarBtn").addEventListener("click", () => setSidebarCollapsed(false));
  $("collapseChatBtn").addEventListener("click", () => setChatCollapsed(true));
  $("expandChatBtn").addEventListener("click", () => setChatCollapsed(false));
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
  $("zoomOutBtn").addEventListener("click", () => zoomBy(1 / 1.15));
  $("zoomInBtn").addEventListener("click", () => zoomBy(1.15));
  $("zoomFitBtn").addEventListener("click", () => setZoomMode("fit"));
  $("zoomActualBtn").addEventListener("click", () => setZoomMode("actual"));
  $("chooseFileBtn").addEventListener("click", () => $("paperFileInput").click());
  $("paperFileInput").addEventListener("change", () => {
    state.selectedFile = $("paperFileInput").files[0] || null;
    $("chosenFileName").textContent = state.selectedFile ? state.selectedFile.name : "也可以粘贴 PDF 链接或本地路径";
  });
  $("importPaperBtn").addEventListener("click", importPaper);
  $("newConversationBtn").addEventListener("click", newConversation);
  $("initializeBtn").addEventListener("click", initializeConversation);
  $("sendBtn").addEventListener("click", sendMessage);
  $("messageInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });
  $("pdfViewer").addEventListener("mouseup", () => window.setTimeout(handleSelection, 20));
  $("pdfViewer").addEventListener("scroll", scheduleSelectionBoxSync, { passive: true });
  window.addEventListener("resize", scheduleSelectionBoxSync);
  $("addSelectionBtn").addEventListener("click", addSelectionToConversation);
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
  $("settingsBtn").addEventListener("click", () => $("settingsDialog").showModal());
  $("saveConversationTitleBtn").addEventListener("click", saveConversationTitle);
  $("savePaperTitleBtn").addEventListener("click", savePaperTitle);
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
}

bindEvents();
window.addEventListener("load", resetShellScroll);
window.addEventListener("resize", () => {
  applyPanelState();
  applyChatWidth(state.chatWidth, { persist: true });
  rerenderPdfSoon();
});
window.addEventListener("keydown", handleGlobalShortcuts);
loadInitialData().catch((error) => toast(error.message, 7000));
