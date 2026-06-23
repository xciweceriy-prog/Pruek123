/* =========================================================
   SMART FINANCE TRACKER — SCRIPT.JS
   Handles: state, CRUD, storage, charts, filters, theme, cloud sync
   ========================================================= */

// ---------------------------------------------------------
// CLOUD SYNC CONFIG
// ---------------------------------------------------------
// The Apps Script Web App URL is stored separately from app logic so it can
// be changed at runtime via the Cloud Settings modal without touching code.
// It persists in Local Storage under CONFIG_KEY. Leave empty to run fully
// offline (Local Storage only) — all CRUD features still work.
const CONFIG = {
  API_URL_STORAGE_KEY: "smartFinanceTracker_apiUrl",
  REQUEST_TIMEOUT_MS: 12000,   // abort a request if Apps Script doesn't respond in time
  SYNC_RETRY_DELAY_MS: 15000,  // wait before auto-retrying after a failed sync
};

function getApiUrl() {
  return (localStorage.getItem(CONFIG.API_URL_STORAGE_KEY) || "").trim();
}

function setApiUrl(url) {
  if (url) localStorage.setItem(CONFIG.API_URL_STORAGE_KEY, url);
  else localStorage.removeItem(CONFIG.API_URL_STORAGE_KEY);
}

function isCloudConfigured() {
  return getApiUrl().length > 0;
}

// ---------------------------------------------------------
// CONSTANTS & STATE
// ---------------------------------------------------------
const STORAGE_KEY = "smartFinanceTracker_transactions";
const PENDING_QUEUE_KEY = "smartFinanceTracker_pendingOps"; // queued ops created while offline
const THEME_KEY = "smartFinanceTracker_theme";

const CATEGORIES = {
  income: ["Salary", "Bonus", "Freelance", "Investment", "Other"],
  expense: ["Food", "Transport", "Shopping", "Entertainment", "Education", "Bills", "Other"],
};

let transactions = [];      // master array of transaction objects (local cache of truth)
let pendingOps = [];        // queue of { op: 'create'|'update'|'delete', payload } awaiting cloud sync
let editingId = null;       // id currently being edited (null = adding new)
let deleteTargetId = null;  // id pending delete confirmation
let syncState = "offline";  // "connected" | "syncing" | "offline" | "error"

// Chart instances (so we can destroy/redraw on update)
let pieChartInstance = null;
let barChartInstance = null;
let categoryPieInstance = null;
let monthlyTrendInstance = null;


// ---------------------------------------------------------
// DOM REFERENCES
// ---------------------------------------------------------
const el = (id) => document.getElementById(id);

const sidebar = el("sidebar");
const menuToggle = el("menuToggle");
const navItems = document.querySelectorAll(".nav-item");
const pageSections = document.querySelectorAll(".page-section");

const themeToggle = el("themeToggle");
const themeToggleMobile = el("themeToggleMobile");

const modalOverlay = el("modalOverlay");
const deleteModalOverlay = el("deleteModalOverlay");
const transactionForm = el("transactionForm");
const modalTitle = el("modalTitle");

const titleInput = el("titleInput");
const amountInput = el("amountInput");
const dateInput = el("dateInput");
const typeInput = el("typeInput");
const categoryInput = el("categoryInput");
const notesInput = el("notesInput");
const transactionIdInput = el("transactionId");

const searchInput = el("searchInput");
const filterType = el("filterType");
const sortOrder = el("sortOrder");
const tableBody = el("transactionTableBody");
const emptyState = el("emptyState");

const toast = el("toast");
const toastMessage = el("toastMessage");

const syncDot = el("syncDot");
const syncLabel = el("syncLabel");
const syncDotMobile = el("syncDotMobile");
const syncNowBtn = el("syncNowBtn");
const settingsModalOverlay = el("settingsModalOverlay");
const settingsForm = el("settingsForm");
const apiUrlInput = el("apiUrlInput");

// ---------------------------------------------------------
// INITIALIZATION
// ---------------------------------------------------------
document.addEventListener("DOMContentLoaded", async () => {
  loadTheme();
  loadTransactionsFromLocal();
  loadPendingQueue();
  populateCategoryOptions();
  setDefaultDate();
  renderAll();
  attachEventListeners();

  // Reflect current connection status immediately, then try a real sync.
  setSyncState(isCloudConfigured() ? "syncing" : "offline");
  if (isCloudConfigured()) {
    await loadTransactions(); // pulls fresh data from Sheets, falls back to local on failure
  }

  // Keep trying to flush queued offline changes whenever the browser regains connectivity.
  window.addEventListener("online", () => { if (isCloudConfigured()) syncData(); });
  window.addEventListener("offline", () => setSyncState("offline"));
});

