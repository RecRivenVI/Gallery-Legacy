import { validateData } from "./contract.js";
let generationId = null;
export let protocolDefinition = null;
export async function loadProtocol() {
  if (protocolDefinition) return protocolDefinition;
  const response = await fetch("/protocol/protocol.json");
  const value = await response.json();
  if (
    !response.ok ||
    value.version !== 1 ||
    !Array.isArray(value.workSorts) ||
    !Array.isArray(value.authorSorts)
  )
    throw Object.assign(new Error("PROTOCOL_MISMATCH"), {
      code: "PROTOCOL_MISMATCH",
    });
  protocolDefinition = Object.freeze(value);
  return protocolDefinition;
}
export function currentGeneration() {
  return generationId;
}
export async function request(resource, parameters = {}, options = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(parameters))
    if (value !== null && value !== undefined && value !== "")
      query.set(key, String(value));
  const response = await fetch(
    `/api/v1/${resource}${query.size ? "?" + query : ""}`,
    {
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    },
  );
  let body;
  try {
    body = await response.json();
  } catch {
    throw Object.assign(new Error("INVALID_RESPONSE"), {
      code: "INVALID_RESPONSE",
    });
  }
  if (!response.ok) {
    const code = body.error?.code || "REQUEST_FAILED";
    if (
      [
        "CONTENT_CHANGED",
        "GENERATION_CHANGED",
        "CURSOR_CONTEXT_MISMATCH",
        "INVALID_CURSOR",
      ].includes(code) &&
      typeof window !== "undefined"
    )
      window.dispatchEvent(
        new CustomEvent("gallery-content-changed", {
          detail: { code, epoch: body.generationId, revision: body.revision },
        }),
      );
    throw Object.assign(new Error(body.error?.code || "REQUEST_FAILED"), {
      code,
      status: response.status,
    });
  }
  if (body.protocolVersion !== 1 || !Object.hasOwn(body, "data"))
    throw Object.assign(new Error("PROTOCOL_MISMATCH"), {
      code: "PROTOCOL_MISMATCH",
    });
  if (typeof body.generationId !== "string")
    throw Object.assign(new Error("PROTOCOL_MISMATCH"), {
      code: "PROTOCOL_MISMATCH",
    });
  const previousGeneration = generationId;
  generationId = body.generationId;
  if (
    previousGeneration &&
    previousGeneration !== generationId &&
    typeof window !== "undefined"
  )
    window.dispatchEvent(
      new CustomEvent("gallery-generation-changed", {
        detail: { previous: previousGeneration, generation: generationId },
      }),
    );
  if (!validateData(resource, body.data))
    throw Object.assign(new Error("INVALID_RESPONSE"), {
      code: "INVALID_RESPONSE",
    });
  if(["works","authors","tags"].includes(resource)) {
    body.data.epoch=body.generationId;
    if(Number.isSafeInteger(body.revision))body.data.revision=body.revision;
  }
  return body.data;
}
export async function list(resource, parameters, options) {
  const data = await request(resource, parameters, options);
  if (
    !Array.isArray(data.items) ||
    !Number.isSafeInteger(data.total) ||
    data.total < 0
  )
    throw Object.assign(new Error("INVALID_RESPONSE"), {
      code: "INVALID_RESPONSE",
    });
  return data;
}
