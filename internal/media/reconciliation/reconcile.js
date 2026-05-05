"use strict";

const { normalizeRelativePath } = require("../../library/paths.js");
const {
  FILE_REFERENCE_KINDS,
  MEDIA_RECONCILIATION_CONTRACT_VERSION,
  compareText,
  deepFreeze,
  fail,
  sortDiagnostics,
  sortEvidence,
} = require("./contract.js");
const { canonicalFilesystemFiles } = require("./inputs.js");

function invalidReferenceDiagnostic(code, metadataOrdinal, reference) {
  return {
    code,
    metadataOrdinal,
    referenceKind: typeof reference?.kind === "string" ? reference.kind : null,
    sourcePath: typeof reference?.sourcePath === "string" ? reference.sourcePath : null,
  };
}

function canonicalReference(reference, metadataOrdinal, diagnostics) {
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
    diagnostics.push(invalidReferenceDiagnostic("invalid_file_reference", metadataOrdinal, reference));
    return null;
  }
  if (!FILE_REFERENCE_KINDS.includes(reference.kind)) {
    diagnostics.push(invalidReferenceDiagnostic("unsupported_reference", metadataOrdinal, reference));
    return null;
  }
  if (typeof reference.value !== "string" || !reference.value || typeof reference.sourcePath !== "string" || !reference.sourcePath
    || /[\\/]$/.test(reference.value) || (reference.kind === "file_name" && /[\\/]/.test(reference.value))) {
    diagnostics.push(invalidReferenceDiagnostic("invalid_file_reference", metadataOrdinal, reference));
    return null;
  }
  let identity;
  try { identity = normalizeRelativePath(reference.value); }
  catch {
    diagnostics.push(invalidReferenceDiagnostic("invalid_file_reference", metadataOrdinal, reference));
    return null;
  }
  if (reference.kind === "file_name" && identity.relativePath.includes("\\")) {
    diagnostics.push(invalidReferenceDiagnostic("invalid_file_reference", metadataOrdinal, reference));
    return null;
  }
  return {
    kind: reference.kind,
    key: identity.relativePathKey,
    sourcePath: reference.sourcePath,
  };
}

function evidenceFor(reference) {
  return {
    code: reference.kind === "relative_path" ? "exact_relative_path" : "exact_file_name",
    sourcePath: reference.sourcePath,
    referenceKind: reference.kind,
  };
}

function assertionCompare(left, right) {
  return (left.kind === right.kind ? 0 : left.kind === "relative_path" ? -1 : 1)
    || compareText(left.key, right.key);
}

function canonicalAssertions(item, metadataOrdinal, diagnostics) {
  if (!item || typeof item !== "object" || Array.isArray(item)) fail("invalid_metadata_input", `metadataMedia[${metadataOrdinal}] must be an object`);
  const references = item.fileReferences === undefined ? [] : item.fileReferences;
  if (!Array.isArray(references)) fail("invalid_metadata_input", `metadataMedia[${metadataOrdinal}].fileReferences must be an array`);
  const groups = new Map();
  for (const raw of references) {
    const reference = canonicalReference(raw, metadataOrdinal, diagnostics);
    if (!reference) continue;
    const key = `${reference.kind}\0${reference.key}`;
    if (!groups.has(key)) groups.set(key, { kind: reference.kind, key: reference.key, references: [] });
    groups.get(key).references.push(reference);
  }
  return [...groups.values()].map(group => ({
    ...group,
    references: group.references.sort((left, right) => compareText(left.sourcePath, right.sourcePath)),
  })).sort(assertionCompare);
}

function intersection(sets) {
  if (sets.length === 0) return new Set();
  return new Set([...sets[0]].filter(value => sets.every(set => set.has(value))));
}

function union(sets) {
  return new Set(sets.flatMap(set => [...set]));
}

function buildCandidateGraph(metadataDeclarations, files, diagnostics) {
  if (!Array.isArray(metadataDeclarations)) fail("invalid_metadata_input", "metadataDeclarations must be an array");
  const byPath = new Map(files.map(file => [file.relativePathKey, file]));
  const byName = new Map();
  for (const file of files) {
    if (!byName.has(file.fileNameKey)) byName.set(file.fileNameKey, []);
    byName.get(file.fileNameKey).push(file.relativePathKey);
  }
  const candidates = new Map();
  const forcedAmbiguous = new Set();

  for (let metadataOrdinal = 0; metadataOrdinal < metadataDeclarations.length; metadataOrdinal++) {
    const assertions = canonicalAssertions(metadataDeclarations[metadataOrdinal], metadataOrdinal, diagnostics);
    const evaluated = assertions.map(assertion => ({
      ...assertion,
      files: new Set(assertion.kind === "relative_path"
        ? byPath.has(assertion.key) ? [assertion.key] : []
        : byName.get(assertion.key) || []),
    }));
    const common = intersection(evaluated.map(value => value.files));
    const selected = common.size > 0 ? common : union(evaluated.map(value => value.files));
    if (common.size === 0 && selected.size > 0 && evaluated.length > 1) {
      forcedAmbiguous.add(metadataOrdinal);
      diagnostics.push({ code: "conflicting_file_references", metadataOrdinal, referenceKind: null, sourcePath: null });
    }
    const edges = new Map();
    for (const fileKey of selected) {
      const evidence = [];
      for (const assertion of evaluated) {
        if (!assertion.files.has(fileKey)) continue;
        for (const reference of assertion.references) evidence.push(evidenceFor(reference));
      }
      edges.set(fileKey, sortEvidence(evidence));
    }
    candidates.set(metadataOrdinal, edges);
  }
  return { candidates, forcedAmbiguous };
}

