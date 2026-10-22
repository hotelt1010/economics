/* Adaptive economics study app — mastery-gated prerequisites + spaced review. */

const STORAGE_KEY = "econ-adaptive-state-v1";
const MASTERY_THRESHOLD = 0.8;
const SESSIONS_TO_MASTER = 2;
const REVIEW_INTERVALS = [1, 3, 7, 16, 35]; // days
const DIFFICULTY_WEIGHT = { easy: 0.08, med: 0.12, hard: 0.18 };
const WRONG_PENALTY_MULT = 1.3;
const MAX_NEW_TOPICS_PER_SESSION = 2;
const QUESTIONS_PER_TOPIC_PER_SESSION = 5;

let state = null;
let session = null; // { queue: [{topicId, mode}], index, touchedTopics: Set, currentQuestions: [] }

function today() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    state = JSON.parse(raw);
  } else {
    state = { topics: {} };
  }
  if (!state.streak) {
    state.streak = { current: 0, longest: 0, lastCompletedDate: null };
  }
  // Ensure every syllabus topic has a state entry (handles newly added topics),
  // and backfill fields added after a user's state was first saved.
  for (const t of window.SYLLABUS) {
    if (!state.topics[t.id]) {
      state.topics[t.id] = {
        mastery: 0,
        sessionsAboveThreshold: 0,
        masteredAt: null,
        review: { interval: 0, dueDate: null },
        missedQuestionIds: [],
        seenQuestionIds: [],
      };
    } else {
      const ts = state.topics[t.id];
      if (!ts.missedQuestionIds) ts.missedQuestionIds = [];
      if (!ts.seenQuestionIds) ts.seenQuestionIds = [];
    }
  }
  saveState();
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function topicById(id) {
  return window.SYLLABUS.find((t) => t.id === id);
}

function isMastered(id) {
  return !!state.topics[id].masteredAt;
}

function prereqsMet(topic) {
  return topic.prerequisites.every((p) => isMastered(p));
}

function topicStatus(topic) {
  if (isMastered(topic.id)) return "mastered";
  if (prereqsMet(topic)) return "available";
  return "locked";
}

function hasContent(id) {
  return !!(window.QUESTION_BANK && window.QUESTION_BANK[id] && window.QUESTION_BANK[id].length);
}

/* ---------- Queue building ---------- */

function buildTodaysQueue() {
  const t = today();
  const queue = [];

  // Due reviews first — mastered topics whose review is due.
  for (const topic of window.SYLLABUS) {
    const ts = state.topics[topic.id];
    if (isMastered(topic.id) && ts.review.dueDate && ts.review.dueDate <= t && hasContent(topic.id)) {
      queue.push({ topicId: topic.id, mode: "review" });
    }
  }

  // New/available topics with content, capped per session.
  let added = 0;
  for (const topic of window.SYLLABUS) {
    if (added >= MAX_NEW_TOPICS_PER_SESSION) break;
    const status = topicStatus(topic);
    if (status === "available" && hasContent(topic.id)) {
      queue.push({ topicId: topic.id, mode: "practice" });
      added++;
    }
  }

  return queue;
}

function shuffle(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
}

// Below-mastery topics get retested with: missed questions first (targeted
// remediation), then still-unseen questions from the bank (a "shuffle bag" —
// once every question has been seen once, the bag resets so the whole bank
// cycles before anything repeats), then random repeats only if the bank is
// smaller than the requested count.
function pickQuestions(topicId, count) {
  const bank = window.QUESTION_BANK[topicId] || [];
  const ts = state.topics[topicId];
  if (!bank.length) return [];

  const missed = shuffle(bank.filter((q) => ts.missedQuestionIds.includes(q.id)));
  let unseen = bank.filter((q) => !ts.seenQuestionIds.includes(q.id) && !ts.missedQuestionIds.includes(q.id));
  if (unseen.length === 0 && bank.length > missed.length) {
    // Whole bank has been seen — reset the cycle so it repeats from the top.
    ts.seenQuestionIds = [];
    unseen = bank.filter((q) => !ts.missedQuestionIds.includes(q.id));
  }
  unseen = shuffle(unseen);

  const selected = [];
  for (const q of [...missed, ...unseen]) {
    if (selected.length >= count) break;
    selected.push(q);
  }
  if (selected.length < count) {
    // Bank smaller than requested count — pad with random repeats.
    const rest = shuffle(bank.filter((q) => !selected.includes(q)));
    for (const q of [...rest, ...shuffle(bank)]) {
      if (selected.length >= count) break;
      if (!selected.includes(q)) selected.push(q);
    }
  }

  for (const q of selected) {
    if (!ts.seenQuestionIds.includes(q.id)) ts.seenQuestionIds.push(q.id);
  }
  saveState();

  return selected;
}

