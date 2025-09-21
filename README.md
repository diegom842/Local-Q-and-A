# Offline Q&A (FastAPI + SQLite + SSE)

## 1) Install
Python 3.10+ recommended.

```bash
python -m venv .venv
source .venv/bin/activate    # Windows: .venv\Scripts\activate
pip install -r requirements.txt
2) Run (bind to all interfaces for LAN)
uvicorn app:app --host 0.0.0.0 --port 8080 --reload
3) Connect
On the host machine: http://localhost:8080
On phones/laptops in the same Wi-Fi:
Find your IP (macOS): ipconfig getifaddr en0 (try en1 if needed)
Example: http://192.168.1.23:8080
Notes
Data stored in app.db (SQLite). WAL mode enabled for safe concurrent writes.
One vote per device per question enforced via cookie did + DB composite primary key.
Server-Sent Events (/events) push new questions and votes to all connected clients.
No internet required after installing dependencies.
