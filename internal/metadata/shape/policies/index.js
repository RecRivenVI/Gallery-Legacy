"use strict";

const PixivShapePolicy = require("./pixiv.js");
const FanboxShapePolicy = require("./fanbox.js");
const GankShapePolicy = require("./gank.js");
const FantiaShapePolicy = require("./fantia.js");
const PatreonShapePolicy = require("./patreon.js");
const PawchiveShapePolicy = require("./pawchive.js");
const XShapePolicy = require("./x.js");
const WeiboShapePolicy = require("./weibo.js");

const SHAPE_POLICIES = Object.freeze([
  PixivShapePolicy,
  FanboxShapePolicy,
  GankShapePolicy,
  FantiaShapePolicy,
  PatreonShapePolicy,
  PawchiveShapePolicy,
  XShapePolicy,
  WeiboShapePolicy,
]);

const SHAPE_POLICY_BY_PLATFORM = Object.freeze(Object.fromEntries(SHAPE_POLICIES.map(policy => [policy.PLATFORM_ID, policy])));

function shapePolicyForPlatform(platformId) {
  return SHAPE_POLICY_BY_PLATFORM[platformId] || null;
}

module.exports = { SHAPE_POLICIES, SHAPE_POLICY_BY_PLATFORM, shapePolicyForPlatform };
