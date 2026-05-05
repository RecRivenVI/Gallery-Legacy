"use strict";
// Optional download planning only: no network, filesystem IO or Runtime imports.
const path = require("node:path");
const normalizeExt = x => ({jpeg:"jpg",jpe:"jpg",jfif:"jpg",jif:"jpg",jfi:"jpg",html:"htm"}[String(x).toLowerCase()] || String(x).toLowerCase());
function extFromUrl(url, fallback = 'jpg') {
    const clean = String(url || '').split('?')[0];
    const ext = path.extname(clean).replace(/^\./, '').toLowerCase();
    return normalizeExt(ext) || fallback;
}

function mapEntry(map, key) {
    return map && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
}

function buildMediaList(postBody) {
    const media = [];
    if (postBody.coverImageUrl) {
        const coverUrl = postBody.coverImageUrl.replace(/\/c\/[0-9a-z_]+/i, '');
        const ext = extFromUrl(coverUrl, 'jpg');
        media.push({ base: 'cover', rawExt: ext, name: `cover.${ext}`, url: coverUrl });
    }

    const body = postBody.body || {};
    const images = [];
    const files = [];
    const seen = new Set();

    for (const block of body.blocks || []) {
        if (block.type === 'image' && block.imageId) {
            const img = mapEntry(body.imageMap, block.imageId);
            if (img) {
                images.push({ rawExt: normalizeExt(img.extension), url: img.originalUrl });
                seen.add(block.imageId);
            }
        } else if (block.type === 'file' && block.fileId) {
            const file = mapEntry(body.fileMap, block.fileId);
            if (file) {
                files.push({ rawExt: normalizeExt(file.extension), url: file.url });
                seen.add(block.fileId);
            }
        }
    }

    for (const img of body.images || []) {
        if (img && !seen.has(img.id)) {
            images.push({ rawExt: normalizeExt(img.extension), url: img.originalUrl });
            if (img.id) {
                seen.add(img.id);
            }
        }
    }
    for (const file of body.files || []) {
        if (file && !seen.has(file.id)) {
            files.push({ rawExt: normalizeExt(file.extension), url: file.url });
            if (file.id) {
                seen.add(file.id);
            }
        }
    }
    for (const [id, img] of Object.entries(body.imageMap || {})) {
        if (!seen.has(id)) {
            images.push({ rawExt: normalizeExt(img.extension), url: img.originalUrl });
        }
    }
    for (const [id, file] of Object.entries(body.fileMap || {})) {
        if (!seen.has(id)) {
            files.push({ rawExt: normalizeExt(file.extension), url: file.url });
        }
    }

    let index = 1;
    for (const item of images.concat(files)) {
        const ext = item.rawExt || 'jpg';
        media.push({ base: String(index), rawExt: ext, name: `${index}.${ext}`, url: item.url });
        index++;
    }
    return media;
}

module.exports = {extFromUrl,mapEntry,buildMediaList};
