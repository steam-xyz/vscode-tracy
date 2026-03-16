import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';

const CONTENT_TYPES = new Map<string, string>([
  ['.css', 'text/css; charset=utf-8'],
  ['.data', 'application/octet-stream'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.wasm', 'application/wasm'],
]);

const REQUIRED_UI_FILES = ['index.html', 'favicon.svg', 'tracy-profiler.data', 'tracy-profiler.js', 'tracy-profiler.wasm'];
const TRACE_SESSION_TTL_MS = 60 * 60 * 1000;
const MAX_UI_LOG_BODY_BYTES = 64 * 1024;

type TraceSession = {
  createdAt: number;
  fileName: string;
  traceUri: vscode.Uri;
};

type UiLogLevel = 'debug' | 'info' | 'log' | 'warn' | 'error';

type UiLogPayload = {
  level: UiLogLevel;
  message: string;
  pageId?: string;
  source?: string;
  traceId?: string;
};

export class TracyUiServer implements vscode.Disposable {
  private readonly rootPath: string;
  private readonly log: (message: string) => void;
  private readonly traceSessions = new Map<string, TraceSession>();
  private server: http.Server | undefined;
  private externalBaseUrlPromise: Promise<string> | undefined;

  public constructor(extensionUri: vscode.Uri, log: (message: string) => void) {
    this.rootPath = path.join(extensionUri.fsPath, 'tracy-ui');
    this.log = log;
  }

  public async createTraceUrl(traceUri: vscode.Uri): Promise<string> {
    await this.ensureBundleExists();
    const baseUrl = await this.getBaseUrl();
    const sessionId = this.createTraceSession(traceUri);
    return `${baseUrl}/index.html?trace=${encodeURIComponent(sessionId)}`;
  }

  public dispose(): void {
    this.externalBaseUrlPromise = undefined;
    this.traceSessions.clear();

    if (!this.server) {
      return;
    }

    this.server.close();
    this.server = undefined;
  }

  private async ensureBundleExists(): Promise<void> {
    for (const relativePath of REQUIRED_UI_FILES) {
      const targetPath = path.join(this.rootPath, relativePath);

      try {
        await fs.access(targetPath);
      } catch {
        throw new Error(`Bundled Tracy UI is missing ${relativePath}. Run "pnpm tracy:fetch" first.`);
      }
    }
  }

  private createTraceSession(traceUri: vscode.Uri): string {
    this.cleanupTraceSessions();

    const fileName = path.posix.basename(traceUri.path) || traceUri.toString(true);
    const sessionId = randomUUID();
    this.traceSessions.set(sessionId, {
      createdAt: Date.now(),
      fileName,
      traceUri,
    });
    this.log(`Created trace session ${sessionId} for ${fileName}.`);
    return sessionId;
  }

  private cleanupTraceSessions(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.traceSessions) {
      if (now - session.createdAt > TRACE_SESSION_TTL_MS) {
        this.traceSessions.delete(sessionId);
      }
    }
  }

  private async getBaseUrl(): Promise<string> {
    if (!this.externalBaseUrlPromise) {
      this.externalBaseUrlPromise = this.start();
    }

    return this.externalBaseUrlPromise;
  }

  private async start(): Promise<string> {
    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server?.off('error', onError);
        reject(error);
      };

      this.server?.once('error', onError);
      this.server?.listen(0, '127.0.0.1', () => {
        this.server?.off('error', onError);
        resolve();
      });
    });

    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to determine the Tracy UI server address.');
    }

    const localUri = vscode.Uri.parse(`http://127.0.0.1:${address.port}`);
    const externalUri = await vscode.env.asExternalUri(localUri);
    const baseUrl = externalUri.toString().replace(/\/$/, '');
    this.log(`Tracy UI server listening at ${baseUrl}`);
    return baseUrl;
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      const method = request.method ?? 'GET';
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');

      if (url.pathname === '/api/logs') {
        if (method !== 'POST') {
          this.writeResponse(response, 405, 'text/plain; charset=utf-8', 'Method Not Allowed', method);
          return;
        }

        await this.handleUiLogRequest(request, response);
        return;
      }

      if (method !== 'GET' && method !== 'HEAD') {
        this.writeResponse(response, 405, 'text/plain; charset=utf-8', 'Method Not Allowed', method);
        return;
      }

      if (url.pathname.startsWith('/api/traces/')) {
        await this.handleTraceRequest(url.pathname.slice('/api/traces/'.length), method, response);
        return;
      }

      const filePath = this.resolveAssetPath(url.pathname);
      if (!filePath) {
        this.writeResponse(response, 400, 'text/plain; charset=utf-8', 'Bad Request', method);
        return;
      }

      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        this.writeResponse(response, 404, 'text/plain; charset=utf-8', 'Not Found', method);
        return;
      }

      const extension = path.extname(filePath).toLowerCase();
      if (path.basename(filePath) === 'index.html') {
        const originalHtml = await fs.readFile(filePath, 'utf8');
        const body = injectBridgeScript(originalHtml);
        this.writeBufferResponse(response, 200, 'text/html; charset=utf-8', Buffer.from(body), method);
        return;
      }

      const body = await fs.readFile(filePath);
      this.writeBufferResponse(response, 200, CONTENT_TYPES.get(extension) ?? 'application/octet-stream', body, method);
    } catch (error) {
      const code = isNodeError(error) && error.code === 'ENOENT' ? 404 : 500;
      const message = code === 404 ? 'Not Found' : 'Internal Server Error';
      this.writeResponse(response, code, 'text/plain; charset=utf-8', message, request.method ?? 'GET');
    }
  }

  private async handleTraceRequest(sessionId: string, method: string, response: http.ServerResponse): Promise<void> {
    this.cleanupTraceSessions();

    const session = this.traceSessions.get(sessionId);
    if (!session) {
      this.writeResponse(response, 404, 'text/plain; charset=utf-8', 'Unknown trace session', method);
      return;
    }

    const bytes = await vscode.workspace.fs.readFile(session.traceUri);
    const headers = {
      'Content-Disposition': `inline; filename="${escapeHeaderValue(session.fileName)}"`,
      'X-Tracy-Trace-File-Name': encodeURIComponent(session.fileName),
    };
    this.writeBufferResponse(response, 200, 'application/octet-stream', Buffer.from(bytes), method, headers);
  }

  private async handleUiLogRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    let payload: UiLogPayload | undefined;

    try {
      const requestBody = await readRequestBody(request, MAX_UI_LOG_BODY_BYTES);
      const parsedBody: unknown = JSON.parse(requestBody.toString('utf8'));
      payload = parseUiLogPayload(parsedBody);
    } catch (error) {
      const isTooLarge = error instanceof RequestBodyTooLargeError;
      const statusCode = isTooLarge ? 413 : 400;
      const message = isTooLarge ? 'Request Entity Too Large' : 'Invalid log payload';
      this.writeResponse(response, statusCode, 'text/plain; charset=utf-8', message, request.method ?? 'POST');
      return;
    }

    if (!payload) {
      this.writeResponse(response, 400, 'text/plain; charset=utf-8', 'Invalid log payload', request.method ?? 'POST');
      return;
    }

    this.cleanupTraceSessions();
    const session = payload.traceId ? this.traceSessions.get(payload.traceId) : undefined;
    this.log(formatUiLogMessage(payload, session?.fileName));

    response.writeHead(204, {
      'Cache-Control': 'no-store',
    });
    response.end();
  }

  private resolveAssetPath(requestPath: string): string | undefined {
    const pathname = requestPath === '/' ? '/index.html' : requestPath;
    const resolvedPath = path.resolve(this.rootPath, `.${pathname}`);
    const rootPrefix = this.rootPath.endsWith(path.sep) ? this.rootPath : `${this.rootPath}${path.sep}`;

    if (resolvedPath !== this.rootPath && !resolvedPath.startsWith(rootPrefix)) {
      return undefined;
    }

    return resolvedPath;
  }

  private writeResponse(
    response: http.ServerResponse,
    statusCode: number,
    contentType: string,
    body: string,
    method: string,
  ): void {
    this.writeBufferResponse(response, statusCode, contentType, Buffer.from(body, 'utf8'), method);
  }

  private writeBufferResponse(
    response: http.ServerResponse,
    statusCode: number,
    contentType: string,
    body: Buffer,
    method: string,
    extraHeaders: Record<string, string> = {},
  ): void {
    response.writeHead(statusCode, {
      'Cache-Control': 'no-store',
      'Content-Length': body.byteLength,
      'Content-Type': contentType,
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      ...extraHeaders,
    });
    response.end(method === 'HEAD' ? undefined : body);
  }
}

