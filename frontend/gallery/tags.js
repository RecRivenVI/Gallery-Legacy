import { list } from "../shared/api.js";

// Tag browsing is a structured, platform-scoped resource, not work text search.
export function mountTagBrowser(container, { platform, select }) {
  container.innerHTML =
    '<div class="fp-section">标签</div><input class="search-input" aria-label="查找标签" placeholder="查找标签"><div data-tags></div><button data-next hidden>下一页</button>';
  const input = container.querySelector("input"),
    results = container.querySelector("[data-tags]"),
    next = container.querySelector("[data-next]");
  let controller = null,
    cursor = null,
    timer = null,
    revision = 0;
  async function load(nextPage = false) {
    const current = ++revision;
    controller?.abort();
    controller = new AbortController();
    try {
      const data = await list(
        "tags",
        {
          platform,
          q: input.value,
          pageSize: 40,
          cursor: nextPage ? cursor : null,
        },
        { signal: controller.signal },
      );
      if (current !== revision) return;
      results.replaceChildren();
      const clear = document.createElement("button");
      clear.className = "fp-item";
      clear.textContent = "清除标签筛选";
      clear.onclick = () => select(null);
      results.append(clear);
      for (const tag of data.items) {
        const item = document.createElement("button");
        item.className = "fp-item";
        item.textContent = tag.label + " · " + tag.workCount;
        item.onclick = () => select(tag.label);
        results.append(item);
      }
      cursor = data.cursor;
      next.hidden = data.items.length < 40 || !cursor;
    } catch (error) {
      if (error.name !== "AbortError" && current === revision)
        results.textContent = "标签读取失败";
    }
  }
  input.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(() => load(false), 180);
  };
  next.onclick = () => load(true);
  void load();
  return () => {
    revision++;
    clearTimeout(timer);
    controller?.abort();
  };
}
