"use strict";
const EXTS_ARCHIVE = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'lzma', 'xz']);
const HASH_RE = /^\/[0-9a-f]{2}\/[0-9a-f]{2}\/([0-9a-f]{64})/;
const INLINE_RE = /src="(?:https?:\/\/(?:pawchive\.(?:pw|st)))?(\/inline\/[^"]+|\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.[^"]+)/g;
// Optional download planning only: no network, filesystem IO or Runtime imports.
const path = require("node:path");
const ROOT_DL="https://file.pawchive.pw";
const sanitizeName=(value,fallback="untitled")=>String(value||"").replace(/[\\/:*?"<>|]/g,"_").trim().replace(/[. ]+$/g,"")||fallback;
function rpartition(s, sep) {
    const i = s.lastIndexOf(sep);
    return i < 0 ? ['', '', s] : [s.slice(0, i), sep, s.slice(i + sep.length)];
}

function filenameFromUrl(url) {
    return rpartition(String(url || '').split('?')[0], '/')[2];
}

function extFromUrl(url) {
    const [name, , ext] = rpartition(filenameFromUrl(url), '.');
    return name ? ext.toLowerCase() : '';
}

function nameextFromName(filename) {
    const [name, , ext] = rpartition(String(filename || ''), '.');
    if (name && ext.length <= 16) {
        return { filename: name, extension: ext.toLowerCase() };
    }
    return { filename, extension: '' };
}

function nameextFromUrl(url) {
    return nameextFromName(decodeURIComponent(filenameFromUrl(url)));
}

function extractFile(post) {
    const file = post.file;
    if (!file || !Object.prototype.hasOwnProperty.call(file, 'path')) {
        return [];
    }
    file.type = 'file';
    return [file];
}

function extractAttachments(post) {
    const attachments = post.attachments || [];
    for (const attachment of attachments) {
        attachment.type = 'attachment';
    }
    return attachments;
}

function extractInline(post) {
    const out = [];
    const content = post.content || '';
    let m;
    INLINE_RE.lastIndex = 0;
    while ((m = INLINE_RE.exec(content)) !== null) {
        out.push({ path: m[1], name: m[1], type: 'inline' });
    }
    return out;
}

function buildFiles(post) {
    const files = [];
    const archives = [];
    const integrity = [];
    const hashes = new Set();
    const generated = [].concat(extractFile(post), extractAttachments(post), extractInline(post));

    for (const file of generated) {
        if (!Object.prototype.hasOwnProperty.call(file, 'path')) {
            continue;
        }
        let p = file.path;
        if (p.includes('\\')) {
            p = file.path = p.replace(/\\/g, '/');
        }
        file.url = p[0] === '/' ? `${ROOT_DL}/data${p}` : p;

        const m = HASH_RE.exec(p);
        if (m) {
            const hash = file.hash = m[1];
            if (hashes.has(hash)) {
                continue;
            }
            hashes.add(hash);
        } else {
            file.hash = '';
        }

        let ext;
        if (file.name) {
            const ne = nameextFromName(file.name);
            file.filename = ne.filename;
            file.extension = ne.extension;
            ext = extFromUrl(p);
            if (!file.extension) {
                file.extension = ext;
            }
        } else {
            const ne = nameextFromUrl(p);
            file.filename = ne.filename;
            file.extension = ne.extension;
            ext = file.extension;
        }

        if (EXTS_ARCHIVE.has(ext) || (ext === 'bin' && EXTS_ARCHIVE.has(file.extension))) {
            file.type = 'archive';
            archives.push({ ...file });
        }
        files.push(file);
        if (file.type === 'file' || file.type === 'attachment' || file.type === 'archive') {
            integrity.push(file);
        }
    }
    return { files, archives, integrity };
}

function buildPlanMedia(files, { post, service } = {}) {
    const seenBases = new Map();
    return files.map((file, index) => {
        const num = index + 1;
        let base;
        if (service === 'fanbox') {
            base = file.filename === 'cover' ? 'cover' : String(num);
        } else {
            base = sanitizeName(String(file.filename || `file-${num}`).slice(0, 180));
        }
        const seen = seenBases.get(base) || 0;
        seenBases.set(base, seen + 1);
        if (seen > 0) {
            base = `${base}_${seen + 1}`;
        }
        const downloadUrl = file.name
            ? `${file.url}?f=${encodeURIComponent(file.name)}`
            : file.url;
        return {
            num,
            base,
            rawExt: file.extension,
            name: file.extension ? `${base}.${file.extension}` : base,
            url: downloadUrl,
            sourceName: file.name || (file.extension ? `${file.filename}.${file.extension}` : file.filename),
            integrity: {
                type: file.type,
                name: file.name || '',
                filename: file.filename || '',
                extension: file.extension || '',
                hash: file.hash || '',
            },
        };
    });
}

module.exports = {rpartition,filenameFromUrl,extFromUrl,nameextFromName,nameextFromUrl,extractFile,extractAttachments,extractInline,buildFiles,buildPlanMedia};
