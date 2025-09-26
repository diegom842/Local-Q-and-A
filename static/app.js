const listEl = document.getElementById("list");
const formEl = document.getElementById("ask-form");
const inputEl = document.getElementById("ask-input");
const hintEl = document.getElementById("char-hint");
const refreshBtn = document.getElementById("refresh");
const toastEl = document.getElementById("toast");
const sortButtons = document.querySelectorAll('[data-sort]');
const segmentedEl = document.querySelector(".segmented");
const emptyEl = document.getElementById("empty");
const offlineBanner = document.getElementById("offline-banner");
const srStatusEl = document.getElementById("sr-status");

let sortMode = localStorage.getItem("sortMode") === "recent" ? "recent" : "top";

const votedSet = new Set(JSON.parse(localStorage.getItem("voted") || "[]"));
let reorderQueued = false;
let hasAnyQuestions = false;
let sseRetry = 0;

function persistVoted() {
  localStorage.setItem("voted", JSON.stringify([...votedSet]));
}

function updateButtonState(btn, id, flagged, mutateSet = true) {
  let on = flagged;
  if (on === undefined) {
    on = votedSet.has(id);
  } else {
    on = Boolean(on);
  }
  if (!btn) {
    if (mutateSet) {
      if (on) {
        votedSet.add(id);
      } else {
        votedSet.delete(id);
      }
      persistVoted();
    }
    return on;
  }
  btn.classList.toggle("is-on", on);
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  if (mutateSet) {
    if (on) {
      votedSet.add(id);
    } else {
      votedSet.delete(id);
    }
    persistVoted();
  }
  return on;
}

function showEmpty(show) {
  if (!emptyEl) return;
  emptyEl.hidden = !show;
}

function setOffline(flag) {
  if (!offlineBanner) return;
  offlineBanner.hidden = !flag;
}

function announce(message) {
  if (!srStatusEl) return;
  srStatusEl.textContent = "";
  requestAnimationFrame(() => {
    srStatusEl.textContent = message;
  });
}

function toggleCardExpansion(card) {
  const expanded = card.getAttribute("aria-expanded") === "true";
  const next = !expanded;
  card.setAttribute("aria-expanded", String(next));
  card.dataset.expanded = String(next);
}

/* --- Utilities --- */
function toast(msg, ms = 1800) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  requestAnimationFrame(() => toastEl.classList.add("show"));
  setTimeout(() => {
    toastEl.classList.remove("show");
    setTimeout(() => (toastEl.hidden = true), 220);
  }, ms);
}

function liId(qid) {
  return `q-${qid}`;
}

function questionCard(item, mutateSet = true) {
  const li = document.createElement("li");
  li.className = "card";
  li.id = liId(item.id);
  li.dataset.created = String(item.created_at ?? Date.now());
  li.dataset.expanded = "false";
  li.tabIndex = 0;
  li.setAttribute("aria-expanded", "false");
  li.dataset.qid = String(item.id);

  const body = document.createElement("div");
  body.className = "q-body";
  body.textContent = item.body;

  const meta = document.createElement("div");
  meta.className = "q-meta";

  const qid = item.id;
  const up = document.createElement("button");
  up.className = "upvote";
  up.dataset.qid = String(qid);
  up.setAttribute("aria-label", "Upvote");
  if (votedSet.has(qid)) up.classList.add("is-on");

  const icon = document.createElement("span");
  icon.className = "chev";
  const count = document.createElement("span");
  count.className = "count";
  count.textContent = String(item.upvotes);

  up.addEventListener("click", () => optimisticVote(qid, count, up));
  up.addEventListener("keydown", (event) => {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      optimisticVote(qid, count, up);
    }
  });

  up.appendChild(icon);
  up.appendChild(count);
  meta.appendChild(up);
  li.appendChild(body);
  li.appendChild(meta);
  updateButtonState(up, item.id, item.user_voted, mutateSet);

  li.addEventListener("click", (event) => {
    if (event.target.closest(".upvote")) return;
    toggleCardExpansion(li);
  });

  li.addEventListener("keydown", (event) => {
    if (event.target.closest(".upvote")) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleCardExpansion(li);
    }
  });

  return li;
}

