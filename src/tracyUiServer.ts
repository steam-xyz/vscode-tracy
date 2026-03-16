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

type TraceSession = {
  createdAt: number;
  fileName: string;
  traceUri: vscode.Uri;
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
      if (method !== 'GET' && method !== 'HEAD') {
        this.writeResponse(response, 405, 'text/plain; charset=utf-8', 'Method Not Allowed', method);
        return;
      }

      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
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
      if (!traceId) {
        return;
      }

      const traceUrl = '/api/traces/' + encodeURIComponent(traceId);
      let hasStarted = false;
      let isRuntimeReady = false;

      Module.postRun = Array.isArray(Module.postRun) ? Module.postRun : [];
      Module.postRun.push(() => {
        isRuntimeReady = true;
        void openTraceIfReady();
      });

      async function openTraceIfReady() {
        if (!isRuntimeReady || hasStarted) {
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

  return html.replace('</body>', `  ${bridgeScript}\n</body>`);
}

function escapeHeaderValue(value: string): string {
  return value.replaceAll(/[\r\n"]/g, '_');
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return !!value && typeof value === 'object' && 'code' in value;
}