/* ---------- Mastery updates ---------- */

// Wrong answers get queued for targeted remediation (surfaced first next
// time via pickQuestions); a later correct answer clears that flag.
function updateMissedList(ts, questionId, correct) {
  const idx = ts.missedQuestionIds.indexOf(questionId);
  if (correct) {
    if (idx !== -1) ts.missedQuestionIds.splice(idx, 1);
  } else if (idx === -1) {
    ts.missedQuestionIds.push(questionId);
  }
}

function recordAnswer(topicId, question, correct) {
  const ts = state.topics[topicId];
  const w = DIFFICULTY_WEIGHT[question.difficulty] || 0.1;
  if (correct) {
    ts.mastery = Math.min(1, ts.mastery + w);
  } else {
    ts.mastery = Math.max(0, ts.mastery - w * WRONG_PENALTY_MULT);
  }
  updateMissedList(ts, question.id, correct);
  saveState();
}

function updateStreak() {
  const t = today();
  const s = state.streak;
  if (s.lastCompletedDate === t) {
    // Already logged a session today — don't double-count.
  } else if (s.lastCompletedDate === addDays(t, -1)) {
    s.current += 1;
  } else {
    s.current = 1;
  }
  s.longest = Math.max(s.longest, s.current);
  s.lastCompletedDate = t;
  saveState();
}

function endOfSessionEvaluation(touchedTopicIds) {
  for (const topicId of touchedTopicIds) {
    const ts = state.topics[topicId];
    if (isMastered(topicId)) continue; // review topics handled separately
    if (ts.mastery >= MASTERY_THRESHOLD) {
      ts.sessionsAboveThreshold += 1;
    } else {
      ts.sessionsAboveThreshold = 0;
    }
    if (ts.sessionsAboveThreshold >= SESSIONS_TO_MASTER) {
      ts.masteredAt = today();
      ts.review = { interval: REVIEW_INTERVALS[0], dueDate: addDays(today(), REVIEW_INTERVALS[0]) };
    }
  }
  saveState();
}

function recordReviewResult(topicId, question, correct) {
  const ts = state.topics[topicId];
  updateMissedList(ts, question.id, correct);
  if (correct) {
    ts.mastery = Math.min(1, ts.mastery + 0.05);
    const idx = REVIEW_INTERVALS.indexOf(ts.review.interval);
    const nextIdx = Math.min(idx + 1, REVIEW_INTERVALS.length - 1);
    ts.review.interval = REVIEW_INTERVALS[nextIdx < 0 ? 0 : nextIdx];
    ts.review.dueDate = addDays(today(), ts.review.interval);
  } else {
    ts.mastery = Math.max(0, ts.mastery - 0.2);
    ts.review.interval = REVIEW_INTERVALS[0];
    ts.review.dueDate = addDays(today(), REVIEW_INTERVALS[0]);
    if (ts.mastery < 0.6) {
      // Falls out of mastered status back into active learning.
      ts.masteredAt = null;
      ts.sessionsAboveThreshold = 0;
    }
  }
  saveState();
}

/* ---------- Rendering ---------- */

const app = document.getElementById("app");

function render() {
  if (session) {
    renderSession();
  } else {
    renderDashboard();
  }
}

function reviewStatusLabel(ts) {
  if (!ts.review.dueDate) return "";
  if (ts.review.dueDate <= today()) return `<span class="badge badge-due">review due</span>`;
  const days = Math.round((new Date(ts.review.dueDate) - new Date(today())) / 86400000);
  return `<span class="review-note">next review in ${days} day${days === 1 ? "" : "s"} (${ts.review.dueDate})</span>`;
}

