/**
 * Tool Applier Service tests.
 *
 * Covers the #1 structural gap from OPERATIONS.md §2: model output must be
 * applied through structured edits, path-guarded, worktree-isolated,
 * verification-gated, and approval-required — never blindly written.
 *
 * Tests run against scratch git repos in /tmp. The doctrine sandbox (bwrap)
 * is used for verification, so these tests prove the real path: a traversal
 * attempt is refused, a failing verification blocks the merge, and a passing
 * edit lands in a worktree pending human approval.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DurableStore } from '../src/services/durableStore';
import { ToolApplierService, ToolApplyRequest, StructuredEdit } from '../src/services/toolApplierService';

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function scratchRepo(name: string): { repo: string; branch: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `tool-applier-${name}-`));
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
    name: 'test-repo',
    version: '1.0.0',
    scripts: { verify: 'git diff --check' },
  }));
  fs.writeFileSync(path.join(repo, 'README.md'), '# Test Repo\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'initial');
  const branch = git(repo, 'branch', '--show-current');
  return { repo, branch };
}

function withIsolatedEnv<T>(run: () => T): T {
  const saved = {
    FACTORY_DATA_DIR: process.env.FACTORY_DATA_DIR,
    FACTORY_WORKSPACE_ROOT: process.env.FACTORY_WORKSPACE_ROOT,
    FACTORY_WORKTREE_ROOT: process.env.FACTORY_WORKTREE_ROOT,
  };
  process.env.FACTORY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-applier-data-'));
  process.env.FACTORY_WORKSPACE_ROOT = os.tmpdir();
  process.env.FACTORY_WORKTREE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-applier-worktrees-'));
  try {
    DurableStore.resetForTests();
    return run();
  } finally {
    process.env.FACTORY_DATA_DIR = saved.FACTORY_DATA_DIR;
    process.env.FACTORY_WORKSPACE_ROOT = saved.FACTORY_WORKSPACE_ROOT;
    process.env.FACTORY_WORKTREE_ROOT = saved.FACTORY_WORKTREE_ROOT;
    DurableStore.resetForTests();
  }
}

function baseRequest(repo: string, branch: string): ToolApplyRequest {
  return {
    tenantId: 'tenant-tool-apply-test',
    repo,
    branch,
    edits: [
      { path: 'hello.txt', operation: 'create', content: 'hello from the tool applier\n' },
    ],
    requestedBy: 'test-worker',
    rationale: 'test apply',
  };
}

test('a create edit applies to an isolated worktree and verification passes', () => {
  withIsolatedEnv(() => {
    const { repo, branch } = scratchRepo('create');
    const request = baseRequest(repo, branch);
    const result = ToolApplierService.apply(request);

    assert.equal(result.applied, true);
    assert.equal(result.verificationPassed, true);
    assert.ok(result.approvalId, 'an approval must be requested before merge');
    assert.ok(result.worktreePath, 'a worktree path must be returned');
    assert.ok(result.evidence.length > 0, 'evidence must be recorded');

    // The edit is inside the worktree, readable back.
    const filePath = path.join(result.worktreePath, 'hello.txt');
    assert.ok(fs.existsSync(filePath), 'the created file must exist in the worktree');
    assert.equal(fs.readFileSync(filePath, 'utf8'), 'hello from the tool applier\n');

    // The primary repo must be untouched — nothing merged yet.
    const porcelain = git(repo, 'status', '--porcelain');
    assert.equal(porcelain, '', 'the primary repo must remain clean until approval');
  });
});

test('a modify edit changes an existing file in the worktree', () => {
  withIsolatedEnv(() => {
    const { repo, branch } = scratchRepo('modify');
    const request: ToolApplyRequest = {
      ...baseRequest(repo, branch),
      edits: [
        { path: 'README.md', operation: 'modify', content: '# Test Repo\nModified by tool applier\n' },
      ],
    };
    const result = ToolApplierService.apply(request);

    assert.equal(result.applied, true);
    assert.equal(result.verificationPassed, true);
    const filePath = path.join(result.worktreePath, 'README.md');
    assert.equal(fs.readFileSync(filePath, 'utf8'), '# Test Repo\nModified by tool applier\n');
  });
});

test('a delete edit removes a file from the worktree', () => {
  withIsolatedEnv(() => {
    const { repo, branch } = scratchRepo('delete');
    fs.writeFileSync(path.join(repo, 'todelete.txt'), 'delete me\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'add delete target');

    const request: ToolApplyRequest = {
      ...baseRequest(repo, branch),
      edits: [{ path: 'todelete.txt', operation: 'delete' }],
    };
    const result = ToolApplierService.apply(request);

    assert.equal(result.applied, true);
    assert.equal(result.verificationPassed, true);
    assert.equal(fs.existsSync(path.join(result.worktreePath, 'todelete.txt')), false);
  });
});

test('a path traversal edit (..) is refused before touching disk', () => {
  withIsolatedEnv(() => {
    const { repo, branch } = scratchRepo('traversal');
    const request: ToolApplyRequest = {
      ...baseRequest(repo, branch),
      edits: [{ path: '../../etc/passwd', operation: 'create', content: 'pwned\n' }],
    };
    assert.throws(
      () => ToolApplierService.apply(request),
      /TOOL_APPLY_PATH_TRAVERSAL|TOOL_APPLY_PATH_OUTSIDE_REPO|TOOL_APPLY_PATH_ESCAPES_REPO/,
      'a traversal path must be refused',
    );
    // No worktree should be left behind.
    const worktreesRoot = process.env.FACTORY_WORKTREE_ROOT!;
    const entries = fs.existsSync(worktreesRoot) ? fs.readdirSync(worktreesRoot) : [];
    assert.equal(entries.length, 0, 'no worktree artifacts must remain after a refusal');
  });
});

test('an absolute path edit is refused', () => {
  withIsolatedEnv(() => {
    const { repo, branch } = scratchRepo('absolute');
    const request: ToolApplyRequest = {
      ...baseRequest(repo, branch),
      edits: [{ path: '/etc/passwd', operation: 'create', content: 'pwned\n' }],
    };
    assert.throws(
      () => ToolApplierService.apply(request),
      /TOOL_APPLY_PATH_ABSOLUTE/,
      'an absolute path must be refused',
    );
  });
});

test('a .git path edit is refused', () => {
  withIsolatedEnv(() => {
    const { repo, branch } = scratchRepo('gitdir');
    const request: ToolApplyRequest = {
      ...baseRequest(repo, branch),
      edits: [{ path: '.git/config', operation: 'create', content: 'pwned\n' }],
    };
    assert.throws(
      () => ToolApplierService.apply(request),
      /TOOL_APPLY_PATH_GITDIR/,
      'a .git path must be refused',
    );
  });
});

test('a verification failure returns applied:true but verificationPassed:false, no approval', () => {
  withIsolatedEnv(() => {
    const { repo, branch } = scratchRepo('verify-fail');
    // A repo whose verify script fails
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
      name: 'fail-repo',
      version: '1.0.0',
      scripts: { verify: 'exit 1' },
    }));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'failing verify');

    const request: ToolApplyRequest = {
      ...baseRequest(repo, branch),
      edits: [{ path: 'newfile.txt', operation: 'create', content: 'should not merge\n' }],
    };
    const result = ToolApplierService.apply(request);

    assert.equal(result.applied, false); // verification failed, apply did not succeed
    assert.equal(result.verificationPassed, false);
    assert.equal(result.approvalId, undefined, 'no approval must be requested when verification fails');
    assert.ok(result.error, 'an error must be recorded');
  });
});

test('the approve path merges an approved apply into the target branch', () => {
  withIsolatedEnv(() => {
    const { repo, branch } = scratchRepo('approve');
    const request = baseRequest(repo, branch);
    const result = ToolApplierService.apply(request);

    assert.equal(result.applied, true);
    assert.equal(result.verificationPassed, true);
    assert.ok(result.approvalId);

    // Approve the apply.
    const mergeResult = ToolApplierService.approve('tenant-tool-apply-test', result.approvalId!, 'test-operator');
    assert.equal(mergeResult.merged, true);
    assert.equal(mergeResult.targetBranch, branch);

    // The file must now exist in the primary repo.
    const filePath = path.join(repo, 'hello.txt');
    assert.ok(fs.existsSync(filePath), 'the approved file must exist in the primary repo after merge');
    assert.equal(fs.readFileSync(filePath, 'utf8'), 'hello from the tool applier\n');

    // The worktree must be cleaned up.
    assert.equal(fs.existsSync(result.worktreePath), false, 'the worktree must be removed after merge');
  });
});

test('the reject path cleans up without merging', () => {
  withIsolatedEnv(() => {
    const { repo, branch } = scratchRepo('reject');
    const result = ToolApplierService.apply(baseRequest(repo, branch));
    assert.equal(result.applied, true);
    assert.ok(result.approvalId);

    ToolApplierService.reject('tenant-tool-apply-test', result.approvalId!, 'test rejection', 'test-operator');

    // The file must NOT exist in the primary repo.
    assert.equal(fs.existsSync(path.join(repo, 'hello.txt')), false, 'a rejected apply must not reach the primary repo');
    // The worktree must be cleaned up.
    assert.equal(fs.existsSync(result.worktreePath), false, 'the worktree must be removed after rejection');
  });
});

test('listing records returns the apply history for a tenant', () => {
  withIsolatedEnv(() => {
    const { repo, branch } = scratchRepo('list');
    const result = ToolApplierService.apply(baseRequest(repo, branch));
    assert.ok(result.approvalId);

    const records = ToolApplierService.list('tenant-tool-apply-test');
    assert.equal(records.length, 1);
    const byApproval = records.find((r) => r.approvalId === result.approvalId);
    assert.ok(byApproval, 'the record must be findable by approval id');
    assert.equal(byApproval?.status, 'APPROVAL_PENDING');
  });
});
