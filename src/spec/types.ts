/**
 * Types describing the declarative tool definitions stored in `tools/*.json`.
 *
 * These files were written from real carrefour.it traffic. They are fully
 * self-describing: parameter schema + HTTP request template with `{"$param": "x"}`
 * placeholders. This project executes them directly — no external runner needed.
 */

export type ParamRef = { $param: string };

export type Template =
  | ParamRef
  | string
  | number
  | boolean
  | null
  | Template[]
  | { [key: string]: Template };

export interface JsonSchemaProperty {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description?: string;
  items?: JsonSchemaProperty;
  enum?: unknown[];
  /** Sent when the caller leaves the parameter out. */
  default?: unknown;
}

export interface JsonSchemaObject {
  type: 'object';
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

export interface RequestSpec {
  method: HttpMethod;
  url: string;
  headers?: Record<string, Template>;
  query?: Record<string, Template>;
  body?: Template;
  content_type?: string;
}

/** Names of the response extractors in `extract.ts`. */
export type ExtractorName = 'json' | 'product_grid' | 'suggestions' | 'cart' | 'stores' | 'timeslots';

export interface ResponseSpec {
  /** How to turn the raw response into something worth handing to a model. Default: `json`. */
  extract?: ExtractorName;
  /** For JSON responses: keep only these top-level keys. */
  pick?: string[];
  /** Advice added to the answer when the response's `error` field holds one of these codes. */
  hints?: Record<string, string>;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters?: JsonSchemaObject;
  request: RequestSpec;
  requires_auth?: boolean;
  /**
   * The request needs a fresh SFCC CSRF token: the executor fetches one and
   * exposes it to the templates as `{"$param": "csrf_token"}`.
   */
  csrf?: boolean;
  response?: ResponseSpec;
}

/** A fully resolved HTTP request, ready to be handed to `fetch`. */
export interface BuiltRequest {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  /** Already-encoded body, or undefined for bodyless requests. */
  body?: string | FormData;
}
