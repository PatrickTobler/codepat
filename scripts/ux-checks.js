// Read-only layout checks for the page a loop is demoing. Paste this function into the
// chrome-devtools `evaluate_script` tool at each screen size; it changes nothing on the page.
// Returns problems only: an empty `problems` list means the screen passed.
() => {
  const problems = [];
  const doc = document.documentElement;
  if (doc.scrollWidth > window.innerWidth + 1)
    problems.push(`Page is ${doc.scrollWidth - window.innerWidth}px wider than the ${window.innerWidth}px screen (horizontal scroll).`);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  // Content inside a scroller or a clipping box (carousels, marquees) may extend past the edge on purpose.
  const clipped = (el) => {
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement)
      if (/(hidden|clip|auto|scroll)/.test(getComputedStyle(a).overflowX)) return true;
    return false;
  };
  // Screen-reader-only text is 1px wide on purpose.
  const srOnly = (el) => el.getBoundingClientRect().width <= 2;
  const name = (el) => (el.getAttribute("aria-label") || el.textContent || el.getAttribute("title") || el.tagName).trim().replace(/\s+/g, " ").slice(0, 40);
  for (const el of document.querySelectorAll("body *")) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth + 1 && getComputedStyle(el).position !== "fixed" && !clipped(el))
      problems.push(`Sticks out past the right edge: ${el.tagName.toLowerCase()} "${name(el)}".`);
    if (problems.length > 25) break;
  }
  if (window.innerWidth <= 480)
    for (const el of document.querySelectorAll("a[href], button, [role='button'], input, select, textarea, [role='tab'], [role='menuitem']")) {
      // WCAG 2.5.8 exempts links inside a sentence.
      if (!visible(el) || getComputedStyle(el).display === "inline") continue;
      const r = el.getBoundingClientRect();
      if (r.width < 24 || r.height < 24) problems.push(`Tap target under 24px (${Math.round(r.width)}x${Math.round(r.height)}): "${name(el)}".`);
    }
  for (const el of document.querySelectorAll("button, a[href], [role='button']"))
    if (visible(el) && !name(el).replace(el.tagName, "").trim() && !el.querySelector("img[alt]:not([alt=''])"))
      problems.push(`Control without an accessible name: ${el.outerHTML.slice(0, 80)}`);
  for (const img of document.querySelectorAll("img:not([alt])")) if (visible(img)) problems.push(`Image without alt: ${img.src.slice(0, 80)}`);
  for (const el of document.querySelectorAll("p, span, a, button, h1, h2, h3, li, label, td")) {
    if (!visible(el) || srOnly(el) || !el.childNodes.length || el.scrollWidth <= el.clientWidth + 1) continue;
    const s = getComputedStyle(el);
    if (s.textOverflow !== "ellipsis" && s.overflowX === "hidden") problems.push(`Text cut off without an ellipsis: "${name(el)}".`);
  }
  return { width: window.innerWidth, problems: [...new Set(problems)].slice(0, 30) };
};