// ---------------------------------------------------------
// LOCAL STORAGE HELPERS (offline backup — always kept in sync with `transactions`)
// ---------------------------------------------------------
function loadTransactionsFromLocal() {
  const stored = localStorage.getItem(STORAGE_KEY);
  transactions = stored ? JSON.parse(stored) : [];
}

function saveTransactionsToLocal() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(transactions));
}

function loadPendingQueue() {
  const stored = localStorage.getItem(PENDING_QUEUE_KEY);
  pendingOps = stored ? JSON.parse(stored) : [];
}

function savePendingQueue() {
  localStorage.setItem(PENDING_QUEUE_KEY, JSON.stringify(pendingOps));
}

function queueOp(op, payload) {
  pendingOps.push({ op, payload, queuedAt: Date.now() });
  savePendingQueue();
}

function loadTheme() {
  const savedTheme = localStorage.getItem(THEME_KEY);
  if (savedTheme === "dark") {
    document.body.classList.add("dark-mode");
    updateThemeIcons(true);
  }
}

function saveTheme() {
  const isDark = document.body.classList.contains("dark-mode");
  localStorage.setItem(THEME_KEY, isDark ? "dark" : "light");
}

// ---------------------------------------------------------
// EVENT LISTENERS
// ---------------------------------------------------------
function attachEventListeners() {
  // Sidebar navigation
  navItems.forEach((item) => {
    item.addEventListener("click", (e) => {
      e.preventDefault();
      switchSection(item.dataset.section);
      navItems.forEach((n) => n.classList.remove("active"));
      item.classList.add("active");
      sidebar.classList.remove("open");
    });
  });

  // Mobile menu toggle
  menuToggle.addEventListener("click", () => sidebar.classList.toggle("open"));

  // Theme toggle (desktop + mobile)
  themeToggle.addEventListener("click", toggleTheme);
  themeToggleMobile.addEventListener("click", toggleTheme);

  // Open add-transaction modal (two entry points: dashboard + transactions page)
  el("openAddModalBtn").addEventListener("click", () => openModal());
  el("openAddModalBtn2").addEventListener("click", () => openModal());

  // Modal close/cancel
  el("closeModalBtn").addEventListener("click", closeModal);
  el("cancelModalBtn").addEventListener("click", closeModal);
  modalOverlay.addEventListener("click", (e) => { if (e.target === modalOverlay) closeModal(); });

  // Type change -> repopulate category dropdown
  typeInput.addEventListener("change", () => populateCategoryOptions(typeInput.value));

  // Form submit
  transactionForm.addEventListener("submit", handleFormSubmit);

  // Delete modal
  el("closeDeleteModalBtn").addEventListener("click", closeDeleteModal);
  el("cancelDeleteBtn").addEventListener("click", closeDeleteModal);
  el("confirmDeleteBtn").addEventListener("click", confirmDelete);
  deleteModalOverlay.addEventListener("click", (e) => { if (e.target === deleteModalOverlay) closeDeleteModal(); });

  // Search & filters
  searchInput.addEventListener("input", renderTable);
  filterType.addEventListener("change", renderTable);
  sortOrder.addEventListener("change", renderTable);

  // Export CSV
  el("exportCsvBtn").addEventListener("click", exportToCSV);

  // Cloud sync controls
  syncNowBtn.addEventListener("click", () => syncData());
  el("openSettingsBtn").addEventListener("click", openSettingsModal);
  el("closeSettingsModalBtn").addEventListener("click", closeSettingsModal);
  settingsModalOverlay.addEventListener("click", (e) => { if (e.target === settingsModalOverlay) closeSettingsModal(); });
  settingsForm.addEventListener("submit", handleSettingsSubmit);
  el("clearApiUrlBtn").addEventListener("click", handleDisconnect);
}

