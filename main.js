const { Plugin, ItemView, WorkspaceLeaf, Notice } = require('obsidian');
const { spawn } = require('child_process');
const path = require('path');

const VIEW_TYPE_HERMES_MVP = 'hermes-obsidian-mvp';

class HermesACPClient {
  constructor(plugin) {
    this.plugin = plugin;
    this.proc = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.sessionId = null;
    this.onText = null;
    this.onThought = null;
    this.onTool = null;
  }

  start() {
    if (this.proc) return;
    const cwd = this.plugin.app.vault.adapter.basePath || process.cwd();
    this.proc = spawn(this.plugin.settings.hermesCommand, ['acp'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout.on('data', chunk => {
      this.buffer += chunk.toString('utf8');
      this.consumeBuffer();
    });

    this.proc.stderr.on('data', chunk => {
      console.log('[Hermes ACP stderr]', chunk.toString('utf8'));
    });

    this.proc.on('exit', code => {
      console.log('[Hermes ACP exit]', code);
      this.proc = null;
    });
  }

  consumeBuffer() {
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        this.handleMessage(msg);
      } catch (err) {
        console.warn('Failed to parse ACP line', err, line);
      }
    }
  }

  handleMessage(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(msg.error);
      else resolve(msg.result);
      return;
    }

    if (msg.method === 'session/update') {
      const params = msg.params || {};
      const update = params.update || {};
      const kind = update.sessionUpdate || update.kind || '';
      const text = JSON.stringify(update);
      if (text.includes('agent_message') || text.includes('text')) {
        if (this.onText) this.onText(update);
      }
      if (text.includes('agent_thought')) {
        if (this.onThought) this.onThought(update);
      }
      if (text.includes('tool_call')) {
        if (this.onTool) this.onTool(update);
      }
    }
  }

  request(method, params = {}) {
    this.start();
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    this.proc.stdin.write(JSON.stringify(payload) + '\n');
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  async initialize() {
    await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    });
  }

  async ensureSession() {
    if (this.sessionId) return this.sessionId;
    const cwd = this.plugin.app.vault.adapter.basePath || process.cwd();
    const result = await this.request('session/new', { cwd });
    this.sessionId = result?.sessionId || result?.session_id || result?.id;
    return this.sessionId;
  }

  async prompt(text) {
    await this.initialize();
    const sessionId = await this.ensureSession();
    return this.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }],
    });
  }
}

class HermesMVPView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.messages = [];
  }

  getViewType() {
    return VIEW_TYPE_HERMES_MVP;
  }

  getDisplayText() {
    return 'Hermes';
  }

  async onOpen() {
    this.render();
  }

  render() {
    const root = this.containerEl.children[1];
    root.empty();

    const wrap = root.createDiv({ cls: 'hermes-mvp-wrap' });
    const list = wrap.createDiv({ cls: 'hermes-mvp-messages' });
    this.messages.forEach(msg => {
      const row = list.createDiv({ cls: `hermes-mvp-msg hermes-mvp-${msg.role}` });
      row.createEl('strong', { text: msg.role === 'user' ? 'You' : 'Hermes' });
      row.createEl('div', { text: msg.text });
    });

    const form = wrap.createDiv({ cls: 'hermes-mvp-form' });
    const input = form.createEl('textarea', { attr: { rows: '4', placeholder: 'Ask Hermes...' } });
    const btn = form.createEl('button', { text: 'Send' });

    btn.addEventListener('click', async () => {
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      this.messages.push({ role: 'user', text });
      this.render();

      try {
        await this.plugin.client.prompt(text);
        this.messages.push({ role: 'assistant', text: 'Request sent to Hermes. Streaming hookup is next.' });
      } catch (err) {
        this.messages.push({ role: 'assistant', text: `Error: ${err.message || err}` });
      }
      this.render();
    });
  }
}

module.exports = class HermesObsidianMVPPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({ hermesCommand: 'hermes' }, await this.loadData());
    this.client = new HermesACPClient(this);

    this.registerView(VIEW_TYPE_HERMES_MVP, leaf => new HermesMVPView(leaf, this));

    this.addRibbonIcon('bot', 'Open Hermes MVP', async () => {
      await this.activateView();
    });

    this.addCommand({
      id: 'open-hermes-mvp',
      name: 'Open Hermes MVP',
      callback: async () => {
        await this.activateView();
      },
    });
  }

  async onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_HERMES_MVP);
  }

  async activateView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_HERMES_MVP)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE_HERMES_MVP, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
};
