import { sanitize } from "./log.js";

// An HttpError's message is written for the client and is returned as-is.
// Anything else (a bug, a TypeError) is reported as a generic 500 so internal
// details never leak to Cursor's cloud.
export class HttpError extends Error {
  constructor(status, message, code = "proxy_error", type = "invalid_request_error") {
    super(sanitize(message, 500));
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.type = type;
  }
}

export class UpstreamError extends HttpError {
  constructor(status, message, code = "upstream_error") {
    super(status >= 400 && status < 600 ? status : 502, message, code, "upstream_error");
    this.name = "UpstreamError";
  }
}

// Raised mid-stream from response.failed / error / bad response.incomplete events.
export class UpstreamStreamError extends HttpError {
  constructor(message, code = "upstream_stream_error") {
    super(statusForUpstreamCode(code), message || "The upstream response failed.", code, "upstream_error");
    this.name = "UpstreamStreamError";
  }
}

export function statusForUpstreamCode(code) {
  if (code === "context_length_exceeded" || code === "invalid_prompt" || code === "invalid_request_error") return 400;
  if (code === "rate_limit_exceeded" || code === "usage_limit_reached" || code === "insufficient_quota") return 429;
  return 502;
}

export function openAIError(error) {
  const known = error instanceof HttpError;
  const status = known && Number.isInteger(error.status) ? error.status : 500;
  return {
    status,
    body: {
      error: {
        message: known ? error.message : "The proxy could not complete the request.",
        type: known ? error.type : "proxy_error",
        param: null,
        code: known ? error.code : "proxy_error"
      }
    }
  };
}