function renderDashboard() {
  const queue = buildTodaysQueue();
  const reviewCount = queue.filter((i) => i.mode === "review").length;
  const newCount = queue.filter((i) => i.mode === "practice").length;
  const bySection = {};
  for (const t of window.SYLLABUS) {
    (bySection[t.section] = bySection[t.section] || []).push(t);
  }

  const parts = [];
  if (reviewCount) parts.push(`${reviewCount} due for review`);
  if (newCount) parts.push(`${newCount} in progress`);
  const breakdown = parts.length ? ` — ${parts.join(", ")}` : "";

  // A streak only stays "live" if today's or yesterday's session was logged —
  // otherwise it's lapsed and will reset to 1 on the next completed session.
  const s = state.streak;
  const streakLive = s.lastCompletedDate === today() || s.lastCompletedDate === addDays(today(), -1);
  const displayStreak = streakLive ? s.current : 0;

  let html = `<header class="topbar">
    <div class="title-row">
      <h1>Economics — Adaptive Study</h1>
      <span class="streak-badge" title="Longest streak: ${s.longest} day${s.longest === 1 ? "" : "s"}">🔥 ${displayStreak} day${displayStreak === 1 ? "" : "s"}</span>
    </div>
    <div class="header-actions">
      <a href="glossary.html" class="secondary-link">📖 Dictionary</a>
      <button id="start-session" class="primary" ${queue.length === 0 ? "disabled" : ""}>
        Start today's session (${queue.length} item${queue.length === 1 ? "" : "s"}${breakdown})
      </button>
    </div>
  </header>`;

  if (queue.length === 0) {
    html += `<p class="hint">Nothing due right now. Either everything unlocked is mastered and not due for review yet, or the next topic doesn't have questions loaded yet.</p>`;
  }

  html += `<div class="sections">`;
  for (const [section, topics] of Object.entries(bySection)) {
    html += `<section class="section-block"><h2>${section}</h2><ul class="topic-list">`;
    for (const t of topics) {
      const status = topicStatus(t);
      const ts = state.topics[t.id];
      const pct = Math.round(ts.mastery * 100);
      const content = hasContent(t.id) ? "" : `<span class="badge badge-nocontent">no content yet</span>`;
      const belowThreshold = status === "available" && ts.mastery > 0 && ts.mastery < MASTERY_THRESHOLD;
      const remediation = belowThreshold && ts.missedQuestionIds.length
        ? `<span class="badge badge-remediate">${ts.missedQuestionIds.length} to retest</span>`
        : "";
      html += `<li class="topic status-${status}">
        <span class="status-dot"></span>
        <span class="topic-title">${t.id}. ${t.title}</span>
        ${content}
        <span class="badge badge-${status}">${status}</span>
        ${remediation}
        ${status === "mastered" ? reviewStatusLabel(ts) : ""}
        ${status !== "locked" ? `<span class="mastery-bar"><span class="mastery-fill" style="width:${pct}%"></span></span><span class="mastery-pct">${pct}%</span>` : ""}
      </li>`;
    }
    html += `</ul></section>`;
  }
  html += `</div>`;

  app.innerHTML = html;
  const btn = document.getElementById("start-session");
  if (btn) btn.addEventListener("click", startSession);
}

function startSession() {
  const queue = buildTodaysQueue();
  session = { queue, index: 0, touchedTopics: new Set(), currentQuestions: [], qIndex: 0, correctCount: 0, totalCount: 0 };
  loadNextQueueItem();
}

function loadNextQueueItem() {
  if (session.index >= session.queue.length) {
    endSession();
    return;
  }
  const item = session.queue[session.index];
  session.touchedTopics.add(item.topicId);
  const count = item.mode === "review" ? 3 : QUESTIONS_PER_TOPIC_PER_SESSION;
  session.currentQuestions = pickQuestions(item.topicId, count);
  session.qIndex = 0;
  session.currentMode = item.mode;
  session.currentTopicId = item.topicId;
  render();
}

function renderSession() {
  const topic = topicById(session.currentTopicId);
  const q = session.currentQuestions[session.qIndex];

  if (!q) {
    // No questions left for this topic item — move to next queue entry.
    session.index += 1;
    loadNextQueueItem();
    return;
  }

  const modeLabel = session.currentMode === "review" ? "Review" : "Practice";
  let optionsHtml = "";
  if (q.type === "mcq") {
    optionsHtml = `<div class="options">` + q.options.map((opt, i) =>
      `<button class="option" data-idx="${i}">${opt}</button>`
    ).join("") + `</div>`;
  } else {
    optionsHtml = `<div class="answer-input-row">
        <textarea id="short-answer" rows="3" placeholder="Type or speak your answer, then reveal the model answer to self-check."></textarea>
        <button id="mic-btn" class="mic-btn" type="button" title="Speak your answer">🎤</button>
      </div>
      <button id="reveal" class="secondary">Reveal answer</button>`;
  }

  app.innerHTML = `
    <header class="topbar">
      <button id="quit-session" class="secondary">← Back to dashboard</button>
      <span class="session-progress">${modeLabel}: ${topic.title} — Q${session.qIndex + 1}/${session.currentQuestions.length}</span>
    </header>
    <div class="question-card">
      <div class="difficulty-tag difficulty-${q.difficulty}">${q.difficulty}</div>
      <p class="prompt">${q.prompt}</p>
      ${optionsHtml}
      <div id="feedback" class="feedback"></div>
      <button id="next-question" class="primary" style="display:none">Next</button>
    </div>
  `;

  document.getElementById("quit-session").addEventListener("click", () => {
    session = null;
    render();
  });

  if (q.type === "mcq") {
    document.querySelectorAll(".option").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.idx, 10);
        answerQuestion(q, idx === q.answer);
        document.querySelectorAll(".option").forEach((b, i) => {
          b.disabled = true;
          if (i === q.answer) b.classList.add("correct");
          else if (i === idx) b.classList.add("incorrect");
        });
      });
    });
  } else {
    document.getElementById("reveal").addEventListener("click", () => {
      const fb = document.getElementById("feedback");
      fb.innerHTML = `<p class="model-answer"><strong>Model answer:</strong> ${q.answer}</p>
        <p class="explanation">${q.explanation}</p>
        <div class="self-check">
          <button id="self-correct" class="primary">I got it right</button>
          <button id="self-wrong" class="secondary">I got it wrong</button>
        </div>`;
      document.getElementById("self-correct").addEventListener("click", () => answerQuestion(q, true));
      document.getElementById("self-wrong").addEventListener("click", () => answerQuestion(q, false));
      document.getElementById("reveal").disabled = true;
    });
    setupMicButton();
  }
}

