import asyncio
import json
import os
import time
import uuid
from typing import AsyncIterator, Dict, List, Literal, Optional

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import case, event, func
from sqlalchemy.engine import Engine
from sqlmodel import Field, Relationship, SQLModel, Session, create_engine, select

# ---- Models ----

class Question(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    body: str = Field(index=False)
    created_at: float = Field(default_factory=lambda: time.time())
    votes: List["Vote"] = Relationship(back_populates="question")


class Device(SQLModel, table=True):
    id: str = Field(primary_key=True)  # UUID from cookie
    first_seen: float = Field(default_factory=lambda: time.time())
    last_seen: float = Field(default_factory=lambda: time.time())
    user_agent: Optional[str] = None
    last_ip: Optional[str] = None
    votes: List["Vote"] = Relationship(back_populates="device")


class Vote(SQLModel, table=True):
    question_id: int = Field(foreign_key="question.id", primary_key=True)
    device_id: str = Field(foreign_key="device.id", primary_key=True)
    created_at: float = Field(default_factory=lambda: time.time())
    question: Optional[Question] = Relationship(back_populates="votes")
    device: Optional[Device] = Relationship(back_populates="votes")


# ---- DB setup ----

DATABASE_URL = "sqlite:///./app.db"
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})


@event.listens_for(Engine, "connect")
def set_sqlite_pragma(dbapi_connection, connection_record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL;")
    cursor.execute("PRAGMA foreign_keys=ON;")
    cursor.close()


def init_db():
    SQLModel.metadata.create_all(engine)


# ---- App & SSE hub ----

app = FastAPI(title="Offline Q&A")
app.mount("/static", StaticFiles(directory="static", html=False), name="static")

# Each subscriber gets an asyncio.Queue of server-sent event strings
_subscribers: List[asyncio.Queue[str]] = []
_subscribers_lock = asyncio.Lock()


@app.middleware("http")
async def ensure_device_cookie(request: Request, call_next):
    did = request.cookies.get("did")
    new_did = False
    if not did:
        did = str(uuid.uuid4())
        new_did = True

    request.state.device_id = did

    with Session(engine) as session:
        dev = session.get(Device, did)
        if not dev:
            dev = Device(
                id=did,
                user_agent=request.headers.get("user-agent"),
                last_ip=request.client.host if request.client else None,
            )
            session.add(dev)
        else:
            dev.last_seen = time.time()
            dev.user_agent = request.headers.get("user-agent")
            dev.last_ip = request.client.host if request.client else dev.last_ip
        session.commit()

    response = await call_next(request)

    if new_did:
        response.set_cookie(
            key="did",
            value=did,
            httponly=True,
            samesite="lax",
            path="/",
        )

    return response


async def broadcast(event_type: str, payload: Dict):
    data = json.dumps(payload, separators=(",", ":"))
    msg = f"event: {event_type}\n" f"data: {data}\n\n"
    async with _subscribers_lock:
        for q in list(_subscribers):
            # Don't await put forever; if a queue is full or dead, ignore
            try:
                q.put_nowait(msg)
            except asyncio.QueueFull:
                # Best-effort: drop this subscriber
                try:
                    _subscribers.remove(q)
                except ValueError:
                    pass


async def sse_event_generator(q: asyncio.Queue[str]) -> AsyncIterator[str]:
    # Heartbeat to keep connections alive
    try:
        while True:
            try:
                msg = await asyncio.wait_for(q.get(), timeout=20.0)
                yield msg
            except asyncio.TimeoutError:
                yield ": ping\n\n"
    except asyncio.CancelledError:
        return


# ---- Utilities ----

def get_session():
    with Session(engine) as session:
        yield session


def get_device_id(request: Request) -> str:
    did = getattr(request.state, "device_id", None)
    if not did:
        raise HTTPException(status_code=500, detail="Device ID unavailable")
    return did


def validate_body(text: str) -> str:
    body = (text or "").strip()
    if not (1 <= len(body) <= 500):
        raise HTTPException(status_code=400, detail="Question must be 1..500 characters.")
    return body


# ---- Routes ----

@app.on_event("startup")
async def on_startup():
    init_db()


@app.on_event("shutdown")
async def on_shutdown():
    # Dispose connections then remove database artifacts for a fresh start next run
    engine.dispose()
    for name in ("app.db", "app.db-shm", "app.db-wal"):
        try:
            os.remove(name)
        except FileNotFoundError:
            continue
        except OSError:
            # Ignore issues like permission errors; surfaces on next startup if critical
            pass


@app.get("/api/health")
def health():
    return {"ok": True, "time": time.time()}


@app.get("/api/questions")
def list_questions(
    request: Request,
    sort: Literal["top", "recent"] = "top",
    session: Session = Depends(get_session),
):
    did = get_device_id(request)
    # Select questions with vote counts
    user_voted_flag = func.max(case((Vote.device_id == did, 1), else_=0)).label("user_voted")

    q = (
        select(
            Question.id,
            Question.body,
            Question.created_at,
            func.count(Vote.device_id).label("upvotes"),
            user_voted_flag,
        )
        .select_from(Question)
        .join(Vote, Vote.question_id == Question.id, isouter=True)
        .group_by(Question.id)
    )
    rows = session.exec(q).all()
    # Sort in Python for clarity: upvotes desc, created_at asc
    if sort == "recent":
        rows_sorted = sorted(rows, key=lambda r: (-r.created_at, r.id))
    else:
        rows_sorted = sorted(rows, key=lambda r: (-r.upvotes, r.created_at))
    # Convert to dicts
    return [
        {
            "id": r.id,
            "body": r.body,
            "created_at": r.created_at,
            "upvotes": int(r.upvotes),
            "user_voted": bool(r.user_voted),
        }
        for r in rows_sorted
    ]


@app.post("/api/questions")
async def create_question(payload: Dict, request: Request, session: Session = Depends(get_session)):
    _ = get_device_id(request)  # author remains anonymous
    body = validate_body(payload.get("body", ""))
    q = Question(body=body)
    session.add(q)
    session.commit()
    session.refresh(q)
    # Broadcast creation
    await broadcast("question-created", {"id": q.id, "body": q.body, "created_at": q.created_at, "upvotes": 0})
    return {"id": q.id, "body": q.body, "created_at": q.created_at}


@app.post("/api/questions/{qid}/vote")
async def vote_question(qid: int, request: Request, session: Session = Depends(get_session)):
    did = get_device_id(request)
    q = session.get(Question, qid)
    if not q:
        raise HTTPException(status_code=404, detail="Question not found")

    existing = session.get(Vote, (qid, did))
    if existing:
        count_stmt = select(func.count(Vote.device_id)).where(Vote.question_id == qid)
        current = int(session.exec(count_stmt).one())
        return {"ok": True, "question_id": qid, "upvotes": current, "already_voted": True}

    session.add(Vote(question_id=qid, device_id=did))
    session.commit()

    count_stmt = select(func.count(Vote.device_id)).where(Vote.question_id == qid)
    current = int(session.exec(count_stmt).one())

    # Broadcast vote
    await broadcast("vote-cast", {"question_id": qid, "upvotes": current})
    return {"ok": True, "question_id": qid, "upvotes": current, "already_voted": False}


@app.delete("/api/questions/{qid}/vote")
async def unvote_question(qid: int, request: Request, session: Session = Depends(get_session)):
    did = get_device_id(request)
    vote = session.get(Vote, (qid, did))
    if not vote:
        count_stmt = select(func.count(Vote.device_id)).where(Vote.question_id == qid)
        current = int(session.exec(count_stmt).one())
        return {"ok": True, "question_id": qid, "upvotes": current, "removed": False}

    session.delete(vote)
    session.commit()

    count_stmt = select(func.count(Vote.device_id)).where(Vote.question_id == qid)
    current = int(session.exec(count_stmt).one())
    await broadcast("vote-cast", {"question_id": qid, "upvotes": current})
    return {"ok": True, "question_id": qid, "upvotes": current, "removed": True}


@app.get("/events")
async def sse(request: Request):
    """
    Server-Sent Events endpoint.
    Each client gets its own queue; we remove it on disconnect.
    """
    q: asyncio.Queue[str] = asyncio.Queue(maxsize=100)
    async with _subscribers_lock:
        _subscribers.append(q)

    async def event_stream():
        try:
            async for chunk in sse_event_generator(q):
                # Client disconnected?
                if await request.is_disconnected():
                    break
                yield chunk
        finally:
            # Clean up on disconnect
            async with _subscribers_lock:
                try:
                    _subscribers.remove(q)
                except ValueError:
                    pass

    return StreamingResponse(event_stream(), media_type="text/event-stream")


# Optional explicit root if needed; StaticFiles(html=True) already serves index:
@app.get("/_debug", response_class=HTMLResponse)
def debug_index():
    return "<html><body><h1>Q&A server running</h1></body></html>"


# Serve static frontend at root (must be last so API routes win for /api/*)
app.mount("/", StaticFiles(directory="static", html=True), name="root")
