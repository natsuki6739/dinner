(() => {
  "use strict";

  const $ = id => document.getElementById(id);
  const HISTORY_KEY = "kinnmeshi-history-jp-v1";
  let recipes = [];

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function splitWords(value) {
    return String(value ?? "")
      .split(/[、,\s]+/)
      .map(word => word.trim().toLowerCase())
      .filter(Boolean);
  }

  function recipeText(recipe) {
    return [
      recipe.name,
      recipe.category,
      recipe.area,
      ...(recipe.tags || []),
      ...(recipe.ingredients || []),
      ...(recipe.proteinFoods || []),
      recipe.sourceName
    ].join(" ").toLowerCase();
  }

  function setError(message = "") {
    const box = $("errorBox");
    box.textContent = message;
    box.classList.toggle("hidden", !message);
  }

  async function loadJson(path, fallback) {
    try {
      const response = await fetch(`${path}?v=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      console.warn(`${path}の読み込み失敗`, error);
      return fallback;
    }
  }

  function updateStatus(report) {
    const domains = [...new Set(recipes.map(recipe => recipe.sourceDomain).filter(Boolean))].sort();
    $("recipeCount").textContent = `${recipes.length}件の日本語レシピ`;

    $("sourceCount").textContent = domains.length ? `${domains.length}サイト由来` : "";
    $("sourceCount").classList.toggle("hidden", !domains.length);

    const generated = report?.generatedAt ? new Date(report.generatedAt) : null;
    $("checkedAt").textContent = generated && !Number.isNaN(generated.getTime())
      ? `${generated.toLocaleDateString("ja-JP")}確認`
      : "";
    $("checkedAt").classList.toggle("hidden", !$("checkedAt").textContent);

    $("domainList").innerHTML = domains.map(domain => `<span>${escapeHtml(domain)}</span>`).join("");
  }

  function filterCandidates() {
    const goal = $("goal").value;
    const maxTimeValue = $("maxTime").value;
    const include = splitWords($("includeWords").value);
    const exclude = splitWords($("excludeWords").value);

    let candidates = recipes.filter(recipe => goal === "any" || (recipe.goals || []).includes(goal));

    if (maxTimeValue !== "any") {
      const maxTime = Number(maxTimeValue);
      candidates = candidates.filter(recipe =>
        Number.isFinite(recipe.timeMinutes) && recipe.timeMinutes <= maxTime
      );
    }

    candidates = candidates.filter(recipe => {
      const text = recipeText(recipe);
      return !exclude.some(word => text.includes(word));
    });

    if (include.length && candidates.length) {
      const scored = candidates.map(recipe => ({
        recipe,
        score: include.reduce((total, word) => total + Number(recipeText(recipe).includes(word)), 0)
      })).sort((a, b) => b.score - a.score);

      const bestScore = scored[0]?.score || 0;
      if (bestScore > 0) {
        candidates = scored.filter(item => item.score === bestScore).map(item => item.recipe);
      }
    }

    return candidates;
  }

  function pickRecipe() {
    setError("");
    if (!recipes.length) {
      setError("料理データを読み込めませんでした。少し待ってからページを再読み込みしてください。");
      return;
    }

    const candidates = filterCandidates();
    if (!candidates.length) {
      setError("条件に合うレシピがありません。条件を少し緩めてください。");
      return;
    }

    showRecipe(candidates[Math.floor(Math.random() * candidates.length)], true);
  }

  function showRecipe(recipe, addToHistory) {
    $("mealName").textContent = recipe.name;
    $("mealMeta").textContent = `${recipe.area || "日本の家庭料理"}・${recipe.category || "料理"}`;
    $("timeBadge").textContent = recipe.timeMinutes ? `約${recipe.timeMinutes}分` : "時間記載なし";

    const badges = [
      `たんぱく質 ${recipe.proteinLabel || "目安"}`,
      ...(recipe.proteinFoods || []).slice(0, 3),
      Number.isFinite(recipe.calories) ? `${recipe.calories}kcal` : ""
    ].filter(Boolean);

    $("goalBadges").innerHTML = badges.map(label => `<span>${escapeHtml(label)}</span>`).join("");
    $("ingredientList").innerHTML = (recipe.ingredients || []).map(item => `<li>${escapeHtml(item)}</li>`).join("");
    $("stepList").innerHTML = (recipe.steps || []).map(step => `<li>${escapeHtml(step)}</li>`).join("");
    $("sourceLink").href = recipe.sourceUrl;
    $("sourceLink").textContent = `出典：${recipe.sourceName || "元サイト"}で確認`;
    $("resultCard").classList.remove("hidden");

    if (addToHistory) addHistory(recipe);
    $("resultCard").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function historyItems() {
    try {
      const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
      return Array.isArray(value) ? value : [];
    } catch (_) {
      return [];
    }
  }

  function addHistory(recipe) {
    const history = historyItems();
    history.unshift({
      id: recipe.id,
      name: recipe.name,
      category: recipe.category,
      date: new Date().toLocaleString("ja-JP"),
      sourceUrl: recipe.sourceUrl
    });
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 100)));
    renderHistory();
  }

  function renderHistory() {
    const history = historyItems();
    if (!history.length) {
      $("history").className = "muted";
      $("history").textContent = "まだありません。";
      return;
    }

    $("history").className = "";
    $("history").innerHTML = history.map((item, index) => `
      <div class="history-item" data-history-index="${index}">
        <strong>${escapeHtml(item.name)}</strong>
        <small>${escapeHtml(item.category || "料理")}・${escapeHtml(item.date)}</small>
      </div>
    `).join("");

    document.querySelectorAll("[data-history-index]").forEach(element => {
      element.addEventListener("click", () => {
        const item = history[Number(element.dataset.historyIndex)];
        const recipe = recipes.find(candidate => String(candidate.id) === String(item.id));
        if (recipe) showRecipe(recipe, false);
        else if (item.sourceUrl) window.open(item.sourceUrl, "_blank", "noopener");
      });
    });
  }

  function renderCatalog(query = "") {
    const normalized = String(query ?? "").trim().toLowerCase();
    const filtered = recipes.filter(recipe => !normalized || recipeText(recipe).includes(normalized));
    $("catalogCount").textContent = `${filtered.length}件表示`;

    $("catalog").innerHTML = filtered.map((recipe, index) => `
      <details class="catalog-item">
        <summary>
          <span class="catalog-index">${index + 1}</span>
          <span class="catalog-title">
            <strong>${escapeHtml(recipe.name)}</strong>
            <small>${escapeHtml(recipe.category || "料理")}・約${escapeHtml(recipe.timeMinutes || "-")}分・出典 ${escapeHtml(recipe.sourceName || "元サイト")}</small>
          </span>
        </summary>
        <div class="catalog-body">
          <div class="badges">
            <span>たんぱく質 ${escapeHtml(recipe.proteinLabel || "目安")}</span>
            ${(recipe.proteinFoods || []).slice(0, 3).map(label => `<span>${escapeHtml(label)}</span>`).join("")}
          </div>
          <h3>材料・分量</h3>
          <ul>${(recipe.ingredients || []).map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
          <h3>簡易手順</h3>
          <ol>${(recipe.steps || []).map(step => `<li>${escapeHtml(step)}</li>`).join("")}</ol>
          <a class="source-link" href="${escapeHtml(recipe.sourceUrl)}" target="_blank" rel="noopener noreferrer">
            出典：${escapeHtml(recipe.sourceName || "元サイト")}で確認
          </a>
        </div>
      </details>
    `).join("");
  }

  async function initialize() {
    setError("");
    const [loadedRecipes, report] = await Promise.all([
      loadJson("./recipes.json", []),
      loadJson("./recipes-validation.json", null)
    ]);

    recipes = Array.isArray(loadedRecipes) ? loadedRecipes : [];
    updateStatus(report);
    renderHistory();
    renderCatalog();

    if (recipes.length !== 500) {
      setError(`料理データは現在${recipes.length}件です。500件の更新処理が完了するまで少しお待ちください。`);
    }
  }

  $("pickButton").addEventListener("click", pickRecipe);
  $("anotherButton").addEventListener("click", pickRecipe);
  $("toggleCatalogButton").addEventListener("click", () => {
    const area = $("catalogArea");
    const opening = area.classList.contains("hidden");
    area.classList.toggle("hidden", !opening);
    $("toggleCatalogButton").textContent = opening ? "一覧を閉じる" : "一覧を開く";
    if (opening) renderCatalog($("catalogSearch").value);
  });
  $("catalogSearch").addEventListener("input", event => renderCatalog(event.target.value));
  $("clearHistoryButton").addEventListener("click", () => {
    if (window.confirm("履歴をすべて削除しますか？")) {
      localStorage.removeItem(HISTORY_KEY);
      renderHistory();
    }
  });

  initialize();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js?v=20260714-2").catch(error => {
        console.warn("オフライン機能の登録に失敗しました。", error);
      });
    });
  }
})();
