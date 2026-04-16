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

// src/transport/hermes-acp-client.ts
var import_child_process = require("child_process");
var import_fs = require("fs");
var HermesACPClient = class {
  constructor(hermesCommand) {
    this.hermesCommand = hermesCommand;
    this.proc = null;
    this.buffer = "";
    this.nextId = 1;
    this.pending = /* @__PURE__ */ new Map();
    this.initialized = false;
    this.sessionId = null;
  }
  resolveHermesCommand() {
    if (this.hermesCommand.includes("/") || this.hermesCommand.includes("\\")) {
      return this.hermesCommand;
    }
    const home = process.env.HOME;
    const candidates = [
      this.hermesCommand,
      home ? `${home}/.local/bin/${this.hermesCommand}` : null,
      home ? `${home}/.npm-global/bin/${this.hermesCommand}` : null,
      `/usr/local/bin/${this.hermesCommand}`,
      `/opt/homebrew/bin/${this.hermesCommand}`
    ].filter((value) => Boolean(value));
    for (const candidate of candidates) {
      if (candidate === this.hermesCommand || (0, import_fs.existsSync)(candidate)) return candidate;
    }
    return this.hermesCommand;
  }
  ensureStarted(cwd) {
    if (this.proc) return;
    const command = this.resolveHermesCommand();
    this.proc = (0, import_child_process.spawn)(command, ["acp"], {
      cwd: cwd || process.cwd(),
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.proc.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      this.consumeBuffer();
    });
    this.proc.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text && this.onStatus) this.onStatus(text);
    });
    this.proc.on("error", (error) => {
      const extra = command === this.hermesCommand ? "" : ` (resolved from ${this.hermesCommand} to ${command})`;
      this.onError?.(`Failed to start Hermes ACP${extra}: ${String(error)}`);
    });
    this.proc.on("exit", (code) => {
      const error = `Hermes ACP exited${code !== null ? ` with code ${code}` : ""}`;
      for (const pending of this.pending.values()) pending.reject(new Error(error));
      this.pending.clear();
      this.proc = null;
      this.initialized = false;
      this.sessionId = null;
      this.onStatus?.(error);
    });
  }
  consumeBuffer() {
    let newlineIndex = -1;
    while ((newlineIndex = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        this.handleMessage(msg);
      } catch (error) {
        this.onError?.(`Failed to parse ACP output: ${String(error)}`);
      }
    }
  }
  handleMessage(msg) {
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const pending = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) {
        const detail = typeof msg.error === "string" ? msg.error : msg.error?.message || JSON.stringify(msg.error);
        pending.reject(new Error(detail));
      } else pending.resolve(msg.result);
      return;
    }
    if (msg.method === "session/update") {
      this.handleSessionUpdate(msg.params ?? {});
    }
  }
  handleSessionUpdate(params) {
    const update = params.update ?? params;
    if (!update || typeof update !== "object") return;
    const sessionUpdate = update.sessionUpdate ?? update.session_update;
    if (sessionUpdate === "agent_message_chunk" || sessionUpdate === "agent_message") {
      const text = this.extractText(update);
      if (text) this.onAssistantText?.(text);
      return;
    }
    if (sessionUpdate === "agent_thought_chunk" || sessionUpdate === "tool_call" || sessionUpdate === "tool_call_update") {
      const text = this.extractText(update);
      if (text) this.onStatus?.(text);
      return;
    }
    if (sessionUpdate === "available_commands_update") {
      return;
    }
    const fallback = this.extractText(update);
    if (fallback) this.onStatus?.(fallback);
  }
  extractText(value) {
    const parts = [];
    const walk = (node) => {
      if (node == null) return;
      if (typeof node === "string") return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (typeof node !== "object") return;
      if (typeof node.text === "string") parts.push(node.text);
      if (typeof node.content === "string") parts.push(node.content);
      if (typeof node.result === "string") parts.push(node.result);
      if (typeof node.description === "string") parts.push(node.description);
      for (const key of Object.keys(node)) {
        walk(node[key]);
      }
    };
    walk(value);
    return parts.join("");
  }
  request(method, params) {
    if (!this.proc) throw new Error("Hermes ACP process is not running");
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    this.proc.stdin.write(`${JSON.stringify(payload)}
`);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }
  async ensureInitialized(cwd) {
    this.ensureStarted(cwd);
    if (this.initialized) return;
    await this.request("initialize", {
      protocol_version: 1,
      client_capabilities: {},
      client_info: {
        name: "hermes-obsidian-mvp",
        version: "0.0.2"
      }
    });
    this.initialized = true;
  }
  async ensureSession(cwd) {
    if (this.sessionId) return this.sessionId;
    const result = await this.request("session/new", { cwd: cwd || process.cwd(), mcpServers: [] });
    this.sessionId = result?.sessionId ?? result?.session_id ?? result?.id;
    if (!this.sessionId) throw new Error("Hermes ACP did not return a session id");
    return this.sessionId;
  }
  async sendPrompt(text, cwd) {
    await this.ensureInitialized(cwd);
    const sessionId = await this.ensureSession(cwd);
    return this.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }]
    });
  }
};

