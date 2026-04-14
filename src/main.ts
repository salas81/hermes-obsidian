import { App, ItemView, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf } from 'obsidian';

const VIEW_TYPE_HERMES_MVP = 'hermes-obsidian-mvp';

type ChatMessage = {
  role: 'user' | 'assistant' | 'status' | 'error';
  text: string;
  timestamp: number;
};

type DeviceIdentity = {
  deviceId: string;
  publicKey: string;
  privateKey: string;
  cryptoKey?: CryptoKey;
};

type GatewayEvent = {
  event: string;
  payload?: Record<string, any>;
  seq?: number;
};

interface HermesPluginSettings {
  gatewayUrl: string;
  token: string;
  sessionKey: string;
  onboardingComplete: boolean;
  deviceId?: string;
  devicePublicKey?: string;
  devicePrivateKey?: string;
}

const DEFAULT_SETTINGS: HermesPluginSettings = {
  gatewayUrl: '',
  token: '',
  sessionKey: 'main',
  onboardingComplete: false,
};

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function normalizeGatewayUrl(url: string): string | null {
  let value = url.trim();
  if (!value) return null;
  if (value.startsWith('https://')) value = `wss://${value.slice(8)}`;
  else if (value.startsWith('http://')) value = `ws://${value.slice(7)}`;
  if (!value.startsWith('ws://') && !value.startsWith('wss://')) return null;
  return value.replace(/\/+$/, '');
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(normalized);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

function randomId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function buildSigningPayload(data: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string | null;
  nonce?: string | null;
}) {
  const version = data.nonce ? 'v2' : 'v1';
  const parts = [
    version,
    data.deviceId,
    data.clientId,
    data.clientMode,
    data.role,
    data.scopes.join(','),
    String(data.signedAtMs),
    data.token ?? '',
  ];
  if (version === 'v2') parts.push(data.nonce ?? '');
  return parts.join('|');
}

async function signDevicePayload(identity: DeviceIdentity, payload: string): Promise<string> {
  const encoded = new TextEncoder().encode(payload);
  let cryptoKey = identity.cryptoKey;
  if (!cryptoKey) {
    cryptoKey = await crypto.subtle.importKey('pkcs8', fromBase64Url(identity.privateKey), { name: 'Ed25519' }, false, ['sign']);
  }
  const signature = await crypto.subtle.sign('Ed25519', cryptoKey, encoded);
  return toBase64Url(new Uint8Array(signature));
}

class GatewayClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (reason?: unknown) => void }>();
  private pendingTimeouts = new Map<string, number>();
  private closed = false;
  private connectSent = false;
  private connectNonce: string | null = null;
  private backoffMs = 800;
  private connectTimer: number | null = null;

  constructor(private opts: {
    url: string;
    token: string;
    deviceIdentity?: DeviceIdentity;
    onHello?: (payload: any) => void;
    onClose?: (info: { code: number; reason: string }) => void;
    onError?: (error: Error) => void;
    onEvent?: (event: GatewayEvent) => void;
  }) {}

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
    this.flushPending(new Error('client stopped'));
  }

  async request(method: string, params: Record<string, unknown>) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('not connected');
    const id = randomId();
    const frame = { type: 'req', id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const timeout = window.setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error('request timeout'));
      }, 30000);
      this.pendingTimeouts.set(id, timeout);
      this.ws!.send(JSON.stringify(frame));
    });
  }

  private doConnect() {
    if (this.closed) return;
    const normalized = normalizeGatewayUrl(this.opts.url);
    if (!normalized) {
      this.opts.onError?.(new Error('Invalid gateway URL'));
      return;
    }

    this.ws = new WebSocket(normalized);
    this.ws.addEventListener('open', () => this.queueConnect());
    this.ws.addEventListener('message', evt => this.handleMessage(asString(evt.data)));
    this.ws.addEventListener('close', evt => {
      this.ws = null;
      this.flushPending(new Error(evt.reason || `closed (${evt.code})`));
      this.opts.onClose?.({ code: evt.code, reason: evt.reason || '' });
      this.scheduleReconnect();
    });
    this.ws.addEventListener('error', () => {
      this.opts.onError?.(new Error('WebSocket connection error'));
    });
  }

  private scheduleReconnect() {
    if (this.closed) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 1.7, 15000);
    window.setTimeout(() => this.doConnect(), delay);
  }

  private flushPending(error: Error) {
    for (const [id, pending] of this.pending) {
      const timeout = this.pendingTimeouts.get(id);
      if (timeout) window.clearTimeout(timeout);
      pending.reject(error);
    }
    this.pending.clear();
    this.pendingTimeouts.clear();
  }

  private queueConnect() {
    this.connectNonce = null;
    this.connectSent = false;
    if (this.connectTimer !== null) window.clearTimeout(this.connectTimer);
    this.connectTimer = window.setTimeout(() => {
      void this.sendConnect();
    }, 750);
  }

  private async sendConnect() {
    if (this.connectSent) return;
    this.connectSent = true;
    if (this.connectTimer !== null) {
      window.clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }

    const clientId = 'gateway-client';
    const clientMode = 'ui';
    const role = 'operator';
    const scopes = ['operator.admin', 'operator.write', 'operator.read'];

    let device: Record<string, unknown> | undefined;
    if (this.opts.deviceIdentity) {
      try {
        const signedAt = Date.now();
        const payload = buildSigningPayload({
          deviceId: this.opts.deviceIdentity.deviceId,
          clientId,
          clientMode,
          role,
          scopes,
          signedAtMs: signedAt,
          token: this.opts.token || null,
          nonce: this.connectNonce,
        });
        const signature = await signDevicePayload(this.opts.deviceIdentity, payload);
        device = {
          id: this.opts.deviceIdentity.deviceId,
          publicKey: this.opts.deviceIdentity.publicKey,
          signature,
          signedAt,
          nonce: this.connectNonce ?? undefined,
        };
      } catch (error) {
        this.opts.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    }

    const payload = {
      minProtocol: 3,
      maxProtocol: 3,
      client: { id: clientId, version: '0.1.0', platform: 'obsidian', mode: clientMode },
      role,
      scopes,
      auth: this.opts.token ? { token: this.opts.token } : undefined,
      device,
      caps: ['tool-events'],
    };

    try {
      const result = await this.request('connect', payload);
      this.backoffMs = 800;
      this.opts.onHello?.(result);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.opts.onError?.(err);
      this.ws?.close(4008, err.message || 'connect failed');
    }
  }

  private handleMessage(raw: string) {
    let frame: any;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }

    if (frame.type === 'event') {
      if (frame.event === 'connect.challenge') {
        const nonce = frame.payload?.nonce;
        if (typeof nonce === 'string') {
          this.connectNonce = nonce;
          void this.sendConnect();
        }
        return;
      }
      this.opts.onEvent?.({ event: frame.event, payload: frame.payload ?? {}, seq: frame.seq });
      return;
    }

    if (frame.type === 'res') {
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
      else pending.reject(new Error(frame.error?.message ?? 'request failed'));
    }
  }
}

class HermesMVPView extends ItemView {
  plugin: HermesObsidianMVPPlugin;
  messages: ChatMessage[] = [];
  private inputValue = '';
  private isSending = false;

  constructor(leaf: WorkspaceLeaf, plugin: HermesObsidianMVPPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE_HERMES_MVP;
  }

