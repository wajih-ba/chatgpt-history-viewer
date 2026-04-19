# ChatGPT Conversation Extractor

A full local project for capturing ChatGPT conversations through a Chrome extension and viewing them in a FastAPI web UI.

## What It Does

1. Chrome extension injects a page-context script on ChatGPT.
2. Injected script intercepts `fetch` responses from:
   - `/backend-api/conversations`
   - `/backend-api/conversation/{id}`
3. It normalizes chat metadata and nested message trees.
4. The extension background service forwards JSON payloads to FastAPI.
5. FastAPI upserts chats/messages into SQLite via SQLAlchemy.
6. FastAPI serves a web UI to browse all chats and full conversations.

## Project Structure

```text
project/
├── backend/
│   ├── __init__.py
│   ├── main.py
│   ├── models.py
│   ├── database.py
│   ├── schemas.py
│   ├── services.py
│   └── routes/
│       ├── __init__.py
│       ├── api.py
│       └── web.py
├── extension/
│   ├── manifest.json
│   ├── content.js
│   ├── injected.js
│   ├── background.js
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── frontend/
│   ├── templates/
│   │   ├── index.html
│   │   └── chat_detail.html
│   └── static/
│       ├── app.css
│       ├── chats.js
│       └── chat-detail.js
└── requirements.txt
```

## Requirements

- Python 3.11+
- Google Chrome

## Setup and Run

### 1. Install backend dependencies

From the project root:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

### 2. Start FastAPI server

```powershell
uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload
```

Open the UI:

- Chat list: <http://127.0.0.1:8000/>

### 3. Load Chrome extension

1. Go to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `extension` folder

### 4. Capture ChatGPT data

1. Open ChatGPT (`https://chatgpt.com` or `https://chat.openai.com`)
2. Click the extension icon and press **Sync All Chats**
3. Keep the ChatGPT tab open while it paginates and fetches all conversation details
4. The extension sends data to the backend during sync
5. Refresh `http://127.0.0.1:8000/` to view saved chats

You can still capture incrementally by browsing chats normally; fetch interception remains active.

`Sync All Chats` uses two phases: it first collects every conversation ID by pagination, then fetches each conversation detail with retries. This avoids missing older chats and stores all messages from each conversation mapping.

## API Endpoints

- `POST /api/chats`  
  Upsert chat metadata

- `POST /api/messages`  
  Upsert message batch for a chat

- `GET /api/chats?search=<term>`  
  List chats, optional title search

- `GET /api/chats/{id}`  
  Retrieve full conversation

- `GET /api/chats/{id}/export`  
  Export a chat and messages as JSON

## Data Handling Details

- Duplicate prevention:
  - Chat upsert via `ON CONFLICT(id)`
  - Message upsert via `ON CONFLICT(chat_id, source_id)`
- Message ID fallback:
  - If source message ID is missing, backend generates a deterministic hash ID
- Nested tree support:
  - Extension extracts the current branch via `current_node` and parent links
  - Falls back to all nodes sorted by timestamp when branch is unavailable

## Notes

- CORS is enabled broadly (`*`) for local development.
- SQLite DB file is created at project root as `chat_archive.db`.
- This project intentionally avoids DOM scraping and relies only on fetch interception.
