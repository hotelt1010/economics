/* Alphabetical economics dictionary — search + grouped list, built from data/glossary.js */

function topicTitle(id) {
  const t = window.SYLLABUS.find((s) => s.id === id);
  return t ? `${t.id}. ${t.title}` : id;
}

function renderGlossary(filterText) {
  const container = document.getElementById("glossary-list");
  const q = (filterText || "").trim().toLowerCase();

  const terms = [...window.GLOSSARY]
    .filter((e) => !q || e.term.toLowerCase().includes(q) || e.definition.toLowerCase().includes(q))
    .sort((a, b) => a.term.localeCompare(b.term));

  if (terms.length === 0) {
    container.innerHTML = `<p class="hint">No terms match "${filterText}".</p>`;
    return;
  }

  let html = "";
  let currentLetter = "";
  for (const entry of terms) {
    const letter = entry.term[0].toUpperCase();
    if (letter !== currentLetter) {
      currentLetter = letter;
      html += `<h2 class="glossary-letter">${currentLetter}</h2>`;
    }
    const topicBadges = (entry.topics || [])
      .map((id) => `<span class="badge badge-available" title="${topicTitle(id)}">${id}</span>`)
      .join(" ");
    html += `<div class="glossary-entry">
      <div class="glossary-term">${entry.term} ${topicBadges}</div>
      <div class="glossary-def">${entry.definition}</div>
    </div>`;
  }
  container.innerHTML = html;
}

document.getElementById("glossary-search").addEventListener("input", (e) => {
  renderGlossary(e.target.value);
});

renderGlossary("");
