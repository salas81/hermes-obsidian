import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { existsSync } from 'fs';

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (reason?: unknown) => void;
};

type SessionUpdateParams = {
  sessionId?: string;
  session_id?: string;
  update?: Record<string, any>;
};

type SessionSummary = {
  id: string;
  [key: string]: any;
};

export class HermesACPClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private initialized = false;
  private sessionId: string | null = null;
  onAssistantText?: (text: string) => void;
  onStatus?: (text: string) => void;
  onError?: (text: string) => void;

  constructor(private hermesCommand: string) {}

  private resolveHermesCommand() {
    if (this.hermesCommand.includes('/') || this.hermesCommand.includes('\\')) {
      return this.hermesCommand;
    }

    const home = process.env.HOME;
    const candidates = [
      this.hermesCommand,
      home ? `${home}/.local/bin/${this.hermesCommand}` : null,
      home ? `${home}/.npm-global/bin/${this.hermesCommand}` : null,
      `/usr/local/bin/${this.hermesCommand}`,
      `/opt/homebrew/bin/${this.hermesCommand}`,
    ].filter((value): value is string => Boolean(value));

    for (const candidate of candidates) {
      if (candidate === this.hermesCommand || existsSync(candidate)) return candidate;
    }

    return this.hermesCommand;
  }

  private ensureStarted(cwd?: string) {
    if (this.proc) return;

    const command = this.resolveHermesCommand();

    this.proc = spawn(command, ['acp'], {
      cwd: cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout.on('data', chunk => {
      this.buffer += chunk.toString('utf8');
      this.consumeBuffer();
    });

    this.proc.stderr.on('data', chunk => {
      const text = chunk.toString('utf8').trim();
      if (text && this.onStatus) this.onStatus(text);
    });

    this.proc.on('error', error => {
      const extra = command === this.hermesCommand
        ? ''
        : ` (resolved from ${this.hermesCommand} to ${command})`;
      this.onError?.(`Failed to start Hermes ACP${extra}: ${String(error)}`);
    });

    this.proc.on('exit', code => {
      const error = `Hermes ACP exited${code !== null ? ` with code ${code}` : ''}`;
      for (const pending of this.pending.values()) pending.reject(new Error(error));
      this.pending.clear();
      this.proc = null;
      this.initialized = false;
      this.sessionId = null;
      this.onStatus?.(error);
    });
  }

  private consumeBuffer() {
    let newlineIndex = -1;
    while ((newlineIndex = this.buffer.indexOf('\n')) >= 0) {
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

  private handleMessage(msg: any) {
    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const pending = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) {
        const detail = typeof msg.error === 'string'
          ? msg.error
          : msg.error?.message || JSON.stringify(msg.error);
        pending.reject(new Error(detail));
      } else pending.resolve(msg.result);
      return;
    }

    if (msg.method === 'session/update') {
      this.handleSessionUpdate(msg.params ?? {});
    }
  }

  private handleSessionUpdate(params: SessionUpdateParams) {
    const update = params.update ?? params;
    if (!update || typeof update !== 'object') return;

    const sessionUpdate = update.sessionUpdate ?? update.session_update;

    if (sessionUpdate === 'agent_message_chunk' || sessionUpdate === 'agent_message') {
      const text = this.extractText(update);
      if (text) this.onAssistantText?.(text);
      return;
    }

    if (sessionUpdate === 'agent_thought_chunk' || sessionUpdate === 'tool_call' || sessionUpdate === 'tool_call_update') {
      const text = this.extractText(update);
      if (text) this.onStatus?.(text);
      return;
    }

    if (sessionUpdate === 'available_commands_update') {
      return;
    }

    const fallback = this.extractText(update);
    if (fallback) this.onStatus?.(fallback);
  }

  private extractText(value: any): string {
    const parts: string[] = [];

    const walk = (node: any) => {
      if (node == null) return;
      if (typeof node === 'string') return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (typeof node !== 'object') return;

      if (typeof node.text === 'string') parts.push(node.text);
      if (typeof node.content === 'string') parts.push(node.content);
      if (typeof node.result === 'string') parts.push(node.result);
      if (typeof node.description === 'string') parts.push(node.description);

      for (const key of Object.keys(node)) {
        walk(node[key]);
      }
    };

    walk(value);
    return parts.join('');
  }

  private request(method: string, params: Record<string, unknown>) {
    if (!this.proc) throw new Error('Hermes ACP process is not running');

    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  private async ensureInitialized(cwd?: string) {
    this.ensureStarted(cwd);
    if (this.initialized) return;

    await this.request('initialize', {
      protocol_version: 1,
      client_capabilities: {},
      client_info: {
        name: 'hermes-obsidian-mvp',
        version: '0.0.4',
      },
    });
    this.initialized = true;
  }

  async listSessions(cwd?: string): Promise<SessionSummary[]> {
    await this.ensureInitialized(cwd);
    const result = await this.request('session/list', {});
    const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
    return sessions
      .map((session: any) => {
        const id = session?.id ?? session?.sessionId ?? session?.session_id;
        return id ? { ...session, id } : null;
      })
      .filter((session: SessionSummary | null): session is SessionSummary => Boolean(session));
  }

  async resumeSession(sessionId: string, cwd?: string) {
    await this.ensureInitialized(cwd);
    const result = await this.request('session/resume', {
      sessionId,
      cwd: cwd || process.cwd(),
    });
    this.sessionId = result?.sessionId ?? result?.session_id ?? result?.id ?? sessionId;
    return result;
  }

  async loadSession(sessionId: string, cwd?: string) {
    await this.ensureInitialized(cwd);
    const result = await this.request('session/load', {
      sessionId,
      cwd: cwd || process.cwd(),
      mcpServers: [],
    });
    this.sessionId = result?.sessionId ?? result?.session_id ?? result?.id ?? sessionId;
    return result;
  }

  async restoreLatestSession(cwd?: string) {
    const sessions = await this.listSessions(cwd);
    if (!sessions.length) return null;

    const latest = [...sessions].sort((a, b) => {
      const aTs = Number(a.updatedAt ?? a.updated_at ?? a.createdAt ?? a.created_at ?? 0);
      const bTs = Number(b.updatedAt ?? b.updated_at ?? b.createdAt ?? b.created_at ?? 0);
      return bTs - aTs;
    })[0];

    try {
      return await this.loadSession(latest.id, cwd);
    } catch {
      return this.resumeSession(latest.id, cwd);
    }
  }

  private async ensureSession(cwd?: string) {
    if (this.sessionId) return this.sessionId;
    const result = await this.request('session/new', { cwd: cwd || process.cwd(), mcpServers: [] });
    this.sessionId = result?.sessionId ?? result?.session_id ?? result?.id;
    if (!this.sessionId) throw new Error('Hermes ACP did not return a session id');
    return this.sessionId;
  }

  async sendPrompt(text: string, cwd?: string) {
    await this.ensureInitialized(cwd);
    const sessionId = await this.ensureSession(cwd);
    return this.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }],
    });
  }
}