  getDisplayText() {
    return 'Hermes';
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

  setMessages(messages: ChatMessage[]) {
    this.messages = messages;
    this.render();
  }

  appendMessage(role: ChatMessage['role'], text: string) {
    if (!text) return;
    const last = this.messages[this.messages.length - 1];
    if (role === 'assistant' && last?.role === 'assistant') last.text += text;
    else if (role === 'status' && last?.role === 'status') last.text = text;
    else this.messages.push({ role, text, timestamp: Date.now() });
    this.render();
  }

  markSending(isSending: boolean) {
    this.isSending = isSending;
    this.render();
  }

  private async submitPrompt() {
    const text = this.inputValue.trim();
    if (!text || this.isSending) return;
    if (!this.plugin.gatewayConnected || !this.plugin.gateway) {
      new Notice('Not connected to Hermes gateway');
      return;
    }

    this.inputValue = '';
    this.isSending = true;
    this.messages.push({ role: 'user', text, timestamp: Date.now() });
    this.messages.push({ role: 'assistant', text: '', timestamp: Date.now() });
    this.render();

    try {
      await this.plugin.gateway.request('chat.send', {
        sessionKey: this.plugin.settings.sessionKey,
        message: text,
        deliver: false,
        idempotencyKey: randomId(),
      });
    } catch (error) {
      this.appendMessage('error', error instanceof Error ? error.message : String(error));
    } finally {
      this.isSending = false;
      this.render();
    }
  }

  render() {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();

    const wrap = root.createDiv({ cls: 'hermes-mvp-wrap' });
    const list = wrap.createDiv({ cls: 'hermes-mvp-messages' });

    for (const msg of this.messages) {
      const row = list.createDiv({ cls: `hermes-mvp-msg hermes-mvp-${msg.role}` });
      const label = msg.role === 'user' ? 'You' : msg.role === 'assistant' ? 'Hermes' : msg.role === 'status' ? 'Status' : 'Error';
      row.createEl('strong', { text: label });
      row.createDiv({ text: msg.text || (msg.role === 'assistant' ? '...' : '') });
    }

    const form = wrap.createDiv({ cls: 'hermes-mvp-form' });
    const input = form.createEl('textarea', {
      attr: { rows: '4', placeholder: 'Ask Hermes...' },
    });
    input.value = this.inputValue;
    input.disabled = this.isSending;
    input.addEventListener('input', () => {
      this.inputValue = input.value;
    });
    input.addEventListener('keydown', evt => {
      if (evt.key === 'Enter' && (evt.metaKey || evt.ctrlKey)) {
        evt.preventDefault();
        void this.submitPrompt();
      }
    });

    const button = form.createEl('button', { text: this.isSending ? 'Sending...' : 'Send' });
    button.disabled = this.isSending;
    button.addEventListener('click', () => void this.submitPrompt());
  }
}

class HermesSettingTab extends PluginSettingTab {
  plugin: HermesObsidianMVPPlugin;

