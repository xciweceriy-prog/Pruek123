/**
 * =========================================================
 * SMART FINANCE TRACKER — Code.gs
 * Google Apps Script Web App backend for Google Sheets sync.
 *
 * Exposes a single POST endpoint that accepts JSON bodies of the form:
 *   { "action": "create" | "read" | "update" | "delete", "payload": {...} }
 * and returns JSON of the form:
 *   { "success": true, "data": ... }
 *   { "success": false, "error": "message" }
 *
 * See the deployment guide further down (or the accompanying README)
 * for step-by-step spreadsheet setup and Web App deployment instructions.
 * =========================================================
 */

// ---------------------------------------------------------
// CONFIG
// ---------------------------------------------------------
const SHEET_NAME = "Transactions"; // must match the tab name in your spreadsheet

// Column order — keep this in sync with the header row in the sheet.
const COLUMNS = ["ID", "Transaction Title", "Amount", "Type", "Category", "Date", "Notes", "Created At"];

// ---------------------------------------------------------
// ENTRY POINT — handles all POST requests from the web app
// ---------------------------------------------------------
function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse({ success: false, error: "INVALID_JSON_BODY" });
  }

  const action = body.action;
  const payload = body.payload || {};

  try {
    switch (action) {
      case "create":
        return jsonResponse(handleCreate(payload));
      case "read":
        return jsonResponse(handleRead());
      case "update":
        return jsonResponse(handleUpdate(payload));
      case "delete":
        return jsonResponse(handleDelete(payload));
      default:
        return jsonResponse({ success: false, error: "UNKNOWN_ACTION" });
    }
  } catch (err) {
    return jsonResponse({ success: false, error: String(err.message || err) });
  }
}

// Allow a simple GET for a quick "is this deployed?" health check in a browser.
function doGet(e) {
  return jsonResponse({ success: true, message: "Smart Finance Tracker API is running." });
}

// ---------------------------------------------------------
// SHEET HELPERS
// ---------------------------------------------------------
function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet) {
    // Auto-create the sheet with headers if it doesn't exist yet.
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(COLUMNS);
  }
  return sheet;
}

function getAllRows() {
  const sheet = getSheet();
  const range = sheet.getDataRange().getValues();
  if (range.length <= 1) return []; // only header row, or empty

  const header = range[0];
  return range.slice(1).map((row) => {
    const obj = {};
    header.forEach((colName, i) => { obj[colName] = row[i]; });
    return obj;
  });
}

function findRowIndexById(id) {
  const sheet = getSheet();
  const ids = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 0), 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2; // +2: skip header, 1-indexed
  }
  return -1;
}

// ---------------------------------------------------------
// VALIDATION — never trust incoming data blindly
// ---------------------------------------------------------
function validatePayload(payload) {
  if (!payload || typeof payload !== "object") return "Payload must be an object.";
  if (!payload.id || typeof payload.id !== "string") return "Missing or invalid 'id'.";
  if (!payload.title || typeof payload.title !== "string") return "Missing or invalid 'title'.";

  const amount = parseFloat(payload.amount);
  if (isNaN(amount) || amount <= 0) return "Amount must be a positive number.";

  if (payload.type !== "income" && payload.type !== "expense") return "Type must be 'income' or 'expense'.";
  if (!payload.category || typeof payload.category !== "string") return "Missing or invalid 'category'.";
  if (!payload.date || isNaN(new Date(payload.date).getTime())) return "Missing or invalid 'date'.";

  return null; // no errors
}

// ---------------------------------------------------------
// CRUD HANDLERS
// ---------------------------------------------------------
function handleCreate(payload) {
  const error = validatePayload(payload);
  if (error) return { success: false, error: error };

  // Prevent duplicate records: if this id already exists, treat as an update instead.
  const existingRow = findRowIndexById(payload.id);
  if (existingRow !== -1) {
    return handleUpdate(payload);
  }

  const sheet = getSheet();
  const createdAt = payload.createdAt || new Date().toISOString();

  sheet.appendRow([
    payload.id,
    payload.title,
    parseFloat(payload.amount),
    payload.type,
    payload.category,
    payload.date,
    payload.notes || "",
    createdAt,
  ]);

  return { success: true, data: { id: payload.id } };
}

function handleRead() {
  const rows = getAllRows();
  // Normalize sheet column names into the camelCase shape the front end expects.
  const data = rows.map((r) => ({
    id: String(r["ID"]),
    title: r["Transaction Title"],
    amount: parseFloat(r["Amount"]) || 0,
    type: r["Type"],
    category: r["Category"],
    date: r["Date"] instanceof Date ? Utilities.formatDate(r["Date"], "GMT", "yyyy-MM-dd") : r["Date"],
    notes: r["Notes"] || "",
    createdAt: r["Created At"],
  }));

  return { success: true, data: data };
}

function handleUpdate(payload) {
  const error = validatePayload(payload);
  if (error) return { success: false, error: error };

  const rowIndex = findRowIndexById(payload.id);
  if (rowIndex === -1) {
    // No existing record — create it instead of failing, so updates are idempotent.
    return handleCreate(payload);
  }

  const sheet = getSheet();
  sheet.getRange(rowIndex, 1, 1, COLUMNS.length).setValues([[
    payload.id,
    payload.title,
    parseFloat(payload.amount),
    payload.type,
    payload.category,
    payload.date,
    payload.notes || "",
    payload.createdAt || new Date().toISOString(),
  ]]);

  return { success: true, data: { id: payload.id } };
}

function handleDelete(payload) {
  if (!payload || !payload.id) return { success: false, error: "Missing 'id' for delete." };

  const rowIndex = findRowIndexById(payload.id);
  if (rowIndex === -1) {
    // Already gone — deletion is idempotent, so this is still a success.
    return { success: true, data: { id: payload.id, alreadyDeleted: true } };
  }

  getSheet().deleteRow(rowIndex);
  return { success: true, data: { id: payload.id } };
}

// ---------------------------------------------------------
// RESPONSE HELPER
// ---------------------------------------------------------
function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