// ---------------------------------------------------------
// SECTION SWITCHING (Dashboard / Transactions / Analytics)
// ---------------------------------------------------------
function switchSection(sectionId) {
  pageSections.forEach((sec) => sec.classList.add("hidden"));
  el(sectionId).classList.remove("hidden");

  // Redraw charts when their section becomes visible (canvas needs visible parent to size correctly)
  if (sectionId === "dashboard-section") renderDashboardCharts();
  if (sectionId === "analytics-section") renderAnalyticsCharts();
}

// ---------------------------------------------------------
// THEME TOGGLE
// ---------------------------------------------------------
function toggleTheme() {
  document.body.classList.toggle("dark-mode");
  const isDark = document.body.classList.contains("dark-mode");
  updateThemeIcons(isDark);
  saveTheme();
}

function updateThemeIcons(isDark) {
  const iconClass = isDark ? "fa-sun" : "fa-moon";
  const labelText = isDark ? "Light Mode" : "Dark Mode";
  themeToggle.innerHTML = `<i class="fa-solid ${iconClass}"></i> <span>${labelText}</span>`;
  themeToggleMobile.innerHTML = `<i class="fa-solid ${iconClass}"></i>`;
}

// ---------------------------------------------------------
// CLOUD SETTINGS MODAL
// ---------------------------------------------------------
function openSettingsModal() {
  apiUrlInput.value = getApiUrl();
  el("apiUrlError").textContent = "";
  settingsModalOverlay.classList.remove("hidden");
}

function closeSettingsModal() {
  settingsModalOverlay.classList.add("hidden");
}

async function handleSettingsSubmit(e) {
  e.preventDefault();
  const url = apiUrlInput.value.trim();

  if (url && !isLikelyValidAppsScriptUrl(url)) {
    el("apiUrlError").textContent = "That doesn't look like a valid Apps Script Web App URL.";
    return;
  }

  setApiUrl(url);
  closeSettingsModal();

  if (url) {
    showToast("Cloud URL saved. Connecting...");
    setSyncState("syncing");
    await loadTransactions(); // attempt initial pull to confirm the connection works
  } else {
    showToast("Cloud sync disconnected. Working offline.");
    setSyncState("offline");
  }
}

function handleDisconnect() {
  setApiUrl("");
  apiUrlInput.value = "";
  setSyncState("offline");
  closeSettingsModal();
  showToast("Disconnected from Google Sheets. Local Storage is now the only data source.");
}

function isLikelyValidAppsScriptUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.includes("script.google.com");
  } catch {
    return false;
  }
}

// ---------------------------------------------------------
// SYNC STATUS UI
// ---------------------------------------------------------
function setSyncState(state) {
  syncState = state; // "connected" | "syncing" | "offline" | "error"

  const labels = { connected: "Connected", syncing: "Syncing...", offline: "Offline", error: "Sync Error" };

  syncDot.className = "sync-dot " + state;
  syncDotMobile.className = "sync-dot " + state;
  syncLabel.textContent = labels[state] || "Offline";
}


function populateCategoryOptions(type = "income") {
  categoryInput.innerHTML = "";
  CATEGORIES[type].forEach((cat) => {
    const opt = document.createElement("option");
    opt.value = cat;
    opt.textContent = cat;
    categoryInput.appendChild(opt);
  });
}

function setDefaultDate() {
  const today = new Date().toISOString().split("T")[0];
  dateInput.value = today;
}

// ---------------------------------------------------------
// MODAL CONTROL (ADD / EDIT)
// ---------------------------------------------------------
function openModal(transaction = null) {
  clearErrors();
  transactionForm.reset();

  if (transaction) {
    // EDIT MODE — pre-fill the form
    editingId = transaction.id;
    modalTitle.innerHTML = `<i class="fa-solid fa-pen"></i> Edit Transaction`;
    transactionIdInput.value = transaction.id;
    titleInput.value = transaction.title;
    amountInput.value = transaction.amount;
    dateInput.value = transaction.date;
    typeInput.value = transaction.type;
    populateCategoryOptions(transaction.type);
    categoryInput.value = transaction.category;
    notesInput.value = transaction.notes || "";
  } else {
    // ADD MODE
    editingId = null;
    modalTitle.innerHTML = `<i class="fa-solid fa-plus-circle"></i> Add Transaction`;
    typeInput.value = "income";
    populateCategoryOptions("income");
    setDefaultDate();
  }

  modalOverlay.classList.remove("hidden");
}