function injectBridgeScript(html: string): string {
  const bridgeScript = `<script type="text/javascript">
    'use strict';
    (function () {
      const searchParams = new URLSearchParams(window.location.search);
      const traceId = searchParams.get('trace');
      const traceUrl = traceId ? '/api/traces/' + encodeURIComponent(traceId) : undefined;
      const logEndpoint = '/api/logs';
      const pageId = typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : String(Date.now()) + '-' + Math.random().toString(16).slice(2);
      const originalConsole = {
        debug: typeof console.debug === 'function' ? console.debug.bind(console) : console.log.bind(console),
        error: typeof console.error === 'function' ? console.error.bind(console) : console.log.bind(console),
        info: typeof console.info === 'function' ? console.info.bind(console) : console.log.bind(console),
        log: typeof console.log === 'function' ? console.log.bind(console) : function () {},
        warn: typeof console.warn === 'function' ? console.warn.bind(console) : console.log.bind(console),
      };
      let hasStarted = false;
      let isRuntimeReady = false;

      function createJsonReplacer() {
        const seen = new WeakSet();
        return function (_key, value) {
          if (value instanceof Error) {
            return {
              message: value.message,
              name: value.name,
              stack: value.stack,
            };
          }

          if (typeof value === 'bigint') {
            return value.toString() + 'n';
          }

          if (typeof value === 'object' && value !== null) {
            if (seen.has(value)) {
              return '[Circular]';
            }

            seen.add(value);
          }

          return value;
        };
      }

      function formatLogArg(value) {
        if (typeof value === 'string') {
          return value;
        }

        if (value instanceof Error) {
          return value.stack || value.message;
        }

        if (typeof value === 'undefined') {
          return 'undefined';
        }

        try {
          return JSON.stringify(value, createJsonReplacer());
        } catch (_error) {
          return String(value);
        }
      }

      function postUiLog(level, source, argsLike) {
        const args = Array.prototype.slice.call(argsLike);
        const message = args.map(formatLogArg).join(' ');
        if (!message) {
          return;
        }

        const body = JSON.stringify({
          level,
          message: message.length > 32000 ? message.slice(0, 32000) + ' ...<truncated>' : message,
          pageId,
          source,
          traceId,
        });

        void fetch(logEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body,
          cache: 'no-store',
          keepalive: true,
        }).catch(function () {
          // Best-effort logging only.
        });
      }

      for (const level of ['debug', 'error', 'info', 'log', 'warn']) {
        const originalMethod = originalConsole[level] || originalConsole.log;
        console[level] = function () {
          originalMethod.apply(console, arguments);
          postUiLog(level, 'console', arguments);
        };
      }

      if (typeof Module === 'object' && Module) {
        const originalPrintErr = typeof Module.printErr === 'function' ? Module.printErr.bind(Module) : undefined;
        Module.printErr = function () {
          if (originalPrintErr) {
            originalPrintErr.apply(Module, arguments);
            return;
          }

          console.error.apply(console, arguments);
        };
      }

      window.addEventListener('error', (event) => {
        const details = [];
        if (event.message) {
          details.push(event.message);
        }
        if (event.filename) {
          details.push(event.filename + ':' + event.lineno + ':' + event.colno);
        }
        if (event.error) {
          details.push(event.error);
        }

        postUiLog('error', 'window.error', details);
      });

      window.addEventListener('unhandledrejection', (event) => {
        postUiLog('error', 'unhandledrejection', [event.reason]);
      });

      Module.postRun = Array.isArray(Module.postRun) ? Module.postRun : [];
      Module.postRun.push(() => {
        isRuntimeReady = true;
        void openTraceIfReady();
      });

      async function openTraceIfReady() {
        if (!traceUrl || !isRuntimeReady || hasStarted) {
          return;
        }

        hasStarted = true;
        try {
          if (typeof Module.setStatus === 'function') {
            Module.setStatus('Loading trace...');
          }

          const response = await fetch(traceUrl, { cache: 'no-store' });
          if (!response.ok) {
            throw new Error('HTTP ' + response.status);
          }

          const encodedFileName = response.headers.get('X-Tracy-Trace-File-Name');
          const fileName = encodedFileName ? decodeURIComponent(encodedFileName) : 'trace.tracy';
          const buffer = await response.arrayBuffer();
          const bytes = new Uint8Array(buffer);

          try {
            if (FS.analyzePath('/upload.tracy').exists) {
              FS.unlink('/upload.tracy');
            }
          } catch (_) {
            // Best effort cleanup before replacing the virtual file.
          }

          FS.createDataFile('/', 'upload.tracy', bytes, true, true);
          Module.ccall('nativeOpenFile', 'number', [], []);
          FS.unlink('/upload.tracy');
          document.title = 'Tracy Profiler - ' + fileName;

          if (typeof Module.setStatus === 'function') {
            Module.setStatus('');
          }

          console.log('[vscode-tracy] Opened trace:', fileName);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error('[vscode-tracy] Failed to open trace:', message);
          if (typeof Module.setStatus === 'function') {
            Module.setStatus('Failed to open trace. See JavaScript console.');
          }
        }
      }

      const readyPoll = window.setInterval(() => {
        if (isRuntimeReady) {
          window.clearInterval(readyPoll);
          return;
        }

        if (window.Module && window.Module.calledRun === true) {
          isRuntimeReady = true;
          window.clearInterval(readyPoll);
          void openTraceIfReady();
        }
      }, 100);
    })();
  </script>`;

  const bootstrapScriptTag = '<script async type="text/javascript" src="tracy-profiler.js"></script>';
  if (html.includes(bootstrapScriptTag)) {
    return html.replace(bootstrapScriptTag, `  ${bridgeScript}\n    ${bootstrapScriptTag}`);
  }

  return html.replace('</body>', `  ${bridgeScript}\n</body>`);
}

