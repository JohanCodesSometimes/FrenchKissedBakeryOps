(() => {
  "use strict";

  const list = document.querySelector("#trend-list");
  const state = document.querySelector("#trend-state");
  const filters = document.querySelector("#trend-filters");
  const addDialog = document.querySelector("#trend-dialog");
  const addForm = document.querySelector("#trend-form");
  const recommendationDialog = document.querySelector("#trend-recommendation-dialog");
  const recommendationForm = document.querySelector("#trend-recommendation-form");
  const testDialog = document.querySelector("#trend-test-dialog");
  const testForm = document.querySelector("#trend-test-form");
  const trendsById = new Map();
  const dialogTriggers = new WeakMap();
  let youtubeTrends = [];
  let youtubeResult = null;
  let refreshSequence = 0;
  let submitting = false;
  let searchTimer = null;

  if (!list || !state || !filters || !addDialog || !addForm) return;

  document.querySelector("#open-trend-dialog").addEventListener("click", (event) => {
    addForm.reset();
    addForm.elements.sourcePlatform.value = "TikTok (manually observed)";
    addForm.elements.engagementScore.value = "0";
    openDialog(addDialog, event.currentTarget);
    addForm.elements.title.focus();
  });

  document.querySelectorAll("[data-trend-close]").forEach((button) => {
    button.addEventListener("click", () => button.closest("dialog").close());
  });
  [addDialog, recommendationDialog, testDialog].forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog && !submitting) dialog.close();
    });
    dialog.addEventListener("cancel", (event) => {
      if (submitting) event.preventDefault();
    });
    dialog.addEventListener("close", () => {
      const trigger = dialogTriggers.get(dialog);
      dialogTriggers.delete(dialog);
      trigger?.focus?.({ preventScroll: true });
    });
  });

  filters.addEventListener("submit", (event) => event.preventDefault());
  filters.addEventListener("change", refreshTrends);
  document.querySelector("#refresh-youtube-trends")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "Refreshing…";
    try {
      await refreshTrends({ youtubeRefresh: true });
    } finally {
      button.disabled = false;
      button.textContent = "Refresh YouTube";
    }
  });
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

  testForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitting || !testForm.reportValidity()) return;
    const fields = Object.fromEntries(new FormData(testForm).entries());
    const id = fields.id;
    delete fields.id;
    const numberFields = ["expectedIngredientCost", "plannedQuantity", "targetSellingPrice", "actualQuantityProduced", "actualQuantitySold", "actualRevenue"];
    numberFields.forEach((field) => {
      fields[field] = fields[field] === "" ? null : Number(fields[field]);
    });
    fields.trendStatus = "testing";
    submitting = true;
    setFormBusy(testForm, true, "Saving…");
    const errorBox = document.querySelector("#trend-test-error");
    errorBox.hidden = true;
    try {
      await request(`/api/trends/${encodeURIComponent(id)}`, { method: "PATCH", body: fields });
      testDialog.close();
      showNotice("Trend test saved", "success");
      await refreshTrends();
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
    } finally {
      submitting = false;
      setFormBusy(testForm, false, "Save Trend Test");
    }
  });

  async function refreshTrends(options = {}) {
    const sequence = ++refreshSequence;
    showState("Loading trends…", "Checking curated ideas and available provider signals.");
    const params = new URLSearchParams();
    for (const [key, value] of new FormData(filters).entries()) {
      if (value && key !== "source") params.set(key, value);
    }
    params.set("limit", "100");
    try {
      const [result, provider] = await Promise.all([
        request(`/api/trends?${params.toString()}`),
        request(`/api/trends/youtube${options.youtubeRefresh ? "?refresh=1" : ""}`),
      ]);
      if (sequence !== refreshSequence) return;
      youtubeResult = provider;
      youtubeTrends = provider.trends || [];
      renderProviderStatus(provider);
      const combined = combineVisibleTrends(result.trends || [], youtubeTrends);
      renderSummary(buildCombinedSummary(combined));
      renderTrends(combined);
    } catch (error) {
      if (sequence !== refreshSequence) return;
      list.hidden = true;
      showState("Trend Finder could not load", error.message, true);
    }
  }

  function combineVisibleTrends(curated, youtube) {
    const source = filters.elements.source?.value || "all";
    const search = String(filters.elements.search?.value || "").trim().toLowerCase();
    const category = filters.elements.category?.value || "";
    const status = filters.elements.status?.value || "";
    const visibleYouTube = youtube.filter((trend) => {
      if (category && trend.category !== category) return false;
      if (status && status !== "active") return false;
      if (!search) return true;
      return [trend.title, trend.suggestedProduct, trend.channel, trend.topic].join(" ").toLowerCase().includes(search);
    });
    const rows = source === "curated" ? curated : source === "youtube" ? visibleYouTube : [...curated, ...visibleYouTube];
    const sort = filters.elements.sort?.value || "opportunity";
    const sorters = {
      opportunity: (a, b) => Number(b.opportunityScore || 0) - Number(a.opportunityScore || 0),
      engagement: (a, b) => Number(b.engagementScore || 0) - Number(a.engagementScore || 0),
      relevance: (a, b) => Number(b.relevanceScore || 0) - Number(a.relevanceScore || 0),
      recent: (a, b) => Date.parse(b.publishedAt || b.lastSeenAt || 0) - Date.parse(a.publishedAt || a.lastSeenAt || 0),
      oldest: (a, b) => Date.parse(a.publishedAt || a.lastSeenAt || 0) - Date.parse(b.publishedAt || b.lastSeenAt || 0),
    };
    return rows.sort(sorters[sort]);
  }

  function buildCombinedSummary(trends) {
    const visible = trends.filter((trend) => trend.trendStatus !== "archived");
    const weekAgo = Date.now() - 7 * 86_400_000;
    return {
      activeTrends: visible.length,
      highOpportunityTrends: visible.filter((trend) => Number(trend.opportunityScore || 0) >= 75).length,
      newThisWeek: visible.filter((trend) => Date.parse(trend.publishedAt || trend.firstSeenAt || 0) >= weekAgo).length,
      averageOpportunityScore: visible.length
        ? Math.round(visible.reduce((sum, trend) => sum + Number(trend.opportunityScore || 0), 0) / visible.length)
        : 0,
    };
  }

  function renderProviderStatus(provider) {
    const box = document.querySelector("#youtube-provider-status");
    if (!box) return;
    box.className = `provider-status ${provider.available ? "available" : "unavailable"}`;
    box.replaceChildren();
    box.append(element("strong", "", "YouTube discovery"));
    const copy = provider.available
      ? `${provider.trends?.length || 0} normalized opportunities${provider.cached ? " from the protected cache" : ""}${provider.stale ? " (stale while the provider recovers)" : ""}. Retrieved ${formatDateTime(provider.retrievedAt)}.`
      : provider.error?.message || "YouTube discovery is not configured. Curated trends remain available.";
    box.append(element("span", "", copy));
  }

  function renderSummary(summary) {
    setText("#trend-active-count", summary.activeTrends || 0);
    setText("#trend-high-count", summary.highOpportunityTrends || 0);
    setText("#trend-new-count", summary.newThisWeek || 0);
    setText("#trend-average-score", summary.averageOpportunityScore || 0);
  }

  function renderTrends(trends) {
    trendsById.clear();
    trends.filter((trend) => trend.dataOrigin !== "youtube").forEach((trend) => trendsById.set(trend.id, trend));
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
    const isYouTube = trend.dataOrigin === "youtube";
    const card = element("article", `trend-card${isYouTube ? " youtube-trend-card" : ""}`);
    const header = element("div", "trend-card-header");
    const heading = element("div");
    heading.append(element("p", "eyebrow", titleCase(trend.category)), element("h3", "", trend.title));
    const badges = element("div", "trend-badges");
    badges.append(
      badge(isYouTube ? trend.recommendation : titleCase(trend.trendStatus), `trend-status-${isYouTube ? recommendationClass(trend.recommendation) : trend.trendStatus}`),
      badge(isYouTube ? "YouTube signal" : trend.dataOrigin === "demo" ? "Demo sample" : trend.dataOrigin === "provider" ? "Configured provider" : "Manually curated", "trend-origin"),
    );
    header.append(heading, badges);
    card.append(header);

    if (isYouTube && trend.thumbnailUrl) {
      const image = element("img", "trend-thumbnail");
      image.src = trend.thumbnailUrl;
      image.alt = "";
      image.loading = "lazy";
      image.referrerPolicy = "no-referrer";
      card.append(image);
    }
    if (trend.description) card.append(element("p", "trend-description", trend.description));
    const source = element("div", "trend-source-row");
    source.append(element("span", "", isYouTube
      ? `YouTube · ${trend.channel} · ${formatDate(trend.publishedAt)}`
      : `Source: ${trend.sourcePlatform || "Manual curation"}`));
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

    if (isYouTube) {
      const signals = element("dl", "youtube-signals");
      signals.append(
        signalItem("Views", compactNumber(trend.views)),
        signalItem("Daily velocity", compactNumber(trend.viewVelocity)),
        signalItem("Engagement", `${Number(trend.engagementRate || 0).toFixed(2)}%`),
        signalItem("Repeated topic", `${Number(trend.repeatedTopicCount || 1)} video${Number(trend.repeatedTopicCount || 1) === 1 ? "" : "s"}`),
      );
      card.append(signals);
    }

    const recommendation = element("div", "trend-recommendation");
    recommendation.append(element("strong", "", "Bakery recommendation"));
    recommendation.append(element("p", "", trend.suggestedProduct || "Analyze this trend to create a product idea."));
    if (trend.suggestedAction) recommendation.append(element("p", "trend-action-copy", trend.suggestedAction));
    if (trend.analysisReasoning) recommendation.append(element("small", "", trend.analysisReasoning));
    card.append(recommendation);

    if (!isYouTube && (trend.testDate || trend.expectedIngredientCost !== null && trend.expectedIngredientCost !== undefined)) {
      const details = element("div", "trend-test-details");
      details.append(element("strong", "", "Trend test"));
      if (trend.testDate) details.append(element("span", "", `Planned for ${formatDate(trend.testDate)}`));
      if (trend.plannedQuantity !== null && trend.plannedQuantity !== undefined) {
        details.append(element("span", "", `${Number(trend.plannedQuantity)} planned · ${formatMoney(trend.expectedIngredientCost)} expected cost · ${formatMoney(trend.targetSellingPrice)} target price`));
      }
      if (trend.actualQuantityProduced !== null && trend.actualQuantityProduced !== undefined) {
        details.append(element("span", "", `${Number(trend.actualQuantityProduced)} produced · ${Number(trend.actualQuantitySold || 0)} sold · ${formatMoney(trend.actualRevenue || 0)} revenue`));
      }
      if (trend.testOutcome) details.append(element("span", "", `Outcome: ${outcomeLabel(trend.testOutcome)}`));
      card.append(details);
    }

    card.append(element("p", "trend-dates", isYouTube
      ? `${trend.inferenceDisclosure} Source data retrieved ${formatDateTime(trend.retrievedAt || youtubeResult?.retrievedAt)}.`
      : `First seen ${formatDate(trend.firstSeenAt)} · Last seen ${formatDate(trend.lastSeenAt)}`));
    if (!isYouTube) {
      const actions = element("div", "trend-actions");
      actions.append(
        actionButton("Analyze", "analyze", trend.id, "primary-button"),
        actionButton("Watch", "watching", trend.id),
        actionButton("Test", "testing", trend.id),
        actionButton("Adopt", "adopted", trend.id),
        actionButton("Edit recommendation", "edit", trend.id),
        actionButton("Dismiss", "archived", trend.id, "ghost-button danger"),
      );
      card.append(actions);
    }
    return card;
  }

  async function handleAction(button) {
    const trend = trendsById.get(button.dataset.trendId);
    if (!trend || button.disabled) return;
    if (button.dataset.trendAction === "edit") {
      recommendationForm.elements.id.value = trend.id;
      recommendationForm.elements.suggestedProduct.value = trend.suggestedProduct || "";
      recommendationForm.elements.suggestedAction.value = trend.suggestedAction || "";
      openDialog(recommendationDialog, button);
      recommendationForm.elements.suggestedProduct.focus();
      return;
    }
    if (button.dataset.trendAction === "testing") {
      testForm.reset();
      testForm.elements.id.value = trend.id;
      testForm.elements.expectedIngredientCost.value = valueOrEmpty(trend.expectedIngredientCost);
      testForm.elements.plannedQuantity.value = valueOrEmpty(trend.plannedQuantity);
      testForm.elements.testDate.value = trend.testDate || new Date().toISOString().slice(0, 10);
      testForm.elements.targetSellingPrice.value = valueOrEmpty(trend.targetSellingPrice);
      testForm.elements.testNotes.value = trend.testNotes || "";
      testForm.elements.actualQuantityProduced.value = valueOrEmpty(trend.actualQuantityProduced);
      testForm.elements.actualQuantitySold.value = valueOrEmpty(trend.actualQuantitySold);
      testForm.elements.actualRevenue.value = valueOrEmpty(trend.actualRevenue);
      testForm.elements.resultNotes.value = trend.resultNotes || "";
      testForm.elements.testOutcome.value = trend.testOutcome || "";
      setText("#trend-test-title", trend.testDate ? "Update Trend Test" : "Plan a Trend Test");
      document.querySelector("#trend-test-error").hidden = true;
      openDialog(testDialog, button);
      testForm.elements.expectedIngredientCost.focus();
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
    if (!response.ok) {
      const message = typeof result.error === "string" ? result.error : result.error?.message;
      throw new Error(message || "Trend Finder request failed");
    }
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

  function openDialog(dialog, trigger) {
    dialogTriggers.set(dialog, trigger);
    dialog.showModal();
  }

  function scoreItem(label, value, highlight = false) {
    const item = element("div", highlight ? "opportunity" : "");
    item.append(element("dt", "", label), element("dd", "", `${Number(value || 0)}/100`));
    return item;
  }
  function signalItem(label, value) {
    const item = element("div");
    item.append(element("dt", "", label), element("dd", "", value));
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
  function formatDateTime(value) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "not yet" : parsed.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  function compactNumber(value) { return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(Number(value || 0)); }
  function recommendationClass(value) { return String(value || "").toLowerCase().replace(/\s+/g, "-"); }

  function formatMoney(value) {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(Number(value || 0));
  }
  function outcomeLabel(value) {
    return { repeat: "Repeat the test", adopt: "Adopt", revise: "Revise and retest", dismiss: "Dismiss" }[value] || titleCase(value);
  }
  function valueOrEmpty(value) { return value === null || value === undefined ? "" : String(value); }

  refreshTrends();
})();
