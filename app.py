import asyncio
import io
import math
import os
import json
import re
import time
from typing import AsyncIterator, Dict, List, Optional, Tuple

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from sqlmodel import Field, SQLModel, Session, create_engine, select
from wordcloud import WordCloud
from PIL import Image
from better_profanity import profanity

DATABASE_URL = "sqlite:///./app.db"
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})


class ResponseEntry(SQLModel, table=True):
    __tablename__ = "question"

    id: Optional[int] = Field(default=None, primary_key=True)
    body: str
    created_at: float = Field(default_factory=lambda: time.time())


CUSTOM_PROFANE_TERMS = [
    "motherfucker",
    "fuck",
    "shit",
    "bitch",
    "asshole",
    "bastard",
    "cunt",
    "dick",
    "cock",
    "pussy",
    "slut",
    "whore",
    "damn",
    "bollocks",
    "wanker",
    "naughty",
    "naked",
    "sexy",
    "sex",
    "porn",
    "porno",
    "pornography",
    "erotic",
    "penis",
    "vagina",
    "breasts",
    "boobs",
    "butt",
    "butts",
    "booty",
    "orgasm",
    "lust",
    "intimate",
]

ALLOWED_RELIGIOUS_TERMS = {
    "god",
    "gods",
    "jesus",
    "christ",
    "jesus christ",
    "lord",
    "savior",
    "messiah",
    "yahweh",
    "jehovah",
    "holy",
    "holy spirit",
    "holy-spirit",
    "spirit",
}

STOPWORDS = {
    "a",
    "about",
    "after",
    "all",
    "also",
    "am",
    "an",
    "and",
    "any",
    "are",
    "as",
    "at",
    "be",
    "been",
    "before",
    "being",
    "but",
    "by",
    "can",
    "could",
    "did",
    "do",
    "does",
    "doing",
    "down",
    "during",
    "each",
    "few",
    "for",
    "from",
    "had",
    "has",
    "have",
    "having",
    "he",
    "her",
    "here",
    "hers",
    "herself",
    "him",
    "himself",
    "his",
    "how",
    "i",
    "if",
    "in",
    "into",
    "is",
    "it",
    "its",
    "itself",
    "just",
    "me",
    "more",
    "most",
    "my",
    "myself",
    "no",
    "nor",
    "not",
    "now",
    "of",
    "off",
    "on",
    "once",
    "only",
    "or",
    "other",
    "our",
    "ours",
    "ourselves",
    "out",
    "over",
    "own",
    "same",
    "she",
    "should",
    "so",
    "some",
    "such",
    "than",
    "that",
    "the",
    "their",
    "theirs",
    "them",
    "themselves",
    "then",
    "there",
    "these",
    "they",
    "this",
    "those",
    "through",
    "to",
    "too",
    "under",
    "until",
    "up",
    "very",
    "was",
    "we",
    "were",
    "what",
    "when",
    "where",
    "which",
    "while",
    "who",
    "whom",
    "why",
    "will",
    "with",
    "you",
    "your",
    "yours",
    "yourself",
    "yourselves",
}

MAX_TOKEN_LENGTH = 40
DEFAULT_WIDTH = 1200
DEFAULT_HEIGHT = 600
MAX_WIDTH = 2000
MAX_HEIGHT = 1200
RATE_LIMIT_SECONDS = 3.0

TOKEN_PATTERN = re.compile(r"[^\w\s'-]+")

FONT_CANDIDATES = [
    "/System/Library/Fonts/SFCompactRounded-Semibold.otf",
    "/System/Library/Fonts/SFNSRounded.ttf",
    "/Library/Fonts/SFCompactRounded-Semibold.otf",
    "/Library/Fonts/Signika Negative.ttf",
    "/Library/Fonts/SignikaNegative-Regular.ttf",
    "/System/Library/Fonts/Supplemental/SignikaNegative-Regular.ttf",
    "/usr/share/fonts/truetype/signika/SignikaNegative-Regular.ttf",
    "/usr/share/fonts/google/SignikaNegative-Regular.ttf",
    "C:/Windows/Fonts/SignikaNegative-Regular.ttf",
    "/System/Library/Fonts/Supplemental/Impact.ttf",
    "/Library/Fonts/Impact.ttf",
    "C:/Windows/Fonts/impact.ttf",
]

WORDCLOUD_FONT_PATH = next((p for p in FONT_CANDIDATES if os.path.exists(p)), None)

profanity.load_censor_words()
profanity.add_censor_words(CUSTOM_PROFANE_TERMS)
profanity.CENSOR_WORDSET = [word for word in profanity.CENSOR_WORDSET if str(word).lower() not in {term.lower() for term in ALLOWED_RELIGIOUS_TERMS}]
app = FastAPI(title="Offline Response Collector")
app.mount("/static", StaticFiles(directory="static", html=False), name="static")

