// This file is how we talk to Home Assistant. There are two ways in:
//   * REST: simple request and response over HTTP. Good for states, services,
//     templates, logs and the stored config of automations and scripts.
//   * WebSocket: a long lived connection. Good for registries, traces, dashboards,
//     config entries and anything that Home Assistant only exposes this way.
// Both use the same long-lived access token, sent in an Authorization header (REST)
// or in an auth message (WebSocket).
import { fetch as undiciFetch, Agent } from "undici";
import WebSocket from "ws";
import type { Config } from "./config.js";

// Our own error type. It carries the HTTP status and Home Assistant's error code
// when we have them, which lets calling code make decisions (for example, treat a
// 404 as "does not exist" rather than as a failure).
export class HAError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "HAError";
  }
}

// What Home Assistant gives us for one entity: its id, current state text, a bag of
// attributes, and timestamps for the last change and last update.
export interface HAState {
  entity_id: string;
  state: string;
  attributes: Record<string, any>;
  last_changed: string;
  last_updated: string;
  context?: Record<string, unknown>;
}

// The next few interfaces describe entries in Home Assistant's registries (the
// lists of areas, devices and entities). We only declare the fields we actually
// use. Home Assistant sends more, and we simply pass them through when needed.
export interface AreaEntry {
  area_id: string;
  name: string;
  floor_id?: string | null;
  aliases?: string[];
  labels?: string[];
}

export interface DeviceEntry {
  id: string;
  name: string | null;
  name_by_user?: string | null;
  area_id: string | null;
  manufacturer?: string | null;
  model?: string | null;
  disabled_by?: string | null;
}

export interface EntityRegistryEntry {
  entity_id: string;
  name?: string | null;
  original_name?: string | null;
  device_id: string | null;
  area_id: string | null;
  platform?: string;
  disabled_by?: string | null;
  hidden_by?: string | null;
  device_class?: string | null;
  original_device_class?: string | null;
  labels?: string[];
}

// A convenience bundle: the three registries as lists, plus lookup tables so we can
// find an item by id quickly, plus a helper that answers "which area is this entity
// in?". The helper handles the common case where an entity has no area of its own
// and inherits the area of the device it belongs to.
export interface Registry {
  areas: AreaEntry[];
  devices: DeviceEntry[];
  entities: EntityRegistryEntry[];
  areaById: Map<string, AreaEntry>;
  deviceById: Map<string, DeviceEntry>;
  entityById: Map<string, EntityRegistryEntry>;
  /** Effective area id for an entity: its own area, else its device's area. */
  areaIdOf(entityId: string): string | null;
}

// Bookkeeping for a WebSocket command we sent and are still waiting to hear back
// about. We keep a timer so it cannot wait forever. The two optional fields are
// only used for 'subscription' style commands that stream events.
interface PendingCommand {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  events?: any[];
  collectMs?: number;
}

// How the WebSocket works, in plain terms: we open it lazily the first time a tool
// needs it, log in with the token, then keep it open and reuse it for every later
// command. Each command gets a unique number, and Home Assistant tags its answer
// with that number so we can match answers to questions even when several are in
// flight at once.
/** Persistent, authenticated Home Assistant WebSocket channel with lazy connect and auto reconnect. */
export class HAWebSocket {
  private socket?: WebSocket;
  private connecting?: Promise<void>;
  private nextId = 1;
  private pending = new Map<number, PendingCommand>();
  private keepalive?: NodeJS.Timeout;

  constructor(private readonly cfg: Config) {}

  // True only when the socket exists and is fully open.
  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  // Safe to call many times. If we are already connected it does nothing, and if a
  // connection attempt is already underway it waits for that one instead of starting
  // a second. The 'finally' clears the in-progress marker whether it worked or not.
  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.open().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  // Opens the socket and performs the login handshake. The sequence Home Assistant
  // uses is: it sends auth_required, we send our token, it replies auth_ok (good) or
  // auth_invalid (bad token).
  private open(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.cfg.wsUrl, {
        rejectUnauthorized: !this.cfg.insecureTls,
        handshakeTimeout: this.cfg.timeoutMs,
      });
      let authed = false;
      // Shared bail-out. Before we are logged in, a failure rejects the connect promise.
      // Either way we close the socket so we do not leave half open connections around.
      const fail = (err: Error) => {
        if (!authed) reject(err);
        try {
          socket.close();
        } catch {
          /* ignore */
        }
      };
      // If login takes longer than the timeout we give up, rather than hanging forever.
      const authTimer = setTimeout(
        () => fail(new HAError("Timed out authenticating to the Home Assistant WebSocket")),
        this.cfg.timeoutMs
      );