function connectedComponents(candidates) {
  const fileToMetadata = new Map();
  for (const [metadataOrdinal, edges] of candidates) {
    for (const fileKey of edges.keys()) {
      if (!fileToMetadata.has(fileKey)) fileToMetadata.set(fileKey, []);
      fileToMetadata.get(fileKey).push(metadataOrdinal);
    }
  }
  for (const values of fileToMetadata.values()) values.sort((left, right) => left - right);

  const visitedMetadata = new Set();
  const components = [];
  for (const start of [...candidates.keys()].sort((left, right) => left - right)) {
    if (visitedMetadata.has(start) || candidates.get(start).size === 0) continue;
    const metadata = new Set();
    const files = new Set();
    const pendingMetadata = [start];
    while (pendingMetadata.length) {
      const metadataOrdinal = pendingMetadata.shift();
      if (metadata.has(metadataOrdinal)) continue;
      metadata.add(metadataOrdinal);
      visitedMetadata.add(metadataOrdinal);
      for (const fileKey of candidates.get(metadataOrdinal).keys()) {
        if (files.has(fileKey)) continue;
        files.add(fileKey);
        for (const neighbour of fileToMetadata.get(fileKey) || []) if (!metadata.has(neighbour)) pendingMetadata.push(neighbour);
      }
    }
    components.push({
      metadataOrdinals: [...metadata].sort((left, right) => left - right),
      filesystemRelativePathKeys: [...files].sort(compareText),
    });
  }
  return components;
}

function reconcileMedia({ metadataDeclarations, filesystemFiles } = {}) {
  const files = canonicalFilesystemFiles(filesystemFiles);
  const diagnostics = [];
  const { candidates, forcedAmbiguous } = buildCandidateGraph(metadataDeclarations, files, diagnostics);
  const matched = [];
  const ambiguous = [];
  const matchedMetadata = new Set();
  const matchedFiles = new Set();
  const ambiguousMetadata = new Set();
  const ambiguousFiles = new Set();

  for (const component of connectedComponents(candidates)) {
    const conflict = component.metadataOrdinals.some(value => forcedAmbiguous.has(value));
    if (!conflict && component.metadataOrdinals.length === 1 && component.filesystemRelativePathKeys.length === 1) {
      const metadataOrdinal = component.metadataOrdinals[0];
      const filesystemRelativePathKey = component.filesystemRelativePathKeys[0];
      matched.push({ metadataOrdinal, filesystemRelativePathKey, evidence: candidates.get(metadataOrdinal).get(filesystemRelativePathKey) });
      matchedMetadata.add(metadataOrdinal);
      matchedFiles.add(filesystemRelativePathKey);
      continue;
    }
    component.metadataOrdinals.forEach(value => ambiguousMetadata.add(value));
    component.filesystemRelativePathKeys.forEach(value => ambiguousFiles.add(value));
    const componentCandidates = [];
    for (const metadataOrdinal of component.metadataOrdinals) {
      for (const [filesystemRelativePathKey, evidence] of candidates.get(metadataOrdinal)) {
        componentCandidates.push({ metadataOrdinal, filesystemRelativePathKey, evidence });
      }
    }
    componentCandidates.sort((left, right) => left.metadataOrdinal - right.metadataOrdinal
      || compareText(left.filesystemRelativePathKey, right.filesystemRelativePathKey));
    ambiguous.push({
      metadataOrdinals: component.metadataOrdinals,
      filesystemRelativePathKeys: component.filesystemRelativePathKeys,
      candidates: componentCandidates,
      diagnostics: [{ code: conflict ? "conflicting_file_references" : "non_unique_candidate_graph" }],
    });
  }

  matched.sort((left, right) => left.metadataOrdinal - right.metadataOrdinal || compareText(left.filesystemRelativePathKey, right.filesystemRelativePathKey));
  ambiguous.sort((left, right) => (left.metadataOrdinals[0] ?? Number.MAX_SAFE_INTEGER) - (right.metadataOrdinals[0] ?? Number.MAX_SAFE_INTEGER)
    || compareText(left.filesystemRelativePathKeys[0] || "", right.filesystemRelativePathKeys[0] || ""));
  const metadataOnly = metadataDeclarations.map((_, ordinal) => ordinal).filter(ordinal => !matchedMetadata.has(ordinal) && !ambiguousMetadata.has(ordinal));
  const filesystemOnly = files.map(file => file.relativePathKey).filter(key => !matchedFiles.has(key) && !ambiguousFiles.has(key));
  const result = {
    contractVersion: MEDIA_RECONCILIATION_CONTRACT_VERSION,
    matched,
    metadataOnly,
    filesystemOnly,
    ambiguous,
    diagnostics: sortDiagnostics(diagnostics),
  };
  return deepFreeze(result);
}

module.exports = { reconcileMedia };