// Voice input for short-answer questions via the Web Speech API. Chrome/Edge
// only, and requires a secure context (https:// or http://localhost) plus
// an internet connection — it will not work over a plain file:// double-click,
// so the button self-disables with an explanation when unavailable.
function setupMicButton() {
  const micBtn = document.getElementById("mic-btn");
  if (!micBtn) return;

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    micBtn.disabled = true;
    micBtn.classList.add("mic-unavailable");
    micBtn.title = "Voice input isn't available here — try Chrome or Edge, opened via a local server (not double-clicked from file://).";
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = "en-US";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  let listening = false;

  const setIdle = () => {
    listening = false;
    micBtn.classList.remove("listening");
    micBtn.textContent = "🎤";
  };

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    const textarea = document.getElementById("short-answer");
    if (textarea) {
      textarea.value = textarea.value ? `${textarea.value} ${transcript}` : transcript;
    }
  };
  recognition.onerror = (event) => {
    setIdle();
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      alert("Microphone access was blocked. Allow microphone permission for this page to use voice input.");
    }
  };
  recognition.onend = setIdle;

  micBtn.addEventListener("click", () => {
    if (listening) {
      recognition.stop();
      return;
    }
    try {
      recognition.start();
      listening = true;
      micBtn.classList.add("listening");
      micBtn.textContent = "⏹";
    } catch (e) {
      setIdle();
    }
  });
}

function answerQuestion(q, correct) {
  session.totalCount += 1;
  if (correct) session.correctCount += 1;

  if (session.currentMode === "review") {
    recordReviewResult(session.currentTopicId, q, correct);
  } else {
    recordAnswer(session.currentTopicId, q, correct);
  }

  const fb = document.getElementById("feedback");
  if (q.type === "mcq") {
    fb.innerHTML = `<p class="${correct ? "correct-text" : "incorrect-text"}">${correct ? "Correct!" : "Not quite."}</p>
      <p class="explanation">${q.explanation}</p>`;
  } else {
    fb.innerHTML += `<p class="${correct ? "correct-text" : "incorrect-text"}">${correct ? "Marked correct." : "Marked wrong — review the model answer above."}</p>`;
  }

  const nextBtn = document.getElementById("next-question");
  nextBtn.style.display = "inline-block";
  nextBtn.onclick = () => {
    session.qIndex += 1;
    const q2 = session.currentQuestions[session.qIndex];
    if (!q2) {
      session.index += 1;
      loadNextQueueItem();
    } else {
      render();
    }
  };
}

function endSession() {
  endOfSessionEvaluation([...session.touchedTopics]);
  updateStreak();
  const s = state.streak;
  const summary = `<header class="topbar"><h1>Session complete</h1></header>
    <div class="question-card">
      <p>You answered ${session.correctCount}/${session.totalCount} correctly.</p>
      <p>Topics touched: ${[...session.touchedTopics].map((id) => topicById(id).title).join(", ")}</p>
      <p class="streak-line">🔥 ${s.current} day streak${s.current === s.longest && s.longest > 1 ? " — new best!" : ""}</p>
      <button id="back-to-dashboard" class="primary">Back to dashboard</button>
    </div>`;
  app.innerHTML = summary;
  document.getElementById("back-to-dashboard").addEventListener("click", () => {
    session = null;
    render();
  });
}

/* ---------- Init ---------- */

// Boot is triggered by auth.js (after it resolves any sign-in/sync), via window.startApp().