      socket.on("error", (err) => fail(new HAError(`WebSocket error: ${err.message}`)));

      // When the socket closes we forget it, stop the keepalive, and fail every command
      // still waiting, because their answers are never going to arrive. The next command
      // that needs the socket will simply reconnect.
      socket.on("close", () => {
        clearTimeout(authTimer);
        if (this.socket === socket) {
          this.socket = undefined;
          this.stopKeepalive();
        }
        this.rejectAll(new HAError("Home Assistant WebSocket closed"));
        if (!authed) reject(new HAError("Home Assistant WebSocket closed before authentication"));
      });

      // Every incoming message lands here. Before login we only care about the auth
      // messages. After login everything goes to handle().
      socket.on("message", (raw) => {
        let msg: any;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (!authed) {
          if (msg.type === "auth_required") {
            socket.send(JSON.stringify({ type: "auth", access_token: this.cfg.token }));
          } else if (msg.type === "auth_ok") {
            authed = true;
            clearTimeout(authTimer);
            this.socket = socket;
            this.startKeepalive();
            resolve();
          } else if (msg.type === "auth_invalid") {
            clearTimeout(authTimer);
            // A bad token. We include the address and the token LENGTH (never the token) in the
            // message because a mismatched length is the most common clue: a real long-lived
            // token is very long, so a short one usually means a truncated paste.
            fail(new HAError(`Home Assistant rejected the access token for ${this.cfg.url} (token length ${this.cfg.token.length}): ${msg.message ?? "auth_invalid"}`, 401));
          }
          return;
        }
        this.handle(msg);
      });
    });
  }

  // Routes an answer from Home Assistant to whoever asked. 'event' messages belong to
  // subscriptions and are collected. 'pong' answers our keepalive pings. 'result' is
  // the actual outcome of a command, either success or an error.
  private handle(msg: any): void {
    const id: number | undefined = msg.id;
    if (id === undefined) return;
    const p = this.pending.get(id);
    if (!p) return;
    if (msg.type === "event") {
      p.events?.push(msg.event);
      return;
    }
    if (msg.type === "pong") {
      this.settle(id, p, msg);
      return;
    }
    if (msg.type === "result") {
      if (!msg.success) {
        const e = msg.error ?? {};
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.reject(new HAError(e.message ?? "Home Assistant command failed", undefined, e.code, e));
        return;
      }
      // Subscription style commands succeed immediately but then stream events. For those
      // we do not resolve straight away. We wait a short window to gather events and then
      // resolve with both the initial result and whatever arrived.
      if (p.collectMs !== undefined) {
        // Subscription style command: keep collecting events for a short window.
        clearTimeout(p.timer);
        p.timer = setTimeout(() => {
          this.pending.delete(id);
          p.resolve({ result: msg.result, events: p.events ?? [] });
        }, p.collectMs);
        return;
      }
      this.settle(id, p, msg.result);
    }
  }

  // Common finishing steps for a successful command: stop tracking it, cancel its timer, hand back the value.
  private settle(id: number, p: PendingCommand, value: unknown): void {
    this.pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(value);
  }

  // Fails every command that is still waiting. Used when the connection drops or we shut down.
  private rejectAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  // Sends a ping every 30 seconds so that routers, proxies and Home Assistant itself
  // do not decide the connection is idle and drop it. unref() means this timer will
  // not by itself keep the program alive.
  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepalive = setInterval(() => {
      if (this.connected) {
        this.socket!.send(JSON.stringify({ id: this.nextId++, type: "ping" }));
      }
    }, 30_000);
    this.keepalive.unref();
  }

  private stopKeepalive(): void {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = undefined;
  }

  // The main way to talk over the WebSocket. We make sure we are connected, give the
  // command a fresh id, set a timeout, remember it as pending, and send it. The
  // promise settles when handle() sees the matching answer.
  /** Send a command and resolve with its result payload. */
  async command<T = any>(payload: { type: string; [k: string]: unknown }, timeoutMs?: number): Promise<T> {
    await this.connect();
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HAError(`WebSocket command ${payload.type} timed out`));
      }, timeoutMs ?? this.cfg.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ id, ...payload }));
    });
  }

  // Like command(), but for things such as subscribe_events where Home Assistant
  // streams data. We listen for a short window (4 seconds unless told otherwise) and
  // return what we saw. Afterwards we unsubscribe so Home Assistant stops sending.
  /** Send a subscription style command and collect its events for a short window. */
  async commandCollect(
    payload: { type: string; [k: string]: unknown },
    collectMs = 4000
  ): Promise<{ result: unknown; events: any[] }> {
    await this.connect();
    const id = this.nextId++;
    const value = await new Promise<{ result: unknown; events: any[] }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HAError(`WebSocket command ${payload.type} timed out`));
      }, this.cfg.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, events: [], collectMs });
      this.socket!.send(JSON.stringify({ id, ...payload }));
    });
    try {
      this.socket?.send(JSON.stringify({ id: this.nextId++, type: "unsubscribe_events", subscription: id }));
    } catch {
      /* ignore */
    }
    return value;
  }

  close(): void {
    this.stopKeepalive();
    this.rejectAll(new HAError("Connection closed"));
    try {
      this.socket?.close();
    } catch {
      /* ignore */
    }
    this.socket = undefined;
  }
}