function closeModal() {
  modalOverlay.classList.add("hidden");
  editingId = null;
  clearErrors();
}

// ---------------------------------------------------------
// FORM VALIDATION
// ---------------------------------------------------------
function clearErrors() {
  el("titleError").textContent = "";
  el("amountError").textContent = "";
  el("dateError").textContent = "";
}

function validateForm() {
  clearErrors();
  let isValid = true;

  const title = titleInput.value.trim();
  const amount = parseFloat(amountInput.value);
  const date = dateInput.value;

  if (!title) {
    el("titleError").textContent = "Please enter a transaction title.";
    isValid = false;
  }

  if (amountInput.value.trim() === "" || isNaN(amount)) {
    el("amountError").textContent = "Please enter a valid amount.";
    isValid = false;
  } else if (amount <= 0) {
    el("amountError").textContent = "Amount must be greater than zero.";
    isValid = false;
  }

  if (!date) {
    el("dateError").textContent = "Please select a date.";
    isValid = false;
  }

  return isValid;
}

// ---------------------------------------------------------
// FORM SUBMIT (ADD or UPDATE) — local-first, then sync to cloud
// ---------------------------------------------------------
async function handleFormSubmit(e) {
  e.preventDefault();

  if (!validateForm()) return;

  const isEditing = Boolean(editingId);
  const transactionData = {
    id: editingId || generateId(),
    title: titleInput.value.trim(),
    amount: Math.abs(parseFloat(amountInput.value)), // enforce positive value
    type: typeInput.value,
    category: categoryInput.value,
    date: dateInput.value,
    notes: notesInput.value.trim(),
    createdAt: isEditing
      ? (transactions.find((t) => t.id === editingId)?.createdAt || new Date().toISOString())
      : new Date().toISOString(),
  };

  // 1) Update local state immediately so the UI never waits on the network.
  if (isEditing) {
    const index = transactions.findIndex((t) => t.id === editingId);
    if (index !== -1) transactions[index] = transactionData;
  } else {
    transactions.push(transactionData);
  }
  saveTransactionsToLocal();
  closeModal();
  renderAll();

  // 2) Push to Google Sheets (or queue it if offline/unconfigured).
  if (isEditing) {
    await updateTransaction(transactionData);
  } else {
    await saveTransaction(transactionData);
  }
}

function generateId() {
  return "txn_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
}

// ---------------------------------------------------------
// DELETE CONFIRMATION FLOW
// ---------------------------------------------------------
function requestDelete(id) {
  deleteTargetId = id;
  deleteModalOverlay.classList.remove("hidden");
}

function closeDeleteModal() {
  deleteTargetId = null;
  deleteModalOverlay.classList.add("hidden");
}

async function confirmDelete() {
  const idToDelete = deleteTargetId;
  transactions = transactions.filter((t) => t.id !== idToDelete);
  saveTransactionsToLocal();
  closeDeleteModal();
  renderAll();
  showToast("Transaction deleted.");

  await deleteTransaction(idToDelete);
}



// ---------------------------------------------------------
// CLOUD SYNC — Google Apps Script Web App communication
// ---------------------------------------------------------
// All requests go through one fetch wrapper that adds a timeout and
// normalizes errors, so each CRUD function only deals with success/failure.
async function apiRequest(action, payload = {}) {
  const apiUrl = getApiUrl();
  if (!apiUrl) throw new Error("NO_API_URL");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      // Apps Script Web Apps read the body as text/plain to avoid CORS preflight;
      // the script itself parses the JSON string out of e.postData.contents.
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action, payload }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) throw new Error(`HTTP_${response.status}`);

    const data = await response.json();
    if (!data || data.success !== true) {
      throw new Error(data && data.error ? data.error : "UNKNOWN_API_ERROR");
    }
    return data;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") throw new Error("TIMEOUT");
    throw err;
  }
}

// ---- Validation: never send or accept malformed records ----
function isValidTransactionShape(t) {
  return (
    t &&
    typeof t.id === "string" && t.id.length > 0 &&
    typeof t.title === "string" && t.title.trim().length > 0 &&
    typeof t.amount === "number" && !isNaN(t.amount) && t.amount > 0 &&
    (t.type === "income" || t.type === "expense") &&
    typeof t.category === "string" && t.category.length > 0 &&
    typeof t.date === "string" && !isNaN(Date.parse(t.date))
  );
}

