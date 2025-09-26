const form = document.getElementById("response-form");
const input = document.getElementById("response-input");
const counter = document.getElementById("char-counter");
const toast = document.getElementById("toast");
const cloud = document.getElementById("cloud");

let toastTimer;
let sseRetry = 0;
let currentCloudUrl = null;
let cloudFetchChain = Promise.resolve();
let cloudRequestId = 0;

function setCounter(value) {
  if (!counter) {
    return;
  }
  counter.textContent = `${value}/120`;
  counter.classList.toggle("is-warn", value >= 108);
}

function showToast(message, duration = 1800) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toast.classList.add("is-visible");
  toastTimer = setTimeout(() => {
    toast.classList.remove("is-visible");
    setTimeout(() => {
      toast.hidden = true;
    }, 220);
  }, duration);
}

async function fetchCloud(query = "") {
  const requestId = ++cloudRequestId;
  let nextUrl;
  try {
    cloud.dataset.loading = "1";
    const res = await fetch(`/wordcloud.png${query}`, { cache: "no-store" });
    if (!res.ok) {
      throw new Error(`wordcloud fetch failed: ${res.status}`);
    }
    const blob = await res.blob();
    nextUrl = URL.createObjectURL(blob);

    await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = resolve;
      img.onerror = reject;
      img.src = nextUrl;
    });

    if (currentCloudUrl) {
      URL.revokeObjectURL(currentCloudUrl);
    }
    currentCloudUrl = nextUrl;
    cloud.src = nextUrl;
    nextUrl = null;
  } catch (err) {
    console.error(err);
  } finally {
    if (nextUrl) {
      URL.revokeObjectURL(nextUrl);
    }
    requestAnimationFrame(() => {
      if (requestId === cloudRequestId) {
        cloud.dataset.loading = "0";
      }
    });
  }
}

function refreshCloud() {
  const query = `?ts=${Date.now()}`;
  cloudFetchChain = cloudFetchChain.catch(() => {}).then(() => fetchCloud(query));
}

async function submitResponse(body) {
  try {
    const res = await fetch("/api/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body })
    });
    if (!res.ok) {
      let message = "Couldn’t submit. Try again.";
      try {
        const data = await res.json();
        if (data?.detail) {
          message = data.detail;
        }
      } catch (_) {
        if (res.status === 429) {
          message = "Please wait a moment before submitting again.";
        }
      }
      showToast(message);
      return false;
    }
    showToast("Submitted");
    refreshCloud();
    return true;
  } catch (err) {
    console.error(err);
    showToast("Network error. Try again.");
    return false;
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const value = (input.value || "").trim();
  if (!value) {
    showToast("Add a response first.");
    return;
  }
  if (value.length > 120) {
    showToast("Keep responses under 120 characters.");
    return;
  }
  const ok = await submitResponse(value);
  if (ok) {
    input.value = "";
    setCounter(0);
    input.focus();
  }
});

input.addEventListener("input", () => {
  setCounter((input.value || "").length);
});

cloud.addEventListener("error", () => {
  cloud.dataset.loading = "0";
});

function startSSE() {
  const es = new EventSource("/events");
  es.addEventListener("open", () => {
    sseRetry = 0;
  });
  es.addEventListener("response-created", () => {
    refreshCloud();
  });
  es.onerror = () => {
    es.close();
    sseRetry = Math.min(sseRetry + 1, 6);
    const delay = Math.min(30000, 2000 * 2 ** sseRetry) + Math.random() * 1000;
    setTimeout(startSSE, delay);
  };
}

window.addEventListener("beforeunload", () => {
  if (currentCloudUrl) {
    URL.revokeObjectURL(currentCloudUrl);
  }
});

setCounter((input.value || "").length);
fetchCloud();
startSSE();
