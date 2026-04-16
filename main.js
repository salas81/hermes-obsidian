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
  ensureStarted(cwd) {
    if (this.proc) return;
    this.proc = (0, import_child_process.spawn)(this.hermesCommand, ["acp"], {
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
      this.onError?.(`Failed to start Hermes ACP: ${String(error)}`);
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
      if (msg.error) pending.reject(msg.error);
      else pending.resolve(msg.result);
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
        version: "0.0.1"
      }
    });
    this.initialized = true;
  }
  async ensureSession(cwd) {
    if (this.sessionId) return this.sessionId;
    const result = await this.request("new_session", { cwd: cwd || process.cwd() });
    this.sessionId = result?.sessionId ?? result?.session_id ?? result?.id;
    if (!this.sessionId) throw new Error("Hermes ACP did not return a session id");
    return this.sessionId;
  }
  async sendPrompt(text, cwd) {
    await this.ensureInitialized(cwd);
    const sessionId = await this.ensureSession(cwd);
    return this.request("prompt", {
      session_id: sessionId,
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
  markSending(isSending) {
    this.isSending = isSending;
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
    button.addEventListener("click", () => {
      void this.submitPrompt();
    });
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
  async activateView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_HERMES_MVP)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE_HERMES_MVP, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
  }
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsic3JjL21haW4udHMiLCAic3JjL3RyYW5zcG9ydC9oZXJtZXMtYWNwLWNsaWVudC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgQXBwLCBJdGVtVmlldywgTm90aWNlLCBQbHVnaW4sIFBsdWdpblNldHRpbmdUYWIsIFNldHRpbmcsIFdvcmtzcGFjZUxlYWYgfSBmcm9tICdvYnNpZGlhbic7XG5pbXBvcnQgeyBIZXJtZXNBQ1BDbGllbnQgfSBmcm9tICcuL3RyYW5zcG9ydC9oZXJtZXMtYWNwLWNsaWVudCc7XG5cbmNvbnN0IFZJRVdfVFlQRV9IRVJNRVNfTVZQID0gJ2hlcm1lcy1vYnNpZGlhbi1tdnAnO1xuXG50eXBlIENoYXRNZXNzYWdlID0ge1xuICByb2xlOiAndXNlcicgfCAnYXNzaXN0YW50JyB8ICdzdGF0dXMnIHwgJ2Vycm9yJztcbiAgdGV4dDogc3RyaW5nO1xufTtcblxuaW50ZXJmYWNlIEhlcm1lc1BsdWdpblNldHRpbmdzIHtcbiAgaGVybWVzQ29tbWFuZDogc3RyaW5nO1xufVxuXG5jb25zdCBERUZBVUxUX1NFVFRJTkdTOiBIZXJtZXNQbHVnaW5TZXR0aW5ncyA9IHtcbiAgaGVybWVzQ29tbWFuZDogJ2hlcm1lcycsXG59O1xuXG5jbGFzcyBIZXJtZXNNVlBWaWV3IGV4dGVuZHMgSXRlbVZpZXcge1xuICBwbHVnaW46IEhlcm1lc09ic2lkaWFuTVZQUGx1Z2luO1xuICBtZXNzYWdlczogQ2hhdE1lc3NhZ2VbXSA9IFtdO1xuICBwcml2YXRlIGlucHV0VmFsdWUgPSAnJztcbiAgcHJpdmF0ZSBpc1NlbmRpbmcgPSBmYWxzZTtcblxuICBjb25zdHJ1Y3RvcihsZWFmOiBXb3Jrc3BhY2VMZWFmLCBwbHVnaW46IEhlcm1lc09ic2lkaWFuTVZQUGx1Z2luKSB7XG4gICAgc3VwZXIobGVhZik7XG4gICAgdGhpcy5wbHVnaW4gPSBwbHVnaW47XG4gIH1cblxuICBnZXRWaWV3VHlwZSgpIHtcbiAgICByZXR1cm4gVklFV19UWVBFX0hFUk1FU19NVlA7XG4gIH1cblxuICBnZXREaXNwbGF5VGV4dCgpIHtcbiAgICByZXR1cm4gJ0hlcm1lcyc7XG4gIH1cblxuICBhc3luYyBvbk9wZW4oKSB7XG4gICAgdGhpcy5wbHVnaW4ucmVnaXN0ZXJWaWV3SW5zdGFuY2UodGhpcyk7XG4gICAgdGhpcy5yZW5kZXIoKTtcbiAgfVxuXG4gIGFzeW5jIG9uQ2xvc2UoKSB7XG4gICAgdGhpcy5wbHVnaW4udW5yZWdpc3RlclZpZXdJbnN0YW5jZSh0aGlzKTtcbiAgfVxuXG4gIGFwcGVuZE1lc3NhZ2Uocm9sZTogQ2hhdE1lc3NhZ2VbJ3JvbGUnXSwgdGV4dDogc3RyaW5nKSB7XG4gICAgaWYgKCF0ZXh0KSByZXR1cm47XG5cbiAgICBpZiAocm9sZSA9PT0gJ2Fzc2lzdGFudCcpIHtcbiAgICAgIGNvbnN0IGxhc3QgPSB0aGlzLm1lc3NhZ2VzW3RoaXMubWVzc2FnZXMubGVuZ3RoIC0gMV07XG4gICAgICBpZiAobGFzdCAmJiBsYXN0LnJvbGUgPT09ICdhc3Npc3RhbnQnKSB7XG4gICAgICAgIGxhc3QudGV4dCArPSB0ZXh0O1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhpcy5tZXNzYWdlcy5wdXNoKHsgcm9sZSwgdGV4dCB9KTtcbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKHJvbGUgPT09ICdzdGF0dXMnKSB7XG4gICAgICBjb25zdCBsYXN0ID0gdGhpcy5tZXNzYWdlc1t0aGlzLm1lc3NhZ2VzLmxlbmd0aCAtIDFdO1xuICAgICAgaWYgKGxhc3QgJiYgbGFzdC5yb2xlID09PSAnc3RhdHVzJykge1xuICAgICAgICBsYXN0LnRleHQgPSB0ZXh0O1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhpcy5tZXNzYWdlcy5wdXNoKHsgcm9sZSwgdGV4dCB9KTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5tZXNzYWdlcy5wdXNoKHsgcm9sZSwgdGV4dCB9KTtcbiAgICB9XG5cbiAgICB0aGlzLnJlbmRlcigpO1xuICB9XG5cbiAgbWFya1NlbmRpbmcoaXNTZW5kaW5nOiBib29sZWFuKSB7XG4gICAgdGhpcy5pc1NlbmRpbmcgPSBpc1NlbmRpbmc7XG4gICAgdGhpcy5yZW5kZXIoKTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgc3VibWl0UHJvbXB0KCkge1xuICAgIGNvbnN0IHRleHQgPSB0aGlzLmlucHV0VmFsdWUudHJpbSgpO1xuICAgIGlmICghdGV4dCB8fCB0aGlzLmlzU2VuZGluZykgcmV0dXJuO1xuXG4gICAgdGhpcy5pbnB1dFZhbHVlID0gJyc7XG4gICAgdGhpcy5pc1NlbmRpbmcgPSB0cnVlO1xuICAgIHRoaXMubWVzc2FnZXMucHVzaCh7IHJvbGU6ICd1c2VyJywgdGV4dCB9KTtcbiAgICB0aGlzLm1lc3NhZ2VzLnB1c2goeyByb2xlOiAnYXNzaXN0YW50JywgdGV4dDogJycgfSk7XG4gICAgdGhpcy5yZW5kZXIoKTtcblxuICAgIHRyeSB7XG4gICAgICBhd2FpdCB0aGlzLnBsdWdpbi5jbGllbnQuc2VuZFByb21wdCh0ZXh0LCB0aGlzLnBsdWdpbi5nZXRWYXVsdFBhdGgoKSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XG4gICAgICB0aGlzLmFwcGVuZE1lc3NhZ2UoJ2Vycm9yJywgbWVzc2FnZSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHRoaXMuaXNTZW5kaW5nID0gZmFsc2U7XG4gICAgICB0aGlzLnJlbmRlcigpO1xuICAgIH1cbiAgfVxuXG4gIHJlbmRlcigpIHtcbiAgICBjb25zdCByb290ID0gdGhpcy5jb250YWluZXJFbC5jaGlsZHJlblsxXSBhcyBIVE1MRWxlbWVudDtcbiAgICByb290LmVtcHR5KCk7XG5cbiAgICBjb25zdCB3cmFwID0gcm9vdC5jcmVhdGVEaXYoeyBjbHM6ICdoZXJtZXMtbXZwLXdyYXAnIH0pO1xuICAgIGNvbnN0IGxpc3QgPSB3cmFwLmNyZWF0ZURpdih7IGNsczogJ2hlcm1lcy1tdnAtbWVzc2FnZXMnIH0pO1xuXG4gICAgZm9yIChjb25zdCBtc2cgb2YgdGhpcy5tZXNzYWdlcykge1xuICAgICAgY29uc3Qgcm93ID0gbGlzdC5jcmVhdGVEaXYoeyBjbHM6IGBoZXJtZXMtbXZwLW1zZyBoZXJtZXMtbXZwLSR7bXNnLnJvbGV9YCB9KTtcbiAgICAgIGNvbnN0IGxhYmVsID0gbXNnLnJvbGUgPT09ICd1c2VyJ1xuICAgICAgICA/ICdZb3UnXG4gICAgICAgIDogbXNnLnJvbGUgPT09ICdhc3Npc3RhbnQnXG4gICAgICAgICAgPyAnSGVybWVzJ1xuICAgICAgICAgIDogbXNnLnJvbGUgPT09ICdzdGF0dXMnXG4gICAgICAgICAgICA/ICdTdGF0dXMnXG4gICAgICAgICAgICA6ICdFcnJvcic7XG4gICAgICByb3cuY3JlYXRlRWwoJ3N0cm9uZycsIHsgdGV4dDogbGFiZWwgfSk7XG4gICAgICByb3cuY3JlYXRlRGl2KHsgdGV4dDogbXNnLnRleHQgfHwgKG1zZy5yb2xlID09PSAnYXNzaXN0YW50JyA/ICcuLi4nIDogJycpIH0pO1xuICAgIH1cblxuICAgIGNvbnN0IGZvcm0gPSB3cmFwLmNyZWF0ZURpdih7IGNsczogJ2hlcm1lcy1tdnAtZm9ybScgfSk7XG4gICAgY29uc3QgaW5wdXQgPSBmb3JtLmNyZWF0ZUVsKCd0ZXh0YXJlYScsIHtcbiAgICAgIGF0dHI6IHsgcm93czogJzQnLCBwbGFjZWhvbGRlcjogJ0FzayBIZXJtZXMuLi4nIH0sXG4gICAgfSk7XG4gICAgaW5wdXQudmFsdWUgPSB0aGlzLmlucHV0VmFsdWU7XG4gICAgaW5wdXQuZGlzYWJsZWQgPSB0aGlzLmlzU2VuZGluZztcbiAgICBpbnB1dC5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsICgpID0+IHtcbiAgICAgIHRoaXMuaW5wdXRWYWx1ZSA9IGlucHV0LnZhbHVlO1xuICAgIH0pO1xuICAgIGlucHV0LmFkZEV2ZW50TGlzdGVuZXIoJ2tleWRvd24nLCBldnQgPT4ge1xuICAgICAgaWYgKGV2dC5rZXkgPT09ICdFbnRlcicgJiYgKGV2dC5tZXRhS2V5IHx8IGV2dC5jdHJsS2V5KSkge1xuICAgICAgICBldnQucHJldmVudERlZmF1bHQoKTtcbiAgICAgICAgdm9pZCB0aGlzLnN1Ym1pdFByb21wdCgpO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgY29uc3QgYnV0dG9uID0gZm9ybS5jcmVhdGVFbCgnYnV0dG9uJywgeyB0ZXh0OiB0aGlzLmlzU2VuZGluZyA/ICdTZW5kaW5nLi4uJyA6ICdTZW5kJyB9KTtcbiAgICBidXR0b24uZGlzYWJsZWQgPSB0aGlzLmlzU2VuZGluZztcbiAgICBidXR0b24uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICB2b2lkIHRoaXMuc3VibWl0UHJvbXB0KCk7XG4gICAgfSk7XG4gIH1cbn1cblxuY2xhc3MgSGVybWVzU2V0dGluZ1RhYiBleHRlbmRzIFBsdWdpblNldHRpbmdUYWIge1xuICBwbHVnaW46IEhlcm1lc09ic2lkaWFuTVZQUGx1Z2luO1xuXG4gIGNvbnN0cnVjdG9yKGFwcDogQXBwLCBwbHVnaW46IEhlcm1lc09ic2lkaWFuTVZQUGx1Z2luKSB7XG4gICAgc3VwZXIoYXBwLCBwbHVnaW4pO1xuICAgIHRoaXMucGx1Z2luID0gcGx1Z2luO1xuICB9XG5cbiAgZGlzcGxheSgpOiB2b2lkIHtcbiAgICBjb25zdCB7IGNvbnRhaW5lckVsIH0gPSB0aGlzO1xuICAgIGNvbnRhaW5lckVsLmVtcHR5KCk7XG5cbiAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbClcbiAgICAgIC5zZXROYW1lKCdIZXJtZXMgY29tbWFuZCcpXG4gICAgICAuc2V0RGVzYygnQ29tbWFuZCB1c2VkIHRvIGxhdW5jaCBIZXJtZXMgQUNQIGxvY2FsbHkuJylcbiAgICAgIC5hZGRUZXh0KHRleHQgPT5cbiAgICAgICAgdGV4dFxuICAgICAgICAgIC5zZXRQbGFjZWhvbGRlcignaGVybWVzJylcbiAgICAgICAgICAuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3MuaGVybWVzQ29tbWFuZClcbiAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgdmFsdWUgPT4ge1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3MuaGVybWVzQ29tbWFuZCA9IHZhbHVlLnRyaW0oKSB8fCAnaGVybWVzJztcbiAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgICAgbmV3IE5vdGljZSgnSGVybWVzIGNvbW1hbmQgc2F2ZWQnKTtcbiAgICAgICAgICB9KSxcbiAgICAgICk7XG4gIH1cbn1cblxuZXhwb3J0IGRlZmF1bHQgY2xhc3MgSGVybWVzT2JzaWRpYW5NVlBQbHVnaW4gZXh0ZW5kcyBQbHVnaW4ge1xuICBzZXR0aW5ncyE6IEhlcm1lc1BsdWdpblNldHRpbmdzO1xuICBjbGllbnQhOiBIZXJtZXNBQ1BDbGllbnQ7XG4gIHByaXZhdGUgYWN0aXZlVmlldzogSGVybWVzTVZQVmlldyB8IG51bGwgPSBudWxsO1xuXG4gIGFzeW5jIG9ubG9hZCgpIHtcbiAgICB0aGlzLnNldHRpbmdzID0gT2JqZWN0LmFzc2lnbih7fSwgREVGQVVMVF9TRVRUSU5HUywgYXdhaXQgdGhpcy5sb2FkRGF0YSgpKTtcbiAgICB0aGlzLmNsaWVudCA9IG5ldyBIZXJtZXNBQ1BDbGllbnQodGhpcy5zZXR0aW5ncy5oZXJtZXNDb21tYW5kKTtcbiAgICB0aGlzLndpcmVDbGllbnRDYWxsYmFja3MoKTtcblxuICAgIHRoaXMucmVnaXN0ZXJWaWV3KFZJRVdfVFlQRV9IRVJNRVNfTVZQLCBsZWFmID0+IG5ldyBIZXJtZXNNVlBWaWV3KGxlYWYsIHRoaXMpKTtcbiAgICB0aGlzLmFkZFNldHRpbmdUYWIobmV3IEhlcm1lc1NldHRpbmdUYWIodGhpcy5hcHAsIHRoaXMpKTtcblxuICAgIHRoaXMuYWRkUmliYm9uSWNvbignYm90JywgJ09wZW4gSGVybWVzIE1WUCcsIGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IHRoaXMuYWN0aXZhdGVWaWV3KCk7XG4gICAgfSk7XG5cbiAgICB0aGlzLmFkZENvbW1hbmQoe1xuICAgICAgaWQ6ICdvcGVuLWhlcm1lcy1tdnAnLFxuICAgICAgbmFtZTogJ09wZW4gSGVybWVzIE1WUCcsXG4gICAgICBjYWxsYmFjazogYXN5bmMgKCkgPT4gdGhpcy5hY3RpdmF0ZVZpZXcoKSxcbiAgICB9KTtcbiAgfVxuXG4gIGFzeW5jIG9udW5sb2FkKCkge1xuICAgIHRoaXMuYXBwLndvcmtzcGFjZS5kZXRhY2hMZWF2ZXNPZlR5cGUoVklFV19UWVBFX0hFUk1FU19NVlApO1xuICB9XG5cbiAgcmVnaXN0ZXJWaWV3SW5zdGFuY2UodmlldzogSGVybWVzTVZQVmlldykge1xuICAgIHRoaXMuYWN0aXZlVmlldyA9IHZpZXc7XG4gIH1cblxuICB1bnJlZ2lzdGVyVmlld0luc3RhbmNlKHZpZXc6IEhlcm1lc01WUFZpZXcpIHtcbiAgICBpZiAodGhpcy5hY3RpdmVWaWV3ID09PSB2aWV3KSB0aGlzLmFjdGl2ZVZpZXcgPSBudWxsO1xuICB9XG5cbiAgZ2V0VmF1bHRQYXRoKCkge1xuICAgIHJldHVybiB0aGlzLmFwcC52YXVsdC5hZGFwdGVyLmJhc2VQYXRoIHx8IHByb2Nlc3MuY3dkKCk7XG4gIH1cblxuICBhc3luYyBzYXZlU2V0dGluZ3MoKSB7XG4gICAgYXdhaXQgdGhpcy5zYXZlRGF0YSh0aGlzLnNldHRpbmdzKTtcbiAgICB0aGlzLmNsaWVudCA9IG5ldyBIZXJtZXNBQ1BDbGllbnQodGhpcy5zZXR0aW5ncy5oZXJtZXNDb21tYW5kKTtcbiAgICB0aGlzLndpcmVDbGllbnRDYWxsYmFja3MoKTtcbiAgfVxuXG4gIHByaXZhdGUgd2lyZUNsaWVudENhbGxiYWNrcygpIHtcbiAgICB0aGlzLmNsaWVudC5vbkFzc2lzdGFudFRleHQgPSAodGV4dDogc3RyaW5nKSA9PiB7XG4gICAgICB0aGlzLmFjdGl2ZVZpZXc/LmFwcGVuZE1lc3NhZ2UoJ2Fzc2lzdGFudCcsIHRleHQpO1xuICAgIH07XG5cbiAgICB0aGlzLmNsaWVudC5vblN0YXR1cyA9ICh0ZXh0OiBzdHJpbmcpID0+IHtcbiAgICAgIHRoaXMuYWN0aXZlVmlldz8uYXBwZW5kTWVzc2FnZSgnc3RhdHVzJywgdGV4dCk7XG4gICAgfTtcblxuICAgIHRoaXMuY2xpZW50Lm9uRXJyb3IgPSAodGV4dDogc3RyaW5nKSA9PiB7XG4gICAgICB0aGlzLmFjdGl2ZVZpZXc/LmFwcGVuZE1lc3NhZ2UoJ2Vycm9yJywgdGV4dCk7XG4gICAgICBuZXcgTm90aWNlKHRleHQpO1xuICAgIH07XG4gIH1cblxuICBhc3luYyBhY3RpdmF0ZVZpZXcoKSB7XG4gICAgbGV0IGxlYWYgPSB0aGlzLmFwcC53b3Jrc3BhY2UuZ2V0TGVhdmVzT2ZUeXBlKFZJRVdfVFlQRV9IRVJNRVNfTVZQKVswXTtcbiAgICBpZiAoIWxlYWYpIHtcbiAgICAgIGxlYWYgPSB0aGlzLmFwcC53b3Jrc3BhY2UuZ2V0UmlnaHRMZWFmKGZhbHNlKTtcbiAgICAgIGF3YWl0IGxlYWYuc2V0Vmlld1N0YXRlKHsgdHlwZTogVklFV19UWVBFX0hFUk1FU19NVlAsIGFjdGl2ZTogdHJ1ZSB9KTtcbiAgICB9XG4gICAgYXdhaXQgdGhpcy5hcHAud29ya3NwYWNlLnJldmVhbExlYWYobGVhZik7XG4gIH1cbn1cbiIsICJpbXBvcnQgeyBDaGlsZFByb2Nlc3NXaXRob3V0TnVsbFN0cmVhbXMsIHNwYXduIH0gZnJvbSAnY2hpbGRfcHJvY2Vzcyc7XG5cbnR5cGUgUGVuZGluZ1JlcXVlc3QgPSB7XG4gIHJlc29sdmU6ICh2YWx1ZTogYW55KSA9PiB2b2lkO1xuICByZWplY3Q6IChyZWFzb24/OiB1bmtub3duKSA9PiB2b2lkO1xufTtcblxudHlwZSBTZXNzaW9uVXBkYXRlUGFyYW1zID0ge1xuICBzZXNzaW9uSWQ/OiBzdHJpbmc7XG4gIHNlc3Npb25faWQ/OiBzdHJpbmc7XG4gIHVwZGF0ZT86IFJlY29yZDxzdHJpbmcsIGFueT47XG59O1xuXG5leHBvcnQgY2xhc3MgSGVybWVzQUNQQ2xpZW50IHtcbiAgcHJpdmF0ZSBwcm9jOiBDaGlsZFByb2Nlc3NXaXRob3V0TnVsbFN0cmVhbXMgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBidWZmZXIgPSAnJztcbiAgcHJpdmF0ZSBuZXh0SWQgPSAxO1xuICBwcml2YXRlIHBlbmRpbmcgPSBuZXcgTWFwPG51bWJlciwgUGVuZGluZ1JlcXVlc3Q+KCk7XG4gIHByaXZhdGUgaW5pdGlhbGl6ZWQgPSBmYWxzZTtcbiAgcHJpdmF0ZSBzZXNzaW9uSWQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBvbkFzc2lzdGFudFRleHQ/OiAodGV4dDogc3RyaW5nKSA9PiB2b2lkO1xuICBvblN0YXR1cz86ICh0ZXh0OiBzdHJpbmcpID0+IHZvaWQ7XG4gIG9uRXJyb3I/OiAodGV4dDogc3RyaW5nKSA9PiB2b2lkO1xuXG4gIGNvbnN0cnVjdG9yKHByaXZhdGUgaGVybWVzQ29tbWFuZDogc3RyaW5nKSB7fVxuXG4gIHByaXZhdGUgZW5zdXJlU3RhcnRlZChjd2Q/OiBzdHJpbmcpIHtcbiAgICBpZiAodGhpcy5wcm9jKSByZXR1cm47XG5cbiAgICB0aGlzLnByb2MgPSBzcGF3bih0aGlzLmhlcm1lc0NvbW1hbmQsIFsnYWNwJ10sIHtcbiAgICAgIGN3ZDogY3dkIHx8IHByb2Nlc3MuY3dkKCksXG4gICAgICBzdGRpbzogWydwaXBlJywgJ3BpcGUnLCAncGlwZSddLFxuICAgIH0pO1xuXG4gICAgdGhpcy5wcm9jLnN0ZG91dC5vbignZGF0YScsIGNodW5rID0+IHtcbiAgICAgIHRoaXMuYnVmZmVyICs9IGNodW5rLnRvU3RyaW5nKCd1dGY4Jyk7XG4gICAgICB0aGlzLmNvbnN1bWVCdWZmZXIoKTtcbiAgICB9KTtcblxuICAgIHRoaXMucHJvYy5zdGRlcnIub24oJ2RhdGEnLCBjaHVuayA9PiB7XG4gICAgICBjb25zdCB0ZXh0ID0gY2h1bmsudG9TdHJpbmcoJ3V0ZjgnKS50cmltKCk7XG4gICAgICBpZiAodGV4dCAmJiB0aGlzLm9uU3RhdHVzKSB0aGlzLm9uU3RhdHVzKHRleHQpO1xuICAgIH0pO1xuXG4gICAgdGhpcy5wcm9jLm9uKCdlcnJvcicsIGVycm9yID0+IHtcbiAgICAgIHRoaXMub25FcnJvcj8uKGBGYWlsZWQgdG8gc3RhcnQgSGVybWVzIEFDUDogJHtTdHJpbmcoZXJyb3IpfWApO1xuICAgIH0pO1xuXG4gICAgdGhpcy5wcm9jLm9uKCdleGl0JywgY29kZSA9PiB7XG4gICAgICBjb25zdCBlcnJvciA9IGBIZXJtZXMgQUNQIGV4aXRlZCR7Y29kZSAhPT0gbnVsbCA/IGAgd2l0aCBjb2RlICR7Y29kZX1gIDogJyd9YDtcbiAgICAgIGZvciAoY29uc3QgcGVuZGluZyBvZiB0aGlzLnBlbmRpbmcudmFsdWVzKCkpIHBlbmRpbmcucmVqZWN0KG5ldyBFcnJvcihlcnJvcikpO1xuICAgICAgdGhpcy5wZW5kaW5nLmNsZWFyKCk7XG4gICAgICB0aGlzLnByb2MgPSBudWxsO1xuICAgICAgdGhpcy5pbml0aWFsaXplZCA9IGZhbHNlO1xuICAgICAgdGhpcy5zZXNzaW9uSWQgPSBudWxsO1xuICAgICAgdGhpcy5vblN0YXR1cz8uKGVycm9yKTtcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgY29uc3VtZUJ1ZmZlcigpIHtcbiAgICBsZXQgbmV3bGluZUluZGV4ID0gLTE7XG4gICAgd2hpbGUgKChuZXdsaW5lSW5kZXggPSB0aGlzLmJ1ZmZlci5pbmRleE9mKCdcXG4nKSkgPj0gMCkge1xuICAgICAgY29uc3QgbGluZSA9IHRoaXMuYnVmZmVyLnNsaWNlKDAsIG5ld2xpbmVJbmRleCkudHJpbSgpO1xuICAgICAgdGhpcy5idWZmZXIgPSB0aGlzLmJ1ZmZlci5zbGljZShuZXdsaW5lSW5kZXggKyAxKTtcbiAgICAgIGlmICghbGluZSkgY29udGludWU7XG5cbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IG1zZyA9IEpTT04ucGFyc2UobGluZSk7XG4gICAgICAgIHRoaXMuaGFuZGxlTWVzc2FnZShtc2cpO1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgdGhpcy5vbkVycm9yPy4oYEZhaWxlZCB0byBwYXJzZSBBQ1Agb3V0cHV0OiAke1N0cmluZyhlcnJvcil9YCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBoYW5kbGVNZXNzYWdlKG1zZzogYW55KSB7XG4gICAgaWYgKHR5cGVvZiBtc2cuaWQgPT09ICdudW1iZXInICYmIHRoaXMucGVuZGluZy5oYXMobXNnLmlkKSkge1xuICAgICAgY29uc3QgcGVuZGluZyA9IHRoaXMucGVuZGluZy5nZXQobXNnLmlkKSE7XG4gICAgICB0aGlzLnBlbmRpbmcuZGVsZXRlKG1zZy5pZCk7XG4gICAgICBpZiAobXNnLmVycm9yKSBwZW5kaW5nLnJlamVjdChtc2cuZXJyb3IpO1xuICAgICAgZWxzZSBwZW5kaW5nLnJlc29sdmUobXNnLnJlc3VsdCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKG1zZy5tZXRob2QgPT09ICdzZXNzaW9uL3VwZGF0ZScpIHtcbiAgICAgIHRoaXMuaGFuZGxlU2Vzc2lvblVwZGF0ZShtc2cucGFyYW1zID8/IHt9KTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGhhbmRsZVNlc3Npb25VcGRhdGUocGFyYW1zOiBTZXNzaW9uVXBkYXRlUGFyYW1zKSB7XG4gICAgY29uc3QgdXBkYXRlID0gcGFyYW1zLnVwZGF0ZSA/PyBwYXJhbXM7XG4gICAgaWYgKCF1cGRhdGUgfHwgdHlwZW9mIHVwZGF0ZSAhPT0gJ29iamVjdCcpIHJldHVybjtcblxuICAgIGNvbnN0IHNlc3Npb25VcGRhdGUgPSB1cGRhdGUuc2Vzc2lvblVwZGF0ZSA/PyB1cGRhdGUuc2Vzc2lvbl91cGRhdGU7XG5cbiAgICBpZiAoc2Vzc2lvblVwZGF0ZSA9PT0gJ2FnZW50X21lc3NhZ2VfY2h1bmsnIHx8IHNlc3Npb25VcGRhdGUgPT09ICdhZ2VudF9tZXNzYWdlJykge1xuICAgICAgY29uc3QgdGV4dCA9IHRoaXMuZXh0cmFjdFRleHQodXBkYXRlKTtcbiAgICAgIGlmICh0ZXh0KSB0aGlzLm9uQXNzaXN0YW50VGV4dD8uKHRleHQpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmIChzZXNzaW9uVXBkYXRlID09PSAnYWdlbnRfdGhvdWdodF9jaHVuaycgfHwgc2Vzc2lvblVwZGF0ZSA9PT0gJ3Rvb2xfY2FsbCcgfHwgc2Vzc2lvblVwZGF0ZSA9PT0gJ3Rvb2xfY2FsbF91cGRhdGUnKSB7XG4gICAgICBjb25zdCB0ZXh0ID0gdGhpcy5leHRyYWN0VGV4dCh1cGRhdGUpO1xuICAgICAgaWYgKHRleHQpIHRoaXMub25TdGF0dXM/Lih0ZXh0KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAoc2Vzc2lvblVwZGF0ZSA9PT0gJ2F2YWlsYWJsZV9jb21tYW5kc191cGRhdGUnKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgZmFsbGJhY2sgPSB0aGlzLmV4dHJhY3RUZXh0KHVwZGF0ZSk7XG4gICAgaWYgKGZhbGxiYWNrKSB0aGlzLm9uU3RhdHVzPy4oZmFsbGJhY2spO1xuICB9XG5cbiAgcHJpdmF0ZSBleHRyYWN0VGV4dCh2YWx1ZTogYW55KTogc3RyaW5nIHtcbiAgICBjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbXTtcblxuICAgIGNvbnN0IHdhbGsgPSAobm9kZTogYW55KSA9PiB7XG4gICAgICBpZiAobm9kZSA9PSBudWxsKSByZXR1cm47XG4gICAgICBpZiAodHlwZW9mIG5vZGUgPT09ICdzdHJpbmcnKSByZXR1cm47XG4gICAgICBpZiAoQXJyYXkuaXNBcnJheShub2RlKSkge1xuICAgICAgICBmb3IgKGNvbnN0IGl0ZW0gb2Ygbm9kZSkgd2FsayhpdGVtKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgaWYgKHR5cGVvZiBub2RlICE9PSAnb2JqZWN0JykgcmV0dXJuO1xuXG4gICAgICBpZiAodHlwZW9mIG5vZGUudGV4dCA9PT0gJ3N0cmluZycpIHBhcnRzLnB1c2gobm9kZS50ZXh0KTtcbiAgICAgIGlmICh0eXBlb2Ygbm9kZS5jb250ZW50ID09PSAnc3RyaW5nJykgcGFydHMucHVzaChub2RlLmNvbnRlbnQpO1xuICAgICAgaWYgKHR5cGVvZiBub2RlLnJlc3VsdCA9PT0gJ3N0cmluZycpIHBhcnRzLnB1c2gobm9kZS5yZXN1bHQpO1xuICAgICAgaWYgKHR5cGVvZiBub2RlLmRlc2NyaXB0aW9uID09PSAnc3RyaW5nJykgcGFydHMucHVzaChub2RlLmRlc2NyaXB0aW9uKTtcblxuICAgICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXMobm9kZSkpIHtcbiAgICAgICAgd2Fsayhub2RlW2tleV0pO1xuICAgICAgfVxuICAgIH07XG5cbiAgICB3YWxrKHZhbHVlKTtcbiAgICByZXR1cm4gcGFydHMuam9pbignJyk7XG4gIH1cblxuICBwcml2YXRlIHJlcXVlc3QobWV0aG9kOiBzdHJpbmcsIHBhcmFtczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIHtcbiAgICBpZiAoIXRoaXMucHJvYykgdGhyb3cgbmV3IEVycm9yKCdIZXJtZXMgQUNQIHByb2Nlc3MgaXMgbm90IHJ1bm5pbmcnKTtcblxuICAgIGNvbnN0IGlkID0gdGhpcy5uZXh0SWQrKztcbiAgICBjb25zdCBwYXlsb2FkID0geyBqc29ucnBjOiAnMi4wJywgaWQsIG1ldGhvZCwgcGFyYW1zIH07XG4gICAgdGhpcy5wcm9jLnN0ZGluLndyaXRlKGAke0pTT04uc3RyaW5naWZ5KHBheWxvYWQpfVxcbmApO1xuXG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgIHRoaXMucGVuZGluZy5zZXQoaWQsIHsgcmVzb2x2ZSwgcmVqZWN0IH0pO1xuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBlbnN1cmVJbml0aWFsaXplZChjd2Q/OiBzdHJpbmcpIHtcbiAgICB0aGlzLmVuc3VyZVN0YXJ0ZWQoY3dkKTtcbiAgICBpZiAodGhpcy5pbml0aWFsaXplZCkgcmV0dXJuO1xuXG4gICAgYXdhaXQgdGhpcy5yZXF1ZXN0KCdpbml0aWFsaXplJywge1xuICAgICAgcHJvdG9jb2xfdmVyc2lvbjogMSxcbiAgICAgIGNsaWVudF9jYXBhYmlsaXRpZXM6IHt9LFxuICAgICAgY2xpZW50X2luZm86IHtcbiAgICAgICAgbmFtZTogJ2hlcm1lcy1vYnNpZGlhbi1tdnAnLFxuICAgICAgICB2ZXJzaW9uOiAnMC4wLjEnLFxuICAgICAgfSxcbiAgICB9KTtcbiAgICB0aGlzLmluaXRpYWxpemVkID0gdHJ1ZTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgZW5zdXJlU2Vzc2lvbihjd2Q/OiBzdHJpbmcpIHtcbiAgICBpZiAodGhpcy5zZXNzaW9uSWQpIHJldHVybiB0aGlzLnNlc3Npb25JZDtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCB0aGlzLnJlcXVlc3QoJ25ld19zZXNzaW9uJywgeyBjd2Q6IGN3ZCB8fCBwcm9jZXNzLmN3ZCgpIH0pO1xuICAgIHRoaXMuc2Vzc2lvbklkID0gcmVzdWx0Py5zZXNzaW9uSWQgPz8gcmVzdWx0Py5zZXNzaW9uX2lkID8/IHJlc3VsdD8uaWQ7XG4gICAgaWYgKCF0aGlzLnNlc3Npb25JZCkgdGhyb3cgbmV3IEVycm9yKCdIZXJtZXMgQUNQIGRpZCBub3QgcmV0dXJuIGEgc2Vzc2lvbiBpZCcpO1xuICAgIHJldHVybiB0aGlzLnNlc3Npb25JZDtcbiAgfVxuXG4gIGFzeW5jIHNlbmRQcm9tcHQodGV4dDogc3RyaW5nLCBjd2Q/OiBzdHJpbmcpIHtcbiAgICBhd2FpdCB0aGlzLmVuc3VyZUluaXRpYWxpemVkKGN3ZCk7XG4gICAgY29uc3Qgc2Vzc2lvbklkID0gYXdhaXQgdGhpcy5lbnN1cmVTZXNzaW9uKGN3ZCk7XG4gICAgcmV0dXJuIHRoaXMucmVxdWVzdCgncHJvbXB0Jywge1xuICAgICAgc2Vzc2lvbl9pZDogc2Vzc2lvbklkLFxuICAgICAgcHJvbXB0OiBbeyB0eXBlOiAndGV4dCcsIHRleHQgfV0sXG4gICAgfSk7XG4gIH1cbn1cbiJdLAogICJtYXBwaW5ncyI6ICI7Ozs7Ozs7Ozs7Ozs7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
