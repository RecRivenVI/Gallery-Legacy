"use strict";

// Audit the proposed public working tree, not the still-private Git object history.
// Findings identify paths/categories only; matched credential values are never printed.
const fs = require("node:fs"),
  path = require("node:path"),
  { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
function audit() {
  const listed = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  const files = [...new Set(listed.split("\0").filter(Boolean))]
    .filter(
      (f) =>
        fs.existsSync(path.join(root, f)) &&
        fs.statSync(path.join(root, f)).isFile(),
    )
    .sort();
  const findings = [];
  const legacy = [
    "Gallery",
    "Gallery-Miuix",
    "Gallery-Flutter",
    "Documents",
    "Legacy-Projects",
    "Extractors-Playwright",
    "pixiVenera",
    "IDM-Analysis",
  ];
  for (const name of legacy)
    if (fs.existsSync(path.join(root, name)))
      findings.push({ path: name, kind: "retired_root" });
  for (const file of files) {
    // Casing follows each language/toolchain convention; it is not a public-tree
    // safety condition (for example, commonMain, GalleryApp.kt and Cargo.toml).
    if (
      /^(?:node_modules|dist|runtime|logs|cache|temp|ui-dist|test-results)\/|\.(?:sqlite(?:-wal|-shm|-journal)?|db|log|pid|dmp|heapsnapshot)$/i.test(
        file,
      )
    )
      findings.push({ path: file, kind: "generated_or_runtime" });
    if (
      /\.(?:png|jpe?g|webp|gif|ico|mp4|webm|woff2?|ttf|otf|ttc|eot)$/i.test(file) &&
      !/^frontend\/assets\/app-icon\.(?:png|ico)$/.test(file)
    )
      findings.push({ path: file, kind: "unreviewed_binary" });
    if (!/\.(?:js|json|md|html|css|txt|ps1|yml|yaml)$/.test(file)) continue;
    const text = fs.readFileSync(path.join(root, file), "utf8");
    const patterns = [
      [
        "credential_literal",
        /\b(?:sessionSecret|session_secret|client_secret|passwordHash|password_hash|refresh_token|access_token)\s*[=:]\s*["'][^"'\s]{8,}["']/i,
      ],
      ["private_key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
      [
        "private_environment",
        /[A-Z]:[\\/](?:Users[\\/][A-Za-z0-9_]+|Gallery[\\/]gallery-dl)/i,
      ],
      [
        "personal_email",
        /[A-Z0-9._%+-]+@(?!example\.(?:invalid|test|com)\b)[A-Z0-9.-]+\.[A-Z]{2,}/i,
      ],
    ];
    for (const [kind, pattern] of patterns)
      if (pattern.test(text)) findings.push({ path: file, kind });
    if (
      file.startsWith("internal/") &&
      /require\(["'][^"']*(?:tests|fixtures|extensions|preview)[\\/]/i.test(
        text,
      )
    )
      findings.push({ path: file, kind: "reverse_dependency" });
  }
  const corpus = require("../fixtures/metadata/corpus.json");
  if (corpus.synthetic !== true || corpus.cases.some((x) => !x.synthetic))
    findings.push({
      path: "fixtures/metadata/corpus.json",
      kind: "private_corpus",
    });
  return {
    state: findings.length ? "FAIL" : "PASS",
    publicFiles: files.length,
    fixtureCases: corpus.cases.length,
    findings,
    scope:
      "existing non-ignored working tree only; Git history is deliberately untouched",
  };
}
if (require.main === module) {
  const result = audit();
  console.log(JSON.stringify(result, null, 2));
  if (result.state !== "PASS") process.exitCode = 1;
}
module.exports = { audit };
