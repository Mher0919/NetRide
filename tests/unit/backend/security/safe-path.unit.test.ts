// tests/unit/backend/security/safe-path.unit.test.ts
//
// Regression suite for filesystem path guards (finding C):
//  - backend/src/security/safe-path.ts (migration runner filename guard)
//  - AStarEngine.loadGraph (routing graph file loading)

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isSafeMigrationFilename,
  resolveMigrationFilename,
} from '../../../../backend/src/security/safe-path';
import { AStarEngine } from '../../../../backend/src/routing/engine/astar-engine';

test('safe-path: traversal, absolute and encoded migration names are rejected', () => {
  for (const bad of [
    '../secrets.sql',
    '..\\secrets.sql',
    'a/../b.sql',
    '/etc/passwd',
    'C:\\Windows\\x.sql',
    '%2e%2e%2fsecrets.sql',
    '..',
    '.',
    '',
    null,
    42,
    'x'.repeat(500) + '.sql',
  ]) {
    assert.equal(isSafeMigrationFilename(bad), false, `isSafe(${String(bad)})`);
    assert.equal(resolveMigrationFilename('/tmp/migrations', bad), null, `resolve(${String(bad)})`);
  }
});

test('safe-path: valid names resolve inside the permitted root only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'netride-safe-path-'));
  try {
    const resolved = resolveMigrationFilename(root, '001_initial_schema.sql');
    assert.equal(resolved, path.join(root, '001_initial_schema.sql'));
    assert.equal(path.dirname(resolved!), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('astar: loadGraph rejects missing files and directories', async () => {
  const engine = AStarEngine.getInstance();

  const missing = path.join(os.tmpdir(), `netride-missing-${Date.now()}.bin`);
  await assert.rejects(() => engine.loadGraph(missing), /not found/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netride-graph-dir-'));
  try {
    await assert.rejects(() => engine.loadGraph(dir), /not found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('astar: loadGraph loads a valid graph file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netride-graph-ok-'));
  const file = path.join(dir, 'routing-graph.bin');
  const graph: any = {
    nodeCount: 1,
    edgeCount: 0,
    lats: new Float64Array([34.05]),
    lngs: new Float64Array([-118.25]),
    nodeIds: new BigInt64Array([1n]),
    forwardOffsets: new Uint32Array([0, 0]),
    forwardTargets: new Int32Array(0),
    forwardWeights: new Float64Array(0),
    forwardDistances: new Float64Array(0),
    forwardFlags: new Uint8Array(0),
    forwardRoadClasses: new Uint8Array(0),
    forwardWayIds: new BigInt64Array(0),
    forwardNameIndices: new Int32Array(0),
    backwardOffsets: new Uint32Array([0, 0]),
    backwardTargets: new Int32Array(0),
    backwardWeights: new Float64Array(0),
    backwardDistances: new Float64Array(0),
    backwardFlags: new Uint8Array(0),
    backwardRoadClasses: new Uint8Array(0),
    backwardWayIds: new BigInt64Array(0),
    backwardNameIndices: new Int32Array(0),
    names: [],
  };
  try {
    AStarEngine.saveBinaryGraph(graph, file);
    await AStarEngine.getInstance().loadGraph(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
