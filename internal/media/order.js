"use strict";
// Presentation only. Never use this order for physical identity or observation.
// Digit length and lexical comparison avoid precision loss for arbitrarily long numbers.
function naturalKey(value) {
  return String(value).toLowerCase().replace(/\d+/g, (digits) => {
    const number = digits.replace(/^0+(?=\d)/, "");
    return "\u0001" + String(number.length).padStart(10, "0") + ":" + number + "\u0001";
  });
}
function compareNatural(a, b) {
  const x = naturalKey(a), y = naturalKey(b);
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
}
module.exports = { naturalKey, compareNatural };
