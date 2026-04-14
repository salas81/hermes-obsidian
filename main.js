"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => HermesObsidianMVPPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var VIEW_TYPE_HERMES_MVP = "hermes-obsidian-mvp";
var DEFAULT_SETTINGS = {
  gatewayUrl: "",
  token: "",
  sessionKey: "main",
  onboardingComplete: false
};
function asString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}
function normalizeGatewayUrl(url) {
  let value = url.trim();
  if (!value) return null;
  if (value.startsWith("https://")) value = `wss://${value.slice(8)}`;
  else if (value.startsWith("http://")) value = `ws://${value.slice(7)}`;
  if (!value.startsWith("ws://") && !value.startsWith("wss://")) return null;
  return value.replace(/\/+$/, "");
}
function toBase64Url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function fromBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(normalized);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
function randomId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function buildSigningPayload(data) {
  const version = data.nonce ? "v2" : "v1";
  const parts = [
    version,
    data.deviceId,
    data.clientId,
    data.clientMode,
    data.role,
    data.scopes.join(","),
    String(data.signedAtMs),
    data.token ?? ""
  ];
  if (version === "v2") parts.push(data.nonce ?? "");
  return parts.join("|");
}
async function signDevicePayload(identity, payload) {
  const encoded = new TextEncoder().encode(payload);
  let cryptoKey = identity.cryptoKey;
  if (!cryptoKey) {
    cryptoKey = await crypto.subtle.importKey("pkcs8", fromBase64Url(identity.privateKey), { name: "Ed25519" }, false, ["sign"]);
  }
  const signature = await crypto.subtle.sign("Ed25519", cryptoKey, encoded);
  return toBase64Url(new Uint8Array(signature));
}
var GatewayClient = class {
  constructor(opts) {
    this.opts = opts;
    this.ws = null;
    this.pending = /* @__PURE__ */ new Map();
    this.pendingTimeouts = /* @__PURE__ */ new Map();
    this.closed = false;
    this.connectSent = false;
    this.connectNonce = null;
    this.backoffMs = 800;
    this.connectTimer = null;
  }
  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }
  start() {
    this.closed = false;
    this.doConnect();
  }
  stop() {
    this.closed = true;
    if (this.connectTimer !== null) {
      window.clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    for (const timeout of this.pendingTimeouts.values()) window.clearTimeout(timeout);
    this.pendingTimeouts.clear();
    this.ws?.close();
    this.ws = null;
    this.flushPending(new Error("client stopped"));
  }
  async request(method, params) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("not connected");
    const id = randomId();
    const frame = { type: "req", id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const timeout = window.setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error("request timeout"));
      }, 3e4);
      this.pendingTimeouts.set(id, timeout);
      this.ws.send(JSON.stringify(frame));
    });
  }
  doConnect() {
    if (this.closed) return;
    const normalized = normalizeGatewayUrl(this.opts.url);
    if (!normalized) {
      this.opts.onError?.(new Error("Invalid gateway URL"));
      return;
    }
    this.ws = new WebSocket(normalized);
    this.ws.addEventListener("open", () => this.queueConnect());
    this.ws.addEventListener("message", (evt) => this.handleMessage(asString(evt.data)));
    this.ws.addEventListener("close", (evt) => {
      this.ws = null;
      this.flushPending(new Error(evt.reason || `closed (${evt.code})`));
      this.opts.onClose?.({ code: evt.code, reason: evt.reason || "" });
      this.scheduleReconnect();
    });
    this.ws.addEventListener("error", () => {
      this.opts.onError?.(new Error("WebSocket connection error"));
    });
  }
  scheduleReconnect() {
    if (this.closed) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 1.7, 15e3);
    window.setTimeout(() => this.doConnect(), delay);
  }
  flushPending(error) {
    for (const [id, pending] of this.pending) {
      const timeout = this.pendingTimeouts.get(id);
      if (timeout) window.clearTimeout(timeout);
      pending.reject(error);
    }
    this.pending.clear();
    this.pendingTimeouts.clear();
  }
  queueConnect() {
    this.connectNonce = null;
    this.connectSent = false;
    if (this.connectTimer !== null) window.clearTimeout(this.connectTimer);
    this.connectTimer = window.setTimeout(() => {
      void this.sendConnect();
    }, 750);
  }
  async sendConnect() {
    if (this.connectSent) return;
    this.connectSent = true;
    if (this.connectTimer !== null) {
      window.clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    const clientId = "gateway-client";
    const clientMode = "ui";
    const role = "operator";
    const scopes = ["operator.admin", "operator.write", "operator.read"];
    let device;
    if (this.opts.deviceIdentity) {
      try {
        const signedAt = Date.now();
        const payload2 = buildSigningPayload({
          deviceId: this.opts.deviceIdentity.deviceId,
          clientId,
          clientMode,
          role,
          scopes,
          signedAtMs: signedAt,
          token: this.opts.token || null,
          nonce: this.connectNonce
        });
        const signature = await signDevicePayload(this.opts.deviceIdentity, payload2);
        device = {
          id: this.opts.deviceIdentity.deviceId,
          publicKey: this.opts.deviceIdentity.publicKey,
          signature,
          signedAt,
          nonce: this.connectNonce ?? void 0
        };
      } catch (error) {
        this.opts.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
    const payload = {
      minProtocol: 3,
      maxProtocol: 3,
      client: { id: clientId, version: "0.1.0", platform: "obsidian", mode: clientMode },
      role,
      scopes,
      auth: this.opts.token ? { token: this.opts.token } : void 0,
      device,
      caps: ["tool-events"]
    };
    try {
      const result = await this.request("connect", payload);
      this.backoffMs = 800;
      this.opts.onHello?.(result);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.opts.onError?.(err);
      this.ws?.close(4008, err.message || "connect failed");
    }
  }
  handleMessage(raw) {
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (frame.type === "event") {
      if (frame.event === "connect.challenge") {
        const nonce = frame.payload?.nonce;
        if (typeof nonce === "string") {
          this.connectNonce = nonce;
          void this.sendConnect();
        }
        return;
      }
      this.opts.onEvent?.({ event: frame.event, payload: frame.payload ?? {}, seq: frame.seq });
      return;
    }
    if (frame.type === "res") {
      const id = asString(frame.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      const timeout = this.pendingTimeouts.get(id);
      if (timeout) {
        window.clearTimeout(timeout);
        this.pendingTimeouts.delete(id);
      }
      if (frame.ok) pending.resolve(frame.payload);
      else pending.reject(new Error(frame.error?.message ?? "request failed"));
    }
  }
};
var HermesMVPView = class extends import_obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.messages = [];
    this.inputValue = "";
    this.isSending = false;
    this.plugin = plugin;
  }
  getViewType() {
    return VIEW_TYPE_HERMES_MVP;
  }
  getDisplayText() {
    return "Hermes";
  }
  async onOpen() {
    this.plugin.registerViewInstance(this);
    this.render();
    await this.plugin.connectGateway();
    await this.plugin.loadHistory();
  }
  async onClose() {
    this.plugin.unregisterViewInstance(this);
  }
  setMessages(messages) {
    this.messages = messages;
    this.render();
  }
  appendMessage(role, text) {
    if (!text) return;
    const last = this.messages[this.messages.length - 1];
    if (role === "assistant" && last?.role === "assistant") last.text += text;
    else if (role === "status" && last?.role === "status") last.text = text;
    else this.messages.push({ role, text, timestamp: Date.now() });
    this.render();
  }
  markSending(isSending) {
    this.isSending = isSending;
    this.render();
  }
  async submitPrompt() {
    const text = this.inputValue.trim();
    if (!text || this.isSending) return;
    if (!this.plugin.gatewayConnected || !this.plugin.gateway) {
      new import_obsidian.Notice("Not connected to Hermes gateway");
      return;
    }
    this.inputValue = "";
    this.isSending = true;
    this.messages.push({ role: "user", text, timestamp: Date.now() });
    this.messages.push({ role: "assistant", text: "", timestamp: Date.now() });
    this.render();
    try {
      await this.plugin.gateway.request("chat.send", {
        sessionKey: this.plugin.settings.sessionKey,
        message: text,
        deliver: false,
        idempotencyKey: randomId()
      });
    } catch (error) {
      this.appendMessage("error", error instanceof Error ? error.message : String(error));
    } finally {
      this.isSending = false;
      this.render();
    }
  }
  render() {
    const root = this.containerEl.children[1];
    root.empty();
    const wrap = root.createDiv({ cls: "hermes-mvp-wrap" });
    const list = wrap.createDiv({ cls: "hermes-mvp-messages" });
    for (const msg of this.messages) {
      const row = list.createDiv({ cls: `hermes-mvp-msg hermes-mvp-${msg.role}` });
      const label = msg.role === "user" ? "You" : msg.role === "assistant" ? "Hermes" : msg.role === "status" ? "Status" : "Error";
      row.createEl("strong", { text: label });
      row.createDiv({ text: msg.text || (msg.role === "assistant" ? "..." : "") });
    }
    const form = wrap.createDiv({ cls: "hermes-mvp-form" });
    const input = form.createEl("textarea", {
      attr: { rows: "4", placeholder: "Ask Hermes..." }
    });
    input.value = this.inputValue;
    input.disabled = this.isSending;
    input.addEventListener("input", () => {
      this.inputValue = input.value;
    });
    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" && (evt.metaKey || evt.ctrlKey)) {
        evt.preventDefault();
        void this.submitPrompt();
      }
    });
    const button = form.createEl("button", { text: this.isSending ? "Sending..." : "Send" });
    button.disabled = this.isSending;
    button.addEventListener("click", () => void this.submitPrompt());
  }
};
var HermesSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Hermes remote settings" });
    new import_obsidian.Setting(containerEl).setName("Gateway URL").setDesc("Paste the Hermes gateway URL, usually a Tailscale-served https URL.").addText(
      (text) => text.setPlaceholder("https://your-pi.tailxxxx.ts.net").setValue(this.plugin.settings.gatewayUrl).onChange(async (value) => {
        this.plugin.settings.gatewayUrl = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Auth token").setDesc("Gateway auth token for operator access.").addText(
      (text) => text.setPlaceholder("Paste your gateway token").setValue(this.plugin.settings.token).onChange(async (value) => {
        this.plugin.settings.token = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Test connection").setDesc("Connect to the remote Hermes gateway and verify access.").addButton(
      (button) => button.setButtonText("Connect").setCta().onClick(async () => {
        try {
          await this.plugin.connectGateway(true);
          new import_obsidian.Notice("Connected to Hermes gateway");
        } catch (error) {
          new import_obsidian.Notice(error instanceof Error ? error.message : String(error));
        }
      })
    );
  }
};
var HermesObsidianMVPPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.gateway = null;
    this.gatewayConnected = false;
    this.activeView = null;
  }
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    await this.ensureDeviceIdentity();
    this.registerView(VIEW_TYPE_HERMES_MVP, (leaf) => new HermesMVPView(leaf, this));
    this.addSettingTab(new HermesSettingTab(this.app, this));
    this.addRibbonIcon("bot", "Open Hermes", async () => {
      await this.activateView();
    });
    this.addCommand({
      id: "open-hermes-mvp",
      name: "Open Hermes",
      callback: async () => this.activateView()
    });
    if (this.settings.gatewayUrl && this.settings.token) {
      void this.connectGateway();
    }
  }
  async onunload() {
    this.gateway?.stop();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_HERMES_MVP);
  }
  registerViewInstance(view) {
    this.activeView = view;
  }
  unregisterViewInstance(view) {
    if (this.activeView === view) this.activeView = null;
  }
  async saveSettings() {
    await this.saveData(this.settings);
    this.gateway?.stop();
    this.gateway = null;
    this.gatewayConnected = false;
  }
  async ensureDeviceIdentity() {
    const deviceId = this.settings.deviceId;
    const publicKey = this.settings.devicePublicKey;
    const privateKey = this.settings.devicePrivateKey;
    if (deviceId && publicKey && privateKey) return;
    const keypair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const rawPublic = new Uint8Array(await crypto.subtle.exportKey("raw", keypair.publicKey));
    const rawPrivate = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keypair.privateKey));
    this.settings.deviceId = await sha256Hex(rawPublic);
    this.settings.devicePublicKey = toBase64Url(rawPublic);
    this.settings.devicePrivateKey = toBase64Url(rawPrivate);
    await this.saveData(this.settings);
  }
  getDeviceIdentity() {
    if (!this.settings.deviceId || !this.settings.devicePublicKey || !this.settings.devicePrivateKey) return void 0;
    return {
      deviceId: this.settings.deviceId,
      publicKey: this.settings.devicePublicKey,
      privateKey: this.settings.devicePrivateKey
    };
  }
  async connectGateway(forceReconnect = false) {
    if (!this.settings.gatewayUrl || !this.settings.token) {
      throw new Error("Missing gateway URL or token");
    }
    if (this.gatewayConnected && this.gateway && !forceReconnect) return;
    this.gateway?.stop();
    const normalizedUrl = normalizeGatewayUrl(this.settings.gatewayUrl);
    if (!normalizedUrl) throw new Error("Invalid gateway URL");
    this.settings.gatewayUrl = normalizedUrl;
    await this.saveData(this.settings);
    this.gateway = new GatewayClient({
      url: normalizedUrl,
      token: this.settings.token,
      deviceIdentity: this.getDeviceIdentity(),
      onHello: () => {
        this.gatewayConnected = true;
        this.activeView?.appendMessage("status", "Connected to Hermes gateway");
        void this.loadHistory();
      },
      onClose: (info) => {
        this.gatewayConnected = false;
        if (info.reason) this.activeView?.appendMessage("status", `Connection closed: ${info.reason}`);
      },
      onError: (error) => {
        this.gatewayConnected = false;
        this.activeView?.appendMessage("error", error.message);
      },
      onEvent: (event) => this.handleGatewayEvent(event)
    });
    this.gateway.start();
  }
  handleGatewayEvent(event) {
    if (event.event === "chat" || event.event === "stream" || event.event === "agent") {
      const payload = event.payload ?? {};
      const text = this.extractEventText(payload);
      if (text) this.activeView?.appendMessage("assistant", text);
    }
  }
  extractEventText(payload) {
    const texts = [];
    const walk = (value) => {
      if (value == null) return;
      if (typeof value === "string") return;
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      if (typeof value !== "object") return;
      if (typeof value.text === "string") texts.push(value.text);
      if (typeof value.content === "string") texts.push(value.content);
      if (typeof value.delta === "string") texts.push(value.delta);
      Object.values(value).forEach(walk);
    };
    walk(payload);
    return texts.join("");
  }
  async loadHistory() {
    if (!this.gatewayConnected || !this.gateway) return;
    try {
      const result = await this.gateway.request("chat.history", {
        sessionKey: this.settings.sessionKey,
        limit: 200
      });
      const messages = Array.isArray(result?.messages) ? result.messages.filter((msg) => msg.role === "user" || msg.role === "assistant").map((msg) => ({
        role: msg.role,
        text: this.extractEventText({ content: msg.content }) || asString(msg.text),
        timestamp: typeof msg.timestamp === "number" ? msg.timestamp : Date.now()
      })).filter((msg) => msg.text.trim()) : [];
      this.activeView?.setMessages(messages);
    } catch (error) {
      this.activeView?.appendMessage("error", error instanceof Error ? error.message : String(error));
    }
  }
  async activateView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_HERMES_MVP)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE_HERMES_MVP, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
  }
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsic3JjL21haW4udHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IEFwcCwgSXRlbVZpZXcsIE5vdGljZSwgUGx1Z2luLCBQbHVnaW5TZXR0aW5nVGFiLCBTZXR0aW5nLCBXb3Jrc3BhY2VMZWFmIH0gZnJvbSAnb2JzaWRpYW4nO1xuXG5jb25zdCBWSUVXX1RZUEVfSEVSTUVTX01WUCA9ICdoZXJtZXMtb2JzaWRpYW4tbXZwJztcblxudHlwZSBDaGF0TWVzc2FnZSA9IHtcbiAgcm9sZTogJ3VzZXInIHwgJ2Fzc2lzdGFudCcgfCAnc3RhdHVzJyB8ICdlcnJvcic7XG4gIHRleHQ6IHN0cmluZztcbiAgdGltZXN0YW1wOiBudW1iZXI7XG59O1xuXG50eXBlIERldmljZUlkZW50aXR5ID0ge1xuICBkZXZpY2VJZDogc3RyaW5nO1xuICBwdWJsaWNLZXk6IHN0cmluZztcbiAgcHJpdmF0ZUtleTogc3RyaW5nO1xuICBjcnlwdG9LZXk/OiBDcnlwdG9LZXk7XG59O1xuXG50eXBlIEdhdGV3YXlFdmVudCA9IHtcbiAgZXZlbnQ6IHN0cmluZztcbiAgcGF5bG9hZD86IFJlY29yZDxzdHJpbmcsIGFueT47XG4gIHNlcT86IG51bWJlcjtcbn07XG5cbmludGVyZmFjZSBIZXJtZXNQbHVnaW5TZXR0aW5ncyB7XG4gIGdhdGV3YXlVcmw6IHN0cmluZztcbiAgdG9rZW46IHN0cmluZztcbiAgc2Vzc2lvbktleTogc3RyaW5nO1xuICBvbmJvYXJkaW5nQ29tcGxldGU6IGJvb2xlYW47XG4gIGRldmljZUlkPzogc3RyaW5nO1xuICBkZXZpY2VQdWJsaWNLZXk/OiBzdHJpbmc7XG4gIGRldmljZVByaXZhdGVLZXk/OiBzdHJpbmc7XG59XG5cbmNvbnN0IERFRkFVTFRfU0VUVElOR1M6IEhlcm1lc1BsdWdpblNldHRpbmdzID0ge1xuICBnYXRld2F5VXJsOiAnJyxcbiAgdG9rZW46ICcnLFxuICBzZXNzaW9uS2V5OiAnbWFpbicsXG4gIG9uYm9hcmRpbmdDb21wbGV0ZTogZmFsc2UsXG59O1xuXG5mdW5jdGlvbiBhc1N0cmluZyh2YWx1ZTogdW5rbm93biwgZmFsbGJhY2sgPSAnJyk6IHN0cmluZyB7XG4gIHJldHVybiB0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnID8gdmFsdWUgOiBmYWxsYmFjaztcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplR2F0ZXdheVVybCh1cmw6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICBsZXQgdmFsdWUgPSB1cmwudHJpbSgpO1xuICBpZiAoIXZhbHVlKSByZXR1cm4gbnVsbDtcbiAgaWYgKHZhbHVlLnN0YXJ0c1dpdGgoJ2h0dHBzOi8vJykpIHZhbHVlID0gYHdzczovLyR7dmFsdWUuc2xpY2UoOCl9YDtcbiAgZWxzZSBpZiAodmFsdWUuc3RhcnRzV2l0aCgnaHR0cDovLycpKSB2YWx1ZSA9IGB3czovLyR7dmFsdWUuc2xpY2UoNyl9YDtcbiAgaWYgKCF2YWx1ZS5zdGFydHNXaXRoKCd3czovLycpICYmICF2YWx1ZS5zdGFydHNXaXRoKCd3c3M6Ly8nKSkgcmV0dXJuIG51bGw7XG4gIHJldHVybiB2YWx1ZS5yZXBsYWNlKC9cXC8rJC8sICcnKTtcbn1cblxuZnVuY3Rpb24gdG9CYXNlNjRVcmwoYnl0ZXM6IFVpbnQ4QXJyYXkpOiBzdHJpbmcge1xuICBsZXQgYmluYXJ5ID0gJyc7XG4gIGZvciAoY29uc3QgYiBvZiBieXRlcykgYmluYXJ5ICs9IFN0cmluZy5mcm9tQ2hhckNvZGUoYik7XG4gIHJldHVybiBidG9hKGJpbmFyeSkucmVwbGFjZSgvXFwrL2csICctJykucmVwbGFjZSgvXFwvL2csICdfJykucmVwbGFjZSgvPSskL2csICcnKTtcbn1cblxuZnVuY3Rpb24gZnJvbUJhc2U2NFVybCh2YWx1ZTogc3RyaW5nKTogVWludDhBcnJheSB7XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSB2YWx1ZS5yZXBsYWNlKC8tL2csICcrJykucmVwbGFjZSgvXy9nLCAnLycpICsgJz0nLnJlcGVhdCgoNCAtICh2YWx1ZS5sZW5ndGggJSA0KSkgJSA0KTtcbiAgY29uc3QgYmluYXJ5ID0gYXRvYihub3JtYWxpemVkKTtcbiAgY29uc3Qgb3V0ID0gbmV3IFVpbnQ4QXJyYXkoYmluYXJ5Lmxlbmd0aCk7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgYmluYXJ5Lmxlbmd0aDsgaSArPSAxKSBvdXRbaV0gPSBiaW5hcnkuY2hhckNvZGVBdChpKTtcbiAgcmV0dXJuIG91dDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gc2hhMjU2SGV4KGJ5dGVzOiBVaW50OEFycmF5KTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgY29uc3QgZGlnZXN0ID0gYXdhaXQgY3J5cHRvLnN1YnRsZS5kaWdlc3QoJ1NIQS0yNTYnLCBieXRlcy5idWZmZXIpO1xuICByZXR1cm4gQXJyYXkuZnJvbShuZXcgVWludDhBcnJheShkaWdlc3QpLCBiID0+IGIudG9TdHJpbmcoMTYpLnBhZFN0YXJ0KDIsICcwJykpLmpvaW4oJycpO1xufVxuXG5mdW5jdGlvbiByYW5kb21JZCgpIHtcbiAgY29uc3QgYnl0ZXMgPSBuZXcgVWludDhBcnJheSgxNik7XG4gIGNyeXB0by5nZXRSYW5kb21WYWx1ZXMoYnl0ZXMpO1xuICByZXR1cm4gQXJyYXkuZnJvbShieXRlcywgYiA9PiBiLnRvU3RyaW5nKDE2KS5wYWRTdGFydCgyLCAnMCcpKS5qb2luKCcnKTtcbn1cblxuZnVuY3Rpb24gYnVpbGRTaWduaW5nUGF5bG9hZChkYXRhOiB7XG4gIGRldmljZUlkOiBzdHJpbmc7XG4gIGNsaWVudElkOiBzdHJpbmc7XG4gIGNsaWVudE1vZGU6IHN0cmluZztcbiAgcm9sZTogc3RyaW5nO1xuICBzY29wZXM6IHN0cmluZ1tdO1xuICBzaWduZWRBdE1zOiBudW1iZXI7XG4gIHRva2VuPzogc3RyaW5nIHwgbnVsbDtcbiAgbm9uY2U/OiBzdHJpbmcgfCBudWxsO1xufSkge1xuICBjb25zdCB2ZXJzaW9uID0gZGF0YS5ub25jZSA/ICd2MicgOiAndjEnO1xuICBjb25zdCBwYXJ0cyA9IFtcbiAgICB2ZXJzaW9uLFxuICAgIGRhdGEuZGV2aWNlSWQsXG4gICAgZGF0YS5jbGllbnRJZCxcbiAgICBkYXRhLmNsaWVudE1vZGUsXG4gICAgZGF0YS5yb2xlLFxuICAgIGRhdGEuc2NvcGVzLmpvaW4oJywnKSxcbiAgICBTdHJpbmcoZGF0YS5zaWduZWRBdE1zKSxcbiAgICBkYXRhLnRva2VuID8/ICcnLFxuICBdO1xuICBpZiAodmVyc2lvbiA9PT0gJ3YyJykgcGFydHMucHVzaChkYXRhLm5vbmNlID8/ICcnKTtcbiAgcmV0dXJuIHBhcnRzLmpvaW4oJ3wnKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gc2lnbkRldmljZVBheWxvYWQoaWRlbnRpdHk6IERldmljZUlkZW50aXR5LCBwYXlsb2FkOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZz4ge1xuICBjb25zdCBlbmNvZGVkID0gbmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKHBheWxvYWQpO1xuICBsZXQgY3J5cHRvS2V5ID0gaWRlbnRpdHkuY3J5cHRvS2V5O1xuICBpZiAoIWNyeXB0b0tleSkge1xuICAgIGNyeXB0b0tleSA9IGF3YWl0IGNyeXB0by5zdWJ0bGUuaW1wb3J0S2V5KCdwa2NzOCcsIGZyb21CYXNlNjRVcmwoaWRlbnRpdHkucHJpdmF0ZUtleSksIHsgbmFtZTogJ0VkMjU1MTknIH0sIGZhbHNlLCBbJ3NpZ24nXSk7XG4gIH1cbiAgY29uc3Qgc2lnbmF0dXJlID0gYXdhaXQgY3J5cHRvLnN1YnRsZS5zaWduKCdFZDI1NTE5JywgY3J5cHRvS2V5LCBlbmNvZGVkKTtcbiAgcmV0dXJuIHRvQmFzZTY0VXJsKG5ldyBVaW50OEFycmF5KHNpZ25hdHVyZSkpO1xufVxuXG5jbGFzcyBHYXRld2F5Q2xpZW50IHtcbiAgcHJpdmF0ZSB3czogV2ViU29ja2V0IHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgcGVuZGluZyA9IG5ldyBNYXA8c3RyaW5nLCB7IHJlc29sdmU6ICh2YWx1ZTogYW55KSA9PiB2b2lkOyByZWplY3Q6IChyZWFzb24/OiB1bmtub3duKSA9PiB2b2lkIH0+KCk7XG4gIHByaXZhdGUgcGVuZGluZ1RpbWVvdXRzID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgcHJpdmF0ZSBjbG9zZWQgPSBmYWxzZTtcbiAgcHJpdmF0ZSBjb25uZWN0U2VudCA9IGZhbHNlO1xuICBwcml2YXRlIGNvbm5lY3ROb25jZTogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgYmFja29mZk1zID0gODAwO1xuICBwcml2YXRlIGNvbm5lY3RUaW1lcjogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG5cbiAgY29uc3RydWN0b3IocHJpdmF0ZSBvcHRzOiB7XG4gICAgdXJsOiBzdHJpbmc7XG4gICAgdG9rZW46IHN0cmluZztcbiAgICBkZXZpY2VJZGVudGl0eT86IERldmljZUlkZW50aXR5O1xuICAgIG9uSGVsbG8/OiAocGF5bG9hZDogYW55KSA9PiB2b2lkO1xuICAgIG9uQ2xvc2U/OiAoaW5mbzogeyBjb2RlOiBudW1iZXI7IHJlYXNvbjogc3RyaW5nIH0pID0+IHZvaWQ7XG4gICAgb25FcnJvcj86IChlcnJvcjogRXJyb3IpID0+IHZvaWQ7XG4gICAgb25FdmVudD86IChldmVudDogR2F0ZXdheUV2ZW50KSA9PiB2b2lkO1xuICB9KSB7fVxuXG4gIGdldCBjb25uZWN0ZWQoKSB7XG4gICAgcmV0dXJuIHRoaXMud3M/LnJlYWR5U3RhdGUgPT09IFdlYlNvY2tldC5PUEVOO1xuICB9XG5cbiAgc3RhcnQoKSB7XG4gICAgdGhpcy5jbG9zZWQgPSBmYWxzZTtcbiAgICB0aGlzLmRvQ29ubmVjdCgpO1xuICB9XG5cbiAgc3RvcCgpIHtcbiAgICB0aGlzLmNsb3NlZCA9IHRydWU7XG4gICAgaWYgKHRoaXMuY29ubmVjdFRpbWVyICE9PSBudWxsKSB7XG4gICAgICB3aW5kb3cuY2xlYXJUaW1lb3V0KHRoaXMuY29ubmVjdFRpbWVyKTtcbiAgICAgIHRoaXMuY29ubmVjdFRpbWVyID0gbnVsbDtcbiAgICB9XG4gICAgZm9yIChjb25zdCB0aW1lb3V0IG9mIHRoaXMucGVuZGluZ1RpbWVvdXRzLnZhbHVlcygpKSB3aW5kb3cuY2xlYXJUaW1lb3V0KHRpbWVvdXQpO1xuICAgIHRoaXMucGVuZGluZ1RpbWVvdXRzLmNsZWFyKCk7XG4gICAgdGhpcy53cz8uY2xvc2UoKTtcbiAgICB0aGlzLndzID0gbnVsbDtcbiAgICB0aGlzLmZsdXNoUGVuZGluZyhuZXcgRXJyb3IoJ2NsaWVudCBzdG9wcGVkJykpO1xuICB9XG5cbiAgYXN5bmMgcmVxdWVzdChtZXRob2Q6IHN0cmluZywgcGFyYW1zOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikge1xuICAgIGlmICghdGhpcy53cyB8fCB0aGlzLndzLnJlYWR5U3RhdGUgIT09IFdlYlNvY2tldC5PUEVOKSB0aHJvdyBuZXcgRXJyb3IoJ25vdCBjb25uZWN0ZWQnKTtcbiAgICBjb25zdCBpZCA9IHJhbmRvbUlkKCk7XG4gICAgY29uc3QgZnJhbWUgPSB7IHR5cGU6ICdyZXEnLCBpZCwgbWV0aG9kLCBwYXJhbXMgfTtcbiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgdGhpcy5wZW5kaW5nLnNldChpZCwgeyByZXNvbHZlLCByZWplY3QgfSk7XG4gICAgICBjb25zdCB0aW1lb3V0ID0gd2luZG93LnNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICBpZiAoIXRoaXMucGVuZGluZy5oYXMoaWQpKSByZXR1cm47XG4gICAgICAgIHRoaXMucGVuZGluZy5kZWxldGUoaWQpO1xuICAgICAgICByZWplY3QobmV3IEVycm9yKCdyZXF1ZXN0IHRpbWVvdXQnKSk7XG4gICAgICB9LCAzMDAwMCk7XG4gICAgICB0aGlzLnBlbmRpbmdUaW1lb3V0cy5zZXQoaWQsIHRpbWVvdXQpO1xuICAgICAgdGhpcy53cyEuc2VuZChKU09OLnN0cmluZ2lmeShmcmFtZSkpO1xuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBkb0Nvbm5lY3QoKSB7XG4gICAgaWYgKHRoaXMuY2xvc2VkKSByZXR1cm47XG4gICAgY29uc3Qgbm9ybWFsaXplZCA9IG5vcm1hbGl6ZUdhdGV3YXlVcmwodGhpcy5vcHRzLnVybCk7XG4gICAgaWYgKCFub3JtYWxpemVkKSB7XG4gICAgICB0aGlzLm9wdHMub25FcnJvcj8uKG5ldyBFcnJvcignSW52YWxpZCBnYXRld2F5IFVSTCcpKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICB0aGlzLndzID0gbmV3IFdlYlNvY2tldChub3JtYWxpemVkKTtcbiAgICB0aGlzLndzLmFkZEV2ZW50TGlzdGVuZXIoJ29wZW4nLCAoKSA9PiB0aGlzLnF1ZXVlQ29ubmVjdCgpKTtcbiAgICB0aGlzLndzLmFkZEV2ZW50TGlzdGVuZXIoJ21lc3NhZ2UnLCBldnQgPT4gdGhpcy5oYW5kbGVNZXNzYWdlKGFzU3RyaW5nKGV2dC5kYXRhKSkpO1xuICAgIHRoaXMud3MuYWRkRXZlbnRMaXN0ZW5lcignY2xvc2UnLCBldnQgPT4ge1xuICAgICAgdGhpcy53cyA9IG51bGw7XG4gICAgICB0aGlzLmZsdXNoUGVuZGluZyhuZXcgRXJyb3IoZXZ0LnJlYXNvbiB8fCBgY2xvc2VkICgke2V2dC5jb2RlfSlgKSk7XG4gICAgICB0aGlzLm9wdHMub25DbG9zZT8uKHsgY29kZTogZXZ0LmNvZGUsIHJlYXNvbjogZXZ0LnJlYXNvbiB8fCAnJyB9KTtcbiAgICAgIHRoaXMuc2NoZWR1bGVSZWNvbm5lY3QoKTtcbiAgICB9KTtcbiAgICB0aGlzLndzLmFkZEV2ZW50TGlzdGVuZXIoJ2Vycm9yJywgKCkgPT4ge1xuICAgICAgdGhpcy5vcHRzLm9uRXJyb3I/LihuZXcgRXJyb3IoJ1dlYlNvY2tldCBjb25uZWN0aW9uIGVycm9yJykpO1xuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBzY2hlZHVsZVJlY29ubmVjdCgpIHtcbiAgICBpZiAodGhpcy5jbG9zZWQpIHJldHVybjtcbiAgICBjb25zdCBkZWxheSA9IHRoaXMuYmFja29mZk1zO1xuICAgIHRoaXMuYmFja29mZk1zID0gTWF0aC5taW4odGhpcy5iYWNrb2ZmTXMgKiAxLjcsIDE1MDAwKTtcbiAgICB3aW5kb3cuc2V0VGltZW91dCgoKSA9PiB0aGlzLmRvQ29ubmVjdCgpLCBkZWxheSk7XG4gIH1cblxuICBwcml2YXRlIGZsdXNoUGVuZGluZyhlcnJvcjogRXJyb3IpIHtcbiAgICBmb3IgKGNvbnN0IFtpZCwgcGVuZGluZ10gb2YgdGhpcy5wZW5kaW5nKSB7XG4gICAgICBjb25zdCB0aW1lb3V0ID0gdGhpcy5wZW5kaW5nVGltZW91dHMuZ2V0KGlkKTtcbiAgICAgIGlmICh0aW1lb3V0KSB3aW5kb3cuY2xlYXJUaW1lb3V0KHRpbWVvdXQpO1xuICAgICAgcGVuZGluZy5yZWplY3QoZXJyb3IpO1xuICAgIH1cbiAgICB0aGlzLnBlbmRpbmcuY2xlYXIoKTtcbiAgICB0aGlzLnBlbmRpbmdUaW1lb3V0cy5jbGVhcigpO1xuICB9XG5cbiAgcHJpdmF0ZSBxdWV1ZUNvbm5lY3QoKSB7XG4gICAgdGhpcy5jb25uZWN0Tm9uY2UgPSBudWxsO1xuICAgIHRoaXMuY29ubmVjdFNlbnQgPSBmYWxzZTtcbiAgICBpZiAodGhpcy5jb25uZWN0VGltZXIgIT09IG51bGwpIHdpbmRvdy5jbGVhclRpbWVvdXQodGhpcy5jb25uZWN0VGltZXIpO1xuICAgIHRoaXMuY29ubmVjdFRpbWVyID0gd2luZG93LnNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgdm9pZCB0aGlzLnNlbmRDb25uZWN0KCk7XG4gICAgfSwgNzUwKTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgc2VuZENvbm5lY3QoKSB7XG4gICAgaWYgKHRoaXMuY29ubmVjdFNlbnQpIHJldHVybjtcbiAgICB0aGlzLmNvbm5lY3RTZW50ID0gdHJ1ZTtcbiAgICBpZiAodGhpcy5jb25uZWN0VGltZXIgIT09IG51bGwpIHtcbiAgICAgIHdpbmRvdy5jbGVhclRpbWVvdXQodGhpcy5jb25uZWN0VGltZXIpO1xuICAgICAgdGhpcy5jb25uZWN0VGltZXIgPSBudWxsO1xuICAgIH1cblxuICAgIGNvbnN0IGNsaWVudElkID0gJ2dhdGV3YXktY2xpZW50JztcbiAgICBjb25zdCBjbGllbnRNb2RlID0gJ3VpJztcbiAgICBjb25zdCByb2xlID0gJ29wZXJhdG9yJztcbiAgICBjb25zdCBzY29wZXMgPSBbJ29wZXJhdG9yLmFkbWluJywgJ29wZXJhdG9yLndyaXRlJywgJ29wZXJhdG9yLnJlYWQnXTtcblxuICAgIGxldCBkZXZpY2U6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkO1xuICAgIGlmICh0aGlzLm9wdHMuZGV2aWNlSWRlbnRpdHkpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHNpZ25lZEF0ID0gRGF0ZS5ub3coKTtcbiAgICAgICAgY29uc3QgcGF5bG9hZCA9IGJ1aWxkU2lnbmluZ1BheWxvYWQoe1xuICAgICAgICAgIGRldmljZUlkOiB0aGlzLm9wdHMuZGV2aWNlSWRlbnRpdHkuZGV2aWNlSWQsXG4gICAgICAgICAgY2xpZW50SWQsXG4gICAgICAgICAgY2xpZW50TW9kZSxcbiAgICAgICAgICByb2xlLFxuICAgICAgICAgIHNjb3BlcyxcbiAgICAgICAgICBzaWduZWRBdE1zOiBzaWduZWRBdCxcbiAgICAgICAgICB0b2tlbjogdGhpcy5vcHRzLnRva2VuIHx8IG51bGwsXG4gICAgICAgICAgbm9uY2U6IHRoaXMuY29ubmVjdE5vbmNlLFxuICAgICAgICB9KTtcbiAgICAgICAgY29uc3Qgc2lnbmF0dXJlID0gYXdhaXQgc2lnbkRldmljZVBheWxvYWQodGhpcy5vcHRzLmRldmljZUlkZW50aXR5LCBwYXlsb2FkKTtcbiAgICAgICAgZGV2aWNlID0ge1xuICAgICAgICAgIGlkOiB0aGlzLm9wdHMuZGV2aWNlSWRlbnRpdHkuZGV2aWNlSWQsXG4gICAgICAgICAgcHVibGljS2V5OiB0aGlzLm9wdHMuZGV2aWNlSWRlbnRpdHkucHVibGljS2V5LFxuICAgICAgICAgIHNpZ25hdHVyZSxcbiAgICAgICAgICBzaWduZWRBdCxcbiAgICAgICAgICBub25jZTogdGhpcy5jb25uZWN0Tm9uY2UgPz8gdW5kZWZpbmVkLFxuICAgICAgICB9O1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgdGhpcy5vcHRzLm9uRXJyb3I/LihlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IgOiBuZXcgRXJyb3IoU3RyaW5nKGVycm9yKSkpO1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IHBheWxvYWQgPSB7XG4gICAgICBtaW5Qcm90b2NvbDogMyxcbiAgICAgIG1heFByb3RvY29sOiAzLFxuICAgICAgY2xpZW50OiB7IGlkOiBjbGllbnRJZCwgdmVyc2lvbjogJzAuMS4wJywgcGxhdGZvcm06ICdvYnNpZGlhbicsIG1vZGU6IGNsaWVudE1vZGUgfSxcbiAgICAgIHJvbGUsXG4gICAgICBzY29wZXMsXG4gICAgICBhdXRoOiB0aGlzLm9wdHMudG9rZW4gPyB7IHRva2VuOiB0aGlzLm9wdHMudG9rZW4gfSA6IHVuZGVmaW5lZCxcbiAgICAgIGRldmljZSxcbiAgICAgIGNhcHM6IFsndG9vbC1ldmVudHMnXSxcbiAgICB9O1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRoaXMucmVxdWVzdCgnY29ubmVjdCcsIHBheWxvYWQpO1xuICAgICAgdGhpcy5iYWNrb2ZmTXMgPSA4MDA7XG4gICAgICB0aGlzLm9wdHMub25IZWxsbz8uKHJlc3VsdCk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbnN0IGVyciA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvciA6IG5ldyBFcnJvcihTdHJpbmcoZXJyb3IpKTtcbiAgICAgIHRoaXMub3B0cy5vbkVycm9yPy4oZXJyKTtcbiAgICAgIHRoaXMud3M/LmNsb3NlKDQwMDgsIGVyci5tZXNzYWdlIHx8ICdjb25uZWN0IGZhaWxlZCcpO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgaGFuZGxlTWVzc2FnZShyYXc6IHN0cmluZykge1xuICAgIGxldCBmcmFtZTogYW55O1xuICAgIHRyeSB7XG4gICAgICBmcmFtZSA9IEpTT04ucGFyc2UocmF3KTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAoZnJhbWUudHlwZSA9PT0gJ2V2ZW50Jykge1xuICAgICAgaWYgKGZyYW1lLmV2ZW50ID09PSAnY29ubmVjdC5jaGFsbGVuZ2UnKSB7XG4gICAgICAgIGNvbnN0IG5vbmNlID0gZnJhbWUucGF5bG9hZD8ubm9uY2U7XG4gICAgICAgIGlmICh0eXBlb2Ygbm9uY2UgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgdGhpcy5jb25uZWN0Tm9uY2UgPSBub25jZTtcbiAgICAgICAgICB2b2lkIHRoaXMuc2VuZENvbm5lY3QoKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICB0aGlzLm9wdHMub25FdmVudD8uKHsgZXZlbnQ6IGZyYW1lLmV2ZW50LCBwYXlsb2FkOiBmcmFtZS5wYXlsb2FkID8/IHt9LCBzZXE6IGZyYW1lLnNlcSB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAoZnJhbWUudHlwZSA9PT0gJ3JlcycpIHtcbiAgICAgIGNvbnN0IGlkID0gYXNTdHJpbmcoZnJhbWUuaWQpO1xuICAgICAgY29uc3QgcGVuZGluZyA9IHRoaXMucGVuZGluZy5nZXQoaWQpO1xuICAgICAgaWYgKCFwZW5kaW5nKSByZXR1cm47XG4gICAgICB0aGlzLnBlbmRpbmcuZGVsZXRlKGlkKTtcbiAgICAgIGNvbnN0IHRpbWVvdXQgPSB0aGlzLnBlbmRpbmdUaW1lb3V0cy5nZXQoaWQpO1xuICAgICAgaWYgKHRpbWVvdXQpIHtcbiAgICAgICAgd2luZG93LmNsZWFyVGltZW91dCh0aW1lb3V0KTtcbiAgICAgICAgdGhpcy5wZW5kaW5nVGltZW91dHMuZGVsZXRlKGlkKTtcbiAgICAgIH1cbiAgICAgIGlmIChmcmFtZS5vaykgcGVuZGluZy5yZXNvbHZlKGZyYW1lLnBheWxvYWQpO1xuICAgICAgZWxzZSBwZW5kaW5nLnJlamVjdChuZXcgRXJyb3IoZnJhbWUuZXJyb3I/Lm1lc3NhZ2UgPz8gJ3JlcXVlc3QgZmFpbGVkJykpO1xuICAgIH1cbiAgfVxufVxuXG5jbGFzcyBIZXJtZXNNVlBWaWV3IGV4dGVuZHMgSXRlbVZpZXcge1xuICBwbHVnaW46IEhlcm1lc09ic2lkaWFuTVZQUGx1Z2luO1xuICBtZXNzYWdlczogQ2hhdE1lc3NhZ2VbXSA9IFtdO1xuICBwcml2YXRlIGlucHV0VmFsdWUgPSAnJztcbiAgcHJpdmF0ZSBpc1NlbmRpbmcgPSBmYWxzZTtcblxuICBjb25zdHJ1Y3RvcihsZWFmOiBXb3Jrc3BhY2VMZWFmLCBwbHVnaW46IEhlcm1lc09ic2lkaWFuTVZQUGx1Z2luKSB7XG4gICAgc3VwZXIobGVhZik7XG4gICAgdGhpcy5wbHVnaW4gPSBwbHVnaW47XG4gIH1cblxuICBnZXRWaWV3VHlwZSgpIHtcbiAgICByZXR1cm4gVklFV19UWVBFX0hFUk1FU19NVlA7XG4gIH1cblxuICBnZXREaXNwbGF5VGV4dCgpIHtcbiAgICByZXR1cm4gJ0hlcm1lcyc7XG4gIH1cblxuICBhc3luYyBvbk9wZW4oKSB7XG4gICAgdGhpcy5wbHVnaW4ucmVnaXN0ZXJWaWV3SW5zdGFuY2UodGhpcyk7XG4gICAgdGhpcy5yZW5kZXIoKTtcbiAgICBhd2FpdCB0aGlzLnBsdWdpbi5jb25uZWN0R2F0ZXdheSgpO1xuICAgIGF3YWl0IHRoaXMucGx1Z2luLmxvYWRIaXN0b3J5KCk7XG4gIH1cblxuICBhc3luYyBvbkNsb3NlKCkge1xuICAgIHRoaXMucGx1Z2luLnVucmVnaXN0ZXJWaWV3SW5zdGFuY2UodGhpcyk7XG4gIH1cblxuICBzZXRNZXNzYWdlcyhtZXNzYWdlczogQ2hhdE1lc3NhZ2VbXSkge1xuICAgIHRoaXMubWVzc2FnZXMgPSBtZXNzYWdlcztcbiAgICB0aGlzLnJlbmRlcigpO1xuICB9XG5cbiAgYXBwZW5kTWVzc2FnZShyb2xlOiBDaGF0TWVzc2FnZVsncm9sZSddLCB0ZXh0OiBzdHJpbmcpIHtcbiAgICBpZiAoIXRleHQpIHJldHVybjtcbiAgICBjb25zdCBsYXN0ID0gdGhpcy5tZXNzYWdlc1t0aGlzLm1lc3NhZ2VzLmxlbmd0aCAtIDFdO1xuICAgIGlmIChyb2xlID09PSAnYXNzaXN0YW50JyAmJiBsYXN0Py5yb2xlID09PSAnYXNzaXN0YW50JykgbGFzdC50ZXh0ICs9IHRleHQ7XG4gICAgZWxzZSBpZiAocm9sZSA9PT0gJ3N0YXR1cycgJiYgbGFzdD8ucm9sZSA9PT0gJ3N0YXR1cycpIGxhc3QudGV4dCA9IHRleHQ7XG4gICAgZWxzZSB0aGlzLm1lc3NhZ2VzLnB1c2goeyByb2xlLCB0ZXh0LCB0aW1lc3RhbXA6IERhdGUubm93KCkgfSk7XG4gICAgdGhpcy5yZW5kZXIoKTtcbiAgfVxuXG4gIG1hcmtTZW5kaW5nKGlzU2VuZGluZzogYm9vbGVhbikge1xuICAgIHRoaXMuaXNTZW5kaW5nID0gaXNTZW5kaW5nO1xuICAgIHRoaXMucmVuZGVyKCk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHN1Ym1pdFByb21wdCgpIHtcbiAgICBjb25zdCB0ZXh0ID0gdGhpcy5pbnB1dFZhbHVlLnRyaW0oKTtcbiAgICBpZiAoIXRleHQgfHwgdGhpcy5pc1NlbmRpbmcpIHJldHVybjtcbiAgICBpZiAoIXRoaXMucGx1Z2luLmdhdGV3YXlDb25uZWN0ZWQgfHwgIXRoaXMucGx1Z2luLmdhdGV3YXkpIHtcbiAgICAgIG5ldyBOb3RpY2UoJ05vdCBjb25uZWN0ZWQgdG8gSGVybWVzIGdhdGV3YXknKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICB0aGlzLmlucHV0VmFsdWUgPSAnJztcbiAgICB0aGlzLmlzU2VuZGluZyA9IHRydWU7XG4gICAgdGhpcy5tZXNzYWdlcy5wdXNoKHsgcm9sZTogJ3VzZXInLCB0ZXh0LCB0aW1lc3RhbXA6IERhdGUubm93KCkgfSk7XG4gICAgdGhpcy5tZXNzYWdlcy5wdXNoKHsgcm9sZTogJ2Fzc2lzdGFudCcsIHRleHQ6ICcnLCB0aW1lc3RhbXA6IERhdGUubm93KCkgfSk7XG4gICAgdGhpcy5yZW5kZXIoKTtcblxuICAgIHRyeSB7XG4gICAgICBhd2FpdCB0aGlzLnBsdWdpbi5nYXRld2F5LnJlcXVlc3QoJ2NoYXQuc2VuZCcsIHtcbiAgICAgICAgc2Vzc2lvbktleTogdGhpcy5wbHVnaW4uc2V0dGluZ3Muc2Vzc2lvbktleSxcbiAgICAgICAgbWVzc2FnZTogdGV4dCxcbiAgICAgICAgZGVsaXZlcjogZmFsc2UsXG4gICAgICAgIGlkZW1wb3RlbmN5S2V5OiByYW5kb21JZCgpLFxuICAgICAgfSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIHRoaXMuYXBwZW5kTWVzc2FnZSgnZXJyb3InLCBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcikpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICB0aGlzLmlzU2VuZGluZyA9IGZhbHNlO1xuICAgICAgdGhpcy5yZW5kZXIoKTtcbiAgICB9XG4gIH1cblxuICByZW5kZXIoKSB7XG4gICAgY29uc3Qgcm9vdCA9IHRoaXMuY29udGFpbmVyRWwuY2hpbGRyZW5bMV0gYXMgSFRNTEVsZW1lbnQ7XG4gICAgcm9vdC5lbXB0eSgpO1xuXG4gICAgY29uc3Qgd3JhcCA9IHJvb3QuY3JlYXRlRGl2KHsgY2xzOiAnaGVybWVzLW12cC13cmFwJyB9KTtcbiAgICBjb25zdCBsaXN0ID0gd3JhcC5jcmVhdGVEaXYoeyBjbHM6ICdoZXJtZXMtbXZwLW1lc3NhZ2VzJyB9KTtcblxuICAgIGZvciAoY29uc3QgbXNnIG9mIHRoaXMubWVzc2FnZXMpIHtcbiAgICAgIGNvbnN0IHJvdyA9IGxpc3QuY3JlYXRlRGl2KHsgY2xzOiBgaGVybWVzLW12cC1tc2cgaGVybWVzLW12cC0ke21zZy5yb2xlfWAgfSk7XG4gICAgICBjb25zdCBsYWJlbCA9IG1zZy5yb2xlID09PSAndXNlcicgPyAnWW91JyA6IG1zZy5yb2xlID09PSAnYXNzaXN0YW50JyA/ICdIZXJtZXMnIDogbXNnLnJvbGUgPT09ICdzdGF0dXMnID8gJ1N0YXR1cycgOiAnRXJyb3InO1xuICAgICAgcm93LmNyZWF0ZUVsKCdzdHJvbmcnLCB7IHRleHQ6IGxhYmVsIH0pO1xuICAgICAgcm93LmNyZWF0ZURpdih7IHRleHQ6IG1zZy50ZXh0IHx8IChtc2cucm9sZSA9PT0gJ2Fzc2lzdGFudCcgPyAnLi4uJyA6ICcnKSB9KTtcbiAgICB9XG5cbiAgICBjb25zdCBmb3JtID0gd3JhcC5jcmVhdGVEaXYoeyBjbHM6ICdoZXJtZXMtbXZwLWZvcm0nIH0pO1xuICAgIGNvbnN0IGlucHV0ID0gZm9ybS5jcmVhdGVFbCgndGV4dGFyZWEnLCB7XG4gICAgICBhdHRyOiB7IHJvd3M6ICc0JywgcGxhY2Vob2xkZXI6ICdBc2sgSGVybWVzLi4uJyB9LFxuICAgIH0pO1xuICAgIGlucHV0LnZhbHVlID0gdGhpcy5pbnB1dFZhbHVlO1xuICAgIGlucHV0LmRpc2FibGVkID0gdGhpcy5pc1NlbmRpbmc7XG4gICAgaW5wdXQuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLCAoKSA9PiB7XG4gICAgICB0aGlzLmlucHV0VmFsdWUgPSBpbnB1dC52YWx1ZTtcbiAgICB9KTtcbiAgICBpbnB1dC5hZGRFdmVudExpc3RlbmVyKCdrZXlkb3duJywgZXZ0ID0+IHtcbiAgICAgIGlmIChldnQua2V5ID09PSAnRW50ZXInICYmIChldnQubWV0YUtleSB8fCBldnQuY3RybEtleSkpIHtcbiAgICAgICAgZXZ0LnByZXZlbnREZWZhdWx0KCk7XG4gICAgICAgIHZvaWQgdGhpcy5zdWJtaXRQcm9tcHQoKTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIGNvbnN0IGJ1dHRvbiA9IGZvcm0uY3JlYXRlRWwoJ2J1dHRvbicsIHsgdGV4dDogdGhpcy5pc1NlbmRpbmcgPyAnU2VuZGluZy4uLicgOiAnU2VuZCcgfSk7XG4gICAgYnV0dG9uLmRpc2FibGVkID0gdGhpcy5pc1NlbmRpbmc7XG4gICAgYnV0dG9uLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gdm9pZCB0aGlzLnN1Ym1pdFByb21wdCgpKTtcbiAgfVxufVxuXG5jbGFzcyBIZXJtZXNTZXR0aW5nVGFiIGV4dGVuZHMgUGx1Z2luU2V0dGluZ1RhYiB7XG4gIHBsdWdpbjogSGVybWVzT2JzaWRpYW5NVlBQbHVnaW47XG5cbiAgY29uc3RydWN0b3IoYXBwOiBBcHAsIHBsdWdpbjogSGVybWVzT2JzaWRpYW5NVlBQbHVnaW4pIHtcbiAgICBzdXBlcihhcHAsIHBsdWdpbik7XG4gICAgdGhpcy5wbHVnaW4gPSBwbHVnaW47XG4gIH1cblxuICBkaXNwbGF5KCk6IHZvaWQge1xuICAgIGNvbnN0IHsgY29udGFpbmVyRWwgfSA9IHRoaXM7XG4gICAgY29udGFpbmVyRWwuZW1wdHkoKTtcblxuICAgIGNvbnRhaW5lckVsLmNyZWF0ZUVsKCdoMicsIHsgdGV4dDogJ0hlcm1lcyByZW1vdGUgc2V0dGluZ3MnIH0pO1xuXG4gICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG4gICAgICAuc2V0TmFtZSgnR2F0ZXdheSBVUkwnKVxuICAgICAgLnNldERlc2MoJ1Bhc3RlIHRoZSBIZXJtZXMgZ2F0ZXdheSBVUkwsIHVzdWFsbHkgYSBUYWlsc2NhbGUtc2VydmVkIGh0dHBzIFVSTC4nKVxuICAgICAgLmFkZFRleHQodGV4dCA9PlxuICAgICAgICB0ZXh0XG4gICAgICAgICAgLnNldFBsYWNlaG9sZGVyKCdodHRwczovL3lvdXItcGkudGFpbHh4eHgudHMubmV0JylcbiAgICAgICAgICAuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3MuZ2F0ZXdheVVybClcbiAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgdmFsdWUgPT4ge1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3MuZ2F0ZXdheVVybCA9IHZhbHVlLnRyaW0oKTtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgIH0pLFxuICAgICAgKTtcblxuICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgLnNldE5hbWUoJ0F1dGggdG9rZW4nKVxuICAgICAgLnNldERlc2MoJ0dhdGV3YXkgYXV0aCB0b2tlbiBmb3Igb3BlcmF0b3IgYWNjZXNzLicpXG4gICAgICAuYWRkVGV4dCh0ZXh0ID0+XG4gICAgICAgIHRleHRcbiAgICAgICAgICAuc2V0UGxhY2Vob2xkZXIoJ1Bhc3RlIHlvdXIgZ2F0ZXdheSB0b2tlbicpXG4gICAgICAgICAgLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLnRva2VuKVxuICAgICAgICAgIC5vbkNoYW5nZShhc3luYyB2YWx1ZSA9PiB7XG4gICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy50b2tlbiA9IHZhbHVlLnRyaW0oKTtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgIH0pLFxuICAgICAgKTtcblxuICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgLnNldE5hbWUoJ1Rlc3QgY29ubmVjdGlvbicpXG4gICAgICAuc2V0RGVzYygnQ29ubmVjdCB0byB0aGUgcmVtb3RlIEhlcm1lcyBnYXRld2F5IGFuZCB2ZXJpZnkgYWNjZXNzLicpXG4gICAgICAuYWRkQnV0dG9uKGJ1dHRvbiA9PlxuICAgICAgICBidXR0b24uc2V0QnV0dG9uVGV4dCgnQ29ubmVjdCcpLnNldEN0YSgpLm9uQ2xpY2soYXN5bmMgKCkgPT4ge1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5jb25uZWN0R2F0ZXdheSh0cnVlKTtcbiAgICAgICAgICAgIG5ldyBOb3RpY2UoJ0Nvbm5lY3RlZCB0byBIZXJtZXMgZ2F0ZXdheScpO1xuICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBuZXcgTm90aWNlKGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKSk7XG4gICAgICAgICAgfVxuICAgICAgICB9KSxcbiAgICAgICk7XG4gIH1cbn1cblxuZXhwb3J0IGRlZmF1bHQgY2xhc3MgSGVybWVzT2JzaWRpYW5NVlBQbHVnaW4gZXh0ZW5kcyBQbHVnaW4ge1xuICBzZXR0aW5ncyE6IEhlcm1lc1BsdWdpblNldHRpbmdzO1xuICBnYXRld2F5OiBHYXRld2F5Q2xpZW50IHwgbnVsbCA9IG51bGw7XG4gIGdhdGV3YXlDb25uZWN0ZWQgPSBmYWxzZTtcbiAgcHJpdmF0ZSBhY3RpdmVWaWV3OiBIZXJtZXNNVlBWaWV3IHwgbnVsbCA9IG51bGw7XG5cbiAgYXN5bmMgb25sb2FkKCkge1xuICAgIHRoaXMuc2V0dGluZ3MgPSBPYmplY3QuYXNzaWduKHt9LCBERUZBVUxUX1NFVFRJTkdTLCBhd2FpdCB0aGlzLmxvYWREYXRhKCkpO1xuICAgIGF3YWl0IHRoaXMuZW5zdXJlRGV2aWNlSWRlbnRpdHkoKTtcblxuICAgIHRoaXMucmVnaXN0ZXJWaWV3KFZJRVdfVFlQRV9IRVJNRVNfTVZQLCBsZWFmID0+IG5ldyBIZXJtZXNNVlBWaWV3KGxlYWYsIHRoaXMpKTtcbiAgICB0aGlzLmFkZFNldHRpbmdUYWIobmV3IEhlcm1lc1NldHRpbmdUYWIodGhpcy5hcHAsIHRoaXMpKTtcblxuICAgIHRoaXMuYWRkUmliYm9uSWNvbignYm90JywgJ09wZW4gSGVybWVzJywgYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQgdGhpcy5hY3RpdmF0ZVZpZXcoKTtcbiAgICB9KTtcblxuICAgIHRoaXMuYWRkQ29tbWFuZCh7XG4gICAgICBpZDogJ29wZW4taGVybWVzLW12cCcsXG4gICAgICBuYW1lOiAnT3BlbiBIZXJtZXMnLFxuICAgICAgY2FsbGJhY2s6IGFzeW5jICgpID0+IHRoaXMuYWN0aXZhdGVWaWV3KCksXG4gICAgfSk7XG5cbiAgICBpZiAodGhpcy5zZXR0aW5ncy5nYXRld2F5VXJsICYmIHRoaXMuc2V0dGluZ3MudG9rZW4pIHtcbiAgICAgIHZvaWQgdGhpcy5jb25uZWN0R2F0ZXdheSgpO1xuICAgIH1cbiAgfVxuXG4gIGFzeW5jIG9udW5sb2FkKCkge1xuICAgIHRoaXMuZ2F0ZXdheT8uc3RvcCgpO1xuICAgIHRoaXMuYXBwLndvcmtzcGFjZS5kZXRhY2hMZWF2ZXNPZlR5cGUoVklFV19UWVBFX0hFUk1FU19NVlApO1xuICB9XG5cbiAgcmVnaXN0ZXJWaWV3SW5zdGFuY2UodmlldzogSGVybWVzTVZQVmlldykge1xuICAgIHRoaXMuYWN0aXZlVmlldyA9IHZpZXc7XG4gIH1cblxuICB1bnJlZ2lzdGVyVmlld0luc3RhbmNlKHZpZXc6IEhlcm1lc01WUFZpZXcpIHtcbiAgICBpZiAodGhpcy5hY3RpdmVWaWV3ID09PSB2aWV3KSB0aGlzLmFjdGl2ZVZpZXcgPSBudWxsO1xuICB9XG5cbiAgYXN5bmMgc2F2ZVNldHRpbmdzKCkge1xuICAgIGF3YWl0IHRoaXMuc2F2ZURhdGEodGhpcy5zZXR0aW5ncyk7XG4gICAgdGhpcy5nYXRld2F5Py5zdG9wKCk7XG4gICAgdGhpcy5nYXRld2F5ID0gbnVsbDtcbiAgICB0aGlzLmdhdGV3YXlDb25uZWN0ZWQgPSBmYWxzZTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgZW5zdXJlRGV2aWNlSWRlbnRpdHkoKSB7XG4gICAgY29uc3QgZGV2aWNlSWQgPSB0aGlzLnNldHRpbmdzLmRldmljZUlkO1xuICAgIGNvbnN0IHB1YmxpY0tleSA9IHRoaXMuc2V0dGluZ3MuZGV2aWNlUHVibGljS2V5O1xuICAgIGNvbnN0IHByaXZhdGVLZXkgPSB0aGlzLnNldHRpbmdzLmRldmljZVByaXZhdGVLZXk7XG4gICAgaWYgKGRldmljZUlkICYmIHB1YmxpY0tleSAmJiBwcml2YXRlS2V5KSByZXR1cm47XG5cbiAgICBjb25zdCBrZXlwYWlyID0gYXdhaXQgY3J5cHRvLnN1YnRsZS5nZW5lcmF0ZUtleSgnRWQyNTUxOScsIHRydWUsIFsnc2lnbicsICd2ZXJpZnknXSk7XG4gICAgY29uc3QgcmF3UHVibGljID0gbmV3IFVpbnQ4QXJyYXkoYXdhaXQgY3J5cHRvLnN1YnRsZS5leHBvcnRLZXkoJ3JhdycsIGtleXBhaXIucHVibGljS2V5KSk7XG4gICAgY29uc3QgcmF3UHJpdmF0ZSA9IG5ldyBVaW50OEFycmF5KGF3YWl0IGNyeXB0by5zdWJ0bGUuZXhwb3J0S2V5KCdwa2NzOCcsIGtleXBhaXIucHJpdmF0ZUtleSkpO1xuICAgIHRoaXMuc2V0dGluZ3MuZGV2aWNlSWQgPSBhd2FpdCBzaGEyNTZIZXgocmF3UHVibGljKTtcbiAgICB0aGlzLnNldHRpbmdzLmRldmljZVB1YmxpY0tleSA9IHRvQmFzZTY0VXJsKHJhd1B1YmxpYyk7XG4gICAgdGhpcy5zZXR0aW5ncy5kZXZpY2VQcml2YXRlS2V5ID0gdG9CYXNlNjRVcmwocmF3UHJpdmF0ZSk7XG4gICAgYXdhaXQgdGhpcy5zYXZlRGF0YSh0aGlzLnNldHRpbmdzKTtcbiAgfVxuXG4gIHByaXZhdGUgZ2V0RGV2aWNlSWRlbnRpdHkoKTogRGV2aWNlSWRlbnRpdHkgfCB1bmRlZmluZWQge1xuICAgIGlmICghdGhpcy5zZXR0aW5ncy5kZXZpY2VJZCB8fCAhdGhpcy5zZXR0aW5ncy5kZXZpY2VQdWJsaWNLZXkgfHwgIXRoaXMuc2V0dGluZ3MuZGV2aWNlUHJpdmF0ZUtleSkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICByZXR1cm4ge1xuICAgICAgZGV2aWNlSWQ6IHRoaXMuc2V0dGluZ3MuZGV2aWNlSWQsXG4gICAgICBwdWJsaWNLZXk6IHRoaXMuc2V0dGluZ3MuZGV2aWNlUHVibGljS2V5LFxuICAgICAgcHJpdmF0ZUtleTogdGhpcy5zZXR0aW5ncy5kZXZpY2VQcml2YXRlS2V5LFxuICAgIH07XG4gIH1cblxuICBhc3luYyBjb25uZWN0R2F0ZXdheShmb3JjZVJlY29ubmVjdCA9IGZhbHNlKSB7XG4gICAgaWYgKCF0aGlzLnNldHRpbmdzLmdhdGV3YXlVcmwgfHwgIXRoaXMuc2V0dGluZ3MudG9rZW4pIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignTWlzc2luZyBnYXRld2F5IFVSTCBvciB0b2tlbicpO1xuICAgIH1cblxuICAgIGlmICh0aGlzLmdhdGV3YXlDb25uZWN0ZWQgJiYgdGhpcy5nYXRld2F5ICYmICFmb3JjZVJlY29ubmVjdCkgcmV0dXJuO1xuICAgIHRoaXMuZ2F0ZXdheT8uc3RvcCgpO1xuXG4gICAgY29uc3Qgbm9ybWFsaXplZFVybCA9IG5vcm1hbGl6ZUdhdGV3YXlVcmwodGhpcy5zZXR0aW5ncy5nYXRld2F5VXJsKTtcbiAgICBpZiAoIW5vcm1hbGl6ZWRVcmwpIHRocm93IG5ldyBFcnJvcignSW52YWxpZCBnYXRld2F5IFVSTCcpO1xuICAgIHRoaXMuc2V0dGluZ3MuZ2F0ZXdheVVybCA9IG5vcm1hbGl6ZWRVcmw7XG4gICAgYXdhaXQgdGhpcy5zYXZlRGF0YSh0aGlzLnNldHRpbmdzKTtcblxuICAgIHRoaXMuZ2F0ZXdheSA9IG5ldyBHYXRld2F5Q2xpZW50KHtcbiAgICAgIHVybDogbm9ybWFsaXplZFVybCxcbiAgICAgIHRva2VuOiB0aGlzLnNldHRpbmdzLnRva2VuLFxuICAgICAgZGV2aWNlSWRlbnRpdHk6IHRoaXMuZ2V0RGV2aWNlSWRlbnRpdHkoKSxcbiAgICAgIG9uSGVsbG86ICgpID0+IHtcbiAgICAgICAgdGhpcy5nYXRld2F5Q29ubmVjdGVkID0gdHJ1ZTtcbiAgICAgICAgdGhpcy5hY3RpdmVWaWV3Py5hcHBlbmRNZXNzYWdlKCdzdGF0dXMnLCAnQ29ubmVjdGVkIHRvIEhlcm1lcyBnYXRld2F5Jyk7XG4gICAgICAgIHZvaWQgdGhpcy5sb2FkSGlzdG9yeSgpO1xuICAgICAgfSxcbiAgICAgIG9uQ2xvc2U6IGluZm8gPT4ge1xuICAgICAgICB0aGlzLmdhdGV3YXlDb25uZWN0ZWQgPSBmYWxzZTtcbiAgICAgICAgaWYgKGluZm8ucmVhc29uKSB0aGlzLmFjdGl2ZVZpZXc/LmFwcGVuZE1lc3NhZ2UoJ3N0YXR1cycsIGBDb25uZWN0aW9uIGNsb3NlZDogJHtpbmZvLnJlYXNvbn1gKTtcbiAgICAgIH0sXG4gICAgICBvbkVycm9yOiBlcnJvciA9PiB7XG4gICAgICAgIHRoaXMuZ2F0ZXdheUNvbm5lY3RlZCA9IGZhbHNlO1xuICAgICAgICB0aGlzLmFjdGl2ZVZpZXc/LmFwcGVuZE1lc3NhZ2UoJ2Vycm9yJywgZXJyb3IubWVzc2FnZSk7XG4gICAgICB9LFxuICAgICAgb25FdmVudDogZXZlbnQgPT4gdGhpcy5oYW5kbGVHYXRld2F5RXZlbnQoZXZlbnQpLFxuICAgIH0pO1xuXG4gICAgdGhpcy5nYXRld2F5LnN0YXJ0KCk7XG4gIH1cblxuICBwcml2YXRlIGhhbmRsZUdhdGV3YXlFdmVudChldmVudDogR2F0ZXdheUV2ZW50KSB7XG4gICAgaWYgKGV2ZW50LmV2ZW50ID09PSAnY2hhdCcgfHwgZXZlbnQuZXZlbnQgPT09ICdzdHJlYW0nIHx8IGV2ZW50LmV2ZW50ID09PSAnYWdlbnQnKSB7XG4gICAgICBjb25zdCBwYXlsb2FkID0gZXZlbnQucGF5bG9hZCA/PyB7fTtcbiAgICAgIGNvbnN0IHRleHQgPSB0aGlzLmV4dHJhY3RFdmVudFRleHQocGF5bG9hZCk7XG4gICAgICBpZiAodGV4dCkgdGhpcy5hY3RpdmVWaWV3Py5hcHBlbmRNZXNzYWdlKCdhc3Npc3RhbnQnLCB0ZXh0KTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGV4dHJhY3RFdmVudFRleHQocGF5bG9hZDogUmVjb3JkPHN0cmluZywgYW55Pik6IHN0cmluZyB7XG4gICAgY29uc3QgdGV4dHM6IHN0cmluZ1tdID0gW107XG4gICAgY29uc3Qgd2FsayA9ICh2YWx1ZTogYW55KSA9PiB7XG4gICAgICBpZiAodmFsdWUgPT0gbnVsbCkgcmV0dXJuO1xuICAgICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycpIHJldHVybjtcbiAgICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICB2YWx1ZS5mb3JFYWNoKHdhbGspO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBpZiAodHlwZW9mIHZhbHVlICE9PSAnb2JqZWN0JykgcmV0dXJuO1xuICAgICAgaWYgKHR5cGVvZiB2YWx1ZS50ZXh0ID09PSAnc3RyaW5nJykgdGV4dHMucHVzaCh2YWx1ZS50ZXh0KTtcbiAgICAgIGlmICh0eXBlb2YgdmFsdWUuY29udGVudCA9PT0gJ3N0cmluZycpIHRleHRzLnB1c2godmFsdWUuY29udGVudCk7XG4gICAgICBpZiAodHlwZW9mIHZhbHVlLmRlbHRhID09PSAnc3RyaW5nJykgdGV4dHMucHVzaCh2YWx1ZS5kZWx0YSk7XG4gICAgICBPYmplY3QudmFsdWVzKHZhbHVlKS5mb3JFYWNoKHdhbGspO1xuICAgIH07XG4gICAgd2FsayhwYXlsb2FkKTtcbiAgICByZXR1cm4gdGV4dHMuam9pbignJyk7XG4gIH1cblxuICBhc3luYyBsb2FkSGlzdG9yeSgpIHtcbiAgICBpZiAoIXRoaXMuZ2F0ZXdheUNvbm5lY3RlZCB8fCAhdGhpcy5nYXRld2F5KSByZXR1cm47XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRoaXMuZ2F0ZXdheS5yZXF1ZXN0KCdjaGF0Lmhpc3RvcnknLCB7XG4gICAgICAgIHNlc3Npb25LZXk6IHRoaXMuc2V0dGluZ3Muc2Vzc2lvbktleSxcbiAgICAgICAgbGltaXQ6IDIwMCxcbiAgICAgIH0pO1xuICAgICAgY29uc3QgbWVzc2FnZXMgPSBBcnJheS5pc0FycmF5KHJlc3VsdD8ubWVzc2FnZXMpXG4gICAgICAgID8gcmVzdWx0Lm1lc3NhZ2VzXG4gICAgICAgICAgICAuZmlsdGVyKChtc2c6IGFueSkgPT4gbXNnLnJvbGUgPT09ICd1c2VyJyB8fCBtc2cucm9sZSA9PT0gJ2Fzc2lzdGFudCcpXG4gICAgICAgICAgICAubWFwKChtc2c6IGFueSkgPT4gKHtcbiAgICAgICAgICAgICAgcm9sZTogbXNnLnJvbGUsXG4gICAgICAgICAgICAgIHRleHQ6IHRoaXMuZXh0cmFjdEV2ZW50VGV4dCh7IGNvbnRlbnQ6IG1zZy5jb250ZW50IH0pIHx8IGFzU3RyaW5nKG1zZy50ZXh0KSxcbiAgICAgICAgICAgICAgdGltZXN0YW1wOiB0eXBlb2YgbXNnLnRpbWVzdGFtcCA9PT0gJ251bWJlcicgPyBtc2cudGltZXN0YW1wIDogRGF0ZS5ub3coKSxcbiAgICAgICAgICAgIH0pKVxuICAgICAgICAgICAgLmZpbHRlcigobXNnOiBDaGF0TWVzc2FnZSkgPT4gbXNnLnRleHQudHJpbSgpKVxuICAgICAgICA6IFtdO1xuICAgICAgdGhpcy5hY3RpdmVWaWV3Py5zZXRNZXNzYWdlcyhtZXNzYWdlcyk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIHRoaXMuYWN0aXZlVmlldz8uYXBwZW5kTWVzc2FnZSgnZXJyb3InLCBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcikpO1xuICAgIH1cbiAgfVxuXG4gIGFzeW5jIGFjdGl2YXRlVmlldygpIHtcbiAgICBsZXQgbGVhZiA9IHRoaXMuYXBwLndvcmtzcGFjZS5nZXRMZWF2ZXNPZlR5cGUoVklFV19UWVBFX0hFUk1FU19NVlApWzBdO1xuICAgIGlmICghbGVhZikge1xuICAgICAgbGVhZiA9IHRoaXMuYXBwLndvcmtzcGFjZS5nZXRSaWdodExlYWYoZmFsc2UpO1xuICAgICAgYXdhaXQgbGVhZi5zZXRWaWV3U3RhdGUoeyB0eXBlOiBWSUVXX1RZUEVfSEVSTUVTX01WUCwgYWN0aXZlOiB0cnVlIH0pO1xuICAgIH1cbiAgICBhd2FpdCB0aGlzLmFwcC53b3Jrc3BhY2UucmV2ZWFsTGVhZihsZWFmKTtcbiAgfVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIjs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsc0JBQXdGO0FBRXhGLElBQU0sdUJBQXVCO0FBK0I3QixJQUFNLG1CQUF5QztBQUFBLEVBQzdDLFlBQVk7QUFBQSxFQUNaLE9BQU87QUFBQSxFQUNQLFlBQVk7QUFBQSxFQUNaLG9CQUFvQjtBQUN0QjtBQUVBLFNBQVMsU0FBUyxPQUFnQixXQUFXLElBQVk7QUFDdkQsU0FBTyxPQUFPLFVBQVUsV0FBVyxRQUFRO0FBQzdDO0FBRUEsU0FBUyxvQkFBb0IsS0FBNEI7QUFDdkQsTUFBSSxRQUFRLElBQUksS0FBSztBQUNyQixNQUFJLENBQUMsTUFBTyxRQUFPO0FBQ25C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