function sanitizeIncomingTransaction(raw) {
  return {
    id: String(raw.id || raw.ID || "").trim(),
    title: String(raw.title || raw["Transaction Title"] || "").trim(),
    amount: Math.abs(parseFloat(raw.amount ?? raw.Amount ?? 0)) || 0,
    type: (raw.type || raw.Type || "expense").toLowerCase() === "income" ? "income" : "expense",
    category: String(raw.category || raw.Category || "Other").trim(),
    date: String(raw.date || raw.Date || "").trim(),
    notes: String(raw.notes || raw.Notes || "").trim(),
    createdAt: String(raw.createdAt || raw["Created At"] || new Date().toISOString()),
  };
}

/**
 * loadTransactions()
 * Pulls the full transaction list from Google Sheets and replaces the local
 * cache with it. Falls back silently to whatever is already in Local Storage
 * if the network call fails (offline-first guarantee).
 */
async function loadTransactions() {
  if (!isCloudConfigured()) { setSyncState("offline"); return; }

  setSyncState("syncing");
  try {
    const result = await apiRequest("read");
    const remoteRows = Array.isArray(result.data) ? result.data : [];

    // Validate + de-duplicate by id (last write wins) before trusting remote data.
    const byId = new Map();
    remoteRows.map(sanitizeIncomingTransaction).filter(isValidTransactionShape).forEach((t) => byId.set(t.id, t));

    transactions = Array.from(byId.values());
    saveTransactionsToLocal();
    renderAll();
    setSyncState("connected");

    // Flush anything queued while we were offline.
    if (pendingOps.length) await syncData();
  } catch (err) {
    console.error("loadTransactions failed:", err);
    setSyncState(err.message === "NO_API_URL" ? "offline" : "error");
    showToast("Couldn't reach Google Sheets — showing local data instead.", true);
    // transactions already holds the Local Storage version from startup, so no further action needed.
  }
}

/**
 * saveTransaction(transaction)
 * Sends a newly created transaction to Google Sheets ("create"). If the
 * request fails, the operation is queued for retry and the user is told
 * their data is safe locally.
 */
async function saveTransaction(transaction) {
  if (!isValidTransactionShape(transaction)) {
    showToast("Transaction failed validation and wasn't synced.", true);
    return;
  }
  if (!isCloudConfigured()) { setSyncState("offline"); return; }

  setSyncState("syncing");
  try {
    await apiRequest("create", transaction);
    setSyncState("connected");
  } catch (err) {
    console.error("saveTransaction failed:", err);
    queueOp("create", transaction);
    setSyncState("error");
    showToast("Saved locally. Will sync to Google Sheets when connection is back.", true);
    scheduleRetry();
  }
}

/**
 * updateTransaction(transaction)
 * Sends an edited transaction to Google Sheets ("update"), matched by id.
 */
async function updateTransaction(transaction) {
  if (!isValidTransactionShape(transaction)) {
    showToast("Transaction failed validation and wasn't synced.", true);
    return;
  }
  if (!isCloudConfigured()) { setSyncState("offline"); return; }

  setSyncState("syncing");
  try {
    await apiRequest("update", transaction);
    setSyncState("connected");
  } catch (err) {
    console.error("updateTransaction failed:", err);
    queueOp("update", transaction);
    setSyncState("error");
    showToast("Updated locally. Will sync to Google Sheets when connection is back.", true);
    scheduleRetry();
  }
}

/**
 * deleteTransaction(id)
 * Removes a transaction from Google Sheets by id ("delete").
 */
async function deleteTransaction(id) {
  if (!isCloudConfigured()) { setSyncState("offline"); return; }

  setSyncState("syncing");
  try {
    await apiRequest("delete", { id });
    setSyncState("connected");
  } catch (err) {
    console.error("deleteTransaction failed:", err);
    queueOp("delete", { id });
    setSyncState("error");
    showToast("Deleted locally. Will sync to Google Sheets when connection is back.", true);
    scheduleRetry();
  }
}

/**
 * syncData()
 * Flushes any queued create/update/delete operations (built up while
 * offline or during a Sheets outage) in the order they were made, then
 * re-pulls the canonical list so local and cloud agree.
 */