function upsertItem(item, mutateSet = true) {
  const existing = document.getElementById(liId(item.id));
  if (existing) {
    if (typeof item.upvotes === "number") {
      existing.querySelector(".count").textContent = String(item.upvotes);
    }
    if (item.body) {
      existing.querySelector(".q-body").textContent = item.body;
    }
    if (item.created_at) {
      existing.dataset.created = String(item.created_at);
    }
    existing.dataset.qid = String(item.id);
    if (Object.prototype.hasOwnProperty.call(item, "user_voted")) {
      const btn = existing.querySelector(".upvote");
      if (btn) {
        btn.dataset.qid = String(item.id);
      }
      updateButtonState(btn, item.id, item.user_voted, mutateSet);
    }
  } else {
    listEl.appendChild(questionCard(item, mutateSet));
  }
  scheduleReorder();
}

function scheduleReorder() {
  if (listEl.dataset.loading) return;
  if (reorderQueued) return;
  reorderQueued = true;
  requestAnimationFrame(() => {
    reorderQueued = false;
    reorderAndHighlight();
  });
}

function reorderAndHighlight() {
  const cards = Array.from(listEl.querySelectorAll(".card"));
  if (!cards.length) return;

  cards.sort((a, b) => {
    const upA = parseInt(a.querySelector(".count").textContent, 10) || 0;
    const upB = parseInt(b.querySelector(".count").textContent, 10) || 0;
    const createdA = Number(a.dataset.created) || 0;
    const createdB = Number(b.dataset.created) || 0;

    if (sortMode === "recent") {
      if (createdB !== createdA) return createdB - createdA;
      return upB - upA;
    }

    if (upB !== upA) return upB - upA;
    return createdA - createdB;
  });

  cards.forEach((card) => listEl.appendChild(card));
}

function updateSortButtons() {
  sortButtons.forEach((btn) => {
    const active = btn.dataset.sort === sortMode;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
    if (active && segmentedEl) {
      const index = Number(btn.dataset.index);
      segmentedEl.style.setProperty("--seg-index", isNaN(index) ? "0" : String(index));
    }
  });
  const heading = document.getElementById("list-label");
  if (heading) {
    heading.textContent = sortMode === "recent" ? "Newest questions" : "Top questions";
  }
}

function clearList() {
  listEl.innerHTML = "";
}

/* --- Loading skeletons --- */
function showSkeletons(n = 4) {
  listEl.dataset.loading = "1";
  clearList();
  showEmpty(false);
  for (let i = 0; i < n; i++) {
    const li = document.createElement("li");
    li.className = "card";
    li.setAttribute("aria-hidden", "true");
    li.removeAttribute("tabindex");
    li.style.cursor = "default";

    const left = document.createElement("div");
    left.style.flex = "1";
    const b1 = document.createElement("div");
    b1.className = "skel";
    b1.style.width = `${60 + Math.random() * 30}%`;
    const b2 = document.createElement("div");
    b2.className = "skel";
    b2.style.width = `${40 + Math.random() * 40}%`;
    b2.style.marginTop = "8px";
    left.appendChild(b1);
    left.appendChild(b2);

    const right = document.createElement("div");
    right.className = "q-meta";
    right.innerHTML = `<div class="upvote"><span class="chev"></span><span class="count">0</span></div>`;

    li.appendChild(left);
    li.appendChild(right);
    listEl.appendChild(li);
  }
}

/* --- Data flow --- */
async function loadList() {
  const shouldSkeleton = !hasAnyQuestions && listEl.childElementCount === 0;
  if (shouldSkeleton) {
    showSkeletons();
  } else {
    listEl.dataset.loading = "1";
  }
  try {
    const res = await fetch(`/api/questions?sort=${sortMode}`);
    const data = await res.json();
    setOffline(false);
    const hasData = Array.isArray(data) && data.length > 0;
    if (!hasData) {
      delete listEl.dataset.loading;
      hasAnyQuestions = false;
      votedSet.clear();
      persistVoted();
      showEmpty(true);
      clearList();
      return;
    }
    listEl.dataset.loading = "batch";
    hasAnyQuestions = true;
    clearList();
    const newVoted = new Set();
    data.forEach((item) => {
      if (item.user_voted) {
        newVoted.add(item.id);
      }
      upsertItem(item, false);
    });
    delete listEl.dataset.loading;
    votedSet.clear();
    newVoted.forEach((id) => votedSet.add(id));
    persistVoted();
    showEmpty(false);
    reorderAndHighlight();
  } catch (err) {
    delete listEl.dataset.loading;
    toast("Couldn’t load questions");
    console.error(err);
    setOffline(true);
    if (!hasAnyQuestions && listEl.childElementCount === 0) {
      showEmpty(true);
    }
  }
}

