// Mirror the scene into accessible/native controls without invalidating the
// document on frames whose semantic values and bounds have not changed.
const properties = new WeakMap(),
  attributes = new WeakMap(),
  styles = new WeakMap();
function state(map, element) {
  let values = map.get(element);
  if (!values) {
    values = Object.create(null);
    map.set(element, values);
  }
  return values;
}
export function property(element, key, value) {
  const values = state(properties, element);
  if (values[key] !== value) {
    element[key] = value;
    values[key] = value;
  }
}
export function attribute(element, key, value) {
  const values = state(attributes, element);
  if (values[key] !== value) {
    element.setAttribute(key, value);
    values[key] = value;
  }
}
export function style(element, next) {
  const values = state(styles, element);
  for (const key in next)
    if (values[key] !== next[key]) {
      element.style[key] = next[key];
      values[key] = next[key];
    }
}
export function intersects(a, b) {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}