async function syncData() {
  if (!isCloudConfigured()) {
    showToast("Add a Google Apps Script URL in Cloud Settings to enable sync.", true);
    return;
  }
  if (!navigator.onLine) {
    setSyncState("offline");
    showToast("No internet connection detected.", true);
    return;
  }

  setSyncState("syncing");
  const queueSnapshot = [...pendingOps];

  try {
    for (const item of queueSnapshot) {
      if (item.op === "create") await apiRequest("create", item.payload);
      else if (item.op === "update") await apiRequest("update", item.payload);
      else if (item.op === "delete") await apiRequest("delete", item.payload);

      // Remove this op from the real queue once it succeeds.
      pendingOps = pendingOps.filter((p) => p.queuedAt !== item.queuedAt);
      savePendingQueue();
    }

    await loadTransactions(); // re-sync canonical state from the sheet
    setSyncState("connected");
    if (queueSnapshot.length) showToast("Synced with Google Sheets successfully!");
  } catch (err) {
    console.error("syncData failed:", err);
    setSyncState("error");
    showToast("Sync failed. Your data is safe locally — we'll try again shortly.", true);
    scheduleRetry();
  }
}

// Auto-retry a failed sync after a short delay, without stacking up timers.
let retryTimer = null;
function scheduleRetry() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    if (isCloudConfigured() && navigator.onLine) syncData();
  }, CONFIG.SYNC_RETRY_DELAY_MS);
}


function showToast(message, isError = false) {
  toastMessage.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.remove("hidden");
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => toast.classList.add("hidden"), 2800);
}

// ---------------------------------------------------------
// CURRENCY FORMATTING
// ---------------------------------------------------------
function formatCurrency(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);
}

// ---------------------------------------------------------
// RENDER ORCHESTRATOR
// ---------------------------------------------------------
function renderAll() {
  renderSummaryCards();
  renderTable();
  renderDashboardCharts();
  renderAnalyticsCharts();
  renderInsights();
}

// ---------------------------------------------------------
// SUMMARY CARDS
// ---------------------------------------------------------
function renderSummaryCards() {
  const totalIncome = transactions.filter((t) => t.type === "income").reduce((sum, t) => sum + t.amount, 0);
  const totalExpense = transactions.filter((t) => t.type === "expense").reduce((sum, t) => sum + t.amount, 0);
  const balance = totalIncome - totalExpense;

  el("totalIncome").textContent = formatCurrency(totalIncome);
  el("totalExpense").textContent = formatCurrency(totalExpense);
  el("totalBalance").textContent = formatCurrency(balance);
  el("totalCount").textContent = transactions.length;
}

// ---------------------------------------------------------
// INSIGHTS (highest category, monthly net, avg transaction)
// ---------------------------------------------------------
function renderInsights() {
  // Highest expense category
  const expenseByCategory = {};
  transactions.filter((t) => t.type === "expense").forEach((t) => {
    expenseByCategory[t.category] = (expenseByCategory[t.category] || 0) + t.amount;
  });
  const topCat = Object.entries(expenseByCategory).sort((a, b) => b[1] - a[1])[0];
  el("topCategory").textContent = topCat ? `${topCat[0]} (${formatCurrency(topCat[1])})` : "—";

  // This month's net (income - expense for current month)
  const now = new Date();
  const currentMonthTxns = transactions.filter((t) => {
    const d = new Date(t.date);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  });
  const monthIncome = currentMonthTxns.filter((t) => t.type === "income").reduce((s, t) => s + t.amount, 0);
  const monthExpense = currentMonthTxns.filter((t) => t.type === "expense").reduce((s, t) => s + t.amount, 0);
  el("monthNet").textContent = formatCurrency(monthIncome - monthExpense);

  // Average transaction amount
  const avg = transactions.length ? transactions.reduce((s, t) => s + t.amount, 0) / transactions.length : 0;
  el("avgTransaction").textContent = formatCurrency(avg);
}

