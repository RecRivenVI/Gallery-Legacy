"use strict";
const { beginAdapt, finalize } = require("./contract.js");
const { warning } = require("./helpers.js");
const PLATFORM_ID = "Venera", VERSION = 1;

function adapt(context) {
  const { result, metadata } = beginAdapt(VeneraAdapter, context);
  // The deployed download library is author/book directory -> chapter -> pages.
  // It has no required metadata or upstream-ID/tag declaration. Directory display
  // and identity belong to library facts; arbitrary JSON must not invent them.
  // Parsed JSON is still retained by the indexing source record and shape policy.
  if (metadata && Object.keys(metadata).length)
    warning(result.diagnostics, "venera_metadata_unmapped", "metadata");
  return finalize(result);
}
const VeneraAdapter = Object.freeze({ PLATFORM_ID, VERSION, adapt });
module.exports = VeneraAdapter;