// Optional extras for a REST call: a body, query string values, a request for plain text back instead of JSON, and a custom timeout.
export interface RestOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Return the raw response text instead of parsing JSON. */
  text?: boolean;
  timeoutMs?: number;
}

// The object the rest of the program uses. It wraps both transports and adds a few
// small caches (services for 60 seconds, registries for 30) because those lists
// are big and rarely change, and asking for them on every call would be slow.
/** Home Assistant client exposing both the REST API and the WebSocket API. */
export class HAClient {
  readonly ws: HAWebSocket;
  private dispatcher?: Agent;
  private registryCache?: { at: number; value: Registry };
  private servicesCache?: { at: number; value: any[] };

  constructor(private readonly cfg: Config) {
    this.ws = new HAWebSocket(cfg);
    // If the user turned on 'insecure TLS' we build a special HTTP agent that skips
    // certificate checks, for people with self signed certificates on their home
    // network. Otherwise we use the default, which is strict.
    if (cfg.insecureTls) {
      this.dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
    }
  }

  // ---------------------------------------------------------------- REST

  // The general purpose REST call. Steps: build the URL, add query values, set a
  // timeout that cancels the request, send it with the bearer token, then interpret
  // the answer. Non 2xx answers become a clear HAError, with extra help for 401.
  async rest<T = any>(method: string, path: string, opts: RestOptions = {}): Promise<T> {
    const url = new URL(this.cfg.url + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? this.cfg.timeoutMs);
    try {
      const res = await undiciFetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.cfg.token}`,
          "Content-Type": "application/json",
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
        dispatcher: this.dispatcher,
      });
      const text = await res.text();
      if (!res.ok) {
        let message = text;
        try {
          const parsed = JSON.parse(text);
          message = parsed.message ?? parsed.error ?? text;
        } catch {
          /* keep raw text */
        }
        // A 401 almost always means a bad or mismatched token, so we add targeted advice to the message.
        const hint =
          res.status === 401
            ? ` Home Assistant at ${this.cfg.url} rejected the token (token length ${this.cfg.token.length}, a real long-lived token is roughly 180 characters). Check that the token was created on THIS instance's profile page and was pasted in full.`
            : "";
        throw new HAError(
          `${method} ${path} failed with HTTP ${res.status}: ${String(message).slice(0, 500)}.${hint}`,
          res.status
        );
      }
      // Some endpoints (templates, error log) return plain text, not JSON. The caller says
      // which it expects. If JSON was expected but parsing fails, we hand back the text.
      if (opts.text) return text as unknown as T;
      if (text === "") return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as unknown as T;
      }
    } catch (err) {
      if (err instanceof HAError) throw err;
      // Our timeout fired and aborted the request, so say that plainly.
      if ((err as Error).name === "AbortError") {
        throw new HAError(`${method} ${path} timed out after ${opts.timeoutMs ?? this.cfg.timeoutMs} ms`);
      }
      const cause = (err as any)?.cause?.message;
      throw new HAError(`Cannot reach Home Assistant at ${this.cfg.url}: ${(err as Error).message}${cause ? ` (${cause})` : ""}`);
    } finally {
      clearTimeout(timer);
    }
  }

  // Used for camera pictures. It checks the size twice: once from the content-length
  // header (so we can refuse before downloading) and once after, in case the header
  // was missing or wrong. This protects us from pulling a huge file into memory.
  /** GET a binary response such as a camera image, refusing anything larger than maxBytes. */
  async restBinary(path: string, maxBytes = 4_000_000): Promise<{ data: Buffer; contentType: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      const res = await undiciFetch(new URL(this.cfg.url + path), {
        headers: { Authorization: `Bearer ${this.cfg.token}` },
        signal: controller.signal,
        dispatcher: this.dispatcher,
      });
      if (!res.ok) throw new HAError(`GET ${path} failed with HTTP ${res.status}`, res.status);
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > maxBytes) throw new HAError(`The image is ${declared} bytes, larger than the ${maxBytes} byte limit.`);
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length > maxBytes) throw new HAError(`The image is ${data.length} bytes, larger than the ${maxBytes} byte limit.`);
      return { data, contentType: res.headers.get("content-type") ?? "application/octet-stream" };
    } catch (err) {
      if (err instanceof HAError) throw err;
      throw new HAError(`Cannot fetch ${path}: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  // Every entity's current state. On a big install this is large, which is why tools filter and summarise it.
  getStates(): Promise<HAState[]> {
    return this.rest<HAState[]>("GET", "/api/states");
  }

  // Gets one entity. A 404 just means it does not exist, so that returns null instead of throwing.
  async getState(entityId: string): Promise<HAState | null> {
    try {
      return await this.rest<HAState>("GET", `/api/states/${encodeURIComponent(entityId)}`);
    } catch (err) {
      if (err instanceof HAError && err.status === 404) return null;
      throw err;
    }
  }

  // Core facts about the instance, such as version, time zone and loaded components.
  getConfig(): Promise<any> {
    return this.rest("GET", "/api/config");
  }

  // The catalogue of every service Home Assistant offers, cached for a minute.
  async getServices(): Promise<any[]> {
    if (this.servicesCache && Date.now() - this.servicesCache.at < 60_000) return this.servicesCache.value;
    const value = await this.rest<any[]>("GET", "/api/services");
    this.servicesCache = { at: Date.now(), value };
    return value;
  }

  // Runs a Home Assistant service, for example light.turn_on. The 60 second timeout is
  // longer than normal on purpose because some services (a camera description script,
  // say) legitimately take a while. Setting returnResponse asks Home Assistant to send
  // back the service's result data, for services that produce any.
  async callService(
    domain: string,
    service: string,
    data: Record<string, unknown> = {},
    returnResponse = false
  ): Promise<any> {
    return this.rest("POST", `/api/services/${domain}/${service}`, {
      body: data,
      query: returnResponse ? { return_response: "true" } : undefined,
      timeoutMs: 60_000,
    });
  }

  // Asks Home Assistant to evaluate a Jinja template and return the text. This is how tools can compute across many entities in one call.
  renderTemplate(template: string, variables?: Record<string, unknown>): Promise<string> {
    return this.rest<string>("POST", "/api/template", {
      body: variables ? { template, variables } : { template },
      text: true,
    });
  }

  // Asks Home Assistant to validate its YAML configuration. Can be slow, hence the two minute timeout.
  checkConfig(): Promise<{ result: "valid" | "invalid"; errors: string | null; warnings?: string[] | null }> {
    return this.rest("POST", "/api/config/core/check_config", { timeoutMs: 120_000 });
  }

  // The raw text of home-assistant.log.
  getErrorLog(): Promise<string> {
    return this.rest<string>("GET", "/api/error_log", { text: true });
  }

  // ----------------------------------------------------------- WebSocket

  // Convenience wrapper so tools can say ha.wsCommand(...) instead of reaching into ha.ws.
  wsCommand<T = any>(payload: { type: string; [k: string]: unknown }, timeoutMs?: number): Promise<T> {
    return this.ws.command<T>(payload, timeoutMs);
  }

  // Fetches the three registries at once, builds the lookup tables, and caches the
  // result for 30 seconds. 'force' skips the cache. invalidateCaches() below is called
  // after any write so that the next read does not show stale data.
  /** Area, device and entity registries with lookup indexes, cached for 30 seconds. */
  async getRegistry(force = false): Promise<Registry> {
    if (!force && this.registryCache && Date.now() - this.registryCache.at < 30_000) {
      return this.registryCache.value;
    }
    const [areas, devices, entities] = await Promise.all([
      this.wsCommand<AreaEntry[]>({ type: "config/area_registry/list" }),
      this.wsCommand<DeviceEntry[]>({ type: "config/device_registry/list" }),
      this.wsCommand<EntityRegistryEntry[]>({ type: "config/entity_registry/list" }),
    ]);
    const areaById = new Map(areas.map((a) => [a.area_id, a]));
    const deviceById = new Map(devices.map((d) => [d.id, d]));
    const entityById = new Map(entities.map((e) => [e.entity_id, e]));
    const value: Registry = {
      areas,
      devices,
      entities,
      areaById,
      deviceById,
      entityById,
      areaIdOf(entityId: string) {
        const e = entityById.get(entityId);
        if (!e) return null;
        if (e.area_id) return e.area_id;
        if (e.device_id) return deviceById.get(e.device_id)?.area_id ?? null;
        return null;
      },
    };
    this.registryCache = { at: Date.now(), value };
    return value;
  }

  // Forget cached registries and services. Called after anything changes them.
  invalidateCaches(): void {
    this.registryCache = undefined;
    this.servicesCache = undefined;
  }

  close(): void {
    this.ws.close();
  }
}