// src/main.ts
var VIEW_TYPE_HERMES_MVP = "hermes-obsidian-mvp";
var DEFAULT_SETTINGS = {
  hermesCommand: "hermes"
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
  }
  async onClose() {
    this.plugin.unregisterViewInstance(this);
  }
  appendMessage(role, text) {
    if (!text) return;
    if (role === "assistant") {
      const last = this.messages[this.messages.length - 1];
      if (last && last.role === "assistant") {
        last.text += text;
      } else {
        this.messages.push({ role, text });
      }
    } else if (role === "status") {
      const last = this.messages[this.messages.length - 1];
      if (last && last.role === "status") {
        last.text = text;
      } else {
        this.messages.push({ role, text });
      }
    } else {
      this.messages.push({ role, text });
    }
    this.render();
  }
  async submitPrompt() {
    const text = this.inputValue.trim();
    if (!text || this.isSending) return;
    this.inputValue = "";
    this.isSending = true;
    this.messages.push({ role: "user", text });
    this.messages.push({ role: "assistant", text: "" });
    this.render();
    try {
      await this.plugin.client.sendPrompt(text, this.plugin.getVaultPath());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.appendMessage("error", message);
    } finally {
      this.isSending = false;
      this.render();
    }
  }
  getLabel(role) {
    switch (role) {
      case "user":
        return "You";
      case "assistant":
        return "Hermes";
      case "status":
        return "Status";
      case "error":
        return "Error";
    }
  }
  async renderMessageBody(container, msg) {
    if (msg.role === "assistant") {
      await import_obsidian.MarkdownRenderer.render(this.app, msg.text || "\u2026", container, "", this.plugin);
      return;
    }
    if (msg.role === "status") {
      container.setText(msg.text);
      return;
    }
    container.setText(msg.text || (msg.role === "assistant" ? "\u2026" : ""));
  }
  render() {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass("hermes-mvp-root");
    const wrap = root.createDiv({ cls: "hermes-mvp-wrap" });
    const header = wrap.createDiv({ cls: "hermes-mvp-header" });
    header.createDiv({ cls: "hermes-mvp-title", text: "Hermes" });
    header.createDiv({
      cls: "hermes-mvp-subtitle",
      text: this.isSending ? "Thinking\u2026" : "Local Obsidian chat"
    });
    const list = wrap.createDiv({ cls: "hermes-mvp-messages" });
    if (this.messages.length === 0) {
      const empty = list.createDiv({ cls: "hermes-mvp-empty" });
      empty.createDiv({ cls: "hermes-mvp-empty-title", text: "Start a conversation" });
      empty.createDiv({
        cls: "hermes-mvp-empty-subtitle",
        text: "Ask Hermes to brainstorm, write, summarize, or help you think through a note."
      });
    }
    for (const msg of this.messages) {
      const row = list.createDiv({ cls: `hermes-mvp-row hermes-mvp-row-${msg.role}` });
      const bubble = row.createDiv({ cls: `hermes-mvp-bubble hermes-mvp-bubble-${msg.role}` });
      bubble.createDiv({ cls: "hermes-mvp-bubble-label", text: this.getLabel(msg.role) });
      const body = bubble.createDiv({ cls: "hermes-mvp-bubble-body" });
      void this.renderMessageBody(body, msg);
    }
    const composer = wrap.createDiv({ cls: "hermes-mvp-composer" });
    const inputWrap = composer.createDiv({ cls: "hermes-mvp-input-wrap" });
    const input = inputWrap.createEl("textarea", {
      cls: "hermes-mvp-input",
      attr: { rows: "1", placeholder: "Message Hermes\u2026" }
    });
    input.value = this.inputValue;
    input.disabled = this.isSending;
    input.addEventListener("input", () => {
      this.inputValue = input.value;
      input.style.height = "0px";
      input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
    });
    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" && !evt.shiftKey) {
        evt.preventDefault();
        void this.submitPrompt();
      }
    });
    input.style.height = "0px";
    input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
    const button = composer.createEl("button", {
      cls: "mod-cta hermes-mvp-send",
      text: this.isSending ? "Sending\u2026" : "Send"
    });
    button.disabled = this.isSending;
    button.addEventListener("click", () => {
      void this.submitPrompt();
    });
    list.scrollTop = list.scrollHeight;
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
    new import_obsidian.Setting(containerEl).setName("Hermes command").setDesc("Command used to launch Hermes ACP locally.").addText(
      (text) => text.setPlaceholder("hermes").setValue(this.plugin.settings.hermesCommand).onChange(async (value) => {
        this.plugin.settings.hermesCommand = value.trim() || "hermes";
        await this.plugin.saveSettings();
        new import_obsidian.Notice("Hermes command saved");
      })
    );
  }
};
var HermesObsidianMVPPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.activeView = null;
  }
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.client = new HermesACPClient(this.settings.hermesCommand);
    this.wireClientCallbacks();
    this.injectStyles();
    this.registerView(VIEW_TYPE_HERMES_MVP, (leaf) => new HermesMVPView(leaf, this));
    this.addSettingTab(new HermesSettingTab(this.app, this));
    this.addRibbonIcon("bot", "Open Hermes MVP", async () => {
      await this.activateView();
    });
    this.addCommand({
      id: "open-hermes-mvp",
      name: "Open Hermes MVP",
      callback: async () => this.activateView()
    });
  }
  async onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_HERMES_MVP);
  }
  registerViewInstance(view) {
    this.activeView = view;
  }
  unregisterViewInstance(view) {
    if (this.activeView === view) this.activeView = null;
  }
  getVaultPath() {
    return this.app.vault.adapter.basePath || process.cwd();
  }
  async saveSettings() {
    await this.saveData(this.settings);
    this.client = new HermesACPClient(this.settings.hermesCommand);
    this.wireClientCallbacks();
  }
  wireClientCallbacks() {
    this.client.onAssistantText = (text) => {
      this.activeView?.appendMessage("assistant", text);
    };
    this.client.onStatus = (text) => {
      this.activeView?.appendMessage("status", text);
    };
    this.client.onError = (text) => {
      this.activeView?.appendMessage("error", text);
      new import_obsidian.Notice(text);
    };
  }
  injectStyles() {
    const styleId = "hermes-mvp-inline-styles";
    document.getElementById(styleId)?.remove();
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      .hermes-mvp-root {
        height: 100%;
      }

      .hermes-mvp-wrap {
        display: flex;
        flex-direction: column;
        height: 100%;
        background: var(--background-primary);
        color: var(--text-normal);
      }

      .hermes-mvp-header {
        padding: 14px 16px 10px;
        border-bottom: 1px solid var(--background-modifier-border);
        background: color-mix(in srgb, var(--background-secondary) 70%, transparent);
      }

      .hermes-mvp-title {
        font-size: 18px;
        font-weight: 700;
        letter-spacing: -0.01em;
      }

      .hermes-mvp-subtitle {
        margin-top: 2px;
        font-size: 12px;
        color: var(--text-muted);
      }

      .hermes-mvp-messages {
        flex: 1;
        overflow-y: auto;
        padding: 18px 16px 24px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .hermes-mvp-empty {
        margin: auto 0;
        padding: 24px 18px;
        border: 1px dashed var(--background-modifier-border);
        border-radius: 16px;
        background: color-mix(in srgb, var(--background-secondary) 55%, transparent);
      }

      .hermes-mvp-empty-title {
        font-size: 16px;
        font-weight: 600;
        margin-bottom: 6px;
      }

      .hermes-mvp-empty-subtitle {
        font-size: 13px;
        line-height: 1.5;
        color: var(--text-muted);
      }

      .hermes-mvp-row {
        display: flex;
      }

      .hermes-mvp-row-user {
        justify-content: flex-end;
      }

      .hermes-mvp-row-assistant,
      .hermes-mvp-row-status,
      .hermes-mvp-row-error {
        justify-content: flex-start;
      }

      .hermes-mvp-bubble {
        max-width: min(680px, 92%);
        border-radius: 16px;
        padding: 10px 12px;
        box-shadow: 0 1px 2px rgb(0 0 0 / 0.08);
      }

      .hermes-mvp-bubble-user {
        background: var(--interactive-accent);
        color: var(--text-on-accent);
        border-bottom-right-radius: 6px;
      }

      .hermes-mvp-bubble-assistant {
        background: var(--background-secondary);
        border: 1px solid var(--background-modifier-border);
        border-bottom-left-radius: 6px;
      }

      .hermes-mvp-bubble-status {
        background: color-mix(in srgb, var(--color-blue) 10%, var(--background-secondary));
        border: 1px solid color-mix(in srgb, var(--color-blue) 28%, var(--background-modifier-border));
        color: var(--text-muted);
        max-width: 100%;
      }

      .hermes-mvp-bubble-error {
        background: color-mix(in srgb, var(--color-red) 10%, var(--background-secondary));
        border: 1px solid color-mix(in srgb, var(--color-red) 30%, var(--background-modifier-border));
        color: var(--text-normal);
        max-width: 100%;
      }

      .hermes-mvp-bubble-label {
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        opacity: 0.7;
        margin-bottom: 6px;
      }

      .hermes-mvp-bubble-body {
        font-size: 14px;
        line-height: 1.55;
        word-break: break-word;
      }

      .hermes-mvp-bubble-body > :first-child {
        margin-top: 0;
      }

      .hermes-mvp-bubble-body > :last-child {
        margin-bottom: 0;
      }

      .hermes-mvp-composer {
        display: flex;
        align-items: flex-end;
        gap: 10px;
        padding: 14px 16px 16px;
        border-top: 1px solid var(--background-modifier-border);
        background: var(--background-primary);
      }

      .hermes-mvp-input-wrap {
        flex: 1;
        background: var(--background-secondary);
        border: 1px solid var(--background-modifier-border);
        border-radius: 16px;
        padding: 10px 12px;
      }

      .hermes-mvp-input {
        width: 100%;
        min-height: 24px;
        max-height: 220px;
        resize: none;
        border: 0;
        outline: none;
        background: transparent;
        box-shadow: none;
        color: var(--text-normal);
        font: inherit;
        line-height: 1.5;
        padding: 0;
      }

      .hermes-mvp-input::placeholder {
        color: var(--text-faint);
      }

      .hermes-mvp-send {
        border-radius: 14px;
        min-width: 80px;
        height: 44px;
      }
    `;
    document.head.appendChild(style);
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsic3JjL21haW4udHMiLCAic3JjL3RyYW5zcG9ydC9oZXJtZXMtYWNwLWNsaWVudC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgQXBwLCBJdGVtVmlldywgTWFya2Rvd25SZW5kZXJlciwgTm90aWNlLCBQbHVnaW4sIFBsdWdpblNldHRpbmdUYWIsIFNldHRpbmcsIFdvcmtzcGFjZUxlYWYgfSBmcm9tICdvYnNpZGlhbic7XG5pbXBvcnQgeyBIZXJtZXNBQ1BDbGllbnQgfSBmcm9tICcuL3RyYW5zcG9ydC9oZXJtZXMtYWNwLWNsaWVudCc7XG5cbmNvbnN0IFZJRVdfVFlQRV9IRVJNRVNfTVZQID0gJ2hlcm1lcy1vYnNpZGlhbi1tdnAnO1xuXG50eXBlIENoYXRNZXNzYWdlID0ge1xuICByb2xlOiAndXNlcicgfCAnYXNzaXN0YW50JyB8ICdzdGF0dXMnIHwgJ2Vycm9yJztcbiAgdGV4dDogc3RyaW5nO1xufTtcblxuaW50ZXJmYWNlIEhlcm1lc1BsdWdpblNldHRpbmdzIHtcbiAgaGVybWVzQ29tbWFuZDogc3RyaW5nO1xufVxuXG5jb25zdCBERUZBVUxUX1NFVFRJTkdTOiBIZXJtZXNQbHVnaW5TZXR0aW5ncyA9IHtcbiAgaGVybWVzQ29tbWFuZDogJ2hlcm1lcycsXG59O1xuXG5jbGFzcyBIZXJtZXNNVlBWaWV3IGV4dGVuZHMgSXRlbVZpZXcge1xuICBwbHVnaW46IEhlcm1lc09ic2lkaWFuTVZQUGx1Z2luO1xuICBtZXNzYWdlczogQ2hhdE1lc3NhZ2VbXSA9IFtdO1xuICBwcml2YXRlIGlucHV0VmFsdWUgPSAnJztcbiAgcHJpdmF0ZSBpc1NlbmRpbmcgPSBmYWxzZTtcblxuICBjb25zdHJ1Y3RvcihsZWFmOiBXb3Jrc3BhY2VMZWFmLCBwbHVnaW46IEhlcm1lc09ic2lkaWFuTVZQUGx1Z2luKSB7XG4gICAgc3VwZXIobGVhZik7XG4gICAgdGhpcy5wbHVnaW4gPSBwbHVnaW47XG4gIH1cblxuICBnZXRWaWV3VHlwZSgpIHtcbiAgICByZXR1cm4gVklFV19UWVBFX0hFUk1FU19NVlA7XG4gIH1cblxuICBnZXREaXNwbGF5VGV4dCgpIHtcbiAgICByZXR1cm4gJ0hlcm1lcyc7XG4gIH1cblxuICBhc3luYyBvbk9wZW4oKSB7XG4gICAgdGhpcy5wbHVnaW4ucmVnaXN0ZXJWaWV3SW5zdGFuY2UodGhpcyk7XG4gICAgdGhpcy5yZW5kZXIoKTtcbiAgfVxuXG4gIGFzeW5jIG9uQ2xvc2UoKSB7XG4gICAgdGhpcy5wbHVnaW4udW5yZWdpc3RlclZpZXdJbnN0YW5jZSh0aGlzKTtcbiAgfVxuXG4gIGFwcGVuZE1lc3NhZ2Uocm9sZTogQ2hhdE1lc3NhZ2VbJ3JvbGUnXSwgdGV4dDogc3RyaW5nKSB7XG4gICAgaWYgKCF0ZXh0KSByZXR1cm47XG5cbiAgICBpZiAocm9sZSA9PT0gJ2Fzc2lzdGFudCcpIHtcbiAgICAgIGNvbnN0IGxhc3QgPSB0aGlzLm1lc3NhZ2VzW3RoaXMubWVzc2FnZXMubGVuZ3RoIC0gMV07XG4gICAgICBpZiAobGFzdCAmJiBsYXN0LnJvbGUgPT09ICdhc3Npc3RhbnQnKSB7XG4gICAgICAgIGxhc3QudGV4dCArPSB0ZXh0O1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhpcy5tZXNzYWdlcy5wdXNoKHsgcm9sZSwgdGV4dCB9KTtcbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKHJvbGUgPT09ICdzdGF0dXMnKSB7XG4gICAgICBjb25zdCBsYXN0ID0gdGhpcy5tZXNzYWdlc1t0aGlzLm1lc3NhZ2VzLmxlbmd0aCAtIDFdO1xuICAgICAgaWYgKGxhc3QgJiYgbGFzdC5yb2xlID09PSAnc3RhdHVzJykge1xuICAgICAgICBsYXN0LnRleHQgPSB0ZXh0O1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhpcy5tZXNzYWdlcy5wdXNoKHsgcm9sZSwgdGV4dCB9KTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5tZXNzYWdlcy5wdXNoKHsgcm9sZSwgdGV4dCB9KTtcbiAgICB9XG5cbiAgICB0aGlzLnJlbmRlcigpO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBzdWJtaXRQcm9tcHQoKSB7XG4gICAgY29uc3QgdGV4dCA9IHRoaXMuaW5wdXRWYWx1ZS50cmltKCk7XG4gICAgaWYgKCF0ZXh0IHx8IHRoaXMuaXNTZW5kaW5nKSByZXR1cm47XG5cbiAgICB0aGlzLmlucHV0VmFsdWUgPSAnJztcbiAgICB0aGlzLmlzU2VuZGluZyA9IHRydWU7XG4gICAgdGhpcy5tZXNzYWdlcy5wdXNoKHsgcm9sZTogJ3VzZXInLCB0ZXh0IH0pO1xuICAgIHRoaXMubWVzc2FnZXMucHVzaCh7IHJvbGU6ICdhc3Npc3RhbnQnLCB0ZXh0OiAnJyB9KTtcbiAgICB0aGlzLnJlbmRlcigpO1xuXG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IHRoaXMucGx1Z2luLmNsaWVudC5zZW5kUHJvbXB0KHRleHQsIHRoaXMucGx1Z2luLmdldFZhdWx0UGF0aCgpKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgY29uc3QgbWVzc2FnZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcbiAgICAgIHRoaXMuYXBwZW5kTWVzc2FnZSgnZXJyb3InLCBtZXNzYWdlKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgdGhpcy5pc1NlbmRpbmcgPSBmYWxzZTtcbiAgICAgIHRoaXMucmVuZGVyKCk7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBnZXRMYWJlbChyb2xlOiBDaGF0TWVzc2FnZVsncm9sZSddKSB7XG4gICAgc3dpdGNoIChyb2xlKSB7XG4gICAgICBjYXNlICd1c2VyJzpcbiAgICAgICAgcmV0dXJuICdZb3UnO1xuICAgICAgY2FzZSAnYXNzaXN0YW50JzpcbiAgICAgICAgcmV0dXJuICdIZXJtZXMnO1xuICAgICAgY2FzZSAnc3RhdHVzJzpcbiAgICAgICAgcmV0dXJuICdTdGF0dXMnO1xuICAgICAgY2FzZSAnZXJyb3InOlxuICAgICAgICByZXR1cm4gJ0Vycm9yJztcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHJlbmRlck1lc3NhZ2VCb2R5KGNvbnRhaW5lcjogSFRNTEVsZW1lbnQsIG1zZzogQ2hhdE1lc3NhZ2UpIHtcbiAgICBpZiAobXNnLnJvbGUgPT09ICdhc3Npc3RhbnQnKSB7XG4gICAgICBhd2FpdCBNYXJrZG93blJlbmRlcmVyLnJlbmRlcih0aGlzLmFwcCwgbXNnLnRleHQgfHwgJ1x1MjAyNicsIGNvbnRhaW5lciwgJycsIHRoaXMucGx1Z2luKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAobXNnLnJvbGUgPT09ICdzdGF0dXMnKSB7XG4gICAgICBjb250YWluZXIuc2V0VGV4dChtc2cudGV4dCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29udGFpbmVyLnNldFRleHQobXNnLnRleHQgfHwgKG1zZy5yb2xlID09PSAnYXNzaXN0YW50JyA/ICdcdTIwMjYnIDogJycpKTtcbiAgfVxuXG4gIHJlbmRlcigpIHtcbiAgICBjb25zdCByb290ID0gdGhpcy5jb250YWluZXJFbC5jaGlsZHJlblsxXSBhcyBIVE1MRWxlbWVudDtcbiAgICByb290LmVtcHR5KCk7XG4gICAgcm9vdC5hZGRDbGFzcygnaGVybWVzLW12cC1yb290Jyk7XG5cbiAgICBjb25zdCB3cmFwID0gcm9vdC5jcmVhdGVEaXYoeyBjbHM6ICdoZXJtZXMtbXZwLXdyYXAnIH0pO1xuICAgIGNvbnN0IGhlYWRlciA9IHdyYXAuY3JlYXRlRGl2KHsgY2xzOiAnaGVybWVzLW12cC1oZWFkZXInIH0pO1xuICAgIGhlYWRlci5jcmVhdGVEaXYoeyBjbHM6ICdoZXJtZXMtbXZwLXRpdGxlJywgdGV4dDogJ0hlcm1lcycgfSk7XG4gICAgaGVhZGVyLmNyZWF0ZURpdih7XG4gICAgICBjbHM6ICdoZXJtZXMtbXZwLXN1YnRpdGxlJyxcbiAgICAgIHRleHQ6IHRoaXMuaXNTZW5kaW5nID8gJ1RoaW5raW5nXHUyMDI2JyA6ICdMb2NhbCBPYnNpZGlhbiBjaGF0JyxcbiAgICB9KTtcblxuICAgIGNvbnN0IGxpc3QgPSB3cmFwLmNyZWF0ZURpdih7IGNsczogJ2hlcm1lcy1tdnAtbWVzc2FnZXMnIH0pO1xuXG4gICAgaWYgKHRoaXMubWVzc2FnZXMubGVuZ3RoID09PSAwKSB7XG4gICAgICBjb25zdCBlbXB0eSA9IGxpc3QuY3JlYXRlRGl2KHsgY2xzOiAnaGVybWVzLW12cC1lbXB0eScgfSk7XG4gICAgICBlbXB0eS5jcmVhdGVEaXYoeyBjbHM6ICdoZXJtZXMtbXZwLWVtcHR5LXRpdGxlJywgdGV4dDogJ1N0YXJ0IGEgY29udmVyc2F0aW9uJyB9KTtcbiAgICAgIGVtcHR5LmNyZWF0ZURpdih7XG4gICAgICAgIGNsczogJ2hlcm1lcy1tdnAtZW1wdHktc3VidGl0bGUnLFxuICAgICAgICB0ZXh0OiAnQXNrIEhlcm1lcyB0byBicmFpbnN0b3JtLCB3cml0ZSwgc3VtbWFyaXplLCBvciBoZWxwIHlvdSB0aGluayB0aHJvdWdoIGEgbm90ZS4nLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgZm9yIChjb25zdCBtc2cgb2YgdGhpcy5tZXNzYWdlcykge1xuICAgICAgY29uc3Qgcm93ID0gbGlzdC5jcmVhdGVEaXYoeyBjbHM6IGBoZXJtZXMtbXZwLXJvdyBoZXJtZXMtbXZwLXJvdy0ke21zZy5yb2xlfWAgfSk7XG4gICAgICBjb25zdCBidWJibGUgPSByb3cuY3JlYXRlRGl2KHsgY2xzOiBgaGVybWVzLW12cC1idWJibGUgaGVybWVzLW12cC1idWJibGUtJHttc2cucm9sZX1gIH0pO1xuICAgICAgYnViYmxlLmNyZWF0ZURpdih7IGNsczogJ2hlcm1lcy1tdnAtYnViYmxlLWxhYmVsJywgdGV4dDogdGhpcy5nZXRMYWJlbChtc2cucm9sZSkgfSk7XG4gICAgICBjb25zdCBib2R5ID0gYnViYmxlLmNyZWF0ZURpdih7IGNsczogJ2hlcm1lcy1tdnAtYnViYmxlLWJvZHknIH0pO1xuICAgICAgdm9pZCB0aGlzLnJlbmRlck1lc3NhZ2VCb2R5KGJvZHksIG1zZyk7XG4gICAgfVxuXG4gICAgY29uc3QgY29tcG9zZXIgPSB3cmFwLmNyZWF0ZURpdih7IGNsczogJ2hlcm1lcy1tdnAtY29tcG9zZXInIH0pO1xuICAgIGNvbnN0IGlucHV0V3JhcCA9IGNvbXBvc2VyLmNyZWF0ZURpdih7IGNsczogJ2hlcm1lcy1tdnAtaW5wdXQtd3JhcCcgfSk7XG4gICAgY29uc3QgaW5wdXQgPSBpbnB1dFdyYXAuY3JlYXRlRWwoJ3RleHRhcmVhJywge1xuICAgICAgY2xzOiAnaGVybWVzLW12cC1pbnB1dCcsXG4gICAgICBhdHRyOiB7IHJvd3M6ICcxJywgcGxhY2Vob2xkZXI6ICdNZXNzYWdlIEhlcm1lc1x1MjAyNicgfSxcbiAgICB9KTtcbiAgICBpbnB1dC52YWx1ZSA9IHRoaXMuaW5wdXRWYWx1ZTtcbiAgICBpbnB1dC5kaXNhYmxlZCA9IHRoaXMuaXNTZW5kaW5nO1xuICAgIGlucHV0LmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JywgKCkgPT4ge1xuICAgICAgdGhpcy5pbnB1dFZhbHVlID0gaW5wdXQudmFsdWU7XG4gICAgICBpbnB1dC5zdHlsZS5oZWlnaHQgPSAnMHB4JztcbiAgICAgIGlucHV0LnN0eWxlLmhlaWdodCA9IGAke01hdGgubWluKGlucHV0LnNjcm9sbEhlaWdodCwgMjIwKX1weGA7XG4gICAgfSk7XG4gICAgaW5wdXQuYWRkRXZlbnRMaXN0ZW5lcigna2V5ZG93bicsIGV2dCA9PiB7XG4gICAgICBpZiAoZXZ0LmtleSA9PT0gJ0VudGVyJyAmJiAhZXZ0LnNoaWZ0S2V5KSB7XG4gICAgICAgIGV2dC5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgICB2b2lkIHRoaXMuc3VibWl0UHJvbXB0KCk7XG4gICAgICB9XG4gICAgfSk7XG4gICAgaW5wdXQuc3R5bGUuaGVpZ2h0ID0gJzBweCc7XG4gICAgaW5wdXQuc3R5bGUuaGVpZ2h0ID0gYCR7TWF0aC5taW4oaW5wdXQuc2Nyb2xsSGVpZ2h0LCAyMjApfXB4YDtcblxuICAgIGNvbnN0IGJ1dHRvbiA9IGNvbXBvc2VyLmNyZWF0ZUVsKCdidXR0b24nLCB7XG4gICAgICBjbHM6ICdtb2QtY3RhIGhlcm1lcy1tdnAtc2VuZCcsXG4gICAgICB0ZXh0OiB0aGlzLmlzU2VuZGluZyA/ICdTZW5kaW5nXHUyMDI2JyA6ICdTZW5kJyxcbiAgICB9KTtcbiAgICBidXR0b24uZGlzYWJsZWQgPSB0aGlzLmlzU2VuZGluZztcbiAgICBidXR0b24uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICB2b2lkIHRoaXMuc3VibWl0UHJvbXB0KCk7XG4gICAgfSk7XG5cbiAgICBsaXN0LnNjcm9sbFRvcCA9IGxpc3Quc2Nyb2xsSGVpZ2h0O1xuICB9XG59XG5cbmNsYXNzIEhlcm1lc1NldHRpbmdUYWIgZXh0ZW5kcyBQbHVnaW5TZXR0aW5nVGFiIHtcbiAgcGx1Z2luOiBIZXJtZXNPYnNpZGlhbk1WUFBsdWdpbjtcblxuICBjb25zdHJ1Y3RvcihhcHA6IEFwcCwgcGx1Z2luOiBIZXJtZXNPYnNpZGlhbk1WUFBsdWdpbikge1xuICAgIHN1cGVyKGFwcCwgcGx1Z2luKTtcbiAgICB0aGlzLnBsdWdpbiA9IHBsdWdpbjtcbiAgfVxuXG4gIGRpc3BsYXkoKTogdm9pZCB7XG4gICAgY29uc3QgeyBjb250YWluZXJFbCB9ID0gdGhpcztcbiAgICBjb250YWluZXJFbC5lbXB0eSgpO1xuXG4gICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG4gICAgICAuc2V0TmFtZSgnSGVybWVzIGNvbW1hbmQnKVxuICAgICAgLnNldERlc2MoJ0NvbW1hbmQgdXNlZCB0byBsYXVuY2ggSGVybWVzIEFDUCBsb2NhbGx5LicpXG4gICAgICAuYWRkVGV4dCh0ZXh0ID0+XG4gICAgICAgIHRleHRcbiAgICAgICAgICAuc2V0UGxhY2Vob2xkZXIoJ2hlcm1lcycpXG4gICAgICAgICAgLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLmhlcm1lc0NvbW1hbmQpXG4gICAgICAgICAgLm9uQ2hhbmdlKGFzeW5jIHZhbHVlID0+IHtcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLmhlcm1lc0NvbW1hbmQgPSB2YWx1ZS50cmltKCkgfHwgJ2hlcm1lcyc7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICAgIG5ldyBOb3RpY2UoJ0hlcm1lcyBjb21tYW5kIHNhdmVkJyk7XG4gICAgICAgICAgfSksXG4gICAgICApO1xuICB9XG59XG5cbmV4cG9ydCBkZWZhdWx0IGNsYXNzIEhlcm1lc09ic2lkaWFuTVZQUGx1Z2luIGV4dGVuZHMgUGx1Z2luIHtcbiAgc2V0dGluZ3MhOiBIZXJtZXNQbHVnaW5TZXR0aW5ncztcbiAgY2xpZW50ITogSGVybWVzQUNQQ2xpZW50O1xuICBwcml2YXRlIGFjdGl2ZVZpZXc6IEhlcm1lc01WUFZpZXcgfCBudWxsID0gbnVsbDtcblxuICBhc3luYyBvbmxvYWQoKSB7XG4gICAgdGhpcy5zZXR0aW5ncyA9IE9iamVjdC5hc3NpZ24oe30sIERFRkFVTFRfU0VUVElOR1MsIGF3YWl0IHRoaXMubG9hZERhdGEoKSk7XG4gICAgdGhpcy5jbGllbnQgPSBuZXcgSGVybWVzQUNQQ2xpZW50KHRoaXMuc2V0dGluZ3MuaGVybWVzQ29tbWFuZCk7XG4gICAgdGhpcy53aXJlQ2xpZW50Q2FsbGJhY2tzKCk7XG4gICAgdGhpcy5pbmplY3RTdHlsZXMoKTtcblxuICAgIHRoaXMucmVnaXN0ZXJWaWV3KFZJRVdfVFlQRV9IRVJNRVNfTVZQLCBsZWFmID0+IG5ldyBIZXJtZXNNVlBWaWV3KGxlYWYsIHRoaXMpKTtcbiAgICB0aGlzLmFkZFNldHRpbmdUYWIobmV3IEhlcm1lc1NldHRpbmdUYWIodGhpcy5hcHAsIHRoaXMpKTtcblxuICAgIHRoaXMuYWRkUmliYm9uSWNvbignYm90JywgJ09wZW4gSGVybWVzIE1WUCcsIGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IHRoaXMuYWN0aXZhdGVWaWV3KCk7XG4gICAgfSk7XG5cbiAgICB0aGlzLmFkZENvbW1hbmQoe1xuICAgICAgaWQ6ICdvcGVuLWhlcm1lcy1tdnAnLFxuICAgICAgbmFtZTogJ09wZW4gSGVybWVzIE1WUCcsXG4gICAgICBjYWxsYmFjazogYXN5bmMgKCkgPT4gdGhpcy5hY3RpdmF0ZVZpZXcoKSxcbiAgICB9KTtcbiAgfVxuXG4gIGFzeW5jIG9udW5sb2FkKCkge1xuICAgIHRoaXMuYXBwLndvcmtzcGFjZS5kZXRhY2hMZWF2ZXNPZlR5cGUoVklFV19UWVBFX0hFUk1FU19NVlApO1xuICB9XG5cbiAgcmVnaXN0ZXJWaWV3SW5zdGFuY2UodmlldzogSGVybWVzTVZQVmlldykge1xuICAgIHRoaXMuYWN0aXZlVmlldyA9IHZpZXc7XG4gIH1cblxuICB1bnJlZ2lzdGVyVmlld0luc3RhbmNlKHZpZXc6IEhlcm1lc01WUFZpZXcpIHtcbiAgICBpZiAodGhpcy5hY3RpdmVWaWV3ID09PSB2aWV3KSB0aGlzLmFjdGl2ZVZpZXcgPSBudWxsO1xuICB9XG5cbiAgZ2V0VmF1bHRQYXRoKCkge1xuICAgIHJldHVybiB0aGlzLmFwcC52YXVsdC5hZGFwdGVyLmJhc2VQYXRoIHx8IHByb2Nlc3MuY3dkKCk7XG4gIH1cblxuICBhc3luYyBzYXZlU2V0dGluZ3MoKSB7XG4gICAgYXdhaXQgdGhpcy5zYXZlRGF0YSh0aGlzLnNldHRpbmdzKTtcbiAgICB0aGlzLmNsaWVudCA9IG5ldyBIZXJtZXNBQ1BDbGllbnQodGhpcy5zZXR0aW5ncy5oZXJtZXNDb21tYW5kKTtcbiAgICB0aGlzLndpcmVDbGllbnRDYWxsYmFja3MoKTtcbiAgfVxuXG4gIHByaXZhdGUgd2lyZUNsaWVudENhbGxiYWNrcygpIHtcbiAgICB0aGlzLmNsaWVudC5vbkFzc2lzdGFudFRleHQgPSAodGV4dDogc3RyaW5nKSA9PiB7XG4gICAgICB0aGlzLmFjdGl2ZVZpZXc/LmFwcGVuZE1lc3NhZ2UoJ2Fzc2lzdGFudCcsIHRleHQpO1xuICAgIH07XG5cbiAgICB0aGlzLmNsaWVudC5vblN0YXR1cyA9ICh0ZXh0OiBzdHJpbmcpID0+IHtcbiAgICAgIHRoaXMuYWN0aXZlVmlldz8uYXBwZW5kTWVzc2FnZSgnc3RhdHVzJywgdGV4dCk7XG4gICAgfTtcblxuICAgIHRoaXMuY2xpZW50Lm9uRXJyb3IgPSAodGV4dDogc3RyaW5nKSA9PiB7XG4gICAgICB0aGlzLmFjdGl2ZVZpZXc/LmFwcGVuZE1lc3NhZ2UoJ2Vycm9yJywgdGV4dCk7XG4gICAgICBuZXcgTm90aWNlKHRleHQpO1xuICAgIH07XG4gIH1cblxuICBwcml2YXRlIGluamVjdFN0eWxlcygpIHtcbiAgICBjb25zdCBzdHlsZUlkID0gJ2hlcm1lcy1tdnAtaW5saW5lLXN0eWxlcyc7XG4gICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoc3R5bGVJZCk/LnJlbW92ZSgpO1xuXG4gICAgY29uc3Qgc3R5bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzdHlsZScpO1xuICAgIHN0eWxlLmlkID0gc3R5bGVJZDtcbiAgICBzdHlsZS50ZXh0Q29udGVudCA9IGBcbiAgICAgIC5oZXJtZXMtbXZwLXJvb3Qge1xuICAgICAgICBoZWlnaHQ6IDEwMCU7XG4gICAgICB9XG5cbiAgICAgIC5oZXJtZXMtbXZwLXdyYXAge1xuICAgICAgICBkaXNwbGF5OiBmbGV4O1xuICAgICAgICBmbGV4LWRpcmVjdGlvbjogY29sdW1uO1xuICAgICAgICBoZWlnaHQ6IDEwMCU7XG4gICAgICAgIGJhY2tncm91bmQ6IHZhcigtLWJhY2tncm91bmQtcHJpbWFyeSk7XG4gICAgICAgIGNvbG9yOiB2YXIoLS10ZXh0LW5vcm1hbCk7XG4gICAgICB9XG5cbiAgICAgIC5oZXJtZXMtbXZwLWhlYWRlciB7XG4gICAgICAgIHBhZGRpbmc6IDE0cHggMTZweCAxMHB4O1xuICAgICAgICBib3JkZXItYm90dG9tOiAxcHggc29saWQgdmFyKC0tYmFja2dyb3VuZC1tb2RpZmllci1ib3JkZXIpO1xuICAgICAgICBiYWNrZ3JvdW5kOiBjb2xvci1taXgoaW4gc3JnYiwgdmFyKC0tYmFja2dyb3VuZC1zZWNvbmRhcnkpIDcwJSwgdHJhbnNwYXJlbnQpO1xuICAgICAgfVxuXG4gICAgICAuaGVybWVzLW12cC10aXRsZSB7XG4gICAgICAgIGZvbnQtc2l6ZTogMThweDtcbiAgICAgICAgZm9udC13ZWlnaHQ6IDcwMDtcbiAgICAgICAgbGV0dGVyLXNwYWNpbmc6IC0wLjAxZW07XG4gICAgICB9XG5cbiAgICAgIC5oZXJtZXMtbXZwLXN1YnRpdGxlIHtcbiAgICAgICAgbWFyZ2luLXRvcDogMnB4O1xuICAgICAgICBmb250LXNpemU6IDEycHg7XG4gICAgICAgIGNvbG9yOiB2YXIoLS10ZXh0LW11dGVkKTtcbiAgICAgIH1cblxuICAgICAgLmhlcm1lcy1tdnAtbWVzc2FnZXMge1xuICAgICAgICBmbGV4OiAxO1xuICAgICAgICBvdmVyZmxvdy15OiBhdXRvO1xuICAgICAgICBwYWRkaW5nOiAxOHB4IDE2cHggMjRweDtcbiAgICAgICAgZGlzcGxheTogZmxleDtcbiAgICAgICAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjtcbiAgICAgICAgZ2FwOiAxMnB4O1xuICAgICAgfVxuXG4gICAgICAuaGVybWVzLW12cC1lbXB0eSB7XG4gICAgICAgIG1hcmdpbjogYXV0byAwO1xuICAgICAgICBwYWRkaW5nOiAyNHB4IDE4cHg7XG4gICAgICAgIGJvcmRlcjogMXB4IGRhc2hlZCB2YXIoLS1iYWNrZ3JvdW5kLW1vZGlmaWVyLWJvcmRlcik7XG4gICAgICAgIGJvcmRlci1yYWRpdXM6IDE2cHg7XG4gICAgICAgIGJhY2tncm91bmQ6IGNvbG9yLW1peChpbiBzcmdiLCB2YXIoLS1iYWNrZ3JvdW5kLXNlY29uZGFyeSkgNTUlLCB0cmFuc3BhcmVudCk7XG4gICAgICB9XG5cbiAgICAgIC5oZXJtZXMtbXZwLWVtcHR5LXRpdGxlIHtcbiAgICAgICAgZm9udC1zaXplOiAxNnB4O1xuICAgICAgICBmb250LXdlaWdodDogNjAwO1xuICAgICAgICBtYXJnaW4tYm90dG9tOiA2cHg7XG4gICAgICB9XG5cbiAgICAgIC5oZXJtZXMtbXZwLWVtcHR5LXN1YnRpdGxlIHtcbiAgICAgICAgZm9udC1zaXplOiAxM3B4O1xuICAgICAgICBsaW5lLWhlaWdodDogMS41O1xuICAgICAgICBjb2xvcjogdmFyKC0tdGV4dC1tdXRlZCk7XG4gICAgICB9XG5cbiAgICAgIC5oZXJtZXMtbXZwLXJvdyB7XG4gICAgICAgIGRpc3BsYXk6IGZsZXg7XG4gICAgICB9XG5cbiAgICAgIC5oZXJtZXMtbXZwLXJvdy11c2VyIHtcbiAgICAgICAganVzdGlmeS1jb250ZW50OiBmbGV4LWVuZDtcbiAgICAgIH1cblxuICAgICAgLmhlcm1lcy1tdnAtcm93LWFzc2lzdGFudCxcbiAgICAgIC5oZXJtZXMtbXZwLXJvdy1zdGF0dXMsXG4gICAgICAuaGVybWVzLW12cC1yb3ctZXJyb3Ige1xuICAgICAgICBqdXN0aWZ5LWNvbnRlbnQ6IGZsZXgtc3RhcnQ7XG4gICAgICB9XG5cbiAgICAgIC5oZXJtZXMtbXZwLWJ1YmJsZSB7XG4gICAgICAgIG1heC13aWR0aDogbWluKDY4MHB4LCA5MiUpO1xuICAgICAgICBib3JkZXItcmFkaXVzOiAxNnB4O1xuICAgICAgICBwYWRkaW5nOiAxMHB4IDEycHg7XG4gICAgICAgIGJveC1zaGFkb3c6IDAgMXB4IDJweCByZ2IoMCAwIDAgLyAwLjA4KTtcbiAgICAgIH1cblxuICAgICAgLmhlcm1lcy1tdnAtYnViYmxlLXVzZXIge1xuICAgICAgICBiYWNrZ3JvdW5kOiB2YXIoLS1pbnRlcmFjdGl2ZS1hY2NlbnQpO1xuICAgICAgICBjb2xvcjogdmFyKC0tdGV4dC1vbi1hY2NlbnQpO1xuICAgICAgICBib3JkZXItYm90dG9tLXJpZ2h0LXJhZGl1czogNnB4O1xuICAgICAgfVxuXG4gICAgICAuaGVybWVzLW12cC1idWJibGUtYXNzaXN0YW50IHtcbiAgICAgICAgYmFja2dyb3VuZDogdmFyKC0tYmFja2dyb3VuZC1zZWNvbmRhcnkpO1xuICAgICAgICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1iYWNrZ3JvdW5kLW1vZGlmaWVyLWJvcmRlcik7XG4gICAgICAgIGJvcmRlci1ib3R0b20tbGVmdC1yYWRpdXM6IDZweDtcbiAgICAgIH1cblxuICAgICAgLmhlcm1lcy1tdnAtYnViYmxlLXN0YXR1cyB7XG4gICAgICAgIGJhY2tncm91bmQ6IGNvbG9yLW1peChpbiBzcmdiLCB2YXIoLS1jb2xvci1ibHVlKSAxMCUsIHZhcigtLWJhY2tncm91bmQtc2Vjb25kYXJ5KSk7XG4gICAgICAgIGJvcmRlcjogMXB4IHNvbGlkIGNvbG9yLW1peChpbiBzcmdiLCB2YXIoLS1jb2xvci1ibHVlKSAyOCUsIHZhcigtLWJhY2tncm91bmQtbW9kaWZpZXItYm9yZGVyKSk7XG4gICAgICAgIGNvbG9yOiB2YXIoLS10ZXh0LW11dGVkKTtcbiAgICAgICAgbWF4LXdpZHRoOiAxMDAlO1xuICAgICAgfVxuXG4gICAgICAuaGVybWVzLW12cC1idWJibGUtZXJyb3Ige1xuICAgICAgICBiYWNrZ3JvdW5kOiBjb2xvci1taXgoaW4gc3JnYiwgdmFyKC0tY29sb3ItcmVkKSAxMCUsIHZhcigtLWJhY2tncm91bmQtc2Vjb25kYXJ5KSk7XG4gICAgICAgIGJvcmRlcjogMXB4IHNvbGlkIGNvbG9yLW1peChpbiBzcmdiLCB2YXIoLS1jb2xvci1yZWQpIDMwJSwgdmFyKC0tYmFja2dyb3VuZC1tb2RpZmllci1ib3JkZXIpKTtcbiAgICAgICAgY29sb3I6IHZhcigtLXRleHQtbm9ybWFsKTtcbiAgICAgICAgbWF4LXdpZHRoOiAxMDAlO1xuICAgICAgfVxuXG4gICAgICAuaGVybWVzLW12cC1idWJibGUtbGFiZWwge1xuICAgICAgICBmb250LXNpemU6IDExcHg7XG4gICAgICAgIGZvbnQtd2VpZ2h0OiA3MDA7XG4gICAgICAgIHRleHQtdHJhbnNmb3JtOiB1cHBlcmNhc2U7XG4gICAgICAgIGxldHRlci1zcGFjaW5nOiAwLjA0ZW07XG4gICAgICAgIG9wYWNpdHk6IDAuNztcbiAgICAgICAgbWFyZ2luLWJvdHRvbTogNnB4O1xuICAgICAgfVxuXG4gICAgICAuaGVybWVzLW12cC1idWJibGUtYm9keSB7XG4gICAgICAgIGZvbnQtc2l6ZTogMTRweDtcbiAgICAgICAgbGluZS1oZWlnaHQ6IDEuNTU7XG4gICAgICAgIHdvcmQtYnJlYWs6IGJyZWFrLXdvcmQ7XG4gICAgICB9XG5cbiAgICAgIC5oZXJtZXMtbXZwLWJ1YmJsZS1ib2R5ID4gOmZpcnN0LWNoaWxkIHtcbiAgICAgICAgbWFyZ2luLXRvcDogMDtcbiAgICAgIH1cblxuICAgICAgLmhlcm1lcy1tdnAtYnViYmxlLWJvZHkgPiA6bGFzdC1jaGlsZCB7XG4gICAgICAgIG1hcmdpbi1ib3R0b206IDA7XG4gICAgICB9XG5cbiAgICAgIC5oZXJtZXMtbXZwLWNvbXBvc2VyIHtcbiAgICAgICAgZGlzcGxheTogZmxleDtcbiAgICAgICAgYWxpZ24taXRlbXM6IGZsZXgtZW5kO1xuICAgICAgICBnYXA6IDEwcHg7XG4gICAgICAgIHBhZGRpbmc6IDE0cHggMTZweCAxNnB4O1xuICAgICAgICBib3JkZXItdG9wOiAxcHggc29saWQgdmFyKC0tYmFja2dyb3VuZC1tb2RpZmllci1ib3JkZXIpO1xuICAgICAgICBiYWNrZ3JvdW5kOiB2YXIoLS1iYWNrZ3JvdW5kLXByaW1hcnkpO1xuICAgICAgfVxuXG4gICAgICAuaGVybWVzLW12cC1pbnB1dC13cmFwIHtcbiAgICAgICAgZmxleDogMTtcbiAgICAgICAgYmFja2dyb3VuZDogdmFyKC0tYmFja2dyb3VuZC1zZWNvbmRhcnkpO1xuICAgICAgICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1iYWNrZ3JvdW5kLW1vZGlmaWVyLWJvcmRlcik7XG4gICAgICAgIGJvcmRlci1yYWRpdXM6IDE2cHg7XG4gICAgICAgIHBhZGRpbmc6IDEwcHggMTJweDtcbiAgICAgIH1cblxuICAgICAgLmhlcm1lcy1tdnAtaW5wdXQge1xuICAgICAgICB3aWR0aDogMTAwJTtcbiAgICAgICAgbWluLWhlaWdodDogMjRweDtcbiAgICAgICAgbWF4LWhlaWdodDogMjIwcHg7XG4gICAgICAgIHJlc2l6ZTogbm9uZTtcbiAgICAgICAgYm9yZGVyOiAwO1xuICAgICAgICBvdXRsaW5lOiBub25lO1xuICAgICAgICBiYWNrZ3JvdW5kOiB0cmFuc3BhcmVudDtcbiAgICAgICAgYm94LXNoYWRvdzogbm9uZTtcbiAgICAgICAgY29sb3I6IHZhcigtLXRleHQtbm9ybWFsKTtcbiAgICAgICAgZm9udDogaW5oZXJpdDtcbiAgICAgICAgbGluZS1oZWlnaHQ6IDEuNTtcbiAgICAgICAgcGFkZGluZzogMDtcbiAgICAgIH1cblxuICAgICAgLmhlcm1lcy1tdnAtaW5wdXQ6OnBsYWNlaG9sZGVyIHtcbiAgICAgICAgY29sb3I6IHZhcigtLXRleHQtZmFpbnQpO1xuICAgICAgfVxuXG4gICAgICAuaGVybWVzLW12cC1zZW5kIHtcbiAgICAgICAgYm9yZGVyLXJhZGl1czogMTRweDtcbiAgICAgICAgbWluLXdpZHRoOiA4MHB4O1xuICAgICAgICBoZWlnaHQ6IDQ0cHg7XG4gICAgICB9XG4gICAgYDtcblxuICAgIGRvY3VtZW50LmhlYWQuYXBwZW5kQ2hpbGQoc3R5bGUpO1xuICB9XG5cbiAgYXN5bmMgYWN0aXZhdGVWaWV3KCkge1xuICAgIGxldCBsZWFmID0gdGhpcy5hcHAud29ya3NwYWNlLmdldExlYXZlc09mVHlwZShWSUVXX1RZUEVfSEVSTUVTX01WUClbMF07XG4gICAgaWYgKCFsZWFmKSB7XG4gICAgICBsZWFmID0gdGhpcy5hcHAud29ya3NwYWNlLmdldFJpZ2h0TGVhZihmYWxzZSk7XG4gICAgICBhd2FpdCBsZWFmLnNldFZpZXdTdGF0ZSh7IHR5cGU6IFZJRVdfVFlQRV9IRVJNRVNfTVZQLCBhY3RpdmU6IHRydWUgfSk7XG4gICAgfVxuICAgIGF3YWl0IHRoaXMuYXBwLndvcmtzcGFjZS5yZXZlYWxMZWFmKGxlYWYpO1xuICB9XG59XG4iLCAiaW1wb3J0IHsgQ2hpbGRQcm9jZXNzV2l0aG91dE51bGxTdHJlYW1zLCBzcGF3biB9IGZyb20gJ2NoaWxkX3Byb2Nlc3MnO1xuaW1wb3J0IHsgZXhpc3RzU3luYyB9IGZyb20gJ2ZzJztcblxuXG50eXBlIFBlbmRpbmdSZXF1ZXN0ID0ge1xuICByZXNvbHZlOiAodmFsdWU6IGFueSkgPT4gdm9pZDtcbiAgcmVqZWN0OiAocmVhc29uPzogdW5rbm93bikgPT4gdm9pZDtcbn07XG5cbnR5cGUgU2Vzc2lvblVwZGF0ZVBhcmFtcyA9IHtcbiAgc2Vzc2lvbklkPzogc3RyaW5nO1xuICBzZXNzaW9uX2lkPzogc3RyaW5nO1xuICB1cGRhdGU/OiBSZWNvcmQ8c3RyaW5nLCBhbnk+O1xufTtcblxuZXhwb3J0IGNsYXNzIEhlcm1lc0FDUENsaWVudCB7XG4gIHByaXZhdGUgcHJvYzogQ2hpbGRQcm9jZXNzV2l0aG91dE51bGxTdHJlYW1zIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgYnVmZmVyID0gJyc7XG4gIHByaXZhdGUgbmV4dElkID0gMTtcbiAgcHJpdmF0ZSBwZW5kaW5nID0gbmV3IE1hcDxudW1iZXIsIFBlbmRpbmdSZXF1ZXN0PigpO1xuICBwcml2YXRlIGluaXRpYWxpemVkID0gZmFsc2U7XG4gIHByaXZhdGUgc2Vzc2lvbklkOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgb25Bc3Npc3RhbnRUZXh0PzogKHRleHQ6IHN0cmluZykgPT4gdm9pZDtcbiAgb25TdGF0dXM/OiAodGV4dDogc3RyaW5nKSA9PiB2b2lkO1xuICBvbkVycm9yPzogKHRleHQ6IHN0cmluZykgPT4gdm9pZDtcblxuICBjb25zdHJ1Y3Rvcihwcml2YXRlIGhlcm1lc0NvbW1hbmQ6IHN0cmluZykge31cblxuICBwcml2YXRlIHJlc29sdmVIZXJtZXNDb21tYW5kKCkge1xuICAgIGlmICh0aGlzLmhlcm1lc0NvbW1hbmQuaW5jbHVkZXMoJy8nKSB8fCB0aGlzLmhlcm1lc0NvbW1hbmQuaW5jbHVkZXMoJ1xcXFwnKSkge1xuICAgICAgcmV0dXJuIHRoaXMuaGVybWVzQ29tbWFuZDtcbiAgICB9XG5cbiAgICBjb25zdCBob21lID0gcHJvY2Vzcy5lbnYuSE9NRTtcbiAgICBjb25zdCBjYW5kaWRhdGVzID0gW1xuICAgICAgdGhpcy5oZXJtZXNDb21tYW5kLFxuICAgICAgaG9tZSA/IGAke2hvbWV9Ly5sb2NhbC9iaW4vJHt0aGlzLmhlcm1lc0NvbW1hbmR9YCA6IG51bGwsXG4gICAgICBob21lID8gYCR7aG9tZX0vLm5wbS1nbG9iYWwvYmluLyR7dGhpcy5oZXJtZXNDb21tYW5kfWAgOiBudWxsLFxuICAgICAgYC91c3IvbG9jYWwvYmluLyR7dGhpcy5oZXJtZXNDb21tYW5kfWAsXG4gICAgICBgL29wdC9ob21lYnJldy9iaW4vJHt0aGlzLmhlcm1lc0NvbW1hbmR9YCxcbiAgICBdLmZpbHRlcigodmFsdWUpOiB2YWx1ZSBpcyBzdHJpbmcgPT4gQm9vbGVhbih2YWx1ZSkpO1xuXG4gICAgZm9yIChjb25zdCBjYW5kaWRhdGUgb2YgY2FuZGlkYXRlcykge1xuICAgICAgaWYgKGNhbmRpZGF0ZSA9PT0gdGhpcy5oZXJtZXNDb21tYW5kIHx8IGV4aXN0c1N5bmMoY2FuZGlkYXRlKSkgcmV0dXJuIGNhbmRpZGF0ZTtcbiAgICB9XG5cbiAgICByZXR1cm4gdGhpcy5oZXJtZXNDb21tYW5kO1xuICB9XG5cbiAgcHJpdmF0ZSBlbnN1cmVTdGFydGVkKGN3ZD86IHN0cmluZykge1xuICAgIGlmICh0aGlzLnByb2MpIHJldHVybjtcblxuICAgIGNvbnN0IGNvbW1hbmQgPSB0aGlzLnJlc29sdmVIZXJtZXNDb21tYW5kKCk7XG5cbiAgICB0aGlzLnByb2MgPSBzcGF3bihjb21tYW5kLCBbJ2FjcCddLCB7XG4gICAgICBjd2Q6IGN3ZCB8fCBwcm9jZXNzLmN3ZCgpLFxuICAgICAgc3RkaW86IFsncGlwZScsICdwaXBlJywgJ3BpcGUnXSxcbiAgICB9KTtcblxuICAgIHRoaXMucHJvYy5zdGRvdXQub24oJ2RhdGEnLCBjaHVuayA9PiB7XG4gICAgICB0aGlzLmJ1ZmZlciArPSBjaHVuay50b1N0cmluZygndXRmOCcpO1xuICAgICAgdGhpcy5jb25zdW1lQnVmZmVyKCk7XG4gICAgfSk7XG5cbiAgICB0aGlzLnByb2Muc3RkZXJyLm9uKCdkYXRhJywgY2h1bmsgPT4ge1xuICAgICAgY29uc3QgdGV4dCA9IGNodW5rLnRvU3RyaW5nKCd1dGY4JykudHJpbSgpO1xuICAgICAgaWYgKHRleHQgJiYgdGhpcy5vblN0YXR1cykgdGhpcy5vblN0YXR1cyh0ZXh0KTtcbiAgICB9KTtcblxuICAgIHRoaXMucHJvYy5vbignZXJyb3InLCBlcnJvciA9PiB7XG4gICAgICBjb25zdCBleHRyYSA9IGNvbW1hbmQgPT09IHRoaXMuaGVybWVzQ29tbWFuZFxuICAgICAgICA/ICcnXG4gICAgICAgIDogYCAocmVzb2x2ZWQgZnJvbSAke3RoaXMuaGVybWVzQ29tbWFuZH0gdG8gJHtjb21tYW5kfSlgO1xuICAgICAgdGhpcy5vbkVycm9yPy4oYEZhaWxlZCB0byBzdGFydCBIZXJtZXMgQUNQJHtleHRyYX06ICR7U3RyaW5nKGVycm9yKX1gKTtcbiAgICB9KTtcblxuICAgIHRoaXMucHJvYy5vbignZXhpdCcsIGNvZGUgPT4ge1xuICAgICAgY29uc3QgZXJyb3IgPSBgSGVybWVzIEFDUCBleGl0ZWQke2NvZGUgIT09IG51bGwgPyBgIHdpdGggY29kZSAke2NvZGV9YCA6ICcnfWA7XG4gICAgICBmb3IgKGNvbnN0IHBlbmRpbmcgb2YgdGhpcy5wZW5kaW5nLnZhbHVlcygpKSBwZW5kaW5nLnJlamVjdChuZXcgRXJyb3IoZXJyb3IpKTtcbiAgICAgIHRoaXMucGVuZGluZy5jbGVhcigpO1xuICAgICAgdGhpcy5wcm9jID0gbnVsbDtcbiAgICAgIHRoaXMuaW5pdGlhbGl6ZWQgPSBmYWxzZTtcbiAgICAgIHRoaXMuc2Vzc2lvbklkID0gbnVsbDtcbiAgICAgIHRoaXMub25TdGF0dXM/LihlcnJvcik7XG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGNvbnN1bWVCdWZmZXIoKSB7XG4gICAgbGV0IG5ld2xpbmVJbmRleCA9IC0xO1xuICAgIHdoaWxlICgobmV3bGluZUluZGV4ID0gdGhpcy5idWZmZXIuaW5kZXhPZignXFxuJykpID49IDApIHtcbiAgICAgIGNvbnN0IGxpbmUgPSB0aGlzLmJ1ZmZlci5zbGljZSgwLCBuZXdsaW5lSW5kZXgpLnRyaW0oKTtcbiAgICAgIHRoaXMuYnVmZmVyID0gdGhpcy5idWZmZXIuc2xpY2UobmV3bGluZUluZGV4ICsgMSk7XG4gICAgICBpZiAoIWxpbmUpIGNvbnRpbnVlO1xuXG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBtc2cgPSBKU09OLnBhcnNlKGxpbmUpO1xuICAgICAgICB0aGlzLmhhbmRsZU1lc3NhZ2UobXNnKTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIHRoaXMub25FcnJvcj8uKGBGYWlsZWQgdG8gcGFyc2UgQUNQIG91dHB1dDogJHtTdHJpbmcoZXJyb3IpfWApO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgaGFuZGxlTWVzc2FnZShtc2c6IGFueSkge1xuICAgIGlmICh0eXBlb2YgbXNnLmlkID09PSAnbnVtYmVyJyAmJiB0aGlzLnBlbmRpbmcuaGFzKG1zZy5pZCkpIHtcbiAgICAgIGNvbnN0IHBlbmRpbmcgPSB0aGlzLnBlbmRpbmcuZ2V0KG1zZy5pZCkhO1xuICAgICAgdGhpcy5wZW5kaW5nLmRlbGV0ZShtc2cuaWQpO1xuICAgICAgaWYgKG1zZy5lcnJvcikge1xuICAgICAgICBjb25zdCBkZXRhaWwgPSB0eXBlb2YgbXNnLmVycm9yID09PSAnc3RyaW5nJ1xuICAgICAgICAgID8gbXNnLmVycm9yXG4gICAgICAgICAgOiBtc2cuZXJyb3I/Lm1lc3NhZ2UgfHwgSlNPTi5zdHJpbmdpZnkobXNnLmVycm9yKTtcbiAgICAgICAgcGVuZGluZy5yZWplY3QobmV3IEVycm9yKGRldGFpbCkpO1xuICAgICAgfVxuICAgICAgZWxzZSBwZW5kaW5nLnJlc29sdmUobXNnLnJlc3VsdCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKG1zZy5tZXRob2QgPT09ICdzZXNzaW9uL3VwZGF0ZScpIHtcbiAgICAgIHRoaXMuaGFuZGxlU2Vzc2lvblVwZGF0ZShtc2cucGFyYW1zID8/IHt9KTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGhhbmRsZVNlc3Npb25VcGRhdGUocGFyYW1zOiBTZXNzaW9uVXBkYXRlUGFyYW1zKSB7XG4gICAgY29uc3QgdXBkYXRlID0gcGFyYW1zLnVwZGF0ZSA/PyBwYXJhbXM7XG4gICAgaWYgKCF1cGRhdGUgfHwgdHlwZW9mIHVwZGF0ZSAhPT0gJ29iamVjdCcpIHJldHVybjtcblxuICAgIGNvbnN0IHNlc3Npb25VcGRhdGUgPSB1cGRhdGUuc2Vzc2lvblVwZGF0ZSA/PyB1cGRhdGUuc2Vzc2lvbl91cGRhdGU7XG5cbiAgICBpZiAoc2Vzc2lvblVwZGF0ZSA9PT0gJ2FnZW50X21lc3NhZ2VfY2h1bmsnIHx8IHNlc3Npb25VcGRhdGUgPT09ICdhZ2VudF9tZXNzYWdlJykge1xuICAgICAgY29uc3QgdGV4dCA9IHRoaXMuZXh0cmFjdFRleHQodXBkYXRlKTtcbiAgICAgIGlmICh0ZXh0KSB0aGlzLm9uQXNzaXN0YW50VGV4dD8uKHRleHQpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmIChzZXNzaW9uVXBkYXRlID09PSAnYWdlbnRfdGhvdWdodF9jaHVuaycgfHwgc2Vzc2lvblVwZGF0ZSA9PT0gJ3Rvb2xfY2FsbCcgfHwgc2Vzc2lvblVwZGF0ZSA9PT0gJ3Rvb2xfY2FsbF91cGRhdGUnKSB7XG4gICAgICBjb25zdCB0ZXh0ID0gdGhpcy5leHRyYWN0VGV4dCh1cGRhdGUpO1xuICAgICAgaWYgKHRleHQpIHRoaXMub25TdGF0dXM/Lih0ZXh0KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAoc2Vzc2lvblVwZGF0ZSA9PT0gJ2F2YWlsYWJsZV9jb21tYW5kc191cGRhdGUnKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgZmFsbGJhY2sgPSB0aGlzLmV4dHJhY3RUZXh0KHVwZGF0ZSk7XG4gICAgaWYgKGZhbGxiYWNrKSB0aGlzLm9uU3RhdHVzPy4oZmFsbGJhY2spO1xuICB9XG5cbiAgcHJpdmF0ZSBleHRyYWN0VGV4dCh2YWx1ZTogYW55KTogc3RyaW5nIHtcbiAgICBjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbXTtcblxuICAgIGNvbnN0IHdhbGsgPSAobm9kZTogYW55KSA9PiB7XG4gICAgICBpZiAobm9kZSA9PSBudWxsKSByZXR1cm47XG4gICAgICBpZiAodHlwZW9mIG5vZGUgPT09ICdzdHJpbmcnKSByZXR1cm47XG4gICAgICBpZiAoQXJyYXkuaXNBcnJheShub2RlKSkge1xuICAgICAgICBmb3IgKGNvbnN0IGl0ZW0gb2Ygbm9kZSkgd2FsayhpdGVtKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgaWYgKHR5cGVvZiBub2RlICE9PSAnb2JqZWN0JykgcmV0dXJuO1xuXG4gICAgICBpZiAodHlwZW9mIG5vZGUudGV4dCA9PT0gJ3N0cmluZycpIHBhcnRzLnB1c2gobm9kZS50ZXh0KTtcbiAgICAgIGlmICh0eXBlb2Ygbm9kZS5jb250ZW50ID09PSAnc3RyaW5nJykgcGFydHMucHVzaChub2RlLmNvbnRlbnQpO1xuICAgICAgaWYgKHR5cGVvZiBub2RlLnJlc3VsdCA9PT0gJ3N0cmluZycpIHBhcnRzLnB1c2gobm9kZS5yZXN1bHQpO1xuICAgICAgaWYgKHR5cGVvZiBub2RlLmRlc2NyaXB0aW9uID09PSAnc3RyaW5nJykgcGFydHMucHVzaChub2RlLmRlc2NyaXB0aW9uKTtcblxuICAgICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXMobm9kZSkpIHtcbiAgICAgICAgd2Fsayhub2RlW2tleV0pO1xuICAgICAgfVxuICAgIH07XG5cbiAgICB3YWxrKHZhbHVlKTtcbiAgICByZXR1cm4gcGFydHMuam9pbignJyk7XG4gIH1cblxuICBwcml2YXRlIHJlcXVlc3QobWV0aG9kOiBzdHJpbmcsIHBhcmFtczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIHtcbiAgICBpZiAoIXRoaXMucHJvYykgdGhyb3cgbmV3IEVycm9yKCdIZXJtZXMgQUNQIHByb2Nlc3MgaXMgbm90IHJ1bm5pbmcnKTtcblxuICAgIGNvbnN0IGlkID0gdGhpcy5uZXh0SWQrKztcbiAgICBjb25zdCBwYXlsb2FkID0geyBqc29ucnBjOiAnMi4wJywgaWQsIG1ldGhvZCwgcGFyYW1zIH07XG4gICAgdGhpcy5wcm9jLnN0ZGluLndyaXRlKGAke0pTT04uc3RyaW5naWZ5KHBheWxvYWQpfVxcbmApO1xuXG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgIHRoaXMucGVuZGluZy5zZXQoaWQsIHsgcmVzb2x2ZSwgcmVqZWN0IH0pO1xuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBlbnN1cmVJbml0aWFsaXplZChjd2Q/OiBzdHJpbmcpIHtcbiAgICB0aGlzLmVuc3VyZVN0YXJ0ZWQoY3dkKTtcbiAgICBpZiAodGhpcy5pbml0aWFsaXplZCkgcmV0dXJuO1xuXG4gICAgYXdhaXQgdGhpcy5yZXF1ZXN0KCdpbml0aWFsaXplJywge1xuICAgICAgcHJvdG9jb2xfdmVyc2lvbjogMSxcbiAgICAgIGNsaWVudF9jYXBhYmlsaXRpZXM6IHt9LFxuICAgICAgY2xpZW50X2luZm86IHtcbiAgICAgICAgbmFtZTogJ2hlcm1lcy1vYnNpZGlhbi1tdnAnLFxuICAgICAgICB2ZXJzaW9uOiAnMC4wLjInLFxuICAgICAgfSxcbiAgICB9KTtcbiAgICB0aGlzLmluaXRpYWxpemVkID0gdHJ1ZTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgZW5zdXJlU2Vzc2lvbihjd2Q/OiBzdHJpbmcpIHtcbiAgICBpZiAodGhpcy5zZXNzaW9uSWQpIHJldHVybiB0aGlzLnNlc3Npb25JZDtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCB0aGlzLnJlcXVlc3QoJ3Nlc3Npb24vbmV3JywgeyBjd2Q6IGN3ZCB8fCBwcm9jZXNzLmN3ZCgpLCBtY3BTZXJ2ZXJzOiBbXSB9KTtcbiAgICB0aGlzLnNlc3Npb25JZCA9IHJlc3VsdD8uc2Vzc2lvbklkID8/IHJlc3VsdD8uc2Vzc2lvbl9pZCA/PyByZXN1bHQ/LmlkO1xuICAgIGlmICghdGhpcy5zZXNzaW9uSWQpIHRocm93IG5ldyBFcnJvcignSGVybWVzIEFDUCBkaWQgbm90IHJldHVybiBhIHNlc3Npb24gaWQnKTtcbiAgICByZXR1cm4gdGhpcy5zZXNzaW9uSWQ7XG4gIH1cblxuICBhc3luYyBzZW5kUHJvbXB0KHRleHQ6IHN0cmluZywgY3dkPzogc3RyaW5nKSB7XG4gICAgYXdhaXQgdGhpcy5lbnN1cmVJbml0aWFsaXplZChjd2QpO1xuICAgIGNvbnN0IHNlc3Npb25JZCA9IGF3YWl0IHRoaXMuZW5zdXJlU2Vzc2lvbihjd2QpO1xuICAgIHJldHVybiB0aGlzLnJlcXVlc3QoJ3Nlc3Npb24vcHJvbXB0Jywge1xuICAgICAgc2Vzc2lvbklkLFxuICAgICAgcHJvbXB0OiBbeyB0eXBlOiAndGV4dCcsIHRleHQgfV0sXG4gICAgfSk7XG4gIH1cbn1cbiJdLAogICJtYXBwaW5ncyI6ICI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLHNCQUEwRzs7O0FDQTFHLDJCQUFzRDtBQUN0RCxnQkFBMkI7QUFjcEIsSUFBTSxrQkFBTixNQUFzQjtBQUFBLEVBVzNCLFlBQW9CLGVBQXVCO0FBQXZCO0FBVnBCLFNBQVEsT0FBOEM7QUFDdEQsU0FBUSxTQUFTO0FBQ2pCLFNBQVEsU0FBUztBQUNqQixTQUFRLFVBQVUsb0JBQUksSUFBNEI7QUFDbEQsU0FBUSxjQUFjO0FBQ3RCLFNBQVEsWUFBMkI7QUFBQSxFQUtTO0FBQUEsRUFFcEMsdUJBQXVCO0FBQzdCLFFBQUksS0FBSyxjQUFjLFNBQVMsR0FBRyxLQUFLLEtBQUssY0FBYyxTQUFTLElBQUksR0FBRztBQUN6RSxhQUFPLEtBQUs7QUFBQSxJQUNkO0FBRUEsVUFBTSxPQUFPLFFBQVEsSUFBSTtBQUN6QixVQUFNLGFBQWE7QUFBQSxNQUNqQixLQUFLO0FBQUEsTUFDTCxPQUFPLEdBQUcsSUFBSSxlQUFlLEtBQUssYUFBYSxLQUFLO0FBQUEsTUFDcEQsT0FBTyxH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
