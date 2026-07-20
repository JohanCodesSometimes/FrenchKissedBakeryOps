(() => {
  "use strict";

  const list = document.querySelector("#trend-list");
  const state = document.querySelector("#trend-state");
  const filters = document.querySelector("#trend-filters");
  const addDialog = document.querySelector("#trend-dialog");
  const addForm = document.querySelector("#trend-form");
  const recommendationDialog = document.querySelector("#trend-recommendation-dialog");
  const recommendationForm = document.querySelector("#trend-recommendation-form");
  const trendsById = new Map();
  let refreshSequence = 0;
  let submitting = false;
  let searchTimer = null;

  if (!list || !state || !filters || !addDialog || !addForm) return;

  document.querySelector("#open-trend-dialog").addEventListener("click", () => {
    addForm.reset();
    addForm.elements.sourcePlatform.value = "TikTok (manually observed)";
    addForm.elements.engagementScore.value = "0";
    addDialog.showModal();
    addForm.elements.title.focus();
  });

  document.querySelectorAll("[data-trend-close]").forEach((button) => {
    button.addEventListener("click", () => button.closest("dialog").close());
  });
  [addDialog, recommendationDialog].forEach((dialog) => dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  }));

  filters.addEventListener("submit", (event) => event.preventDefault());
  filters.addEventListener("change", refreshTrends);
  filters.elements.search.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(refreshTrends, 250);
  });

  document.addEventListener("click", (event) => {
    const nav = event.target.closest('[data-view-target="trends-view"]');
    if (nav) refreshTrends();
    const action = event.target.closest("[data-trend-action]");
    if (action) handleAction(action);
  });

  addForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitting || !addForm.reportValidity()) return;
    const fields = Object.fromEntries(new FormData(addForm).entries());
    submitting = true;
    setFormBusy(addForm, true, "Adding…");
    try {
      fields.hashtags = fields.hashtags.split(/[\s,]+/).filter(Boolean);
      fields.engagementScore = Number(fields.engagementScore || 0);
      await request("/api/trends", { method: "POST", body: fields });
      addDialog.close();
      showNotice("Trend added to your curated list", "success");
      await refreshTrends();
    } catch (error) {
      showNotice(error.message, "error");
    } finally {
      submitting = false;
      setFormBusy(addForm, false, "Add Trend");
    }
  });

  recommendationForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitting || !recommendationForm.reportValidity()) return;
    const fields = Object.fromEntries(new FormData(recommendationForm).entries());
    submitting = true;
    setFormBusy(recommendationForm, true, "Saving…");
    try {
      const id = fields.id;
      delete fields.id;
      await request(`/api/trends/${encodeURIComponent(id)}`, { method: "PATCH", body: fields });
      recommendationDialog.close();
      showNotice("Recommendation updated", "success");
      await refreshTrends();
    } catch (error) {
      showNotice(error.message, "error");
    } finally {
      submitting = false;
      setFormBusy(recommendationForm, false, "Save Recommendation");
    }
  });

  async function refreshTrends() {
    const sequence = ++refreshSequence;
    showState("Loading trends…", "Checking your curated opportunity list.");
    const params = new URLSearchParams();
    for (const [key, value] of new FormData(filters).entries()) {
      if (value) params.set(key, value);
    }
    params.set("limit", "100");
    try {
      const result = await request(`/api/trends?${params.toString()}`);
      if (sequence !== refreshSequence) return;
      renderSummary(result.summary || {});
      renderTrends(result.trends || []);
    } catch (error) {
      if (sequence !== refreshSequence) return;
      list.hidden = true;
      showState("Trend Finder could not load", error.message, true);
    }
  }

  function renderSummary(summary) {
    setText("#trend-active-count", summary.activeTrends || 0);
    setText("#trend-high-count", summary.highOpportunityTrends || 0);
    setText("#trend-new-count", summary.newThisWeek || 0);
    setText("#trend-average-score", summary.averageOpportunityScore || 0);
  }

  function renderTrends(trends) {
    trendsById.clear();
    trends.forEach((trend) => trendsById.set(trend.id, trend));
    list.replaceChildren();
    if (!trends.length) {
      list.hidden = true;
      showState("No matching trends", "Add a manually observed trend or adjust the filters.");
      return;
    }
    for (const trend of trends) list.append(buildTrendCard(trend));
    state.hidden = true;
    list.hidden = false;
  }

  function buildTrendCard(trend) {
    const card = element("article", "trend-card");
    const header = element("div", "trend-card-header");
    const heading = element("div");
    heading.append(element("p", "eyebrow", titleCase(trend.category)), element("h3", "", trend.title));
    const badges = element("div", "trend-badges");
    badges.append(
      badge(titleCase(trend.trendStatus), `trend-status-${trend.trendStatus}`),
      badge(trend.dataOrigin === "demo" ? "Demo sample" : trend.dataOrigin === "provider" ? "Configured provider" : "Manually curated", "trend-origin"),
    );
    header.append(heading, badges);
    card.append(header);

    if (trend.description) card.append(element("p", "trend-description", trend.description));
    const source = element("div", "trend-source-row");
    source.append(element("span", "", `Source: ${trend.sourcePlatform || "Manual curation"}`));
    if (trend.sourceUrl) {
      const link = element("a", "trend-source-link", "Open source ↗");
      link.href = trend.sourceUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      source.append(link);
    }
    card.append(source);

    if (trend.hashtags?.length) {
      const tags = element("div", "trend-hashtags");
      trend.hashtags.forEach((hashtag) => tags.append(element("span", "", hashtag)));
      card.append(tags);
    }

    const scores = element("dl", "trend-scores");
    scores.append(
      scoreItem("Engagement", trend.engagementScore),
      scoreItem("Relevance", trend.relevanceScore),
      scoreItem("Opportunity", trend.opportunityScore, true),
    );
    card.append(scores);

    const recommendation = element("div", "trend-recommendation");
    recommendation.append(element("strong", "", "Bakery recommendation"));
    recommendation.append(element("p", "", trend.suggestedProduct || "Analyze this trend to create a product idea."));
    if (trend.suggestedAction) recommendation.append(element("p", "trend-action-copy", trend.suggestedAction));
    if (trend.analysisReasoning) recommendation.append(element("small", "", trend.analysisReasoning));
    card.append(recommendation);

    card.append(element("p", "trend-dates", `First seen ${formatDate(trend.firstSeenAt)} · Last seen ${formatDate(trend.lastSeenAt)}`));
    const actions = element("div", "trend-actions");
    actions.append(
      actionButton("Analyze", "analyze", trend.id, "primary-button"),
      actionButton("Watch", "watching", trend.id),
      actionButton("Test", "testing", trend.id),
      actionButton("Adopt", "adopted", trend.id),
      actionButton("Edit recommendation", "edit", trend.id),
      actionButton("Archive", "archived", trend.id, "ghost-button danger"),
    );
    card.append(actions);
    return card;
  }

  async function handleAction(button) {
    const trend = trendsById.get(button.dataset.trendId);
    if (!trend || button.disabled) return;
    if (button.dataset.trendAction === "edit") {
      recommendationForm.elements.id.value = trend.id;
      recommendationForm.elements.suggestedProduct.value = trend.suggestedProduct || "";
      recommendationForm.elements.suggestedAction.value = trend.suggestedAction || "";
      recommendationDialog.showModal();
      recommendationForm.elements.suggestedProduct.focus();
      return;
    }
    button.disabled = true;
    const original = button.textContent;
    button.textContent = button.dataset.trendAction === "analyze" ? "Analyzing…" : "Saving…";
    try {
      if (button.dataset.trendAction === "analyze") {
        await request(`/api/trends/${encodeURIComponent(trend.id)}/analyze`, { method: "POST" });
        showNotice("Bakery recommendation refreshed", "success");
      } else {
        await request(`/api/trends/${encodeURIComponent(trend.id)}`, {
          method: "PATCH",
          body: { trendStatus: button.dataset.trendAction },
        });
        showNotice(`Trend marked ${button.dataset.trendAction}`, "success");
      }
      await refreshTrends();
    } catch (error) {
      button.disabled = false;
      button.textContent = original;
      showNotice(error.message, "error");
    }
  }

  async function request(url, options = {}) {
    const requestOptions = { credentials: "same-origin", cache: "no-store", ...options };
    if (options.body !== undefined) {
      requestOptions.headers = { "Content-Type": "application/json" };
      requestOptions.body = JSON.stringify(options.body);
    }
    const response = await fetch(url, requestOptions);
    let result = {};
    try { result = await response.json(); } catch { /* Safe generic error below. */ }
    if (!response.ok) throw new Error(result.error || "Trend Finder request failed");
    return result;
  }

  function showState(title, copy, error = false) {
    state.replaceChildren();
    const empty = element("div", `empty-state${error ? " trend-error" : ""}`);
    empty.append(element("strong", "", title), element("p", "", copy));
    state.append(empty);
    state.hidden = false;
  }

  function setFormBusy(form, busy, label) {
    [...form.elements].forEach((control) => { control.disabled = busy; });
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = busy;
    submit.textContent = label;
  }

  function scoreItem(label, value, highlight = false) {
    const item = element("div", highlight ? "opportunity" : "");
    item.append(element("dt", "", label), element("dd", "", `${Number(value || 0)}/100`));
    return item;
  }

  function badge(text, className) { return element("span", `pill ${className}`, text); }
  function actionButton(label, action, id, className = "secondary-button") {
    const button = element("button", className, label);
    button.type = "button";
    button.dataset.trendAction = action;
    button.dataset.trendId = id;
    return button;
  }
  function element(tag, className = "", text = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== "") node.textContent = text;
    return node;
  }
  function setText(selector, value) { const node = document.querySelector(selector); if (node) node.textContent = value; }
  function titleCase(value) { return String(value || "").replace(/(^|[-_\s])\w/g, (match) => match.toUpperCase()); }
  function formatDate(value) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "not available" : parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  refreshTrends();
})();
