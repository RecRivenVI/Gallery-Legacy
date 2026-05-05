"use strict";

const PixivAdapter = require("./pixiv.js");
const FanboxAdapter = require("./fanbox.js");
const GankAdapter = require("./gank.js");
const FantiaAdapter = require("./fantia.js");
const PatreonAdapter = require("./patreon.js");
const PawchiveAdapter = require("./pawchive.js");
const XAdapter = require("./x.js");
const WeiboAdapter = require("./weibo.js");

const ADAPTERS = Object.freeze([
  PixivAdapter,
  FanboxAdapter,
  GankAdapter,
  FantiaAdapter,
  PatreonAdapter,
  PawchiveAdapter,
  XAdapter,
  WeiboAdapter,
]);

const ADAPTER_BY_PLATFORM = Object.freeze(Object.fromEntries(ADAPTERS.map(adapter => [adapter.PLATFORM_ID, adapter])));

function adapterForPlatform(platformId) {
  return ADAPTER_BY_PLATFORM[platformId] || null;
}

module.exports = { ADAPTERS, ADAPTER_BY_PLATFORM, adapterForPlatform };