_subscribers: List[asyncio.Queue[str]] = []
_subscribers_lock = asyncio.Lock()
_rate_limit_lock = asyncio.Lock()
_last_submission_by_ip: Dict[str, float] = {}

_wordcloud_cache_lock = asyncio.Lock()
_wordcloud_cache: Dict[str, object] = {
    "dirty": True,
    "entries": {},  # type: ignore[dict-item]
    "last_dirty_at": 0.0,
}


def init_db() -> None:
    SQLModel.metadata.create_all(engine)


def get_session():
    with Session(engine) as session:
        yield session


def _prepare_frequencies(texts: List[str]) -> Tuple[Dict[str, int], bool]:
    counts: Dict[str, int] = {}
    for raw in texts:
        lowered = raw.strip().lower()
        if not lowered:
            continue
        normalized = TOKEN_PATTERN.sub(" ", lowered).strip()
        if not normalized:
            continue
        normalized = re.sub(r"\s+", " ", normalized)[:MAX_TOKEN_LENGTH]
        if normalized in STOPWORDS:
            continue
        counts[normalized] = counts.get(normalized, 0) + 1
    if not counts:
        return {}, True
    return counts, False


def _mix_with_white(hex_color: str, amount: float) -> str:
    amount = max(0.0, min(amount, 1.0))
    hex_color = hex_color.lstrip("#")
    r, g, b = [int(hex_color[i:i + 2], 16) for i in range(0, 6, 2)]
    r = round(r + (255 - r) * amount)
    g = round(g + (255 - g) * amount)
    b = round(b + (255 - b) * amount)
    return f"#{r:02x}{g:02x}{b:02x}"


def _build_wordcloud_png(texts: List[str], width: int, height: int) -> Tuple[bytes, bool]:
    frequencies, is_placeholder = _prepare_frequencies(texts)
    if is_placeholder:
        image = Image.new("RGB", (width, height), "white")
    else:
        kwargs = {
            "width": width,
            "height": height,
            "background_color": "white",
            "stopwords": STOPWORDS,
            "max_words": 200,
            "collocations": False,
            "normalize_plurals": True,
            "prefer_horizontal": 1.0,
        }
        if WORDCLOUD_FONT_PATH:
            kwargs["font_path"] = WORDCLOUD_FONT_PATH
        cloud = WordCloud(**kwargs).generate_from_frequencies(frequencies)

        ordered = sorted(cloud.words_.items(), key=lambda item: item[1], reverse=True)
        total_words = len(ordered)

        if total_words:
            top_quartile_count = max(1, math.ceil(total_words * 0.25))
            rare_count = min(2, max(1, round(total_words * 0.05)))
            rare_count = min(rare_count, total_words)
        else:
            top_quartile_count = 0
            rare_count = 0

        neutral_palette = [
            "#1C2A39",
            "#2F3A4A",
            "#5B6573",
            _mix_with_white("#1C2A39", 0.08),
            _mix_with_white("#2F3A4A", 0.06),
        ]
        emerald_base = "#2F855A"
        accent_palette = [
            emerald_base,
            _mix_with_white(emerald_base, 0.1),
            _mix_with_white(emerald_base, 0.18),
        ]
        rare_palette = ["#B65A38", "#B28B2C"]

        rare_words = {word for word, _ in ordered[:rare_count]}
        accent_words = {word for word, _ in ordered[:top_quartile_count]} - rare_words

        word_colors: Dict[str, str] = {}
        for idx, (word, _weight) in enumerate(ordered):
            if word in rare_words:
                color = rare_palette[idx % len(rare_palette)]
            elif word in accent_words:
                color = accent_palette[idx % len(accent_palette)]
            else:
                color = neutral_palette[idx % len(neutral_palette)]
            word_colors[word] = color

        def color_func(word, font_size, position, orientation, random_state=None, **kwargs):
            return word_colors.get(word, neutral_palette[0])

        image = cloud.recolor(color_func=color_func, random_state=33).to_image()

    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue(), is_placeholder


async def _ensure_rate_limit(ip: str) -> None:
    now = time.time()
    async with _rate_limit_lock:
        last_seen = _last_submission_by_ip.get(ip)
        if last_seen and now - last_seen < RATE_LIMIT_SECONDS:
            raise HTTPException(status_code=429, detail="Please wait a moment before submitting again.")
        _last_submission_by_ip[ip] = now
        if len(_last_submission_by_ip) > 512:
            stale_cutoff = now - 30.0
            for key, value in list(_last_submission_by_ip.items()):
                if value < stale_cutoff:
                    _last_submission_by_ip.pop(key, None)


async def _broadcast(event_type: str, payload: Dict[str, object]) -> None:
    data = json.dumps(payload, separators=(",", ":"))
    message = f"event: {event_type}\n" f"data: {data}\n\n"
    async with _subscribers_lock:
        for queue in list(_subscribers):
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                try:
                    _subscribers.remove(queue)
                except ValueError:
                    pass


