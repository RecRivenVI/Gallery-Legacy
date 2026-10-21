"use strict";

function trustedPage(url, documentUrl) {
  return typeof url === "string" && url.split("#", 1)[0] === documentUrl;
}

module.exports = { trustedPage };
