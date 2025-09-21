const listEl = document.getElementById("list");
const formEl = document.getElementById("ask-form");
const inputEl = document.getElementById("ask-input");
const hintEl = document.getElementById("char-hint");
const refreshBtn = document.getElementById("refresh");
const toastEl = document.getElementById("toast");
const sortButtons = document.querySelectorAll('[data-sort]');

let sortMode = localStorage.getItem("sortMode") === "recent" ? "recent" : "top";

const votedSet = new Set(JSON.parse(localStorage.getItem("voted") || "[]"));
let reorderQueued = false;
let hasAnyQuestions = false;

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
  btn.classList.toggle("is-on", on);
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

  const body = document.createElement("div");
  body.className = "q-body";
  body.textContent = item.body;

  const meta = document.createElement("div");
  meta.className = "q-meta";

  const up = document.createElement("button");
  up.className = "upvote";
  up.setAttribute("aria-label", "Upvote");
  if (votedSet.has(item.id)) up.classList.add("is-on");

  const icon = document.createElement("span");
  icon.className = "chev";
  const count = document.createElement("span");
  count.className = "count";
  count.textContent = String(item.upvotes);

  up.addEventListener("click", () => optimisticVote(item.id, count, up));

  up.appendChild(icon);
  up.appendChild(count);
  meta.appendChild(up);
  li.appendChild(body);
  li.appendChild(meta);
  updateButtonState(up, item.id, item.user_voted, mutateSet);
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
    if (Object.prototype.hasOwnProperty.call(item, "user_voted")) {
      const btn = existing.querySelector(".upvote");
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

  cards.forEach((card, idx) => {
    card.classList.toggle("is-top", sortMode === "top" && idx === 0);
  });
}

function updateSortButtons() {
  sortButtons.forEach((btn) => {
    const active = btn.dataset.sort === sortMode;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
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
  for (let i = 0; i < n; i++) {
    const li = document.createElement("li");
    li.className = "card";
    li.setAttribute("aria-hidden", "true");

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
  const shouldSkeleton = hasAnyQuestions || listEl.childElementCount > 0;
  if (shouldSkeleton) {
    showSkeletons();
  } else {
    listEl.dataset.loading = "1";
    clearList();
  }
  try {
    const res = await fetch(`/api/questions?sort=${sortMode}`);
    const data = await res.json();
    clearList();
    if (!Array.isArray(data) || !data.length) {
      delete listEl.dataset.loading;
      hasAnyQuestions = false;
      votedSet.clear();
      persistVoted();
      return;
    }
    listEl.dataset.loading = "batch";
    hasAnyQuestions = true;
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
    reorderAndHighlight();
  } catch (err) {
    delete listEl.dataset.loading;
    clearList();
    toast("Couldn’t load questions");
    console.error(err);
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
  } else {
    toast("Question submitted");
  }
}

async function optimisticVote(qid, countEl, btnEl) {
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
      } else if (targetMethod === "DELETE") {
        updateButtonState(btnEl, qid, false);
      }
      scheduleReorder();
    } else {
      // revert on failure
      updateButtonState(btnEl, qid, !wasOn);
      countEl.textContent = String(current);
      toast("Vote failed");
    }
  } catch (err) {
    updateButtonState(btnEl, qid, !wasOn);
    countEl.textContent = String(current);
    toast("Network error");
    console.error(err);
  }
}

/* --- SSE --- */
function startSSE() {
  const es = new EventSource("/events");
  es.addEventListener("question-created", (e) => {
    const item = JSON.parse(e.data);
    hasAnyQuestions = true;
    upsertItem(item);
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
    setTimeout(startSSE, 2000);
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
});
refreshBtn.addEventListener("click", loadList);
inputEl.addEventListener("input", () => {
  const n = (inputEl.value || "").length;
  hintEl.textContent = `${n}/500`;
});
sortButtons.forEach((btn) => {
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
updateSortButtons();
loadList();
startSSE();
