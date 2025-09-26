# Offline Response Collector with Live Word Cloud

## Setup
```bash
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## Run
```bash
uvicorn app:app --host 0.0.0.0 --port 8080 --reload
```

## Usage
Open `http://localhost:8080/`, submit short responses, and watch the word cloud update live. The app works fully offline once dependencies are installed.

## LAN Tip
For guests on your network, consider proxying to port 80 so they can use a friendly address like `http://qna.lan`. Otherwise, share `http://<host-ip>:8080`.