async def _sse_event_generator(queue: asyncio.Queue[str]) -> AsyncIterator[str]:
    try:
        while True:
            try:
                chunk = await asyncio.wait_for(queue.get(), timeout=20.0)
                yield chunk
            except asyncio.TimeoutError:
                yield ": heartbeat\n\n"
    except asyncio.CancelledError:
        return


def _mark_wordcloud_dirty() -> None:
    _wordcloud_cache["dirty"] = True
    _wordcloud_cache["last_dirty_at"] = time.time()


async def _get_wordcloud_bytes(texts: List[str], width: int, height: int) -> Tuple[bytes, bool]:
    key: Tuple[int, int] = (width, height)
    entries: Dict[Tuple[int, int], Tuple[bytes, bool]] = _wordcloud_cache.setdefault("entries", {})  # type: ignore[assignment]

    if not _wordcloud_cache.get("dirty"):
        cached = entries.get(key)
        if cached is not None:
            return cached

    async with _wordcloud_cache_lock:
        if not _wordcloud_cache.get("dirty"):
            cached = entries.get(key)
            if cached is not None:
                return cached

        if _wordcloud_cache.get("dirty"):
            entries.clear()

        data = await asyncio.to_thread(_build_wordcloud_png, texts, width, height)
        entries[key] = data
        _wordcloud_cache["dirty"] = False
        _wordcloud_cache["last_dirty_at"] = time.time()
        return data


def _validate_body(value: str) -> str:
    body = (value or "").strip()
    if not (1 <= len(body) <= 120):
        raise HTTPException(status_code=400, detail="Responses must be between 1 and 120 characters.")
    if profanity.contains_profanity(body):
        raise HTTPException(status_code=400, detail="Please keep submissions respectful.")
    return body


@app.on_event("startup")
async def on_startup() -> None:
    init_db()


@app.on_event("shutdown")
async def on_shutdown() -> None:
    engine.dispose()
    for suffix in ("", "-shm", "-wal"):
        filename = f"app.db{suffix}"
        try:
            os.remove(filename)
        except FileNotFoundError:
            continue
        except OSError:
            pass
    _wordcloud_cache["dirty"] = True
    entries = _wordcloud_cache.get("entries")
    if isinstance(entries, dict):
        entries.clear()


@app.post("/api/responses")
async def create_response(payload: Dict[str, str], request: Request, session: Session = Depends(get_session)):
    client_host = request.client.host if request.client else "unknown"
    await _ensure_rate_limit(client_host)

    body = _validate_body(payload.get("body", ""))
    entry = ResponseEntry(body=body)
    session.add(entry)
    session.commit()
    session.refresh(entry)

    _mark_wordcloud_dirty()
    await _broadcast("response-created", {"id": entry.id})

    return {"id": entry.id, "body": entry.body, "created_at": entry.created_at}


@app.get("/wordcloud.png")
async def wordcloud_endpoint(
    width: int = Query(DEFAULT_WIDTH, ge=100),
    height: int = Query(DEFAULT_HEIGHT, ge=100),
    session: Session = Depends(get_session),
):
    bounded_width = max(100, min(width, MAX_WIDTH))
    bounded_height = max(100, min(height, MAX_HEIGHT))

    entries: Dict[Tuple[int, int], Tuple[bytes, bool]] = _wordcloud_cache.setdefault("entries", {})  # type: ignore[assignment]
    key: Tuple[int, int] = (bounded_width, bounded_height)
    if not _wordcloud_cache.get("dirty"):
        cached = entries.get(key)
        if cached is not None:
            content, is_placeholder = cached
            return Response(
                content=content,
                media_type="image/png",
                headers={
                    "Cache-Control": "no-store",
                    "X-Wordcloud-Empty": "1" if is_placeholder else "0",
                },
            )

    texts = session.exec(select(ResponseEntry.body)).all()
    content, is_placeholder = await _get_wordcloud_bytes(texts, bounded_width, bounded_height)
    return Response(
        content=content,
        media_type="image/png",
        headers={
            "Cache-Control": "no-store",
            "X-Wordcloud-Empty": "1" if is_placeholder else "0",
        },
    )


@app.get("/events")
async def sse(request: Request):
    queue: asyncio.Queue[str] = asyncio.Queue(maxsize=128)
    async with _subscribers_lock:
        _subscribers.append(queue)

    async def event_stream() -> AsyncIterator[str]:
        try:
            async for part in _sse_event_generator(queue):
                if await request.is_disconnected():
                    break
                yield part
        finally:
            async with _subscribers_lock:
                try:
                    _subscribers.remove(queue)
                except ValueError:
                    pass

    return StreamingResponse(event_stream(), media_type="text/event-stream")


app.mount("/", StaticFiles(directory="static", html=True), name="root")