// ---------------------------------------------------------
// TABLE: FILTER + SEARCH + SORT + RENDER
// ---------------------------------------------------------
function getFilteredTransactions() {
  const searchTerm = searchInput.value.trim().toLowerCase();
  const typeFilterVal = filterType.value;
  const sortVal = sortOrder.value;

  let filtered = transactions.filter((t) => {
    const matchesSearch = t.title.toLowerCase().includes(searchTerm);
    const matchesType = typeFilterVal === "all" || t.type === typeFilterVal;
    return matchesSearch && matchesType;
  });

  switch (sortVal) {
    case "newest":
      filtered.sort((a, b) => new Date(b.date) - new Date(a.date));
      break;
    case "oldest":
      filtered.sort((a, b) => new Date(a.date) - new Date(b.date));
      break;
    case "highest":
      filtered.sort((a, b) => b.amount - a.amount);
      break;
    case "lowest":
      filtered.sort((a, b) => a.amount - b.amount);
      break;
  }

  return filtered;
}

function renderTable() {
  const filtered = getFilteredTransactions();
  tableBody.innerHTML = "";

  if (filtered.length === 0) {
    emptyState.classList.remove("hidden");
  } else {
    emptyState.classList.add("hidden");
  }

  filtered.forEach((t) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${escapeHtml(t.title)}</td>
      <td>${escapeHtml(t.category)}</td>
      <td>${formatDate(t.date)}</td>
      <td>
        <span class="type-badge ${t.type}">
          <i class="fa-solid ${t.type === "income" ? "fa-arrow-up" : "fa-arrow-down"}"></i>
          ${t.type === "income" ? "Income" : "Expense"}
        </span>
      </td>
      <td class="amount-cell ${t.type}">${t.type === "income" ? "+" : "-"}${formatCurrency(t.amount)}</td>
      <td>${escapeHtml(t.notes) || "—"}</td>
      <td class="actions-col">
        <div class="row-actions">
          <button class="icon-btn edit" data-id="${t.id}" title="Edit"><i class="fa-solid fa-pen"></i></button>
          <button class="icon-btn delete" data-id="${t.id}" title="Delete"><i class="fa-solid fa-trash"></i></button>
        </div>
      </td>
    `;
    tableBody.appendChild(row);
  });

  // Attach row action listeners (delegated per render since rows are rebuilt)
  tableBody.querySelectorAll(".icon-btn.edit").forEach((btn) => {
    btn.addEventListener("click", () => {
      const txn = transactions.find((t) => t.id === btn.dataset.id);
      if (txn) openModal(txn);
    });
  });
  tableBody.querySelectorAll(".icon-btn.delete").forEach((btn) => {
    btn.addEventListener("click", () => requestDelete(btn.dataset.id));
  });
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { day: "2-digit", month: "short", year: "numeric" });
}

function escapeHtml(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------------------------------------------------------
// CSV EXPORT
// ---------------------------------------------------------
function exportToCSV() {
  if (transactions.length === 0) {
    showToast("No transactions to export.", true);
    return;
  }

  const headers = ["Title", "Category", "Date", "Type", "Amount", "Notes"];
  const rows = transactions.map((t) => [
    t.title, t.category, t.date, t.type, t.amount.toFixed(2), (t.notes || "").replace(/,/g, ";"),
  ]);

  let csvContent = headers.join(",") + "\n";
  rows.forEach((row) => { csvContent += row.join(",") + "\n"; });

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `smart-finance-transactions-${Date.now()}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  showToast("CSV exported successfully!");
}

// ---------------------------------------------------------
// CHART HELPERS
// ---------------------------------------------------------
function getChartTextColor() {
  return document.body.classList.contains("dark-mode") ? "#f3f4fb" : "#1c1f33";
}

function destroyChart(instance) {
  if (instance) instance.destroy();
}

// ---- Dashboard charts: Pie (Income vs Expense) + Bar (Monthly) ----
function renderDashboardCharts() {
  const ctxPie = el("pieChart");
  const ctxBar = el("barChart");
  if (!ctxPie || !ctxBar) return;

  const totalIncome = transactions.filter((t) => t.type === "income").reduce((s, t) => s + t.amount, 0);
  const totalExpense = transactions.filter((t) => t.type === "expense").reduce((s, t) => s + t.amount, 0);

  destroyChart(pieChartInstance);
  pieChartInstance = new Chart(ctxPie, {
    type: "doughnut",
    data: {
      labels: ["Income", "Expense"],
      datasets: [{
        data: [totalIncome, totalExpense],
        backgroundColor: ["#1fd17a", "#ff5b6e"],
        borderWidth: 0,
        hoverOffset: 8,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { animateScale: true, animateRotate: true },
      plugins: {
        legend: { position: "bottom", labels: { color: getChartTextColor(), font: { family: "Poppins", size: 12 } } },
      },
    },
  });

  // Monthly aggregation for bar chart (last 6 months)
  const monthlyData = getMonthlyAggregation(6);
  destroyChart(barChartInstance);
  barChartInstance = new Chart(ctxBar, {
    type: "bar",
    data: {
      labels: monthlyData.labels,
      datasets: [
        { label: "Income", data: monthlyData.income, backgroundColor: "#1fd17a", borderRadius: 6 },
        { label: "Expense", data: monthlyData.expense, backgroundColor: "#ff5b6e", borderRadius: 6 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 800, easing: "easeOutQuart" },
      plugins: {
        legend: { position: "bottom", labels: { color: getChartTextColor(), font: { family: "Poppins", size: 12 } } },
      },
      scales: {
        x: { ticks: { color: getChartTextColor() }, grid: { display: false } },
        y: { ticks: { color: getChartTextColor() }, grid: { color: "rgba(150,150,150,0.15)" } },
      },
    },
  });
}

// ---- Analytics charts: Category breakdown + Monthly trend line ----
function renderAnalyticsCharts() {
  const ctxCat = el("categoryPieChart");
  const ctxTrend = el("monthlyTrendChart");
  if (!ctxCat || !ctxTrend) return;

  const expenseByCategory = {};
  transactions.filter((t) => t.type === "expense").forEach((t) => {
    expenseByCategory[t.category] = (expenseByCategory[t.category] || 0) + t.amount;
  });

  destroyChart(categoryPieInstance);
  categoryPieInstance = new Chart(ctxCat, {
    type: "pie",
    data: {
      labels: Object.keys(expenseByCategory).length ? Object.keys(expenseByCategory) : ["No Data"],
      datasets: [{
        data: Object.keys(expenseByCategory).length ? Object.values(expenseByCategory) : [1],
        backgroundColor: ["#ff5b6e", "#ff9a5b", "#ffd15b", "#7b6bff", "#4d8dff", "#1fd17a", "#ff5bd8", "#a4a8c4"],
        borderWidth: 0,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom", labels: { color: getChartTextColor(), font: { family: "Poppins", size: 11.5 } } },
      },
    },
  });

  const monthlyData = getMonthlyAggregation(6);
  destroyChart(monthlyTrendInstance);
  monthlyTrendInstance = new Chart(ctxTrend, {
    type: "line",
    data: {
      labels: monthlyData.labels,
      datasets: [
        {
          label: "Expense Trend",
          data: monthlyData.expense,
          borderColor: "#ff5b6e",
          backgroundColor: "rgba(255,91,110,0.15)",
          fill: true,
          tension: 0.4,
          pointBackgroundColor: "#ff5b6e",
        },
        {
          label: "Income Trend",
          data: monthlyData.income,
          borderColor: "#1fd17a",
          backgroundColor: "rgba(31,209,122,0.15)",
          fill: true,
          tension: 0.4,
          pointBackgroundColor: "#1fd17a",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 900, easing: "easeOutQuart" },
      plugins: {
        legend: { position: "bottom", labels: { color: getChartTextColor(), font: { family: "Poppins", size: 12 } } },
      },
      scales: {
        x: { ticks: { color: getChartTextColor() }, grid: { display: false } },
        y: { ticks: { color: getChartTextColor() }, grid: { color: "rgba(150,150,150,0.15)" } },
      },
    },
  });
}

// ---- Helper: aggregate income/expense totals by month (last N months) ----
function getMonthlyAggregation(monthsCount) {
  const labels = [];
  const income = [];
  const expense = [];
  const now = new Date();

  for (let i = monthsCount - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const label = d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
    labels.push(label);

    const monthIncome = transactions
      .filter((t) => t.type === "income")
      .filter((t) => {
        const td = new Date(t.date);
        return td.getMonth() === d.getMonth() && td.getFullYear() === d.getFullYear();
      })
      .reduce((s, t) => s + t.amount, 0);

    const monthExpense = transactions
      .filter((t) => t.type === "expense")
      .filter((t) => {
        const td = new Date(t.date);
        return td.getMonth() === d.getMonth() && td.getFullYear() === d.getFullYear();
      })
      .reduce((s, t) => s + t.amount, 0);

    income.push(monthIncome);
    expense.push(monthExpense);
  }

  return { labels, income, expense };
}
