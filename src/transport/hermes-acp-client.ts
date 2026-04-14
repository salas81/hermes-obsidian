import { spawn, ChildProcessWithoutNullStreams } from 'child_process';

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (reason?: unknown) => void;
};

export class HermesACPClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private initialized = false;
  private sessionId: string | null = null;
  onAssistantText?: (text: string) => void;

  constructor(private hermesCommand: string) {}

  private ensureStarted(cwd?: string) {
    if (this.proc) return;

    this.proc = spawn(this.hermesCommand, ['acp'], {
      cwd: cwd || process.cwd(),
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
      console.log('[Hermes ACP exited]', code);
      this.proc = null;
      this.initialized = false;
      this.sessionId = null;
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
        console.warn('Failed to parse ACP output line', error, line);
      }
    }
  }

  private handleMessage(msg: any) {
    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const pending = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(msg.error);
      else pending.resolve(msg.result);
      return;
    }

    if (msg.method === 'session/update') {
      const serialized = JSON.stringify(msg.params ?? {});
      const match = serialized.match(/"text"\s*:\s*"([^"]*)"/g);
      if (!match || !this.onAssistantText) return;

      for (const part of match) {
        const textMatch = part.match(/"text"\s*:\s*"([^"]*)"/);
        const text = textMatch?.[1]
          ?.replace(/\\n/g, '\n')
          ?.replace(/\\"/g, '"');
        if (text) this.onAssistantText(text);
      }
    }
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
      protocolVersion: 1,
      clientCapabilities: {},
    });
    this.initialized = true;
  }

  private async ensureSession(cwd?: string) {
    if (this.sessionId) return this.sessionId;
    const result = await this.request('session/new', cwd ? { cwd } : {});
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
