import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { OrganizerError } from '../core/errors.js';
import { isRecord, type Operation, type Params, type RequestSpec, type Route } from '../core/types.js';
import { operations, isOperation, validateRoute, renderRoute } from '../core/routes.js';
import type { RouteRepository } from '../core/routes.js';

export class RouteStore implements RouteRepository {
  readonly directory: string;
  readonly file: string;
  routes: Partial<Record<Operation, Route>> = {};

  constructor(directory: string) { this.directory = directory; this.file = join(directory, 'project-routes.json'); }

  async load(): Promise<void> {
    try {
      const data: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (!isRecord(data) || data.version !== 1 || !isRecord(data.routes)) throw new Error('version');
      const routes: Partial<Record<Operation, Route>> = {};
      for (const [operation, route] of Object.entries(data.routes)) {
        if (!isOperation(operation)) throw new Error('operation');
        routes[operation] = validateRoute(operation, route);
      }
      this.routes = routes;
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ENOENT') throw new OrganizerError('INVALID_ROUTE_FILE', '项目接口配置无法读取；请检查 project-routes.json。');
    }
  }

  status(): Record<string, 'calibrated' | 'needs_calibration'> {
    return Object.fromEntries(Object.keys(operations).map(key => [key, isOperation(key) && this.routes[key] ? 'calibrated' : 'needs_calibration']));
  }

  get(operation: Operation, params: Params = {}): RequestSpec {
    const route = this.routes[operation];
    if (!route) throw new OrganizerError('PROJECT_ROUTE_NOT_CALIBRATED', '请先使用 record_start / record_finish 记录一次此项目操作。', { operation });
    return renderRoute(validateRoute(operation, route), params);
  }

  async save(operation: Operation, route: Route): Promise<void> {
    validateRoute(operation, route);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const next = { ...this.routes, [operation]: route };
    const temp = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify({ version: 1, routes: next }, null, 2), { mode: 0o600 });
    await rename(temp, this.file);
    this.routes = next;
  }
}
