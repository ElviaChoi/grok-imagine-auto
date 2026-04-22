(() => {
  if (window.GrokAutoDomUtils) return;
  if (!window.GrokAutoShared) {
    throw new Error("GrokAutoShared was not loaded before content-dom-utils.js.");
  }

  const { sleep, normalize, visible } = window.GrokAutoShared;

  function click(el) {
    if (!el) return false;
    el.scrollIntoView({ block: "center", inline: "center" });
    const rect = el.getBoundingClientRect();
    const x = Math.max(1, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
    const y = Math.max(1, Math.min(window.innerHeight - 1, rect.top + rect.height / 2));
    const common = { bubbles: true, cancelable: true, clientX: x, clientY: y };
    const pointTarget = document.elementFromPoint(x, y);
    const target = pointTarget && (pointTarget === el || el.contains(pointTarget)) ? pointTarget : el;

    target.dispatchEvent(new PointerEvent("pointerover", { ...common, pointerId: 1, pointerType: "mouse" }));
    target.dispatchEvent(new PointerEvent("pointerenter", { ...common, pointerId: 1, pointerType: "mouse" }));
    target.dispatchEvent(new PointerEvent("pointerdown", { ...common, pointerId: 1, pointerType: "mouse", buttons: 1 }));
    target.dispatchEvent(new MouseEvent("mouseover", common));
    target.dispatchEvent(new MouseEvent("mouseenter", common));
    target.dispatchEvent(new MouseEvent("mousedown", common));
    target.dispatchEvent(new PointerEvent("pointerup", { ...common, pointerId: 1, pointerType: "mouse" }));
    target.dispatchEvent(new MouseEvent("mouseup", common));
    if (typeof target.click === "function") {
      target.click();
    } else if (target !== el && typeof el.click === "function") {
      el.click();
    } else {
      target.dispatchEvent(new MouseEvent("click", common));
    }
    return true;
  }

  function clickAt(el, xRatio = 0.5, yRatio = 0.5) {
    if (!el) return false;
    el.scrollIntoView({ block: "center", inline: "center" });
    const rect = el.getBoundingClientRect();
    const x = Math.max(1, Math.min(window.innerWidth - 1, rect.left + rect.width * xRatio));
    const y = Math.max(1, Math.min(window.innerHeight - 1, rect.top + rect.height * yRatio));
    const common = { bubbles: true, cancelable: true, clientX: x, clientY: y };
    const target = document.elementFromPoint(x, y) || el;
    target.dispatchEvent(new PointerEvent("pointerover", { ...common, pointerId: 1, pointerType: "mouse" }));
    target.dispatchEvent(new PointerEvent("pointerenter", { ...common, pointerId: 1, pointerType: "mouse" }));
    target.dispatchEvent(new PointerEvent("pointerdown", { ...common, pointerId: 1, pointerType: "mouse", buttons: 1 }));
    target.dispatchEvent(new MouseEvent("mouseover", common));
    target.dispatchEvent(new MouseEvent("mouseenter", common));
    target.dispatchEvent(new MouseEvent("mousedown", common));
    target.dispatchEvent(new PointerEvent("pointerup", { ...common, pointerId: 1, pointerType: "mouse" }));
    target.dispatchEvent(new MouseEvent("mouseup", common));
    target.dispatchEvent(new MouseEvent("click", common));
    if (typeof target.click === "function") target.click();
    return true;
  }

  async function closeOpenMenus() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
    if (document.activeElement && typeof document.activeElement.blur === "function") document.activeElement.blur();
    await sleep(250);
  }

  function allClickables() {
    return [
      ...document.querySelectorAll(
        "button, [role='button'], [role='menuitem'], [data-radix-collection-item], a"
      )
    ].filter(visible);
  }

  function findClickableByTextOrLabel(patterns) {
    const lowered = patterns.map((p) => p.toLowerCase());
    return allClickables().find((button) => {
      const text = normalize(button.innerText || button.textContent);
      const label = normalize(button.getAttribute("aria-label"));
      const title = normalize(button.getAttribute("title"));
      return lowered.some((pattern) => text.includes(pattern) || label.includes(pattern) || title.includes(pattern));
    });
  }

  function findVisibleTextElement(patterns) {
    const lowered = patterns.map((p) => p.toLowerCase());
    const candidates = [...document.querySelectorAll("body *")]
      .filter(visible)
      .filter((el) => {
        const text = normalize(el.innerText || el.textContent);
        if (!text) return false;
        return lowered.some((pattern) => text === pattern || text.includes(pattern));
      });

    const leaf = candidates.find((el) => {
      const text = normalize(el.innerText || el.textContent);
      return ![...el.children].some((child) => visible(child) && normalize(child.innerText || child.textContent) === text);
    });
    const el = leaf || candidates[0];
    if (!el) return null;

    return (
      el.closest("button, [role='button'], [role='menuitem'], [data-radix-collection-item], [cmdk-item], a") ||
      el
    );
  }

  function findOpenMoreButton() {
    const exact = [
      ...document.querySelectorAll(
        "button[aria-label='\uCD94\uAC00 \uC635\uC158'], button[aria-label='More options'], button[aria-label='More']"
      )
    ]
      .filter(visible)
      .at(-1);
    if (exact) return exact;

    return findClickableByTextOrLabel(["\uCD94\uAC00 \uC635\uC158", "more options"]);
  }

  function findRadio(groupLabel, optionText) {
    const groups = [...document.querySelectorAll("[role='radiogroup']")];
    const group = groups.find((item) => normalize(item.getAttribute("aria-label")).includes(normalize(groupLabel)));
    if (!group) return null;
    return [...group.querySelectorAll("button, [role='radio']")].find((button) =>
      normalize(button.innerText || button.textContent).includes(normalize(optionText))
    );
  }

  function findRadioAny(groupLabels, optionTexts) {
    const labels = groupLabels.map(normalize);
    const options = optionTexts.map(normalize);
    const groups = [...document.querySelectorAll("form [role='radiogroup'], [role='radiogroup']")];

    for (const group of groups) {
      const groupText = normalize(`${group.getAttribute("aria-label") || ""} ${group.innerText || group.textContent}`);
      const labelMatches = labels.some((label) => groupText.includes(label));
      const radios = [...group.querySelectorAll("button, [role='radio']")];
      const radio = radios.find((button) => {
        const text = normalize(button.innerText || button.textContent);
        return options.some((option) => text.includes(option));
      });

      if (labelMatches && radio) return radio;
    }

    for (const group of groups) {
      const radios = [...group.querySelectorAll("button, [role='radio']")];
      const radio = radios.find((button) => {
        const text = normalize(button.innerText || button.textContent);
        return options.some((option) => text.includes(option));
      });
      if (radio) return radio;
    }

    return null;
  }

  async function chooseRadio(groupLabels, optionTexts, delay = 400) {
    const radio = findRadioAny(groupLabels, optionTexts);
    if (radio && radio.getAttribute("aria-checked") !== "true") {
      click(radio);
      await sleep(delay);
    }
  }

  function findOptionButton(optionTexts, root = document) {
    const options = optionTexts.map(normalize);
    return [...root.querySelectorAll("button, [role='radio'], [role='option'], [role='menuitem']")]
      .filter(visible)
      .find((button) => {
        const text = normalize(button.innerText || button.textContent);
        const label = normalize(button.getAttribute("aria-label"));
        const value = normalize(`${text} ${label}`);
        return options.some((option) => value === option || value.includes(option));
      }) || null;
  }

  window.GrokAutoDomUtils = Object.freeze({
    click,
    clickAt,
    closeOpenMenus,
    allClickables,
    findClickableByTextOrLabel,
    findVisibleTextElement,
    findOpenMoreButton,
    findRadio,
    findRadioAny,
    chooseRadio,
    findOptionButton
  });
})();