function escapeHeaderValue(value: string): string {
  return value.replaceAll(/[\r\n"]/g, '_');
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return !!value && typeof value === 'object' && 'code' in value;
}

function isUiLogLevel(value: string): value is UiLogLevel {
  return value === 'debug' || value === 'error' || value === 'info' || value === 'log' || value === 'warn';
}

function parseUiLogPayload(value: unknown): UiLogPayload | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const candidate = value as {
    level?: unknown;
    message?: unknown;
    pageId?: unknown;
    source?: unknown;
    traceId?: unknown;
  };

  if (typeof candidate.level !== 'string' || !isUiLogLevel(candidate.level) || typeof candidate.message !== 'string') {
    return undefined;
  }

  return {
    level: candidate.level,
    message: candidate.message,
    pageId: typeof candidate.pageId === 'string' ? candidate.pageId : undefined,
    source: typeof candidate.source === 'string' ? candidate.source : undefined,
    traceId: typeof candidate.traceId === 'string' ? candidate.traceId : undefined,
  };
}

function formatUiLogMessage(payload: UiLogPayload, fileName: string | undefined): string {
  const parts = ['Tracy UI', `[${payload.level}]`];

  if (fileName) {
    parts.push(`[${fileName}]`);
  } else if (payload.traceId) {
    parts.push(`[trace ${payload.traceId.slice(0, 8)}]`);
  } else if (payload.pageId) {
    parts.push(`[page ${payload.pageId.slice(0, 8)}]`);
  }

  if (payload.source && payload.source !== 'console') {
    parts.push(`[${payload.source}]`);
  }

  parts.push(payload.message);
  return parts.join(' ');
}

async function readRequestBody(request: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;

    if (totalBytes > maxBytes) {
      throw new RequestBodyTooLargeError();
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks, totalBytes);
}

class RequestBodyTooLargeError extends Error {
  public constructor() {
    super('Request body too large.');
  }
}