  constructor(app: App, plugin: HermesObsidianMVPPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Hermes remote settings' });

    new Setting(containerEl)
      .setName('Gateway URL')
      .setDesc('Paste the Hermes gateway URL, usually a Tailscale-served https URL.')
      .addText(text =>
        text
          .setPlaceholder('https://your-pi.tailxxxx.ts.net')
          .setValue(this.plugin.settings.gatewayUrl)
          .onChange(async value => {
            this.plugin.settings.gatewayUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Auth token')
      .setDesc('Gateway auth token for operator access.')
      .addText(text =>
        text
          .setPlaceholder('Paste your gateway token')
          .setValue(this.plugin.settings.token)
          .onChange(async value => {
            this.plugin.settings.token = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Test connection')
      .setDesc('Connect to the remote Hermes gateway and verify access.')
      .addButton(button =>
        button.setButtonText('Connect').setCta().onClick(async () => {
          try {
            await this.plugin.connectGateway(true);
            new Notice('Connected to Hermes gateway');
          } catch (error) {
            new Notice(error instanceof Error ? error.message : String(error));
          }
        }),
      );
  }
}

export default class HermesObsidianMVPPlugin extends Plugin {
  settings!: HermesPluginSettings;
  gateway: GatewayClient | null = null;
  gatewayConnected = false;
  private activeView: HermesMVPView | null = null;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    await this.ensureDeviceIdentity();

    this.registerView(VIEW_TYPE_HERMES_MVP, leaf => new HermesMVPView(leaf, this));
    this.addSettingTab(new HermesSettingTab(this.app, this));

    this.addRibbonIcon('bot', 'Open Hermes', async () => {
      await this.activateView();
    });

    this.addCommand({
      id: 'open-hermes-mvp',
      name: 'Open Hermes',
      callback: async () => this.activateView(),
    });

    if (this.settings.gatewayUrl && this.settings.token) {
      void this.connectGateway();
    }
  }

  async onunload() {
    this.gateway?.stop();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_HERMES_MVP);
  }

  registerViewInstance(view: HermesMVPView) {
    this.activeView = view;
  }

  unregisterViewInstance(view: HermesMVPView) {
    if (this.activeView === view) this.activeView = null;
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.gateway?.stop();
    this.gateway = null;
    this.gatewayConnected = false;
  }

  private async ensureDeviceIdentity() {
    const deviceId = this.settings.deviceId;
    const publicKey = this.settings.devicePublicKey;
    const privateKey = this.settings.devicePrivateKey;
    if (deviceId && publicKey && privateKey) return;

    const keypair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const rawPublic = new Uint8Array(await crypto.subtle.exportKey('raw', keypair.publicKey));
    const rawPrivate = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keypair.privateKey));
    this.settings.deviceId = await sha256Hex(rawPublic);
    this.settings.devicePublicKey = toBase64Url(rawPublic);
    this.settings.devicePrivateKey = toBase64Url(rawPrivate);
    await this.saveData(this.settings);
  }

  private getDeviceIdentity(): DeviceIdentity | undefined {
    if (!this.settings.deviceId || !this.settings.devicePublicKey || !this.settings.devicePrivateKey) return undefined;
    return {
      deviceId: this.settings.deviceId,
      publicKey: this.settings.devicePublicKey,
      privateKey: this.settings.devicePrivateKey,
    };
  }

  async connectGateway(forceReconnect = false) {
    if (!this.settings.gatewayUrl || !this.settings.token) {
      throw new Error('Missing gateway URL or token');
    }

    if (this.gatewayConnected && this.gateway && !forceReconnect) return;
    this.gateway?.stop();

    const normalizedUrl = normalizeGatewayUrl(this.settings.gatewayUrl);
    if (!normalizedUrl) throw new Error('Invalid gateway URL');
    this.settings.gatewayUrl = normalizedUrl;
    await this.saveData(this.settings);

    this.gateway = new GatewayClient({
      url: normalizedUrl,
      token: this.settings.token,
      deviceIdentity: this.getDeviceIdentity(),
      onHello: () => {
        this.gatewayConnected = true;
        this.activeView?.appendMessage('status', 'Connected to Hermes gateway');
        void this.loadHistory();
      },
      onClose: info => {
        this.gatewayConnected = false;
        if (info.reason) this.activeView?.appendMessage('status', `Connection closed: ${info.reason}`);
      },
      onError: error => {
        this.gatewayConnected = false;
        this.activeView?.appendMessage('error', error.message);
      },
      onEvent: event => this.handleGatewayEvent(event),
    });

    this.gateway.start();
  }

  private handleGatewayEvent(event: GatewayEvent) {
    if (event.event === 'chat' || event.event === 'stream' || event.event === 'agent') {
      const payload = event.payload ?? {};
      const text = this.extractEventText(payload);
      if (text) this.activeView?.appendMessage('assistant', text);
    }
  }

  private extractEventText(payload: Record<string, any>): string {
    const texts: string[] = [];
    const walk = (value: any) => {
      if (value == null) return;
      if (typeof value === 'string') return;
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      if (typeof value !== 'object') return;
      if (typeof value.text === 'string') texts.push(value.text);
      if (typeof value.content === 'string') texts.push(value.content);
      if (typeof value.delta === 'string') texts.push(value.delta);
      Object.values(value).forEach(walk);
    };
    walk(payload);
    return texts.join('');
  }

  async loadHistory() {
    if (!this.gatewayConnected || !this.gateway) return;
    try {
      const result = await this.gateway.request('chat.history', {
        sessionKey: this.settings.sessionKey,
        limit: 200,
      });
      const messages = Array.isArray(result?.messages)
        ? result.messages
            .filter((msg: any) => msg.role === 'user' || msg.role === 'assistant')
            .map((msg: any) => ({
              role: msg.role,
              text: this.extractEventText({ content: msg.content }) || asString(msg.text),
              timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : Date.now(),
            }))
            .filter((msg: ChatMessage) => msg.text.trim())
        : [];
      this.activeView?.setMessages(messages);
    } catch (error) {
      this.activeView?.appendMessage('error', error instanceof Error ? error.message : String(error));
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
}