async function submitQuestion(body) {
  const res = await fetch("/api/questions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body })
  });
  if (!res.ok) {
    toast("Couldn’t submit. Try again.");
    announce("Question submission failed.");
  } else {
    toast("Question submitted");
    announce("Question submitted successfully.");
  }
}

async function optimisticVote(qid, countEl, btnEl) {
  const qidFromDom = Number(btnEl?.dataset?.qid);
  if (!Number.isNaN(qidFromDom)) {
    qid = qidFromDom;
  }
  const current = parseInt(countEl.textContent, 10) || 0;
  const wasOn = btnEl.classList.contains("is-on");
  const targetMethod = wasOn ? "DELETE" : "POST";
  const optimisticDelta = wasOn ? -1 : 1;
  if (optimisticDelta > 0) {
    updateButtonState(btnEl, qid, true);
  } else {
    updateButtonState(btnEl, qid, false);
  }
  countEl.textContent = String(Math.max(0, current + optimisticDelta));
  scheduleReorder();

  try {
    const res = await fetch(`/api/questions/${qid}/vote`, { method: targetMethod });
    if (res.ok) {
      const data = await res.json();
      countEl.textContent = String(data.upvotes);
      if (targetMethod === "POST") {
        updateButtonState(btnEl, qid, true);
        announce(`Upvoted. Total ${data.upvotes}.`);
      } else if (targetMethod === "DELETE") {
        updateButtonState(btnEl, qid, false);
        announce(`Vote removed. Total ${data.upvotes}.`);
      }
      scheduleReorder();
    } else {
      // revert on failure
      updateButtonState(btnEl, qid, !wasOn);
      countEl.textContent = String(current);
      toast("Vote failed");
      announce("Vote failed. Please try again.");
    }
  } catch (err) {
    updateButtonState(btnEl, qid, !wasOn);
    countEl.textContent = String(current);
    toast("Network error");
    console.error(err);
    announce("Network error while voting.");
  }
}

/* --- SSE --- */
function startSSE() {
  const es = new EventSource("/events");
  es.addEventListener("open", () => {
    sseRetry = 0;
    setOffline(false);
  });
  es.addEventListener("question-created", (e) => {
    const item = JSON.parse(e.data);
    hasAnyQuestions = true;
    upsertItem(item);
    showEmpty(false);
  });
  es.addEventListener("vote-cast", (e) => {
    const item = JSON.parse(e.data);
    const node = document.getElementById(liId(item.question_id));
    if (node) {
      node.querySelector(".count").textContent = String(item.upvotes);
      scheduleReorder();
    }
  });
  es.onerror = () => {
    es.close();
    sseRetry = Math.min(sseRetry + 1, 6);
    const base = Math.min(30000, 2000 * 2 ** sseRetry);
    const jitter = Math.random() * 1000;
    setOffline(true);
    setTimeout(startSSE, base + jitter);
  };
}

/* --- UX bits --- */
formEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = (inputEl.value || "").trim();
  if (!text) return;
  await submitQuestion(text);
  inputEl.value = "";
  hintEl.textContent = "0/500";
  hintEl.classList.remove("is-warn");
  requestAnimationFrame(() => inputEl.focus());
});
refreshBtn.addEventListener("click", loadList);
inputEl.addEventListener("input", () => {
  const n = (inputEl.value || "").length;
  hintEl.textContent = `${n}/500`;
  hintEl.classList.toggle("is-warn", n >= 440);
});
sortButtons.forEach((btn) => {
  if (!btn.dataset.index) {
    btn.dataset.index = String(Array.from(sortButtons).indexOf(btn));
  }
  btn.addEventListener("click", () => {
    const target = btn.dataset.sort;
    if (target === sortMode) return;
    sortMode = target;
    localStorage.setItem("sortMode", sortMode);
    updateSortButtons();
    loadList();
  });
});

/* init */
hintEl.textContent = "0/500";
hintEl.classList.remove("is-warn");
updateSortButtons();
loadList();
startSSE();
