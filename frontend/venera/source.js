// Venera ComicSource API. Favorites keep the production source key and physical
// path IDs. Generation-local integers are only transient HTTP query parameters.
class LocalGallery extends ComicSource {
  name = "Gallery";
  key = "local_gallery";
  version = "10.6.0";
  minAppVersion = "1.6.3";
  url = "{{HOST_URL}}/venera-source.js";
  settings = { serverUrl: { title: "服务器地址", type: "input", default: "{{HOST_URL}}" } };
  _platforms = JSON.parse(decodeURIComponent("{{PLATFORMS}}"));
  _base() { let value; try { value = this.loadSetting("serverUrl"); } catch {} return String(value || "{{HOST_URL}}").trim().replace(/\/+$/, ""); }
  _q(value) { return encodeURIComponent(String(value ?? "")); }
  async _get(resource, parameters = {}) {
    const query = Object.entries(parameters).filter(([,v]) => v !== null && v !== "").map(([k,v]) => this._q(k) + "=" + this._q(v)).join("&");
    const response = await fetch(this._base() + "/api/v1/" + resource + (query ? "?" + query : ""), { headers: { "cache-time": "no" } });
    const body = await response.json();
    if (!response.ok || body.protocolVersion !== 1 || !body.data) throw new Error(body.error?.code || "Gallery connection failed");
    return body.data;
  }
  _tags(work) {
    const labels = [work.flags?.adult ? "R-18" : null, work.flags?.aiGenerated ? "AI生成" : null].filter(Boolean);
    return [...new Set([...labels, ...(work.tags || []).map((t) => t.label)])];
  }
  _comic(work) { return { id: work.stableId, title: work.title, subtitle: work.authorName || work.name,
    cover: work.cover ? this._base() + work.cover.thumbnailUrl : "", tags: this._tags(work), description: work.description?.text || "" }; }
  category = { title: "Gallery · 平台", parts: [{ name: "平台", type: "fixed", categories: this._platforms.map((id) => ({ label: id, target: { page: "category", attributes: { category: id } } })) }] };
  categoryComics = {
    optionLoader: async (platform) => {
      const authors = []; let page = 1, max = 1;
      do { const data = await this._get("authors", { platform, page, pageSize: 120 });
        authors.push(...data.items.map((a) => "author_" + this._q(a.stableId).replace(/-/g, "%2D") + "-" + a.name));
        max = data.totalPages; page++;
      } while (page <= max);
      return [{ label: "作者", options: ["all-全部", ...authors] }];
    },
    load: async (platform, _param, options, page) => {
      let author = null;
      const option = options?.[0] || "";
      if (option.startsWith("author_")) {
        const stable = decodeURIComponent(option.slice(7));
        const result = await this._get("resolve", { path: stable });
        if (result.kind === "author") author = result.item.id;
      }
      const data = await this._get("works", { platform, author, page: page || 1 });
      return { comics: data.items.map((w) => this._comic(w)), maxPage: data.totalPages };
    },
  };
  search = { load: async (keyword, _options, page) => {
    const data = await this._get("works", { q: keyword, page: page || 1 });
    return { comics: data.items.map((w) => this._comic(w)), maxPage: data.totalPages };
  } };
  comic = {
    loadInfo: async (id) => {
      const result = await this._get("resolve", { path: id }), w = result.item;
      const date = w.publishedAtMs === null ? null : new Date(w.publishedAtMs).toISOString();
      return { ...this._comic(w), tags: { "作者": [w.authorName || w.name], "平台": [w.platformId], "标签": this._tags(w) },
        updateTime: date?.slice(0,10) || null, uploadTime: date, url: w.sourceUrl || this._base() + "/#" + id };
    },
    loadEp: async (comicId, chapterId) => {
      const result = await this._get("resolve", { path: chapterId || comicId });
      let works = [result.item];
      if (result.kind === "author") {
        const chapters = await this._get("chapters", { path: chapterId || comicId });
        works = [];
        for (const chapter of chapters.items) works.push((await this._get("resolve", { path: chapter.stableId })).item);
      }
      return { images: works.flatMap((w) => (w.media || []).filter((m) => m.defaultVisible !== false)
        .map((m) => this._base() + (m.type === "video" ? m.thumbnailUrl : m.url))) };
    },
    onClickTag: (_namespace, tag) => ({ page: "search", attributes: { text: String(tag) } }),
  };
}
