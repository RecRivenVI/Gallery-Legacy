"use strict";
// Optional download planning only: no network, filesystem IO or Runtime imports.
const path = require("node:path");
const EXTENSIONS = {image:"jpg",video:"mp4"};
function extractUrls(txt) {
    return (txt || '').match(/https?:\/\/[^\s"'<>]+/g) || [];
}

function extFromUrl(url, type) {
    const seg = decodeURIComponent(String(url || '').split('?')[0]).split('/').pop();
    const dot = seg.lastIndexOf('.');
    const name = dot > 0 ? seg.slice(0, dot) : '';
    let ext = dot > 0 ? seg.slice(dot + 1).toLowerCase() : '';
    if (!name || ext.length > 16) {
        ext = '';
    }
    return ext || EXTENSIONS[type] || '';
}

function buildFiles(post, previews = true) {
    const ordered = (post.postMedia || []).slice()
        .sort((a, b) => (a.sort || 0) - (b.sort || 0));
    const files = [];
    for (const m of ordered) {
        let url = m.url || m.thumbUrl;
        if (url) {
            url += '=s0';
        } else if (previews) {
            url = m.previewUrl || m.blurUrl;
        }
        if (!url) {
            continue;
        }
        files.push({ type: m.type, url });
    }
    return files.map((file, index) => {
        const num = index + 1;
        const rawExt = extFromUrl(file.url, file.type);
        return {
            num,
            base: String(num),
            rawExt,
            name: `${num}.${rawExt}`,
            url: file.url,
        };
    });
}

module.exports = {extractUrls,extFromUrl,buildFiles};
