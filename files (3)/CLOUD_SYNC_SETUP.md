# Google Sheets Cloud Sync — Setup Guide

This guide walks through connecting Smart Finance Tracker to a Google Sheet
so every transaction is backed up to the cloud and synced across devices.

---

## Part 1 — Spreadsheet Setup

1. Go to [sheets.google.com](https://sheets.google.com) and create a **new blank spreadsheet**.
2. Rename it something like `Smart Finance Tracker Data`.
3. Rename the first tab (bottom-left) to exactly: `Transactions`
   *(this must match `SHEET_NAME` in `Code.gs`)*
4. In row 1, add these exact column headers, one per cell, A1 through H1:

   | A  | B                  | C      | D    | E        | F    | G     | H          |
   |----|--------------------|--------|------|----------|------|-------|------------|
   | ID | Transaction Title | Amount | Type | Category | Date | Notes | Created At |

   > You don't strictly have to do this — `Code.gs` will auto-create the
   > `Transactions` tab with these headers the first time it runs if it's
   > missing. But creating it yourself lets you confirm the spreadsheet ID
   > and tab name are right before you deploy anything.

5. Leave the rest of the sheet empty. Data rows will be added automatically
   by the script as transactions are created.

---

## Part 2 — Add the Apps Script

1. In your spreadsheet, go to **Extensions → Apps Script**.
2. Delete any placeholder code in the editor.
3. Copy the entire contents of `Code.gs` (provided alongside this guide)
   into the editor.
4. Click the **disk icon** (or `Ctrl/Cmd + S`) to save the project.
5. Name the project something like `Smart Finance Tracker API`.

---

## Part 3 — Deploy as a Web App

1. In the Apps Script editor, click **Deploy → New deployment**.
2. Click the gear icon next to "Select type" and choose **Web app**.
3. Fill in the deployment settings:
   - **Description**: `Smart Finance Tracker API v1`
   - **Execute as**: `Me (your account)`
   - **Who has access**: `Anyone`
     *(required so the front end can call it without a Google login prompt —
     your data is still only readable/writable through this specific URL,
     which only you know and control)*
4. Click **Deploy**.
5. Google will ask you to **authorize access** the first time:
   - Click **Authorize access**
   - Choose your Google account
   - You'll see an "unverified app" warning because this is your own
     personal script — click **Advanced → Go to Smart Finance Tracker API
     (unsafe)** → **Allow**.
6. After deployment, copy the **Web App URL** shown. It looks like:
   ```
   https://script.google.com/macros/s/AKfycb.../exec
   ```
   This is the only value the front end needs.

### Redeploying after edits

If you change `Code.gs` later, edits are **not** live until you redeploy:
**Deploy → Manage deployments → (pencil/edit icon) → New version → Deploy.**
The Web App URL stays the same across versions, so you won't need to update
the app again unless you create a brand-new deployment.

---

## Part 4 — Connect the Web App

1. Open Smart Finance Tracker in your browser.
2. Click **Cloud Settings** (top of the Dashboard, or the sync status panel
   in the sidebar).
3. Paste your Web App URL into the field.
4. Click **Save & Connect**.
5. The sync status dot should turn green ("Connected") within a few seconds.
   If it turns red ("Sync Error"), double-check:
   - The URL ends in `/exec`, not `/dev`.
   - "Who has access" is set to **Anyone**.
   - You completed the authorization prompt in Part 3, step 5.

---

## How sync behaves day-to-day

- **On load**: the app pulls the full transaction list from your sheet and
  merges it into the local cache.
- **On add/edit/delete**: the change is applied to Local Storage
  *immediately* (so the UI never feels slow), then sent to the sheet in the
  background.
- **If you're offline or the sheet is unreachable**: the change is queued
  locally and retried automatically every ~15 seconds, and again whenever
  the browser regains a connection. Nothing is lost — Local Storage is
  always the source of truth on your current device.
- **Manual sync**: click the refresh icon next to the sync status indicator
  to force an immediate retry of any queued changes.

## Sync status meanings

| Status      | Color  | Meaning                                              |
|-------------|--------|-------------------------------------------------------|
| Connected   | Green  | Last request to Google Sheets succeeded.              |
| Syncing     | Blue   | A request is currently in flight.                     |
| Offline     | Gray   | No Web App URL configured, or browser has no internet.|
| Sync Error  | Red    | The last request failed; changes are queued for retry.|

## Disconnecting

Open **Cloud Settings** and click **Disconnect** to clear the saved URL.
The app immediately falls back to Local Storage only — no data is deleted,
and your existing transactions remain on your device.
